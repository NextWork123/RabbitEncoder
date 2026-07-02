/**
 * Lossless ASS event editing for translation.
 *
 * The classifier's parser (ass-classifier.ts) intentionally discards
 * everything except style + text, which is fine for classification but useless
 * for rebuilding. This module keeps each `Dialogue:` line's exact prefix
 * (layer, timing, style, actor, margins, effect) so the translator can swap
 * only the Text field and reassemble the file byte-for-byte everywhere else.
 *
 * Tag handling follows the agreed rule: preserve a leading override block and
 * literal "\N" breaks; drop mid-text override tags on translated lines. Drawing
 * lines (\p1 ...) and tag-only/empty lines are marked non-translatable so we
 * never feed vector coordinates to the model.
 */

export interface AssEventLine {
	/** Index into the file's line array (from split on \r?\n). */
	lineNo: number;
	/** Style name for this event. */
	style: string;
	/** Start time in ms. */
	startMs: number;
	/** End time in ms. */
	endMs: number;
	/** The Text field, verbatim. */
	rawText: string;
	/**
	 * Everything on the line up to and including the comma before Text
	 * (e.g. "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,"). Concatenated
	 * with a (possibly new) text to rebuild the line.
	 */
	prefix: string;
}

export interface ParsedAssEvents {
	events: AssEventLine[];
	/** Total number of lines the file split into (sanity for rebuild). */
	lineCount: number;
}

const NUM = (v: string | undefined, d: number): number => {
	const n = parseFloat(v ?? "");
	return Number.isFinite(n) ? n : d;
};

/** Parse an ASS timecode "H:MM:SS.cc" (centiseconds) to milliseconds. */
export function assTimeToMs(tc: string): number {
	const m = tc.trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/);
	if (!m) return 0;
	const cs = m[4]!.padEnd(2, "0").slice(0, 2); // normalize to centiseconds
	return parseInt(m[1]!, 10) * 3_600_000 + parseInt(m[2]!, 10) * 60_000 + parseInt(m[3]!, 10) * 1_000 + parseInt(cs, 10) * 10;
}

/**
 * Parse every `Dialogue:` event, preserving line prefixes. `Comment:` events
 * are ignored (not rendered, never translated).
 */
export function parseAssEvents(assText: string): ParsedAssEvents {
	const lines = assText.split(/\r?\n/);
	const events: AssEventLine[] = [];

	let section = "";
	let eventKeys: string[] = [];
	let idxStart = -1;
	let idxEnd = -1;
	let idxStyle = -1;
	let idxText = -1;

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const raw = lines[lineNo]!;
		const line = raw.trim();
		if (!line) continue;

		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1).trim().toLowerCase();
			continue;
		}
		if (section !== "events") continue;

		const lower = line.toLowerCase();

		if (lower.startsWith("format:")) {
			eventKeys = line
				.substring(line.indexOf(":") + 1)
				.split(",")
				.map((k) => k.trim().toLowerCase());
			idxStart = eventKeys.indexOf("start");
			idxEnd = eventKeys.indexOf("end");
			idxStyle = eventKeys.indexOf("style");
			idxText = eventKeys.indexOf("text");
			continue;
		}

		if (!lower.startsWith("dialogue:")) continue;
		if (eventKeys.length === 0 || idxText < 0) continue;

		// Split into exactly eventKeys.length fields; Text (last) keeps commas.
		const afterPrefix = raw.substring(raw.indexOf(":") + 1);
		const fields: string[] = [];
		let remaining = afterPrefix;
		for (let i = 0; i < eventKeys.length - 1; i++) {
			const comma = remaining.indexOf(",");
			if (comma < 0) {
				fields.push(remaining);
				remaining = "";
				break;
			}
			fields.push(remaining.slice(0, comma));
			remaining = remaining.slice(comma + 1);
		}
		fields.push(remaining);
		if (fields.length < eventKeys.length) continue;

		// Reconstruct the prefix: the "Dialogue:" keyword plus every field up to
		// (but not including) Text, with commas - verbatim from the source.
		const keyword = raw.slice(0, raw.indexOf(":") + 1); // preserves original casing/spacing
		const prefixFields = fields.slice(0, idxText);
		const prefix = keyword + prefixFields.join(",") + ",";
		const rawText = fields.slice(idxText).join(","); // Text may itself contain commas

		events.push({
			lineNo,
			style: (fields[idxStyle] ?? "").trim(),
			startMs: assTimeToMs(fields[idxStart] ?? ""),
			endMs: assTimeToMs(fields[idxEnd] ?? ""),
			rawText,
			prefix,
		});
	}

	return { events, lineCount: lines.length };
}

const LEADING_TAGS_RE = /^(?:\{[^}]*\})+/;
const ALL_TAGS_RE = /\{[^}]*\}/g;
const DRAWING_RE = /\\p[1-9]/i; // \p1.. enters drawing mode

export interface AssTextParts {
	/** Leading override block(s) to re-prepend after translation, or "". */
	lead: string;
	/** Visible text with mid-text tags stripped; literal "\N" breaks kept. */
	visible: string;
	/** False for drawings, tag-only, or empty lines - leave such lines as-is. */
	translatable: boolean;
}

/**
 * Split an ASS Text field into a leading tag block + translatable visible text.
 * Mid-text override tags are removed (they're dropped on translated lines, per
 * spec). Drawing lines and lines with no visible characters are flagged
 * non-translatable.
 */
export function splitAssText(rawText: string): AssTextParts {
	if (DRAWING_RE.test(rawText)) return { lead: "", visible: "", translatable: false };

	const leadMatch = rawText.match(LEADING_TAGS_RE);
	const lead = leadMatch ? leadMatch[0] : "";
	const rest = rawText.slice(lead.length);
	const visible = rest.replace(ALL_TAGS_RE, "");

	// Nothing to translate if only whitespace / "\N" breaks remain.
	const stripped = visible.replace(/\\N/gi, "").trim();
	if (stripped.length === 0) return { lead, visible, translatable: false };

	return { lead, visible, translatable: true };
}

/** Recombine a preserved lead block with translated visible text. */
export function joinAssText(lead: string, translatedVisible: string): string {
	return lead + translatedVisible;
}

/**
 * Rebuild the ASS document, replacing the Text of the given events (keyed by
 * their `lineNo`) and leaving every other byte untouched. Line endings are
 * normalized to "\n" (matching how the pipeline already re-materializes ASS).
 */
export function buildTranslatedAss(assText: string, newTextByLineNo: Map<number, string>, events: AssEventLine[]): string {
	const lines = assText.split(/\r?\n/);
	const prefixByLineNo = new Map<number, string>();
	for (const ev of events) prefixByLineNo.set(ev.lineNo, ev.prefix);

	for (const [lineNo, newText] of newTextByLineNo) {
		const prefix = prefixByLineNo.get(lineNo);
		if (prefix === undefined) continue;
		lines[lineNo] = prefix + newText;
	}
	return lines.join("\n");
}
