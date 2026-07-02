import { describe, expect, it, afterEach } from "bun:test";
import { translateBatch, translateOne, buildTranslatePrompt } from "../src/ollama";
import { planTargetLanguages, type KeptSubDescriptor } from "../src/subtitle-translate";
import type { OllamaOptions } from "../src/ollama";

const EN = { name: "English", code: "en" };
const SL = { name: "Slovenian", code: "sl" };

function opts(overrides: Partial<OllamaOptions> = {}): OllamaOptions {
	return { url: "http://localhost:11434", model: "translategemma:12b", source: EN, target: SL, ...overrides };
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Install a fake fetch that returns `content` as the chat message. */
function mockChat(handler: (body: any) => string) {
	globalThis.fetch = (async (_url: string, init: any) => {
		const body = JSON.parse(init.body);
		const content = handler(body);
		return new Response(JSON.stringify({ message: { content } }), { status: 200 });
	}) as unknown as typeof fetch;
}

describe("ollama.buildTranslatePrompt", () => {
	it("uses the TranslateGemma structure with names and codes", () => {
		const p = buildTranslatePrompt(EN, SL, "Hello");
		expect(p).toContain("professional English (en) to Slovenian (sl) translator");
		expect(p).toContain("Please translate the following English text into Slovenian:\n\n\nHello");
	});
});

describe("ollama.translateBatch", () => {
	it("maps N lines to N returned lines in order", async () => {
		mockChat((body) => {
			// The block is the last line group of the prompt.
			const prompt: string = body.messages[0].content;
			const block = prompt.split("Slovenian:\n\n\n")[1]!;
			return block
				.split("\n")
				.map((l) => `sl:${l}`)
				.join("\n");
		});
		const out = await translateBatch(["one", "two", "three"], opts());
		expect(out).toEqual(["sl:one", "sl:two", "sl:three"]);
	});

	it("passes empty lines through without translating them", async () => {
		mockChat((body) => {
			const block = body.messages[0].content.split("Slovenian:\n\n\n")[1]!;
			return block
				.split("\n")
				.map((l: string) => l.toUpperCase())
				.join("\n");
		});
		const out = await translateBatch(["a", "", "b"], opts());
		expect(out).toEqual(["A", "", "B"]);
	});

	it("falls back to per-line when the batch count is misaligned", async () => {
		let calls = 0;
		globalThis.fetch = (async (_url: string, init: any) => {
			calls++;
			const prompt = JSON.parse(init.body).messages[0].content;
			const block = prompt.split("Slovenian:\n\n\n")[1]!;
			const lineCount = block.split("\n").length;
			// First (batch) call: return the WRONG number of lines to force fallback.
			// Subsequent (per-line) calls each have a single-line block.
			const content = lineCount > 1 ? "merged everything into one line" : `X:${block}`;
			return new Response(JSON.stringify({ message: { content } }), { status: 200 });
		}) as unknown as typeof fetch;

		const out = await translateBatch(["one", "two"], opts());
		expect(out).toEqual(["X:one", "X:two"]);
		expect(calls).toBe(3); // 1 failed batch + 2 per-line
	});

	it("throws on HTTP errors", async () => {
		globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
		await expect(translateOne("hi", opts())).rejects.toThrow(/Ollama HTTP 500/);
	});
});

describe("planTargetLanguages", () => {
	const track = (index: number, language: string, trackType: string, codec = "ass"): KeptSubDescriptor => ({
		index,
		language,
		trackType,
		codec,
	});

	it("skips languages that already have a full or honorifics track", () => {
		const tracks = [track(0, "eng", "full"), track(1, "ger", "full"), track(2, "fre", "full")];
		const plan = planTargetLanguages(tracks, ["eng", "deu", "fra", "slv"]);
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
		expect(plan.productions[0]!.sourceIndex).toBe(0); // English source (top)
	});

	it("counts an existing Slovenian honorifics track as covering Slovenian", () => {
		const tracks = [track(0, "eng", "full"), track(1, "slv", "honorifics")];
		const plan = planTargetLanguages(tracks, ["slv"]);
		expect(plan.productions.length).toBe(0);
	});

	it("skips unsupported target languages with a note", () => {
		const tracks = [track(0, "eng", "full")];
		const plan = planTargetLanguages(tracks, ["tlh", "slv"]);
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
		expect(plan.skipped.some((s) => s.startsWith("tlh"))).toBe(true);
	});

	it("does not translate the source language into itself", () => {
		const tracks = [track(0, "eng", "full")];
		const plan = planTargetLanguages(tracks, ["eng", "slv"]);
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
	});
});
