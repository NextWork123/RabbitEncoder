/**
 * The production sample this feature was designed against: the words
 * "Pain nullification" typeset one event per character along a curve, style
 * "Hurts", actor "Text", each glyph duplicated on two layers (layer 0 = glow
 * pass with \alpha&H80&\blur1, layer 1 = crisp pass with \blur0.6) and the
 * whole set re-emitted for a second frame window.
 *
 * Glyph anchors and rotations are the exact values from the source file; the
 * lines are regenerated from this table so the fixture stays reviewable.
 */

export interface SampleGlyph {
	ch: string;
	x: number;
	y: number;
	frz: number;
	/** Aegisub extradata reference emitted before the override block ({=NNN}). */
	extra: number;
}

export const SAMPLE_GLYPHS: SampleGlyph[] = [
	// "Pain" - upper baseline
	{ ch: "P", x: 917.232, y: 295.339, frz: 10.125, extra: 119 },
	{ ch: "a", x: 947.527, y: 292.6, frz: 1.332, extra: 120 },
	{ ch: "i", x: 969.502, y: 292.089, frz: 1.332, extra: 120 },
	{ ch: "n", x: 991.728, y: 294.787, frz: -8.616, extra: 120 },
	// "nullification" - lower curved baseline
	{ ch: "n", x: 828.158, y: 753.079, frz: -26.565, extra: 125 },
	{ ch: "u", x: 857.096, y: 765.898, frz: -23.199, extra: 126 },
	{ ch: "l", x: 877.713, y: 772.49, frz: -15.945, extra: 126 },
	{ ch: "l", x: 888.96, y: 775.703, frz: -15.945, extra: 126 },
	{ ch: "i", x: 901.073, y: 778.605, frz: -13.241, extra: 126 },
	{ ch: "f", x: 916.875, y: 782.323, frz: -13.241, extra: 126 },
	{ ch: "i", x: 932.769, y: 785.594, frz: -10.305, extra: 126 },
	{ ch: "c", x: 952.599, y: 787.61, frz: -3.576, extra: 126 },
	{ ch: "a", x: 980.938, y: 786.406, frz: 10.62, extra: 126 },
	{ ch: "t", x: 1006.223, y: 784.708, frz: 10.62, extra: 126 },
	{ ch: "i", x: 1022.33, y: 780.106, frz: 17.526, extra: 126 },
	{ ch: "o", x: 1042.826, y: 773.634, frz: 17.526, extra: 126 },
	{ ch: "n", x: 1071.194, y: 761.922, frz: 23.199, extra: 126 },
];

export const SAMPLE_FRAME_WINDOWS: Array<[string, string]> = [
	["0:12:52.45", "0:12:52.50"],
	["0:12:52.54", "0:12:52.58"],
];

/** All 68 Dialogue lines of the sample, byte-identical to the source file. */
export function sampleEvents(): string[] {
	const lines: string[] = [];
	for (const [start, end] of SAMPLE_FRAME_WINDOWS) {
		for (const g of SAMPLE_GLYPHS) {
			const base = `{=${g.extra}}{\\pos(${g.x},${g.y})\\fscx76\\fscy73\\frz${g.frz}\\c&H0E0913&`;
			lines.push(`Dialogue: 0,${start},${end},Hurts,Text,0,0,0,,${base}\\alpha&H80&\\blur1}${g.ch}`);
			lines.push(`Dialogue: 1,${start},${end},Hurts,Text,0,0,0,,${base}\\blur0.6}${g.ch}`);
		}
	}
	return lines;
}

export const HURTS_STYLE_LINE = "Style: Hurts,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1";
