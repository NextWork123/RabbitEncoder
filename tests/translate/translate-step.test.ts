import { describe, expect, it } from "bun:test";
import { computeTranslatedFlagArgs, resolveOutputFormat, buildKeptDescriptors } from "../../src/translate/translate-step";
import type { SubtitleStreamInfo } from "../../src/core/types";

describe("translate-step helpers", () => {
	it("marks a translated track default for its new language", () => {
		const full = computeTranslatedFlagArgs("full");
		expect(full).toContain("--default-track-flag");
		expect(full[full.indexOf("--default-track-flag") + 1]).toBe("0:1");
		expect(full[full.indexOf("--forced-display-flag") + 1]).toBe("0:0");

		const hon = computeTranslatedFlagArgs("honorifics");
		expect(hon[hon.indexOf("--default-track-flag") + 1]).toBe("0:1");
	});

	it("keeps ASS as ASS and honors convertSrtToAss for SRT", () => {
		expect(resolveOutputFormat("ass", false)).toBe("ass");
		expect(resolveOutputFormat("ssa", false)).toBe("ass");
		expect(resolveOutputFormat("subrip", false)).toBe("srt");
		expect(resolveOutputFormat("subrip", true)).toBe("ass");
	});

	it("applies the honorifics language convention when building descriptors", () => {
		const streams: SubtitleStreamInfo[] = [
			{ index: 0, codec: "ass", language: "eng" },
			{ index: 1, codec: "ass", language: "eng" },
		];
		const desc = buildKeptDescriptors(streams, (s) => (s.index === 1 ? "honorifics" : "full"));
		expect(desc[0]).toEqual({ index: 0, codec: "ass", language: "eng", trackType: "full" });
		expect(desc[1]!.language).toBe("en-JP");
		expect(desc[1]!.trackType).toBe("honorifics");
	});
});
