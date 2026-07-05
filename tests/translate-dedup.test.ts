import { describe, expect, it, afterEach } from "bun:test";
import { translateSubtitleContent, type TranslateContentOptions } from "../src/subtitle-translate";
import { buildAss, DEFAULT_STYLE_LINE, SIGN_STYLE_LINE } from "./fixtures/ass";

const EN = { name: "English", code: "en" };
const SL = { name: "Slovenian", code: "sl" };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/**
 * Mock the Ollama chat endpoint: "translates" by uppercasing each line and
 * records every line the model was asked to translate into `sent`.
 */
function mockTranslate(sent: string[]) {
	globalThis.fetch = (async (_url: string, init: any) => {
		const prompt: string = JSON.parse(init.body).messages[0].content;
		const block = prompt.split("Slovenian:\n\n\n")[1]!;
		const lines = block.split("\n");
		sent.push(...lines);
		const content = lines.map((l) => l.toUpperCase()).join("\n");
		return new Response(JSON.stringify({ message: { content } }), { status: 200 });
	}) as unknown as typeof fetch;
}

function opts(over: Partial<TranslateContentOptions> = {}): TranslateContentOptions {
	return {
		format: "ass",
		batchSize: 100,
		translateSignsSongs: true,
		strategy: "translategemma",
		isDialogueStyle: (s) => s === "Default",
		ollama: { url: "http://localhost:11434", model: "translategemma:12b", source: EN, target: SL } as any,
		...over,
	};
}

const STYLES = [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE];

describe("translateAss sign/song deduplication", () => {
	it("translates repeated sign text once and fans it out, preserving each line's own lead", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there",
				"Dialogue: 0,0:23:17.93,0:23:22.26,Signs,,0,0,0,fx,{\\pos(960,1050)\\clip(355,1048,1567,1051)}Rock",
				"Dialogue: 0,0:23:17.93,0:23:22.26,Signs,,0,0,0,fx,{\\pos(960,1050)\\clip(355,1051,1567,1052)}Rock",
				"Dialogue: 0,0:23:17.93,0:23:22.26,Signs,,0,0,0,fx,{\\pos(960,1050)\\clip(355,1052,1567,1053)}Rock",
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());

		// The model saw the sign text exactly once (plus the dialogue line).
		expect(sent.filter((l) => l === "Rock").length).toBe(1);
		expect(sent.length).toBe(2);

		// All three sign lines carry the shared translation, each with its OWN lead.
		expect(out).toContain("{\\pos(960,1050)\\clip(355,1048,1567,1051)}ROCK");
		expect(out).toContain("{\\pos(960,1050)\\clip(355,1051,1567,1052)}ROCK");
		expect(out).toContain("{\\pos(960,1050)\\clip(355,1052,1567,1053)}ROCK");
		expect(out).toContain(",Default,,0,0,0,,HELLO THERE");
		// No untranslated leftovers.
		expect(out).not.toContain("}Rock");
	});

	it("does not dedupe signs with different visible text", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Signs,,0,0,0,,{\\pos(1,1)}Rock", "Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(2,2)}Plant"],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());
		expect(sent.sort()).toEqual(["Plant", "Rock"]);
		expect(out).toContain("{\\pos(1,1)}ROCK");
		expect(out).toContain("{\\pos(2,2)}PLANT");
	});

	it("does NOT dedupe identical dialogue lines (context may differ)", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Same line", "Dialogue: 0,0:10:00.00,0:10:02.00,Default,,0,0,0,,Same line"],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		await translateSubtitleContent(ass, opts());
		expect(sent.filter((l) => l === "Same line").length).toBe(2);
	});

	it("still skips single-char sign events verbatim (never sent, never deduped)", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Signs,,0,0,0,,{\\pos(1,1)}A",
				"Dialogue: 0,0:00:01.00,0:00:03.00,Signs,,0,0,0,,{\\pos(2,2)}A",
				"Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Real dialogue",
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());
		expect(sent).toEqual(["Real dialogue"]);
		expect(out).toContain("{\\pos(1,1)}A");
		expect(out).toContain("{\\pos(2,2)}A");
	});

	it("reports progress totals based on the deduped unit count", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(1,1)}Rock",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(1,2)}Rock",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(1,3)}Rock",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(1,4)}Rock",
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		let lastTotal = -1;
		let lastDone = -1;
		await translateSubtitleContent(
			ass,
			opts({
				onProgress: (done, total) => {
					lastDone = done;
					lastTotal = total;
				},
			}),
		);

		// 5 events collapse to 2 translation units (1 dialogue + 1 unique sign).
		expect(lastTotal).toBe(2);
		expect(lastDone).toBe(2);
	});

	it("dedup never applies when translateSignsSongs is off", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(1,1)}Rock",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(1,2)}Rock",
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts({ translateSignsSongs: false }));
		expect(sent).toEqual(["Hello"]);
		// Sign lines untouched, original text intact.
		expect(out).toContain("{\\pos(1,1)}Rock");
		expect(out).toContain("{\\pos(1,2)}Rock");
	});
});
