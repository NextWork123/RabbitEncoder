import { describe, expect, it } from "bun:test";
import { detectScript, extractDialogueText } from "../src/script-detect";

describe("detectScript", () => {
	it("identifies Latin / Cyrillic / Greek", () => {
		expect(detectScript("Hello world")).toBe("latin");
		expect(detectScript("Привет мир")).toBe("cyrillic");
		expect(detectScript("Γειά σου κόσμε")).toBe("greek");
	});

	it("identifies RTL scripts", () => {
		expect(detectScript("مرحبا بالعالم")).toBe("arabic");
		expect(detectScript("שלום עולם")).toBe("hebrew");
	});

	it("disambiguates CJK by kana / hangul / han", () => {
		expect(detectScript("こんにちは")).toBe("japanese");
		expect(detectScript("안녕하세요")).toBe("korean");
		expect(detectScript("你好世界")).toBe("chinese");
	});

	it("prefers Japanese when kana coexists with kanji", () => {
		// Kanji alone reads as Chinese, but any kana present means Japanese.
		expect(detectScript("日本語のテスト")).toBe("japanese");
	});

	it("picks the dominant script in mixed Latin-majority text", () => {
		expect(detectScript("Mostly english with a few слова")).toBe("latin");
	});
});

describe("extractDialogueText", () => {
	it("strips override tags and \\N from ASS dialogue, dropping the first 9 fields", () => {
		const line = "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello {\\i1}world{\\i0}\\Nbye";
		expect(extractDialogueText(line)).toBe("Hello world bye");
	});

	it("ignores ASS headers and metadata lines", () => {
		expect(extractDialogueText("PlayResX: 1920")).toBe("");
		expect(extractDialogueText("Format: Layer, Start, End")).toBe("");
		expect(extractDialogueText("Style: Default,Arial,40")).toBe("");
	});

	it("ignores SRT index numbers and timestamp lines", () => {
		expect(extractDialogueText("42")).toBe("");
		expect(extractDialogueText("00:00:01,000 --> 00:00:03,000")).toBe("");
	});

	it("passes plain SRT body text through", () => {
		expect(extractDialogueText("Just some text")).toBe("Just some text");
	});

	it("joins multiple dialogue lines with spaces", () => {
		const text = ["Dialogue: 0,0,0,Default,,0,0,0,,First", "Dialogue: 0,0,0,Default,,0,0,0,,Second"].join("\n");
		expect(extractDialogueText(text)).toBe("First Second");
	});
});
