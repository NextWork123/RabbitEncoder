import { Logger } from "./logger";
import { parseAssEvents, splitAssText, joinAssText, buildTranslatedAss, type AssEventLine } from "./ass-edit";
import { parseSrt, buildSrt } from "./srt-edit";
import { translateBatch, type OllamaOptions } from "./ollama";
import { resolveTranslateLang, normalizeTag, type TranslateLang } from "./translate-languages";
import { translateBatchGeneric, type TranslateItem } from "./ollama-generic";
import { createSemaphore, type Semaphore } from "./concurrency";

/**
 * Split a timed line sequence into translation chunks of roughly `batchSize`,
 * nudging each boundary to the largest pause nearby so a chunk never cuts
 * mid-conversation.
 *
 * Algorithm (matches the agreed spec): window = round(batchSize * 0.2). At each
 * nominal boundary `n = i + batchSize`, consider split points b in
 * [n - window, n + window] and pick the one with the largest gap between the
 * previous line's end and the next line's start. The final short chunk takes
 * the remainder with no search.
 *
 * Returns half-open [start, end) index ranges covering [0, count).
 */
export function planChunks(startsMs: number[], endsMs: number[], batchSize: number): Array<[number, number]> {
	const n = startsMs.length;
	const chunks: Array<[number, number]> = [];
	if (n === 0) return chunks;

	const size = Math.max(1, Math.floor(batchSize));
	const window = Math.round(size * 0.2);

	let i = 0;
	while (i < n) {
		const nominalEnd = i + size; // exclusive
		if (nominalEnd >= n) {
			chunks.push([i, n]);
			break;
		}
		if (window <= 0) {
			chunks.push([i, nominalEnd]);
			i = nominalEnd;
			continue;
		}

		const lo = Math.max(i + 1, nominalEnd - window);
		const hi = Math.min(n, nominalEnd + window); // b may equal n (split at end)

		let bestB = nominalEnd;
		let bestGap = Number.NEGATIVE_INFINITY;
		for (let b = lo; b <= hi; b++) {
			if (b <= i) continue;
			// Gap that would be "opened" by cutting before line b.
			const gap = b >= n ? Number.POSITIVE_INFINITY : startsMs[b]! - endsMs[b - 1]!;
			if (gap > bestGap) {
				bestGap = gap;
				bestB = b;
			}
		}
		chunks.push([i, bestB]);
		i = bestB;
	}

	return chunks;
}

export interface TranslateContentOptions {
	format: "ass" | "srt";
	batchSize: number;
	/** Shared Ollama-request budget. If omitted, chunks run sequentially (limit 1). */
	sem?: Semaphore;
	/** When false, only dialogue-classified ASS lines are translated. */
	translateSignsSongs: boolean;
	strategy: "translategemma" | "generic";
	/**
	 * ASS-only: predicate telling whether a style name is dialogue. Required when
	 * `translateSignsSongs` is false; ignored for SRT. Supply via ass-classifier's
	 * `dialogueStyleNames` in production.
	 */
	isDialogueStyle?: (style: string) => boolean;
	ollama: OllamaOptions;
	/** Reports cumulative translated-line progress. */
	onProgress?: (done: number, total: number) => void;
}

interface Unit {
	/** For ASS: event line number. For SRT: cue index. */
	key: number;
	startMs: number;
	endMs: number;
	/** Text handed to the model. */
	visible: string;
	/** ASS leading override block to re-prepend, or "". */
	lead: string;
	/** Speaking character (ASS Name/Actor), passed to generic models as context. */
	name?: string;
}

/**
 * Translate the contents of one subtitle file (ASS or SRT), returning the new
 * file contents. Structure, timing, styling, and non-translated lines are
 * preserved; only visible dialogue (and, if enabled, signs/songs) is replaced.
 */
export async function translateSubtitleContent(content: string, opts: TranslateContentOptions): Promise<string> {
	if (opts.format === "ass") return translateAss(content, opts);
	return translateSrt(content, opts);
}

async function translateUnits(units: Unit[], opts: TranslateContentOptions): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	if (units.length === 0) return out;

	const starts = units.map((u) => u.startMs);
	const ends = units.map((u) => u.endMs);
	const chunks = planChunks(starts, ends, opts.batchSize);

	const total = units.length;
	let done = 0;
	opts.onProgress?.(0, total);

	const sem = opts.sem ?? createSemaphore(1);

	await Promise.all(
		chunks.map(async ([lo, hi]) => {
			const slice = units.slice(lo, hi);
			const translated = await sem.run(() =>
				opts.strategy === "generic"
					? translateBatchGeneric(
							slice.map<TranslateItem>((u) => ({ text: u.visible, name: u.name })),
							opts.ollama,
						)
					: translateBatch(
							slice.map((u) => u.visible),
							opts.ollama,
						),
			);
			for (let k = 0; k < slice.length; k++) {
				out.set(slice[k]!.key, translated[k]!);
			}
			done += slice.length; // safe: runs synchronously between awaits
			opts.onProgress?.(done, total);
		}),
	);

	return out;
}

async function translateAss(content: string, opts: TranslateContentOptions): Promise<string> {
	const { events } = parseAssEvents(content);

	const dialogueOnly = !opts.translateSignsSongs;
	const isDialogue = opts.isDialogueStyle ?? (() => true);

	const units: Unit[] = [];
	for (const ev of events) {
		if (dialogueOnly && !isDialogue(ev.style)) continue;
		const parts = splitAssText(ev.rawText);
		if (!parts.translatable) continue;
		units.push({ key: ev.lineNo, startMs: ev.startMs, endMs: ev.endMs, visible: parts.visible, lead: parts.lead, name: ev.name || undefined });
	}

	if (units.length === 0) {
		Logger.info("[translate] ASS source has no translatable lines; emitting a copy");
		return content;
	}

	const leadByKey = new Map<number, string>();
	for (const u of units) leadByKey.set(u.key, u.lead);

	const translatedVisible = await translateUnits(units, opts);

	const newTextByLineNo = new Map<number, string>();
	for (const [key, visible] of translatedVisible) {
		newTextByLineNo.set(key, joinAssText(leadByKey.get(key) ?? "", visible));
	}

	return buildTranslatedAss(content, newTextByLineNo, events as AssEventLine[]);
}

async function translateSrt(content: string, opts: TranslateContentOptions): Promise<string> {
	const cues = parseSrt(content);

	const units: Unit[] = [];
	cues.forEach((cue, i) => {
		// Flatten internal breaks so each cue is a single batch line; players
		// re-wrap. (ASS preserves layout; SRT trades wrapping for reliable
		// batch alignment.)
		const visible = cue.text.replace(/\r?\n/g, " ").trim();
		if (visible === "") return;
		units.push({ key: i, startMs: cue.startMs, endMs: cue.endMs, visible, lead: "" });
	});

	if (units.length === 0) return content;

	const translated = await translateUnits(units, opts);
	for (const [i, text] of translated) {
		cues[i]!.text = text;
	}

	return buildSrt(cues);
}

// Target-language planning

export interface KeptSubDescriptor {
	index: number;
	codec: string;
	/** Effective language tag (honorifics already mapped to its base, e.g. "en-JP"). */
	language: string;
	/** full | honorifics | forced | sdh | commentary | storyboard */
	trackType: string;
}

export interface TranslationProduction {
	/** Source track to translate from. */
	sourceIndex: number;
	sourceCodec: string;
	source: TranslateLang;
	/** Output MKV language tag (as requested by the user, normalized). */
	targetTag: string;
	target: TranslateLang;
	/** Mirror the source's dialogue role. */
	trackType: "full" | "honorifics";
}

export interface TranslationPlan {
	productions: TranslationProduction[];
	/** Human-readable reasons for anything skipped (for logging). */
	skipped: string[];
}

const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "subviewer", "microdvd"]);

/** Canonical language key for "does a full track in this language already exist". */
function langKey(tag: string | undefined, resolve: (t: string | undefined) => TranslateLang | null): string {
	const t = resolve(tag);
	if (t) return t.code;
	return normalizeTag(tag).split(/[-_]/)[0] || "und";
}

/**
 * Decide which target languages to produce and from which source track.
 *
 * Rules:
 *  - Source = the first text-based `full` or `honorifics` track.
 *  - A target language is skipped if a `full` or `honorifics` track already
 *    exists for it (either counts), or if it equals the source language.
 *  - Untranslatable languages (outside the model's set) are skipped with a note.
 *  - The produced track mirrors the source role (honorifics source -> honorifics
 *    output; otherwise full).
 */
export function planTargetLanguages(
	tracks: KeptSubDescriptor[],
	targetTags: string[],
	strategy: "translategemma" | "generic" = "translategemma",
): TranslationPlan {
	const skipped: string[] = [];
	const productions: TranslationProduction[] = [];

	const resolve: (t: string | undefined) => TranslateLang | null = resolveTranslateLang;

	// Languages already covered by a dialogue-bearing full/honorifics track.
	const existing = new Set<string>();

	for (const track of tracks) {
		if (track.trackType === "full" || track.trackType === "honorifics") {
			existing.add(langKey(track.language, resolve));
		}
	}

	// Select the first eligible dialogue-bearing text track.
	const source = tracks.find((track) => (track.trackType === "full" || track.trackType === "honorifics") && TEXT_CODECS.has(track.codec.toLowerCase()));

	if (!source) {
		skipped.push("no text-based full or honorifics subtitle track available to translate from");
		return { productions, skipped };
	}

	const sourceLang = resolve(source.language);

	if (!sourceLang) {
		skipped.push(`source track language "${source.language}" could not be resolved to a translatable language`);
		return { productions, skipped };
	}

	const sourceKey = langKey(source.language, resolve);
	const seen = new Set<string>();

	for (const rawTag of targetTags) {
		const tag = rawTag.trim();
		if (!tag) continue;

		const target = resolve(tag);

		if (!target) {
			skipped.push(`${tag}: not a language the ${strategy === "generic" ? "resolver recognizes" : "model supports"}`);
			continue;
		}

		const key = target.code;

		if (key === sourceKey) continue;

		if (existing.has(key)) {
			skipped.push(`${tag}: a full/honorifics track already exists`);
			continue;
		}

		if (seen.has(key)) continue;
		seen.add(key);

		productions.push({
			sourceIndex: source.index,
			sourceCodec: source.codec,
			source: sourceLang,
			targetTag: normalizeTag(tag),
			target,
			trackType: source.trackType as "full" | "honorifics",
		});
	}

	return { productions, skipped };
}
