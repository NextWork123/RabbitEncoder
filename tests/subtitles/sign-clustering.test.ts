import { describe, expect, it, afterEach } from "bun:test";
import {
	scrambleDistance,
	clusterSignEvents,
	translateSubtitleContent,
	type SignEventInput,
	type TranslateContentOptions,
} from "../../src/translate/subtitle-translate";
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

/** Replace the character at index `i`. */
function sub(s: string, i: number, ch: string): string {
	return s.slice(0, i) + ch + s.slice(i + 1);
}

/** Format centiseconds as an ASS timecode (H:MM:SS.CC). */
function cs(t: number): string {
	const c = t % 100;
	const s = Math.floor(t / 100) % 60;
	const m = Math.floor(t / 6000) % 60;
	const h = Math.floor(t / 360000);
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

const GROUP = "General Title\u0000";

function sev(lineNo: number, startMs: number, endMs: number, visible: string, group = GROUP): SignEventInput {
	return { lineNo, startMs, endMs, visible, group };
}

// The real typewriter sign from a production release (mid-text \alpha reveal;
// splitAssText strips the mid tag, so the model-facing text is the full
// sentence with one scrambled letter per frame).
const BASE = "A valuable herb that only grows \\Nin areas rich in magicules,\\Nused in healing potions.";

describe("scrambleDistance", () => {
	const S = "A valuable herb";

	it("counts letter-for-letter substitutions", () => {
		expect(scrambleDistance(S, S, 2)).toBe(0);
		expect(scrambleDistance(sub(S, 2, "j"), S, 2)).toBe(1); // "A jaluable herb"
		expect(scrambleDistance(sub(sub(S, 2, "j"), 4, "x"), S, 2)).toBe(2); // "A jaxuable herb"
	});

	it("returns null beyond max (early exit, order-independent)", () => {
		const three = sub(sub(sub(S, 2, "j"), 4, "x"), 6, "o"); // "A jaxuoble herb"
		expect(scrambleDistance(three, S, 2)).toBeNull();
		expect(scrambleDistance(sub(sub(S, 2, "j"), 4, "x"), S, 1)).toBeNull();
	});

	it("returns null for length differences — insertions are content changes", () => {
		// The stray-brace variant from the wild: "Ability }Established".
		expect(scrambleDistance("Ability Established", "Ability }Established", 2)).toBeNull();
	});

	it("returns null when a digit or punctuation position differs", () => {
		expect(scrambleDistance("Floor 1", "Floor 2", 2)).toBeNull();
		expect(scrambleDistance("A valuable herb.", "A valuable herb,", 2)).toBeNull(); // punct vs punct
		expect(scrambleDistance("A valuable herbs", "A valuable herb.", 2)).toBeNull(); // letter vs punct
	});

	it("fails closed for non-ASCII letters", () => {
		expect(scrambleDistance("café", "cafe", 2)).toBeNull();
	});

	it("treats case flips as substitutions", () => {
		expect(scrambleDistance("Herb", "herb", 2)).toBe(1);
	});

	it("requires \\N break positions to align exactly", () => {
		expect(scrambleDistance("up\\Ndown", "up\\Ndawn", 2)).toBe(1); // letter sub after the break
		expect(scrambleDistance("u\\Np", "uN\\p", 2)).toBeNull(); // backslash vs letter
	});
});

describe("clusterSignEvents", () => {
	it("merges a typewriter run (incl. a duplicated frame) with its hold; the hold wins as representative", () => {
		const evs = [
			sev(1, 0, 40, sub(BASE, 0, "D")), // "D valuable herb..."
			sev(2, 50, 90, sub(BASE, 2, "j")), // "A jaluable herb..."
			sev(3, 90, 130, sub(BASE, 2, "j")), // held frame — exact duplicate
			sev(4, 140, 180, sub(BASE, 4, "h")), // "A vahuable herb..."
			sev(5, 200, 3200, BASE), // the 3s hold with the correct text
		];
		const clusters = clusterSignEvents(evs);
		expect(clusters.length).toBe(1);
		expect(clusters[0]!.representative.lineNo).toBe(5);
		expect(clusters[0]!.representative.visible).toBe(BASE);
		expect(clusters[0]!.members.length).toBe(5);
	});

	it("breaks ties for the representative toward the latest event (scrambles converge on correct text)", () => {
		const clusters = clusterSignEvents([sev(1, 0, 1000, sub(BASE, 2, "j")), sev(2, 1100, 2100, BASE)]);
		expect(clusters.length).toBe(1);
		expect(clusters[0]!.representative.lineNo).toBe(2);
	});

	it("merges exact repeats regardless of time distance (preserves old dedup semantics)", () => {
		const clusters = clusterSignEvents([sev(1, 0, 3000, BASE), sev(2, 600_000, 603_000, BASE)]);
		expect(clusters.length).toBe(1);
	});

	it("only fuzzy-merges within windowMs", () => {
		const clusters = clusterSignEvents([sev(1, 0, 3000, BASE), sev(2, 10_000, 13_000, sub(BASE, 2, "j"))]);
		expect(clusters.length).toBe(2); // 7s gap > 5s window
	});

	it("never merges across digit differences", () => {
		const clusters = clusterSignEvents([sev(1, 0, 1000, "Floor 1"), sev(2, 1100, 2100, "Floor 2")]);
		expect(clusters.length).toBe(2);
	});

	it("never merges across groups (style+name)", () => {
		const clusters = clusterSignEvents([sev(1, 0, 1000, BASE, "Signs\u0000A"), sev(2, 1100, 2100, BASE, "Signs\u0000B")]);
		expect(clusters.length).toBe(2);
	});

	it("keeps unrelated sign texts apart", () => {
		const clusters = clusterSignEvents([sev(1, 0, 1000, "Magistone Ore"), sev(2, 1100, 2100, "Unique Skill\\NPredator")]);
		expect(clusters.length).toBe(2);
	});
});

describe("translateAss scramble clustering (integration)", () => {
	it("translates a typewriter sign once from its hold; every frame inherits the translation with its own lead", async () => {
		const frames = [sub(BASE, 0, "D"), sub(BASE, 2, "j"), sub(BASE, 2, "j"), sub(BASE, 4, "h")];
		const frameLines = frames.map((t, i) => `Dialogue: 1,${cs(1000 + i * 4)},${cs(1000 + (i + 1) * 4)},Signs,,0,0,0,,{\\pos(${i},${i})}${t}`);
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there",
				...frameLines,
				`Dialogue: 1,${cs(1016)},${cs(1316)},Signs,,0,0,0,,{\\pos(9,9)}${BASE}`, // 3s hold
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());

		// The model saw the CORRECT sentence exactly once — never a typo variant.
		expect(sent.sort()).toEqual([BASE, "Hello there"]);

		// Every frame carries the shared translation with its own lead.
		const T = BASE.toUpperCase();
		for (let i = 0; i < frames.length; i++) {
			expect(out).toContain(`{\\pos(${i},${i})}${T}`);
		}
		expect(out).toContain(`{\\pos(9,9)}${T}`);
		expect(out).toContain(",Default,,0,0,0,,HELLO THERE");

		// No scrambled leftovers in either language.
		expect(out).not.toContain("jaluable");
		expect(out).not.toContain("JALUABLE");
		expect(out).not.toContain("D valuable");
	});

	it("clustering does not shadow churn: hold-less kana flicker is still skipped verbatim", async () => {
		const kana = ["あかさたなはまやらわ", "いきしちにひみりゐん", "うくすつぬふむゆるぼ", "えけせてねへめれゑぞ", "おこそとのほもよろを"];
		const flicker = kana.map((t, i) => `Dialogue: 1,${cs(1000 + i * 4)},${cs(1000 + (i + 1) * 4)},Signs,Grain,0,0,0,,{\\pos(675,259)}${t}`);
		const ass = buildAss({
			styles: STYLES,
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there", ...flicker],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());

		expect(sent).toEqual(["Hello there"]);
		for (const k of kana) {
			expect(out).toContain(`{\\pos(675,259)}${k}`);
		}
	});

	it("a short but legit lone sign (below READABLE_MS, no churn run) is still translated", async () => {
		const ass = buildAss({
			styles: STYLES,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there",
				"Dialogue: 1,0:00:05.00,0:00:05.30,Signs,,0,0,0,,{\\pos(5,5)}Magistone Ore", // 300ms stamp
			],
		});

		const sent: string[] = [];
		mockTranslate(sent);

		const out = await translateSubtitleContent(ass, opts());

		expect(sent.sort()).toEqual(["Hello there", "Magistone Ore"]);
		expect(out).toContain("{\\pos(5,5)}MAGISTONE ORE");
	});
});
