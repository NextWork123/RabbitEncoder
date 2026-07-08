import { describe, expect, it } from "bun:test";
import { planChunks } from "../../src/translate/subtitle-translate";

describe("planChunks", () => {
	it("returns a single chunk when count <= batchSize", () => {
		const starts = [0, 1000, 2000];
		const ends = [900, 1900, 2900];
		expect(planChunks(starts, ends, 40)).toEqual([[0, 3]]);
	});

	it("returns empty for no lines", () => {
		expect(planChunks([], [], 40)).toEqual([]);
	});

	it("splits at the largest pause within the ±20% window (spec example)", () => {
		// 100 evenly-spaced lines, 1s each, 100ms gaps - except one big 5s gap
		// placed at boundary b=44 (inside the window [32,48] for batchSize 40).
		const n = 100;
		const starts: number[] = [];
		const ends: number[] = [];
		let t = 0;
		for (let i = 0; i < n; i++) {
			starts.push(t);
			ends.push(t + 1000);
			// gap before the NEXT line
			const gap = i === 43 ? 5000 : 100; // big pause opens before line 44
			t = t + 1000 + gap;
		}
		const chunks = planChunks(starts, ends, 40);
		// First boundary should snap to 44 (the big pause), not the nominal 40.
		expect(chunks[0]).toEqual([0, 44]);
	});

	it("falls back to the nominal boundary when gaps are uniform", () => {
		const n = 90;
		const starts: number[] = [];
		const ends: number[] = [];
		let t = 0;
		for (let i = 0; i < n; i++) {
			starts.push(t);
			ends.push(t + 1000);
			t += 1100; // uniform 100ms gaps
		}
		const chunks = planChunks(starts, ends, 40);
		// All candidate gaps equal -> first max wins at lo = 40 - 8 = 32.
		expect(chunks[0]).toEqual([0, 32]);
	});

	it("covers the full range contiguously with no gaps or overlaps", () => {
		const n = 137;
		const starts = Array.from({ length: n }, (_, i) => i * 1000);
		const ends = starts.map((s) => s + 800);
		const chunks = planChunks(starts, ends, 40);
		expect(chunks[0]![0]).toBe(0);
		expect(chunks[chunks.length - 1]![1]).toBe(n);
		for (let k = 1; k < chunks.length; k++) {
			expect(chunks[k]![0]).toBe(chunks[k - 1]![1]);
		}
	});

	it("handles window=0 (tiny batch sizes) by cutting at the nominal boundary", () => {
		const n = 10;
		const starts = Array.from({ length: n }, (_, i) => i * 1000);
		const ends = starts.map((s) => s + 500);
		// batchSize 3 -> window = round(0.6) = 1, so this still searches; use 2 -> round(0.4)=0
		const chunks = planChunks(starts, ends, 2);
		expect(chunks[0]).toEqual([0, 2]);
		expect(chunks).toEqual([
			[0, 2],
			[2, 4],
			[4, 6],
			[6, 8],
			[8, 10],
		]);
	});
});
