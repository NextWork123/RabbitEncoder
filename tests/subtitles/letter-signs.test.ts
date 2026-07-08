import { describe, expect, it } from "bun:test";
import { parseAssEvents } from "../../src/subtitles/ass-edit";
import { reconstructLetterSigns, letterSignReplacementTexts } from "../../src/subtitles/letter-signs";
import { buildAss, DEFAULT_STYLE_LINE, SIGN_STYLE_LINE } from "../fixtures/ass";
import { sampleEvents, SAMPLE_GLYPHS, HURTS_STYLE_LINE } from "../fixtures/letter-sign-sample";

const isDialogue = (s: string) => s === "Default";

/** Build an ASS doc, parse it, reconstruct, and return everything. */
function run(events: string[], styles = [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE, HURTS_STYLE_LINE]) {
	const ass = buildAss({ styles, events });
	const parsed = parseAssEvents(ass);
	return { ass, events: parsed.events, ...reconstructLetterSigns(parsed.events, isDialogue) };
}

/** Shorthand for a single-char sign event. */
function letter(ch: string, x: number, y: number, over = "", timing = "0:00:01.00,0:00:02.00", style = "Signs", name = ""): string {
	return `Dialogue: 0,${timing},${style},${name},0,0,0,,{\\pos(${x},${y})${over}}${ch}`;
}

describe("reconstructLetterSigns on the production sample", () => {
	it('reconstructs "Pain\\Nnullification" once per frame-group', () => {
		const { signs, consumed, events } = run(sampleEvents());

		expect(signs.length).toBe(2);
		for (const s of signs) {
			expect(s.text).toBe("Pain\\Nnullification");
			expect(s.glyphCount).toBe(17);
			expect(s.memberLineNos.length).toBe(34); // 17 glyphs x 2 layers
			expect(s.style).toBe("Hurts");
			expect(s.name).toBe("Text");
		}

		// Every one of the 68 sample events is consumed - nothing leaks through
		// to the verbatim single-char skip.
		expect(consumed.size).toBe(events.length);
		for (const ev of events) expect(consumed.has(ev.lineNo)).toBe(true);

		// The two frame-groups keep their own timing (52.45-52.50, 52.54-52.58).
		expect(signs[0]!.startMs).toBe(772_450);
		expect(signs[0]!.endMs).toBe(772_500);
		expect(signs[1]!.startMs).toBe(772_540);
		expect(signs[1]!.endMs).toBe(772_580);

		// Identical text per frame-group is exactly what lets the existing
		// clusterSignEvents exact-repeat merge translate this once.
		expect(signs[0]!.text).toBe(signs[1]!.text);
	});

	it("elects the crisp (non-\\alpha) copy of the first reading-order glyph as representative", () => {
		const { signs, events } = run(sampleEvents());
		const rep = events.find((e) => e.lineNo === signs[0]!.representativeLineNo)!;

		// Reading order is top line first, so the representative draws "P"...
		expect(rep.rawText.endsWith("}P")).toBe(true);
		// ...from the crisp layer-1 pass, not the glow pass.
		expect(rep.prefix.startsWith("Dialogue: 1,")).toBe(true);
		expect(rep.rawText).not.toContain("\\alpha");
	});

	it("anchors each baseline at ITS OWN bbox center - never at the ring's occupied middle", () => {
		const { signs } = run(sampleEvents());
		const sign = signs[0]!;
		expect(sign.lines.length).toBe(2);

		const pain = SAMPLE_GLYPHS.slice(0, 4);
		const nullif = SAMPLE_GLYPHS.slice(4);
		const center = (gs: typeof SAMPLE_GLYPHS) => [
			(Math.min(...gs.map((g) => g.x)) + Math.max(...gs.map((g) => g.x))) / 2,
			(Math.min(...gs.map((g) => g.y)) + Math.max(...gs.map((g) => g.y))) / 2,
		];
		const meanFrz = (gs: typeof SAMPLE_GLYPHS) => gs.reduce((s, g) => s + g.frz, 0) / gs.length;

		for (const [i, glyphs] of [pain, nullif].entries()) {
			const lead = sign.lines[i]!.replacementLead;
			expect(lead.startsWith("{\\an5\\pos(")).toBe(true);
			const pos = lead.match(/\\pos\((-?[\d.]+),(-?[\d.]+)\)/)!;
			const [cx, cy] = center(glyphs);
			expect(parseFloat(pos[1]!)).toBeCloseTo(cx!, 2);
			expect(parseFloat(pos[2]!)).toBeCloseTo(cy!, 2);
			const frz = lead.match(/\\frz(-?[\d.]+)/)!;
			expect(parseFloat(frz[1]!)).toBeCloseTo(meanFrz(glyphs), 2);
			// Scale, colour, and the crisp pass's blur are inherited; the glow
			// pass's \alpha is not.
			expect(lead).toContain("\\fscx76");
			expect(lead).toContain("\\fscy73");
			expect(lead).toContain("\\c&H0E0913&");
			expect(lead).toContain("\\blur0.6");
			expect(lead).not.toContain("\\alpha");
		}

		// The two baseline anchors stay ~480px apart - the sign's own bbox
		// center (the middle of the ring, where the kanji sits) is never used.
		const y0 = parseFloat(sign.lines[0]!.replacementLead.match(/\\pos\(-?[\d.]+,(-?[\d.]+)\)/)![1]!);
		const y1 = parseFloat(sign.lines[1]!.replacementLead.match(/\\pos\(-?[\d.]+,(-?[\d.]+)\)/)![1]!);
		expect(y1 - y0).toBeGreaterThan(400);
		expect(sign.lines[0]!.text).toBe("Pain");
		expect(sign.lines[1]!.text).toBe("nullification");
	});

	it("letterSignReplacementTexts places each translated \\N segment at its own baseline and blanks the rest", () => {
		const { signs, events } = run(sampleEvents());
		const sign = signs[0]!;
		const texts = letterSignReplacementTexts(sign, "Izničenje\\Nbolečine");

		expect(texts.size).toBe(34);
		expect(texts.get(sign.lines[0]!.representativeLineNo)).toBe(sign.lines[0]!.replacementLead + "Izničenje");
		expect(texts.get(sign.lines[1]!.representativeLineNo)).toBe(sign.lines[1]!.replacementLead + "bolečine");
		const carriers = new Set([sign.lines[0]!.representativeLineNo, sign.lines[1]!.representativeLineNo]);
		for (const [lineNo, text] of texts) {
			if (!carriers.has(lineNo)) expect(text).toBe("");
		}

		// The lower segment's carrier is the crisp copy of the lower arc's
		// first glyph ("n" of nullification), so it keeps that arc's timing row.
		const lower = events.find((e) => e.lineNo === sign.lines[1]!.representativeLineNo)!;
		expect(lower.rawText.endsWith("}n")).toBe(true);
		expect(lower.rawText).not.toContain("\\alpha");
	});

	it("letterSignReplacementTexts falls back to the roomiest baseline when \\N counts mismatch", () => {
		const { signs } = run(sampleEvents());
		const sign = signs[0]!;
		const texts = letterSignReplacementTexts(sign, "Izničenje bolečine"); // no \N: 1 segment, 2 baselines

		// "nullification" (13 glyphs) has more room than "Pain" (4).
		const roomiest = sign.lines[1]!;
		expect(texts.get(roomiest.representativeLineNo)).toBe(roomiest.replacementLead + "Izničenje bolečine");
		expect(texts.get(sign.lines[0]!.representativeLineNo)).toBe("");
	});
});

describe("reading order, spaces, and lines (synthetic)", () => {
	it("inserts a word space at a clear advance gap on one baseline", () => {
		// "BIG SALE": normal advances 25-30px, the space gap is 60px.
		const glyphs: Array<[string, number]> = [
			["B", 100],
			["I", 130],
			["G", 155],
			["S", 215],
			["A", 245],
			["L", 275],
			["E", 300],
		];
		const { signs } = run(glyphs.map(([ch, x]) => letter(ch, x, 100)));

		expect(signs.length).toBe(1);
		expect(signs[0]!.text).toBe("BIG SALE");
	});

	it("joins far-apart words on one baseline with a space and distinct baselines with \\N", () => {
		const { signs } = run([
			// "NO WAY" - same y, gap far beyond the component link radius
			letter("N", 100, 100),
			letter("O", 125, 100),
			letter("W", 400, 100),
			letter("A", 425, 100),
			letter("Y", 450, 100),
			// "OK" on a clearly separate baseline
			letter("O", 100, 400),
			letter("K", 125, 400),
		]);

		expect(signs.length).toBe(1);
		expect(signs[0]!.text).toBe("NO WAY\\NOK");
	});

	it("orders a right-leaning curved arc correctly (regression: frz variance is irrelevant to ordering)", () => {
		const { signs } = run(sampleEvents().slice(0, 34)); // first frame-group only
		expect(signs[0]!.text.split("\\N")[1]).toBe("nullification");
	});
});

describe("fail-closed guards", () => {
	it("aborts on ambiguous grid layouts (no letters consumed)", () => {
		const { signs, consumed } = run([letter("A", 0, 0), letter("B", 30, 0), letter("C", 0, 30), letter("D", 30, 30)]);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("aborts below the minimum glyph count", () => {
		const { signs, consumed } = run([letter("N", 100, 100), letter("O", 125, 100)]);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("aborts when glyphs disagree on scale (unrelated signs sharing timing)", () => {
		const { signs } = run([letter("A", 100, 100, "\\fscx76"), letter("B", 125, 100, "\\fscx76"), letter("C", 150, 100, "\\fscx50")]);
		expect(signs.length).toBe(0);
	});

	it("aborts when glyphs disagree on colour", () => {
		const { signs } = run([letter("A", 100, 100, "\\c&H0000FF&"), letter("B", 125, 100, "\\c&H0000FF&"), letter("C", 150, 100, "\\c&H00FF00&")]);
		expect(signs.length).toBe(0);
	});

	it("a multi-char sibling with the same timing/style/name poisons the whole group", () => {
		const { signs, consumed } = run([letter("A", 100, 100), letter("B", 125, 100), letter("C", 150, 100), letter("OK", 300, 100)]);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("a glyph without \\pos poisons the whole group (a letter would go missing)", () => {
		const { signs, consumed } = run([letter("A", 100, 100), letter("B", 125, 100), "Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\frz10}C"]);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("requires at least two letters (punctuation clusters stay verbatim)", () => {
		const { signs } = run([letter(".", 100, 100), letter(".", 125, 100), letter(".", 150, 100)]);
		expect(signs.length).toBe(0);
	});

	it("never touches dialogue-styled events", () => {
		const { signs, consumed } = run([
			letter("H", 100, 100, "", "0:00:01.00,0:00:02.00", "Default"),
			letter("I", 125, 100, "", "0:00:01.00,0:00:02.00", "Default"),
			letter("!", 150, 100, "", "0:00:01.00,0:00:02.00", "Default"),
		]);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("splits groups by name/actor - two typesets sharing timing don't merge", () => {
		const a = ["W", "H", "Y"].map((ch, i) => letter(ch, 100 + i * 25, 100, "", "0:00:01.00,0:00:02.00", "Signs", "SignA"));
		const b = ["N", "O", "W"].map((ch, i) => letter(ch, 100 + i * 25, 400, "", "0:00:01.00,0:00:02.00", "Signs", "SignB"));
		const { signs } = run([...a, ...b]);
		expect(signs.map((s) => s.text).sort()).toEqual(["NOW", "WHY"]);
	});

	it("regression: \\fnGrain particle effects (same char repeated) stay verbatim, not 'pppp'", () => {
		// Real shape from a production episode: dust specks drawn as the letter
		// "p" in a dingbat font, one event per speck.
		const specks = [
			[451.533, 338.067],
			[447.111, 310.222],
			[495.111, 334.222],
			[490.689, 306.377],
		].map(([x, y]) => `Dialogue: 2,0:03:31.64,0:03:31.73,Hurts,Grain,0,0,0,,{\\pos(${x},${y})\\fscx53\\fscy28\\fnGrain\\c&H230A04&\\alpha&H20&\\blur1.5}p`);
		const { signs, consumed } = run(specks);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("regression: karaoke-template events (Effect=fx) are never candidates", () => {
		const kfx = ["t", "s", "u"].map(
			(ch, i) => `Dialogue: 0,0:22:33.57,0:22:33.72,OP-R2,,0,0,0,fx,{\\an5\\pos(${1200 + i * 30},75)\\bord0\\blur12\\t(0,60,\\alpha&HAF&\\blur0)}${ch}`,
		);
		const { signs, consumed } = run(kfx);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("regression: a \\t-animated glyph poisons its group even without an Effect field", () => {
		const { signs, consumed } = run([letter("A", 100, 100), letter("B", 125, 100), letter("C", 150, 100, "\\t(0,60,\\alpha&HAF&)")]);
		expect(signs.length).toBe(0);
		expect(consumed.size).toBe(0);
	});

	it("regression: glyphs disagreeing on \\fn abort; a shared inline \\fn is inherited by the collapse lead", () => {
		const mixed = run([letter("A", 100, 100, "\\fnGandhi Sans"), letter("B", 125, 100, "\\fnGandhi Sans"), letter("C", 150, 100, "\\fnGrain")]);
		expect(mixed.signs.length).toBe(0);

		const shared = run([letter("A", 100, 100, "\\fnGandhi Sans"), letter("B", 125, 100, "\\fnGandhi Sans"), letter("C", 150, 100, "\\fnGandhi Sans")]);
		expect(shared.signs.length).toBe(1);
		expect(shared.signs[0]!.replacementLead).toContain("\\fnGandhi Sans");
	});

	it("regression: a uniformly translucent sign keeps its \\alpha in the collapse lead", () => {
		const { signs } = run([letter("L", 100, 100, "\\alpha&H20&"), letter("O", 125, 100, "\\alpha&H20&"), letter("W", 150, 100, "\\alpha&H20&")]);
		expect(signs.length).toBe(1);
		expect(signs[0]!.replacementLead).toContain("\\alpha&H20&");
	});

	it("drawings sharing the group's timing neither join nor poison it (backing boxes stay verbatim)", () => {
		const box = "Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\pos(100,100)\\p1}m 0 0 l 200 0 200 50 0 50{\\p0}";
		const { signs, consumed, events } = run([box, letter("A", 100, 100), letter("B", 125, 100), letter("C", 150, 100)]);
		expect(signs.length).toBe(1);
		expect(signs[0]!.text).toBe("ABC");
		const boxEv = events.find((e) => e.rawText.includes("\\p1"))!;
		expect(consumed.has(boxEv.lineNo)).toBe(false);
	});
});
