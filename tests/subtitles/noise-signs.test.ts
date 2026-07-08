import { describe, expect, it, afterEach } from "bun:test";
import { isNoiseSign, findFrameChurnEvents, translateSubtitleContent, type TranslateContentOptions } from "../../src/translate/subtitle-translate";
import { parseAssEvents } from "../../src/subtitles/ass-edit";
import { buildAss, DEFAULT_STYLE_LINE, SIGN_STYLE_LINE } from "../fixtures/ass";

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
const isDialogue = (s: string) => s === "Default";

const GRAIN = [
	"lutIpSLjgSlpDQd\\NpCsQcxPaNjjCuqu\\NCaoMzPETXEHiNyH\\NbMrNIQRUnysTKwy\\NgKmbnHToiMPwmhr\\NYtUoSCqZlPPOikw\\NfGVKZTlqIPCHyEo",
	"aHjokYqMNEuFwCC\\NXOENeCCUfsyaJll\\NotbKPBGtuxvSnaS\\NDHkneXQbnvsWnyV\\NnzEzmQPJinAUzYr\\NeWNXEyAOHWsLeEL\\NhYHDRCwMNkpbHpY",
	"jGcpwbNlkKnxzYB\\NbSKlbHqpaqGcNzQ\\NaqIZKcRqUorpMgn\\NAimxjGJZzrjhRMs\\NYrqTNpMUnoWyVqW\\NKysVbWMrzepXFQs\\NYqLlGaGvXTdRqXj",
	"DefspzwDbZvBIaT\\NyWBhkNYtYdxDzGs\\NcgiZeUDNjCoHVeo\\NkGTDXAIbMQCUddb\\NdCbUlYUzfvadRNc\\NzxvWWDlQsZgZDtY\\NekafTkBmtdYEyFy",
	"YYBjtCcYQgQjHeE\\NTNWPtbCAnHNONzo\\NNlGXgQRYZAqMBEw\\NGaPlKVwXTqiBuDh\\NQRFFqYDdltiNsNV\\NXyvEYsaoWreWNZR\\NaTnHNpNCRouPMpr",
	"szJPjDSqDYlNUhN\\NCKonvoqWeCyIvBb\\NbVKjllXNjqfuGAz\\NrOZVOqXDuzYaQdY\\NeUFqFiGGecbGpJo\\NsLNrisePWBgGtGM\\NgLYQMrdcNyAprPz",
];

/** Format centiseconds as an ASS timecode (H:MM:SS.CC). */
function cs(t: number): string {
	const c = t % 100;
	const s = Math.floor(t / 100) % 60;
	const m = Math.floor(t / 6000) % 60;
	const h = Math.floor(t / 360000);
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Build back-to-back Dialogue lines of `durCs` centiseconds each. */
function churnLines(texts: string[], startCs: number, durCs = 4, style = "Signs", name = "Grain"): string[] {
	return texts.map((t, i) => `Dialogue: 1,${cs(startCs + i * durCs)},${cs(startCs + (i + 1) * durCs)},${style},${name},0,0,0,,{\\pos(675,259)}${t}`);
}

function eventsOf(lines: string[]) {
	return parseAssEvents(buildAss({ styles: STYLES, events: lines })).events;
}

describe("isNoiseSign", () => {
	it("flags real multi-line grain lines, including vowel-rich-segment outliers", () => {
		for (const g of GRAIN) {
			expect(isNoiseSign(g)).toBe(true);
		}
	});

	it("flags a single long gibberish token; short ones only at frame-length durations", () => {
		expect(isNoiseSign("lutIpSLjgSlpDQd")).toBe(true); // 15 chars, no duration needed
		expect(isNoiseSign("lutIpSLj")).toBe(false); // 8 < 12 without duration corroboration
		expect(isNoiseSign("lutIpSLj", 40)).toBe(true); // frame-length loosens minLen to 8
		expect(isNoiseSign("lutIpSLj", 3000)).toBe(false); // long event: strict thresholds
	});

	it("never flags real sign text", () => {
		expect(isNoiseSign("Magistone\\NOre")).toBe(false); // short word segments
		expect(isNoiseSign("Notice\\NPhysical Damage Taken \\N10%")).toBe(false); // spaces + digits
		expect(isNoiseSign("Water Pressure Propulsion")).toBe(false); // spaces
		expect(isNoiseSign("SHOPOPENINGSOON")).toBe(false); // all caps: zero case flips
		expect(isNoiseSign("SelfRegeneration")).toBe(false); // CamelCase: low flip rate
		expect(isNoiseSign("Donaudampfschifffahrt")).toBe(false); // long compound, stable case
	});

	it("fails closed for non-ASCII scripts (Japanese, Cyrillic, accented Latin)", () => {
		expect(isNoiseSign("営業中\\N準備中")).toBe(false);
		expect(isNoiseSign("МагазинОткрытКруглосуточно")).toBe(false);
		expect(isNoiseSign("PâtisserieOuverte")).toBe(false);
	});

	it("is inert for romaji: high flip rate alone is not enough (vowel-dense)", () => {
		expect(isNoiseSign("ShingekiNoKyojin")).toBe(false);
	});

	it("returns false for empty or break-only text", () => {
		expect(isNoiseSign("")).toBe(false);
		expect(isNoiseSign(" \\N ")).toBe(false);
	});
});

describe("findFrameChurnEvents", () => {
	it("flags a contiguous frame-length run of unique-text sign events", () => {
		const events = eventsOf(churnLines(GRAIN, 100));
		const skip = findFrameChurnEvents(events, isDialogue);
		expect(skip.size).toBe(6);
		for (const ev of events) expect(skip.has(ev.lineNo)).toBe(true);
	});

	it("is language-agnostic: flags kana churn that isNoiseSign cannot see", () => {
		const kana = ["あかさたなはまやらわ", "いきしちにひみりゐん", "うくすつぬふむゆるぼ", "えけせてねへめれゑぞ", "おこそとのほもよろを"];
		for (const k of kana) expect(isNoiseSign(k, 40)).toBe(false); // ASCII heuristic is blind here
		const skip = findFrameChurnEvents(eventsOf(churnLines(kana, 100)), isDialogue);
		expect(skip.size).toBe(5); // ...but the churn detector is not
	});

	it("does not flag constant-text frame animation (that is dedup's job)", () => {
		const skip = findFrameChurnEvents(eventsOf(churnLines(Array(6).fill("Rock"), 100)), isDialogue);
		expect(skip.size).toBe(0);
	});

	it("does not flag runs shorter than minRun", () => {
		const skip = findFrameChurnEvents(eventsOf(churnLines(GRAIN.slice(0, 4), 100)), isDialogue);
		expect(skip.size).toBe(0);
	});

	it("splits runs at temporal gaps larger than maxGapMs", () => {
		// Two runs of 3, ~880ms apart: each is below minRun once split.
		const lines = [...churnLines(GRAIN.slice(0, 3), 100), ...churnLines(GRAIN.slice(3, 6), 200)];
		const skip = findFrameChurnEvents(eventsOf(lines), isDialogue);
		expect(skip.size).toBe(0);
	});

	it("groups by style+name so interleaved effects are tracked separately", () => {
		// A 6-event Grain run with a second effect ("Static", 3 events) woven
		// into the same time range: Grain is flagged, the short run is not.
		const lines = [
			...churnLines(GRAIN, 100, 4, "Signs", "Grain"),
			...churnLines(["QwErTyUiOpAsDf", "ZxCvBnMqWeRtYu", "PlMkOiJnUhBygv"], 102, 4, "Signs", "Static"),
		];
		const skip = findFrameChurnEvents(eventsOf(lines), isDialogue);
		expect(skip.size).toBe(6);
	});

	it("ignores dialogue-styled events and events longer than maxEventMs", () => {
		const dlg = findFrameChurnEvents(eventsOf(churnLines(GRAIN, 100, 4, "Default")), isDialogue);
		expect(dlg.size).toBe(0);

		const long = findFrameChurnEvents(eventsOf(churnLines(GRAIN, 100, 300)), isDialogue); // 3s each
		expect(long.size).toBe(0);
	});
});

describe("translateAss noise filtering (integration)", () => {
	it("never sends churn/noise events to the model and preserves them verbatim", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there",
				"Dialogue: 0,0:00:05.00,0:00:08.00,Signs,,0,0,0,,{\\pos(2,2)}Magistone Ore",
				// Per-frame churn run: caught by findFrameChurnEvents (and isNoiseSign).
				...churnLines(GRAIN, 1000),
				// Isolated 3s noise overlay: no run to detect - only isNoiseSign catches it.
				// If either filter regresses, the multi-line \N text also breaks the
				// batch line count, so this fails loudly rather than silently.
				`Dialogue: 0,0:00:20.00,0:00:23.00,Signs,Grain,0,0,0,,{\\pos(3,3)}${GRAIN[0]}`,
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());

		// The model only ever saw the dialogue line and the real sign.
		expect(sent.sort()).toEqual(["Hello there", "Magistone Ore"]);

		// Translated lines landed; noise events survive byte-identical.
		expect(out).toContain(",Default,,0,0,0,,HELLO THERE");
		expect(out).toContain("{\\pos(2,2)}MAGISTONE ORE");
		for (const g of GRAIN) {
			expect(out).toContain(`{\\pos(675,259)}${g}`);
		}
		expect(out).toContain(`{\\pos(3,3)}${GRAIN[0]}`);
	});

	it("reports progress totals excluding filtered noise events", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello", ...churnLines(GRAIN, 1000)],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		let lastDone = -1;
		let lastTotal = -1;
		await translateSubtitleContent(
			ass,
			opts({
				onProgress: (done, total) => {
					lastDone = done;
					lastTotal = total;
				},
			}),
		);

		// 7 events collapse to a single translation unit (the dialogue line).
		expect(lastTotal).toBe(1);
		expect(lastDone).toBe(1);
	});
});
