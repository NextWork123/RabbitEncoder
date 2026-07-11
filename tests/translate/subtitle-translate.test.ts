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

describe("planTargetLanguages — forced source", () => {
	const track = (index: number, language: string, trackType: string, codec = "ass"): KeptSubDescriptor => ({ index, language, trackType, codec });

	it("honors a forced source track over auto selection", () => {
		const tracks = [track(0, "eng", "full"), track(1, "jpn", "full")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 1 });
		expect(plan.productions[0]!.sourceIndex).toBe(1);
	});

	it("falls back to auto when the forced index does not exist", () => {
		const tracks = [track(0, "eng", "full")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 9 });
		expect(plan.productions[0]!.sourceIndex).toBe(0);
		expect(plan.skipped.some((s) => s.includes("not found"))).toBe(true);
	});

	it("falls back to auto when the forced track is image-based", () => {
		const tracks = [track(0, "eng", "full"), track(1, "eng", "full", "hdmv_pgs_subtitle")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 1 });
		expect(plan.productions[0]!.sourceIndex).toBe(0);
		expect(plan.skipped.some((s) => s.includes("not text-based"))).toBe(true);
	});

	it("produces a full track when forcing a non-dialogue source", () => {
		const tracks = [track(0, "eng", "sdh")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 0 });
		expect(plan.productions[0]!.trackType).toBe("full");
	});

	it("still skips the forced source's own language as a target", () => {
		const tracks = [track(0, "eng", "full"), track(1, "deu", "full")];
		const plan = planTargetLanguages(tracks, ["deu", "slv"], { forceSourceIndex: 1 });
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
	});
});
