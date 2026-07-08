import { splitAssText, type AssEventLine } from "./ass-edit";

export const LETTER_SIGN_TUNING = {
	/** Minimum deduped glyphs in a group before reconstruction is attempted. */
	minGlyphs: 3,
	/** Glyphs link into one component when closer than this x median NN distance. */
	linkFactor: 2.5,
	/** Chain aborts when (2nd-nearest / nearest) unvisited candidate < this. */
	ambiguityRatio: 1.3,
	/** A chain step > this x median step inserts a word space. */
	spaceFactor: 1.9,
	/** A chain step > this x median NN distance aborts (mis-merged component). */
	maxStepFactor: 3.25,
	/** Components whose mean y differs <= this x median NN share a baseline (join with " "). */
	sameLineFactor: 1.5,
	/** Max |delta| of \fscx / \fscy between glyphs of one sign. */
	scaleTolerance: 1.0,
};

export interface ReconstructedLetterSign {
	/** Reading-order text; words joined with " ", distinct baselines with "\N". */
	text: string;
	startMs: number;
	endMs: number;
	style: string;
	name: string;
	/** Every event line consumed: all glyphs, all layer copies, this frame-group. */
	memberLineNos: number[];
	/**
	 * Event that should carry the translated text (first glyph in reading
	 * order, crisp/non-\alpha layer copy). All other members get blanked.
	 * Equals lines[0].representativeLineNo.
	 */
	representativeLineNo: number;
	/**
	 * Synthesized override block for a whole-sign collapse (first baseline's
	 * lead). Prefer letterSignReplacementTexts, which places each translated
	 * \N segment at its own baseline. Equals lines[0].replacementLead.
	 */
	replacementLead: string;
	/**
	 * One entry per detected baseline, top to bottom - the segments the
	 * reconstructed text's "\N" breaks separate. Ring/arc typesetting keeps
	 * its geometry this way: each baseline anchors at ITS OWN bbox center
	 * (e.g. top of the ring and bottom of the ring), never at the whole
	 * sign's center, which for a ring is the (occupied) middle.
	 */
	lines: LetterSignLine[];
	/** Deduped glyph count (diagnostics/logging). */
	glyphCount: number;
}

export interface LetterSignLine {
	/** This baseline's reconstructed text (words joined with " "). */
	text: string;
	/** Crisp copy of this baseline's first reading-order glyph. */
	representativeLineNo: number;
	/** {\an5\pos(thisBaselineCenter)\frz(thisBaselineMean)...} */
	replacementLead: string;
	/** Deduped glyphs on this baseline (fallback picks the roomiest line). */
	glyphCount: number;
}

export interface LetterSignResult {
	signs: ReconstructedLetterSign[];
	/** lineNos of every event consumed by a successful reconstruction. */
	consumed: Set<number>;
}

const POS_RE = /\\pos\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/;
const FRZ_RE = /\\frz(-?\d+(?:\.\d+)?)/;
// \fr with no axis letter is an alias for \frz.
const FR_RE = /\\fr(?![xyz])(-?\d+(?:\.\d+)?)/;
const FSCX_RE = /\\fscx(\d+(?:\.\d+)?)/;
const FSCY_RE = /\\fscy(\d+(?:\.\d+)?)/;
// \c / \1c primary colour; anchored on &H so \clip(...) can never match.
const COLOUR_RE = /\\1?c(&H[0-9A-Fa-f]+&)/;
const ALPHA_RE = /\\(?:alpha|1a)&H/;
const BLUR_RE = /\\blur(\d+(?:\.\d+)?)/;
const FN_RE = /\\fn([^\\}]+)/;
// Per-glyph animation: karaoke-FX / motion typesetting, never a static sign.
const ANIM_RE = /\\(?:t\(|move\()/;

/** True when the visible text is exactly one character (code point). */
function isSingleChar(visible: string): boolean {
	const t = visible.trim();
	return [...t].length === 1;
}

/** Layer is the first field after "Dialogue:" in the preserved prefix. */
function parseLayer(prefix: string): number {
	const m = prefix.match(/^[^:]*:\s*(-?\d+)\s*,/);
	return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * Effect is the last field of the preserved prefix (the standard event format
 * puts it right before Text). Karaoke templates stamp it ("fx", "template",
 * "code", "karaoke"); anything non-empty means the event belongs to an effect
 * generator, not to static typesetting.
 */
function parseEffect(prefix: string): string {
	const fields = prefix.replace(/,$/, "").split(",");
	return (fields[fields.length - 1] ?? "").trim();
}

interface RawGlyph {
	lineNo: number;
	layer: number;
	ch: string;
	x: number;
	y: number;
	frz: number;
	fscx: number | null;
	fscy: number | null;
	colour: string | null;
	fn: string | null;
	hasAlpha: boolean;
	lead: string;
}

/** One visual glyph after collapsing its layer copies (glow + crisp). */
interface Glyph {
	ch: string;
	x: number;
	y: number;
	frz: number;
	fscx: number | null;
	fscy: number | null;
	colour: string | null;
	fn: string | null;
	lineNos: number[];
	/** The preferred (crisp) copy carries the translation on collapse. */
	canonicalLineNo: number;
	canonicalLead: string;
}

const dist = (a: Glyph, b: Glyph): number => Math.hypot(a.x - b.x, a.y - b.y);

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
};

/** Format a number for a synthesized tag: <=3 decimals, no trailing zeros. */
const tidy = (n: number): string => String(parseFloat(n.toFixed(3)));

/** Single-linkage components: glyphs closer than `maxLink` connect. */
function connectedComponents(glyphs: Glyph[], maxLink: number): Glyph[][] {
	const parent = glyphs.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
	for (let i = 0; i < glyphs.length; i++) {
		for (let j = i + 1; j < glyphs.length; j++) {
			if (dist(glyphs[i]!, glyphs[j]!) <= maxLink) {
				parent[find(i)] = find(j);
			}
		}
	}
	const byRoot = new Map<number, Glyph[]>();
	for (let i = 0; i < glyphs.length; i++) {
		const r = find(i);
		let arr = byRoot.get(r);
		if (!arr) byRoot.set(r, (arr = []));
		arr.push(glyphs[i]!);
	}
	return [...byRoot.values()];
}

/**
 * Order one component's glyphs into reading order via greedy nearest-neighbor
 * chaining from the leftmost glyph, and insert word spaces at outlier steps.
 * Returns null when the order is ambiguous or a step is implausibly large.
 */
function chainComponent(comp: Glyph[], medianNN: number, t = LETTER_SIGN_TUNING): { glyphs: Glyph[]; text: string } | null {
	if (comp.length === 1) return { glyphs: comp, text: comp[0]!.ch };

	// Left-to-right assumption: start at the leftmost glyph (tie: topmost).
	let start = comp[0]!;
	for (const g of comp) {
		if (g.x < start.x || (g.x === start.x && g.y < start.y)) start = g;
	}

	const ordered: Glyph[] = [start];
	const visited = new Set<Glyph>([start]);
	const steps: number[] = [];

	while (ordered.length < comp.length) {
		const cur = ordered[ordered.length - 1]!;
		let best: Glyph | null = null;
		let d1 = Infinity;
		let d2 = Infinity;
		for (const g of comp) {
			if (visited.has(g)) continue;
			const d = dist(cur, g);
			if (d < d1) {
				d2 = d1;
				d1 = d;
				best = g;
			} else if (d < d2) {
				d2 = d;
			}
		}
		// Two equally plausible next glyphs => the layout isn't a line of text.
		if (d2 < t.ambiguityRatio * d1) return null;
		// A step this large means the chain jumped across the layout (e.g. a
		// curve that doubles back, or a bad merge). Fail closed.
		if (d1 > t.maxStepFactor * medianNN * Math.max(1, t.spaceFactor)) return null;
		ordered.push(best!);
		visited.add(best!);
		steps.push(d1);
	}

	// Word spaces: steps clearly larger than the typical letter advance.
	// Needs >=3 steps for a meaningful median; short chains get no spaces.
	let text = ordered[0]!.ch;
	const medStep = steps.length >= 3 ? median(steps) : Infinity;
	for (let i = 0; i < steps.length; i++) {
		if (steps[i]! > t.spaceFactor * medStep) text += " ";
		text += ordered[i + 1]!.ch;
	}
	return { glyphs: ordered, text };
}

function reconstructGroup(
	raws: RawGlyph[],
	groupBad: boolean,
	meta: { startMs: number; endMs: number; style: string; name: string },
	t = LETTER_SIGN_TUNING,
): ReconstructedLetterSign | null {
	if (groupBad) return null;

	// Collapse layer copies: events drawing the same character at the same
	// position are one visual glyph (glow pass + crisp pass). The copy without
	// \alpha (or the highest layer) is canonical - it carries the translation.
	const stacks = new Map<string, RawGlyph[]>();
	for (const r of raws) {
		const key = `${r.ch}\u0000${r.x}\u0000${r.y}`;
		let arr = stacks.get(key);
		if (!arr) stacks.set(key, (arr = []));
		arr.push(r);
	}

	const glyphs: Glyph[] = [];
	for (const stack of stacks.values()) {
		let canon = stack[0]!;
		for (const r of stack) {
			if (r.hasAlpha !== canon.hasAlpha) {
				if (!r.hasAlpha) canon = r;
			} else if (r.layer > canon.layer) {
				canon = r;
			}
		}
		glyphs.push({
			ch: canon.ch,
			x: canon.x,
			y: canon.y,
			frz: canon.frz,
			fscx: canon.fscx,
			fscy: canon.fscy,
			colour: canon.colour,
			fn: canon.fn,
			lineNos: stack.map((r) => r.lineNo),
			canonicalLineNo: canon.lineNo,
			canonicalLead: canon.lead,
		});
	}

	if (glyphs.length < t.minGlyphs) return null;

	// A "word" whose glyphs are all one repeated character is a particle
	// effect (grain/dust/rain dingbat fonts draw specks as a letter), never
	// text. Collapsing it would render the literal letters on screen.
	if (new Set(glyphs.map((g) => g.ch)).size === 1) return null;

	// Tag coherence: glyphs of one sign share scale, colour, and font.
	// Disagreement means unrelated single-char signs that merely share timing.
	const nums = (sel: (g: Glyph) => number | null): boolean => {
		const vals = glyphs.map(sel);
		if (vals.some((v) => v === null) !== vals.every((v) => v === null)) return false; // mixed tagged/untagged
		const nn = vals.filter((v): v is number => v !== null);
		return nn.length === 0 || Math.max(...nn) - Math.min(...nn) <= t.scaleTolerance;
	};
	if (!nums((g) => g.fscx) || !nums((g) => g.fscy)) return null;
	if (new Set(glyphs.map((g) => g.colour ?? "")).size > 1) return null;
	if (new Set(glyphs.map((g) => g.fn ?? "")).size > 1) return null;

	// Spatial structure: nearest-neighbor scale, then components, then chains.
	const nn: number[] = [];
	for (const g of glyphs) {
		let m = Infinity;
		for (const h of glyphs) {
			if (h !== g) m = Math.min(m, dist(g, h));
		}
		nn.push(m);
	}
	const medianNN = median(nn);
	if (!(medianNN > 0)) return null; // overlapping glyphs - not a text line

	const comps = connectedComponents(glyphs, t.linkFactor * medianNN);

	interface Chained {
		text: string;
		glyphs: Glyph[];
		meanX: number;
		meanY: number;
	}
	const chained: Chained[] = [];
	for (const comp of comps) {
		const c = chainComponent(comp, medianNN, t);
		if (c === null) return null; // one ambiguous component poisons the group
		chained.push({
			text: c.text,
			glyphs: c.glyphs,
			meanX: comp.reduce((s, g) => s + g.x, 0) / comp.length,
			meanY: comp.reduce((s, g) => s + g.y, 0) / comp.length,
		});
	}

	// Assemble components: top-to-bottom, left-to-right. Components on the
	// same baseline are words (join " "); distinct baselines are lines ("\N").
	chained.sort((a, b) => a.meanY - b.meanY || a.meanX - b.meanX);
	const lines: Chained[][] = [];
	for (const c of chained) {
		const cur = lines[lines.length - 1];
		if (cur && Math.abs(c.meanY - cur[0]!.meanY) <= t.sameLineFactor * medianNN) cur.push(c);
		else lines.push([c]);
	}
	const text = lines
		.map((line) => {
			line.sort((a, b) => a.meanX - b.meanX);
			return line.map((c) => c.text).join(" ");
		})
		.join("\\N");

	// A sign must actually say something: at least two letters.
	if ((text.match(/\p{L}/gu)?.length ?? 0) < 2) return null;

	// One anchor PER BASELINE, not per sign: text arced around a circle or
	// split across the screen must land back where its letters were, never at
	// the whole-sign bbox center (for a ring that's the occupied middle).
	// Each baseline gets its own bbox center, mean rotation, and the tag
	// profile of its first glyph's crisp copy. \an5 makes \pos the true
	// center regardless of the style's default alignment.
	const buildLead = (lineGlyphs: Glyph[]): string => {
		let minX = Infinity,
			maxX = -Infinity,
			minY = Infinity,
			maxY = -Infinity,
			frzSum = 0;
		for (const g of lineGlyphs) {
			minX = Math.min(minX, g.x);
			maxX = Math.max(maxX, g.x);
			minY = Math.min(minY, g.y);
			maxY = Math.max(maxY, g.y);
			frzSum += g.frz;
		}
		const rep = lineGlyphs[0]!;
		const meanFrz = frzSum / lineGlyphs.length;

		let lead = `{\\an5\\pos(${tidy((minX + maxX) / 2)},${tidy((minY + maxY) / 2)})`;
		if (Math.abs(meanFrz) >= 0.001) lead += `\\frz${tidy(meanFrz)}`;
		if (rep.fscx !== null) lead += `\\fscx${tidy(rep.fscx)}`;
		if (rep.fscy !== null) lead += `\\fscy${tidy(rep.fscy)}`;
		if (rep.fn !== null) lead += `\\fn${rep.fn}`;
		if (rep.colour !== null) lead += `\\c${rep.colour}`;
		// The canonical copy is chosen to avoid \alpha (glow-pass marker), but
		// a sign whose every copy is translucent keeps its transparency.
		const alpha = rep.canonicalLead.match(/\\(?:alpha|1a)(&H[0-9A-Fa-f]+&?)/);
		if (alpha) lead += `\\alpha${alpha[1]}`;
		const blur = rep.canonicalLead.match(BLUR_RE);
		if (blur) lead += `\\blur${blur[1]}`;
		return lead + "}";
	};

	const signLines: LetterSignLine[] = lines.map((line) => {
		const lineGlyphs = line.flatMap((c) => c.glyphs); // reading order
		return {
			text: line.map((c) => c.text).join(" "),
			representativeLineNo: lineGlyphs[0]!.canonicalLineNo,
			replacementLead: buildLead(lineGlyphs),
			glyphCount: lineGlyphs.length,
		};
	});

	const memberLineNos = glyphs.flatMap((g) => g.lineNos).sort((a, b) => a - b);

	return {
		text,
		startMs: meta.startMs,
		endMs: meta.endMs,
		style: meta.style,
		name: meta.name,
		memberLineNos,
		representativeLineNo: signLines[0]!.representativeLineNo,
		replacementLead: signLines[0]!.replacementLead,
		lines: signLines,
		glyphCount: glyphs.length,
	};
}

/**
 * Detect per-letter typeset signs among non-dialogue events and reconstruct
 * their text. Events of successful groups are reported in `consumed` so the
 * caller can skip them in its normal per-event loop; each sign should then be
 * fed to translation as ONE unit keyed by `representativeLineNo`.
 *
 * Failed groups consume nothing - their events flow through the existing
 * pipeline untouched (and land in the isSingleCharSign verbatim skip).
 */
export function reconstructLetterSigns(events: AssEventLine[], isDialogue: (style: string) => boolean, tuning = LETTER_SIGN_TUNING): LetterSignResult {
	interface Group {
		raws: RawGlyph[];
		bad: boolean;
		meta: { startMs: number; endMs: number; style: string; name: string };
	}
	const groups = new Map<string, Group>();

	for (const ev of events) {
		if (isDialogue(ev.style)) continue;
		// Karaoke-template output ("fx"/"template"/"code"/...) belongs to an
		// effect generator; its glyphs are never static-typeset letters.
		if (parseEffect(ev.prefix) !== "") continue;
		const parts = splitAssText(ev.rawText);
		if (!parts.translatable) continue; // drawings/tag-only never join or block a group

		const key = `${ev.startMs}\u0000${ev.endMs}\u0000${ev.style}\u0000${ev.name}`;
		let g = groups.get(key);
		if (!g) {
			groups.set(key, (g = { raws: [], bad: false, meta: { startMs: ev.startMs, endMs: ev.endMs, style: ev.style, name: ev.name } }));
		}

		// A multi-char sibling means the sign is NOT purely per-letter; a glyph
		// we can't place means the word would come out with letters missing.
		// Either way the whole group must stay verbatim.
		if (!isSingleChar(parts.visible)) {
			g.bad = true;
			continue;
		}
		const pos = parts.lead.match(POS_RE);
		if (!pos) {
			g.bad = true;
			continue;
		}
		// Animated glyphs (\t transforms, \move) are karaoke-FX or motion
		// typesetting: the anchor doesn't describe a static reading line, and
		// collapsing would freeze the effect. Poison the whole group.
		if (ANIM_RE.test(parts.lead)) {
			g.bad = true;
			continue;
		}

		const frz = parts.lead.match(FRZ_RE) ?? parts.lead.match(FR_RE);
		g.raws.push({
			lineNo: ev.lineNo,
			layer: parseLayer(ev.prefix),
			ch: parts.visible.trim(),
			x: parseFloat(pos[1]!),
			y: parseFloat(pos[2]!),
			frz: frz ? parseFloat(frz[1]!) : 0,
			fscx: parts.lead.match(FSCX_RE) ? parseFloat(parts.lead.match(FSCX_RE)![1]!) : null,
			fscy: parts.lead.match(FSCY_RE) ? parseFloat(parts.lead.match(FSCY_RE)![1]!) : null,
			colour: parts.lead.match(COLOUR_RE)?.[1] ?? null,
			fn: parts.lead.match(FN_RE)?.[1]?.trim() ?? null,
			hasAlpha: ALPHA_RE.test(parts.lead),
			lead: parts.lead,
		});
	}

	const signs: ReconstructedLetterSign[] = [];
	const consumed = new Set<number>();
	for (const g of groups.values()) {
		const sign = reconstructGroup(g.raws, g.bad, g.meta, tuning);
		if (!sign) continue;
		signs.push(sign);
		for (const n of sign.memberLineNos) consumed.add(n);
	}
	signs.sort((a, b) => a.startMs - b.startMs || a.representativeLineNo - b.representativeLineNo);
	return { signs, consumed };
}

/**
 * Tier-1 collapse rendering: the Text replacements for one reconstructed sign
 * once its translation is known.
 *
 * The translation's "\N" segments map 1:1 onto the sign's baselines: segment i
 * renders at baseline i's own anchor, so ring/arc typesetting keeps its
 * geometry ("Pain" over the top of the ring, "nullification" under the
 * bottom - and their translations land in the same two places, never in the
 * ring's occupied middle). Every non-carrying member event is blanked (an
 * empty Text field renders nothing, so timing/structure stay untouched).
 *
 * When the translation's break count doesn't match the baseline count (the
 * model merged or added "\N"), the whole translated string falls back to the
 * baseline with the most glyphs - the one with the most room - rather than a
 * synthetic center.
 */
export function letterSignReplacementTexts(sign: ReconstructedLetterSign, translated: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const lineNo of sign.memberLineNos) out.set(lineNo, "");

	const segments = translated.split(/\\N/i).map((s) => s.trim());
	if (segments.length === sign.lines.length && segments.every((s) => s !== "")) {
		for (let i = 0; i < sign.lines.length; i++) {
			const line = sign.lines[i]!;
			out.set(line.representativeLineNo, line.replacementLead + segments[i]!);
		}
	} else {
		let roomiest = sign.lines[0]!;
		for (const line of sign.lines) {
			if (line.glyphCount > roomiest.glyphCount) roomiest = line;
		}
		out.set(roomiest.representativeLineNo, roomiest.replacementLead + translated);
	}
	return out;
}
