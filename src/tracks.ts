import type { AudioStreamInfo, SubtitleStreamInfo } from "./types";

export type AudioTrackType = "main" | "commentary" | "descriptive";

const COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary)\b/i;
const DESCRIPTIVE_PATTERN = /\b(descriptive|description|audio\s*desc(?:ription)?|visually\s*impaired|\bAD\b)\b/i;

export function detectAudioTrackType(stream: AudioStreamInfo): AudioTrackType {
	if (!stream.title) return "main";
	if (COMMENTARY_PATTERN.test(stream.title)) return "commentary";
	if (DESCRIPTIVE_PATTERN.test(stream.title)) return "descriptive";
	return "main";
}

/**
 * Sort audio streams: Japanese first, English second, then everything else
 * alphabetically by language code. Within each language group, main tracks
 * come before commentary/descriptive tracks, then sorted by channel count.
 */
export function sortAudioStreams(streams: AudioStreamInfo[]): AudioStreamInfo[] {
	const langPriority = (lang: string | undefined): number => {
		const l = (lang || "und").toLowerCase();
		if (l === "jpn" || l === "ja" || l === "japanese") return 0;
		if (l === "eng" || l === "en" || l === "english") return 1;
		return 2;
	};

	const typePriority = (stream: AudioStreamInfo): number => {
		const type = detectAudioTrackType(stream);
		if (type === "main") return 0;
		if (type === "commentary") return 1;
		return 2;
	};

	return [...streams].sort((a, b) => {
		const langA = langPriority(a.language);
		const langB = langPriority(b.language);
		if (langA !== langB) return langA - langB;

		if (langA === 2 && langB === 2) {
			const la = (a.language || "und").toLowerCase();
			const lb = (b.language || "und").toLowerCase();
			if (la !== lb) return la.localeCompare(lb);
		}

		const typeA = typePriority(a);
		const typeB = typePriority(b);
		if (typeA !== typeB) return typeA - typeB;

		return (a.channels || 2) - (b.channels || 2);
	});
}

const LOSSLESS_CODECS = new Set(["flac", "truehd", "mlp", "dts", "pcm_s16le", "pcm_s24le", "pcm_s32le"]);

/**
 * Deduplicate audio streams: keep only the best source per
 * language + channel count + track type combination.
 * Prefer lossless codecs, then highest bitrate.
 */
export function deduplicateAudioStreams(streams: AudioStreamInfo[]): AudioStreamInfo[] {
	const bestMap = new Map<string, AudioStreamInfo>();

	for (const stream of streams) {
		const lang = (stream.language || "und").toLowerCase();
		const type = detectAudioTrackType(stream);
		const key = `${lang}:${stream.channels}:${type}`;

		const existing = bestMap.get(key);
		if (!existing) {
			bestMap.set(key, stream);
			continue;
		}

		const isLossless = LOSSLESS_CODECS.has(stream.codec?.toLowerCase() || "");
		const existingIsLossless = LOSSLESS_CODECS.has(existing.codec?.toLowerCase() || "");

		if (isLossless && !existingIsLossless) {
			bestMap.set(key, stream);
		} else if (isLossless === existingIsLossless && (stream.bitrate || 0) > (existing.bitrate || 0)) {
			bestMap.set(key, stream);
		}
	}

	return streams.filter((s) => {
		const lang = (s.language || "und").toLowerCase();
		const type = detectAudioTrackType(s);
		const key = `${lang}:${s.channels}:${type}`;
		return bestMap.get(key) === s;
	});
}

export type SubtitleTrackType = "full" | "forced" | "sdh" | "commentary" | "honorifics";

const SUB_FORCED_PATTERN = /\b(signs?|songs?|forced)\b/i;
const SUB_SDH_PATTERN = /\b(sdh|cc|closed\s*captions?|hearing\s*impaired)\b/i;
const SUB_COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary)\b/i;
const SUB_HONORIFICS_PATTERN = /\b(honorifics?|honours?)\b/i;

export function detectSubtitleTrackType(stream: SubtitleStreamInfo): SubtitleTrackType {
	const title = stream.title || "";

	if (SUB_HONORIFICS_PATTERN.test(title)) return "honorifics";
	if (SUB_COMMENTARY_PATTERN.test(title)) return "commentary";
	if (SUB_SDH_PATTERN.test(title)) return "sdh";
	if (SUB_FORCED_PATTERN.test(title)) return "forced";

	if (stream.isHearingImpaired) return "sdh";
	if (stream.isForced) return "forced";

	return "full";
}

/**
 * Extract fansub/release group name from a subtitle track title.
 * Examples: "English (SubsPlease)" → "SubsPlease", "Signs/Songs [MTBB]" → "MTBB"
 */
export function extractGroupFromTitle(title: string | undefined): string | null {
	if (!title) return null;
	const match = title.match(/[\[(]([A-Za-z0-9._@-]+)[\])](?:\s*$)/);
	return match?.[1] ?? null;
}

/**
 * Build a clean track name for a subtitle stream.
 * Format: "{Type Label} [{Group}]" or just "{Type Label}" if no group.
 */
export function buildSubtitleTrackName(trackType: SubtitleTrackType, group: string | null): string {
	const labels: Record<SubtitleTrackType, string> = {
		full: "Full Subtitles",
		forced: "Signs & Songs",
		sdh: "SDH",
		commentary: "Commentary",
		honorifics: "Full Subtitles (Honorifics)",
	};

	const label = labels[trackType];
	return group ? `${label} [${group}]` : label;
}

/**
 * Sort subtitle streams:
 *   - English first, Japanese second, others alphabetically
 *   - Within each language: full → forced → honorifics → sdh → commentary
 */
export function sortSubtitleStreams(streams: SubtitleStreamInfo[]): SubtitleStreamInfo[] {
	const langPriority = (lang: string | undefined): number => {
		const l = (lang || "und").toLowerCase();
		if (l === "eng" || l === "en" || l === "english") return 0;
		if (l === "jpn" || l === "ja" || l === "japanese") return 1;
		return 2;
	};

	const typePriority = (stream: SubtitleStreamInfo): number => {
		const type = detectSubtitleTrackType(stream);
		switch (type) {
			case "full":
				return 0;
			case "forced":
				return 1;
			case "honorifics":
				return 2;
			case "sdh":
				return 3;
			case "commentary":
				return 4;
			default:
				return 5;
		}
	};

	return [...streams].sort((a, b) => {
		const langA = langPriority(a.language);
		const langB = langPriority(b.language);
		if (langA !== langB) return langA - langB;

		if (langA === 2 && langB === 2) {
			const la = (a.language || "und").toLowerCase();
			const lb = (b.language || "und").toLowerCase();
			if (la !== lb) return la.localeCompare(lb);
		}

		return typePriority(a) - typePriority(b);
	});
}

export function isEnglish(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "eng" || l === "en" || l === "english";
}

export function isJapanese(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "jpn" || l === "ja" || l === "japanese";
}
