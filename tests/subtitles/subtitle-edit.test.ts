import { describe, expect, it } from "bun:test";
import { parseSrt, buildSrt } from "../../src/subtitles/srt-edit";
import { parseAssEvents, splitAssText, joinAssText, buildTranslatedAss, assTimeToMs } from "../../src/subtitles/ass-edit";
import { resolveTranslateLang, isTranslatable } from "../../src/translate/translate-languages";

describe("srt-edit", () => {
	const SRT = ["1", "00:00:01,000 --> 00:00:03,500", "Hello world", "", "2", "00:00:04,000 --> 00:00:06,000", "Two", "lines", ""].join("\n");

	it("parses cues with timing in ms and multi-line text", () => {
		const cues = parseSrt(SRT);
		expect(cues.length).toBe(2);
		expect(cues[0]!.startMs).toBe(1000);
		expect(cues[0]!.endMs).toBe(3500);
		expect(cues[1]!.text).toBe("Two\nlines");
	});

	it("round-trips through build with renumbering", () => {
		const cues = parseSrt(SRT);
		const rebuilt = buildSrt(cues);
		const reparsed = parseSrt(rebuilt);
		expect(reparsed.map((c) => c.text)).toEqual(["Hello world", "Two\nlines"]);
		expect(reparsed[0]!.timingLine).toBe("00:00:01,000 --> 00:00:03,500");
	});

	it("tolerates a missing index line", () => {
		const noIdx = "00:00:01,000 --> 00:00:02,000\nHi\n";
		const cues = parseSrt(noIdx);
		expect(cues.length).toBe(1);
		expect(cues[0]!.text).toBe("Hi");
	});
});

describe("ass-edit timing", () => {
	it("parses centisecond ASS timecodes", () => {
		expect(assTimeToMs("0:00:01.50")).toBe(1500);
		expect(assTimeToMs("1:02:03.04")).toBe(3_723_040);
	});
});

const ASS = [
	"[Script Info]",
	"ScriptType: v4.00+",
	"PlayResX: 1920",
	"PlayResY: 1080",
	"",
	"[V4+ Styles]",
	"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
	"Style: Default,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,60,1",
	"Style: Sign,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,10,10,10,1",
	"",
	"[Events]",
	"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello, world",
	"Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,ignore me",
	"Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,{\\i1}A quote{\\i0} said {\\b1}Bob{\\b0}",
	"Dialogue: 0,0:00:08.00,0:00:10.00,Sign,,0,0,0,,{\\pos(500,300)}SHOP",
	"Dialogue: 0,0:00:11.00,0:00:12.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 0 10 10 0 10{\\p0}",
	"",
].join("\n");

describe("ass-edit", () => {
	it("parses only Dialogue events (skips Comment) with commas preserved in Text", () => {
		const { events } = parseAssEvents(ASS);
		expect(events.length).toBe(4);
		expect(events[0]!.rawText).toBe("Hello, world");
		expect(events[0]!.startMs).toBe(1000);
		expect(events[0]!.style).toBe("Default");
	});

	it("splits leading tags, strips mid-text tags, keeps drawings out", () => {
		const quote = splitAssText("{\\i1}A quote{\\i0} said {\\b1}Bob{\\b0}");
		expect(quote.lead).toBe("{\\i1}");
		expect(quote.visible).toBe("A quote said Bob");
		expect(quote.translatable).toBe(true);

		const sign = splitAssText("{\\pos(500,300)}SHOP");
		expect(sign.lead).toBe("{\\pos(500,300)}");
		expect(sign.visible).toBe("SHOP");

		const drawing = splitAssText("{\\p1}m 0 0 l 10 0{\\p0}");
		expect(drawing.translatable).toBe(false);

		const empty = splitAssText("{\\pos(1,1)}\\N");
		expect(empty.translatable).toBe(false);
	});

	it("rebuilds swapping only translated Text, leaving all else byte-identical", () => {
		const { events } = parseAssEvents(ASS);
		const edits = new Map<number, string>();
		for (const ev of events) {
			const parts = splitAssText(ev.rawText);
			if (!parts.translatable) continue;
			// Fake "translation": uppercase, reattach lead, drop mid tags.
			edits.set(ev.lineNo, joinAssText(parts.lead, parts.visible.toUpperCase()));
		}
		const out = buildTranslatedAss(ASS, edits, events);

		expect(out).toContain("Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,HELLO, WORLD");
		expect(out).toContain("Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,{\\i1}A QUOTE SAID BOB");
		expect(out).toContain("Dialogue: 0,0:00:08.00,0:00:10.00,Sign,,0,0,0,,{\\pos(500,300)}SHOP");
		// Untouched lines survive verbatim:
		expect(out).toContain("Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,ignore me");
		expect(out).toContain("Style: Default,Arial,60");
		expect(out).toContain("PlayResX: 1920");
		// Drawing line untouched:
		expect(out).toContain("{\\p1}m 0 0 l 10 0 10 10 0 10{\\p0}");
	});
});

describe("translate-languages", () => {
	it("resolves ISO-639-2 tags the MKV side uses", () => {
		expect(resolveTranslateLang("eng")).toEqual({ name: "English", code: "en" });
		expect(resolveTranslateLang("deu")!.code).toBe("de");
		expect(resolveTranslateLang("ger")!.code).toBe("de"); // bibliographic
		expect(resolveTranslateLang("fre")!.code).toBe("fr");
		expect(resolveTranslateLang("slv")).toEqual({ name: "Slovenian", code: "sl" });
	});

	it("treats the honorifics pseudo-tag en-JP as English", () => {
		expect(resolveTranslateLang("en-JP")!.code).toBe("en");
	});

	it("disambiguates Chinese script", () => {
		expect(resolveTranslateLang("zh-Hant")!.code).toBe("zh-Hant");
		expect(resolveTranslateLang("zh-TW")!.code).toBe("zh-TW");
		expect(resolveTranslateLang("zho")!.code).toBe("zh-Hans");
	});

	it("returns null for unsupported languages", () => {
		expect(resolveTranslateLang("tlh")).toBeNull(); // Klingon
		expect(isTranslatable("xyz")).toBe(false);
		expect(isTranslatable("slv")).toBe(true);
	});
});
