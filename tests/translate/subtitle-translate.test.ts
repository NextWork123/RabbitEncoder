import { describe, expect, it, afterEach } from "bun:test";
import { planTargetLanguages, type KeptSubDescriptor } from "../../src/translate/subtitle-translate";

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
