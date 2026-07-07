import { describe, expect, it } from "bun:test";
import { classifyAssLines, dialogueStyleNames, extractUsedFonts, normalizeFontName } from "../../src/subtitles/ass-classifier";
import { buildAss, DEFAULT_STYLE_LINE, SIGN_STYLE_LINE } from "../fixtures/ass";

const OP_STYLE_LINE = "Style: OP,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,8,40,40,40,1";
const UNUSED_STYLE_LINE = "Style: Unused,Wingdings,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,5,40,40,40,1";

// A file with a dialogue style (Default), a sign style (Signs), a song style
// (OP), and an unreferenced style (Unused), plus an inline \fn override.
const mixed = buildAss({
	styles: [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE, OP_STYLE_LINE, UNUSED_STYLE_LINE],
	events: [
		"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello world",
		"Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,{\\fnTimes New Roman}A quote",
		"Dialogue: 0,0:00:05.00,0:00:07.00,Signs,,0,0,0,,{\\pos(100,100)}Billboard",
		"Dialogue: 0,0:00:07.00,0:00:09.00,OP,,0,0,0,,{\\k50}la {\\k30}la",
		"Dialogue: 0,0:00:09.00,0:00:11.00,Default,,0,0,0,,{\\k20}sing along",
	],
});

describe("normalizeFontName", () => {
	it("trims, lowercases, and strips a leading @ (vertical-font marker)", () => {
		expect(normalizeFontName("  @Arial  ")).toBe("arial");
		expect(normalizeFontName("Noto Sans")).toBe("noto sans");
	});
});

describe("classifyAssLines", () => {
	it("classifies each event by its style kind", () => {
		const kinds = classifyAssLines(mixed).map((l) => l.kind);
		// Default→dialogue, Default→dialogue, Signs→sign, OP→song, and the last
		// Default line is upgraded to song by its inline \k karaoke tag.
		expect(kinds).toEqual(["dialogue", "dialogue", "sign", "song", "song"]);
	});

	it("upgrades any line carrying karaoke tags to song regardless of style", () => {
		const out = classifyAssLines(
			buildAss({
				styles: [DEFAULT_STYLE_LINE],
				events: ["Dialogue: 0,0,0,Default,,0,0,0,,{\\k40}normally dialogue"],
			}),
		);
		expect(out[0]!.kind).toBe("song");
	});
});

describe("dialogueStyleNames", () => {
	it("returns only dialogue-classified styles (signs/songs/unused excluded)", () => {
		expect([...dialogueStyleNames(mixed)].sort()).toEqual(["Default"]);
	});

	it("includes a differently-named style that is structurally identical to the baseline", () => {
		const ass = buildAss({
			styles: [
				DEFAULT_STYLE_LINE,
				// Same font/size/margins as Default, top-aligned — structurally dialogue.
				"Style: TopText,Arial,40,&H00FFFFFF,&H000000FF,&H00FF0000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,8,40,40,40,1",
			],
			events: ["Dialogue: 0,0,0,Default,,0,0,0,,hi", "Dialogue: 0,0,0,TopText,,0,0,0,,up there"],
		});
		expect([...dialogueStyleNames(ass)].sort()).toEqual(["Default", "TopText"]);
	});
});

describe("extractUsedFonts", () => {
	it("collects fonts from referenced styles plus inline \\fn overrides, normalized", () => {
		// arial (Default + OP), comic sans ms (Signs), times new roman (inline \fn).
		// Wingdings (Unused style, no events) is excluded.
		expect([...extractUsedFonts(mixed)].sort()).toEqual(["arial", "comic sans ms", "times new roman"]);
	});
});
