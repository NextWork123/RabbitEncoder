/**
 * Minimal, lossless SRT reader/writer for translation. Parses cues into
 * `{ index, startMs, endMs, timingLine, text }`, letting the translator swap
 * only the text while every cue's numbering and timing line is preserved
 * verbatim on rebuild.
 *
 * Timing is exposed as milliseconds so the pause-aware chunker can find the
 * largest gap between consecutive cues.
 */

export interface SrtCue {
	/** 1-based cue number as written (kept for rebuild). */
	index: string;
	/** Verbatim timing line, e.g. "00:00:01,000 --> 00:00:03,000". */
	timingLine: string;
	/** Start time in ms (parsed from timingLine). */
	startMs: number;
	/** End time in ms (parsed from timingLine). */
	endMs: number;
	/** Visible text, internal line breaks preserved as "\n". */
	text: string;
}

const TIMING_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function tcToMs(h: string, m: string, s: string, ms: string): number {
	return parseInt(h, 10) * 3_600_000 + parseInt(m, 10) * 60_000 + parseInt(s, 10) * 1_000 + parseInt(ms.padEnd(3, "0"), 10);
}

/** Parse SRT text into cues. Non-conforming trailing blocks are skipped. */
export function parseSrt(srt: string): SrtCue[] {
	const text = srt.replace(/^\uFEFF/, "");
	// Blocks are separated by one or more blank lines.
	const blocks = text.split(/\r?\n\r?\n+/);
	const cues: SrtCue[] = [];

	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		// Trim leading and trailing blank lines within the block.
		while (lines.length && lines[0]!.trim() === "") lines.shift();
		while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
		if (lines.length === 0) continue;

		let idx = 0;
		let indexLabel = "";
		// An index line is optional but usual; detect it by "not a timing line".
		if (!TIMING_RE.test(lines[0]!) && lines[1] && TIMING_RE.test(lines[1]!)) {
			indexLabel = lines[0]!.trim();
			idx = 1;
		}

		const timingLine = lines[idx];
		if (!timingLine) continue;
		const m = timingLine.match(TIMING_RE);
		if (!m) continue;

		const startMs = tcToMs(m[1]!, m[2]!, m[3]!, m[4]!);
		const endMs = tcToMs(m[5]!, m[6]!, m[7]!, m[8]!);
		const body = lines.slice(idx + 1).join("\n");

		cues.push({
			index: indexLabel || String(cues.length + 1),
			timingLine: timingLine.trim(),
			startMs,
			endMs,
			text: body,
		});
	}

	return cues;
}

/**
 * Rebuild an SRT document from cues. Cue numbering is renumbered 1..N so the
 * output is always well-formed even if the source omitted or skipped numbers.
 */
export function buildSrt(cues: SrtCue[]): string {
	const out: string[] = [];
	cues.forEach((cue, i) => {
		out.push(String(i + 1));
		out.push(cue.timingLine);
		out.push(cue.text);
		out.push("");
	});
	return out.join("\n");
}
