import type { AudioStreamInfo, SubtitlePreviewResult, SubtitlePreviewTrack, SubtitleStreamInfo } from "./types";
import { run } from "./process";
import { Logger } from "./logger";
import { join } from "path";
import { readFileSync, unlinkSync, existsSync } from "fs";

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

export type SubtitleTrackType = "full" | "forced" | "sdh" | "commentary" | "honorifics" | "storyboard";

const SUB_FORCED_PATTERN = /\b(signs?[\s/&]*songs?|songs?[\s/&]*signs?|forced|typesett?ing|TS\b|OP\/?ED|karaoke|kara)\b/i;
const SUB_SDH_PATTERN = /\b(sdh|cc|closed\s*captions?|hearing\s*impaired|descriptive)\b/i;
const SUB_COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary|staff\s+commentary|cast\s+commentary|audio\s+commentary)\b/i;
const SUB_HONORIFICS_PATTERN = /\b(honorifics?|honours?|honourifics?|\bhon\b)\b/i;
const SUB_STORYBOARD_PATTERN = /\bstoryboard/i;

export function detectSubtitleTrackType(stream: SubtitleStreamInfo): SubtitleTrackType {
	const title = stream.title || "";

	if (SUB_HONORIFICS_PATTERN.test(title)) return "honorifics";
	if (SUB_COMMENTARY_PATTERN.test(title)) return "commentary";
	if (SUB_SDH_PATTERN.test(title)) return "sdh";
	if (SUB_FORCED_PATTERN.test(title)) return "forced";
	if (SUB_STORYBOARD_PATTERN.test(title)) return "storyboard";

	if (stream.isHearingImpaired) return "sdh";
	if (stream.isForced) return "forced";

	return "full";
}

const GROUP_BLOCKLIST = new Set([
	"cc",
	"sdh",
	"forced",
	"full",
	"signs",
	"songs",
	"commentary",
	"honorifics",
	"honours",
	"hon",
	"default",
	"descriptive",
	"hearing_impaired",
	"hi",
	"ad",
	"eng",
	"jpn",
	"spa",
	"fre",
	"ger",
	"ita",
	"por",
	"rus",
	"chi",
	"kor",
	"ara",
	"dut",
	"pol",
	"english",
	"japanese",
	"spanish",
	"french",
	"german",
	"italian",
	"portuguese",
	"parisian",
	"castilian",
	"russian",
	"chinese",
	"korean",
	"arabic",
	"simplified",
	"traditional",
	"latin_america",
	"brazilian",
	"british",
	"dialogue",
	"dialog",
	"karaoke",
	"kara",
	"ts",
	"op",
	"ed",
	"oped",
]);

function normalizeToken(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

function isBlockedToken(s: string): boolean {
	return GROUP_BLOCKLIST.has(normalizeToken(s));
}

function looksLikeGroupName(s: string): boolean {
	const trimmed = s.trim();

	// Reject empty / too short / too long
	if (!trimmed || trimmed.length < 2 || trimmed.length > 40) return false;

	// Allow common group-name chars, including spaces
	if (!/^[A-Za-z0-9._@+\- ]+$/.test(trimmed)) return false;

	// Reject pure language/tag words
	if (isBlockedToken(trimmed)) return false;

	// Reject tokens that are just numbers
	if (/^\d+$/.test(trimmed)) return false;

	return true;
}

function scoreGroupCandidate(s: string): number {
	let score = 0;
	const trimmed = s.trim();

	// Acronym-ish groups like MTBB, DB, ASW score higher
	if (/[A-Z]{2,}/.test(trimmed)) score += 3;

	// Mixed chars are often more group-like than plain words
	if (/[._@+\-]/.test(trimmed)) score += 2;

	// Single plain English-looking word is weaker
	if (/^[A-Za-z]+$/.test(trimmed)) score -= 1;

	// Longer but reasonable names can be valid
	if (trimmed.length >= 4 && trimmed.length <= 15) score += 1;

	return score;
}

export function normalizeLanguageGroup(lang: string | undefined): string {
	if (isEnglish(lang)) return "en";
	if (isJapanese(lang)) return "ja";
	if (isUndefined(lang)) return "und";
	return (lang || "und").toLowerCase();
}

/**
 * Extract likely fansub/release group name from subtitle title.
 *
 * Examples:
 *   "English (SubsPlease)" => "SubsPlease"
 *   "Signs/Songs [MTBB]" => "MTBB"
 *   "English (CC) [SubsPlease]" => "SubsPlease"
 *   "English [Styled] (MTBB)" => "MTBB"
 */
export function extractGroupFromTitle(title: string | undefined): string | null {
	if (!title) return null;

	const matches = [...title.matchAll(/[\[(]([^[\]()]*)[\])]/g)].map((m) => m[1]?.trim()).filter((s): s is string => Boolean(s));

	const candidates = matches.filter(looksLikeGroupName);
	if (candidates.length === 0) return null;

	candidates.sort((a, b) => scoreGroupCandidate(b) - scoreGroupCandidate(a));
	return candidates[0] ?? null;
}

export function isEnglish(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "eng" || l === "en" || l === "english" || l.startsWith("en-");
}

export function isJapanese(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "jpn" || l === "ja" || l === "japanese" || l.startsWith("ja-");
}

export function isUndefined(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return !l || l === "und" || l === "undetermined";
}

const SOURCE_TAG_PATTERN =
	/\b([A-Z]{2}(?:BD|UHD|DVD)|Netflix|Crunchyroll|Funimation|HiDive|HIDIVE|Amazon|Disney\+?|DSNP|AppleTV\+?|ATV|Hulu|VRV|ADN|Wakanim|B-Global|Bilibili|NF|CR|AMZN)\b/i;

export function extractSourceTag(title: string | undefined): string | null {
	if (!title) return null;
	const match = title.match(SOURCE_TAG_PATTERN);
	if (!match) return null;
	const raw = match[1]!;
	// Normalize BD/DVD/UHD tags to uppercase
	if (/^[A-Z]{2}(?:BD|UHD|DVD)$/i.test(raw)) return raw.toUpperCase();
	// Canonical casing for known services
	const canonical: Record<string, string> = {
		netflix: "NF",
		nf: "NF",
		crunchyroll: "CR",
		cr: "CR",
		funimation: "Funi",
		hidive: "HIDIVE",
		amazon: "AMZN",
		amzn: "AMZN",
		"disney+": "DSNP",
		disney: "DSNP",
		dsnp: "DSNP",
		"appletv+": "ATV",
		appletv: "ATV",
		atv: "ATV",
		hulu: "Hulu",
		vrv: "VRV",
		adn: "ADN",
		wakanim: "Wakanim",
		"b-global": "B-Global",
		bilibili: "Bilibili",
	};
	return canonical[raw.toLowerCase()] ?? raw;
}

/**
 * Build a clean track name for a subtitle stream.
 *
 * Examples:
 *   "Full Subtitles [SubsPlease]"
 *   "Full Subtitles"
 *   "Full Subtitles (Honorifics) [MTBB]"
 *   "SDH [Group]"
 *   "Signs & Songs"
 *   "Full Subtitles [MTBB]"
 */
export function buildSubtitleTrackName(trackType: SubtitleTrackType, sourceTitle?: string): string {
	const title = sourceTitle || "";
	const isDubtitle = /dubtitle/i.test(title);

	const labels: Record<SubtitleTrackType, string> = {
		full: isDubtitle ? "Full Dubtitles" : "Full Subtitles",
		honorifics: "Full Subtitles (Honorifics)",
		forced: "Signs & Songs",
		sdh: "SDH",
		commentary: "Commentary",
		storyboard: "Storyboards",
	};

	let label = labels[trackType];

	const source = extractSourceTag(title);
	if (source) return `${label} [${source}]`;

	const group = extractGroupFromTitle(title);
	if (group) return `${label} [${group}]`;

	return label;
}

/**
 * Determine the source/group priority for a subtitle stream.
 *
 * Priority tiers:
 *   0: BD/DVD sources (JPBD=0, USBD=1, ITBD=2, other BD/DVD=3)
 *   1: Streaming sources (NF=0, CR=1, AMZN=2, DSNP=3, ATV=4, HIDIVE=5, ADN=6, other=7)
 *   2: Release groups (alphabetically)
 *   3: Unknown (no source or group detected)
 */
function sourceGroupPriority(stream: SubtitleStreamInfo): { tier: number; rank: number; name: string } {
	const title = stream.title || "";

	// Check for a recognized source tag first
	const source = extractSourceTag(title);
	if (source) {
		// BD/DVD/UHD sources
		if (/^[A-Z]{2}(BD|UHD|DVD)$/i.test(source)) {
			const prefix = source.slice(0, 2).toUpperCase();
			const bdOrder: Record<string, number> = { JP: 0, US: 1, IT: 2 };
			return { tier: 0, rank: bdOrder[prefix] ?? 3, name: source };
		}

		// Streaming sources
		const streamingOrder: Record<string, number> = {
			NF: 0,
			CR: 1,
			AMZN: 2,
			DSNP: 3,
			ATV: 4,
			HIDIVE: 5,
			ADN: 6,
		};
		const streamingRank = streamingOrder[source.toUpperCase()];
		if (streamingRank !== undefined) {
			return { tier: 1, rank: streamingRank, name: source };
		}

		// Known service but not in the priority list - treat as other streaming
		return { tier: 1, rank: 7, name: source };
	}

	// Check for a release group
	const group = extractGroupFromTitle(title);
	if (group) {
		return { tier: 2, rank: 0, name: group };
	}

	// No source or group detected
	return { tier: 3, rank: 0, name: "" };
}

/**
 * Sort subtitle streams:
 *   1. Language: English first, Japanese second, others alphabetically, undefined last
 *   2. Type: full > honorifics > forced > sdh > commentary > storyboard
 *   3. Format: text-based before picture-based (PGS, VOBSUB...)
 *   4. Source/group:
 *      - BD/DVD: JPBD > USBD > ITBD > other BD/DVD
 *      - Streaming: NF > CR > AMZN > DSNP > ATV > HIDIVE > ADN > other
 *      - Release groups (alphabetically)
 *      - Unknown (no source or group) last
 */
export function sortSubtitleStreams(streams: SubtitleStreamInfo[]): SubtitleStreamInfo[] {
	const langPriority = (lang: string | undefined): number => {
		if (isEnglish(lang)) return 0;
		if (isJapanese(lang)) return 1;
		if (isUndefined(lang)) return 3;
		return 2;
	};

	const typePriority = (stream: SubtitleStreamInfo): number => {
		const type = detectSubtitleTrackType(stream);
		switch (type) {
			case "full":
				return 0;
			case "honorifics":
				return 1;
			case "forced":
				return 2;
			case "sdh":
				return 3;
			case "commentary":
				return 4;
			case "storyboard":
				return 5;
			default:
				return 6;
		}
	};

	const formatPriority = (stream: SubtitleStreamInfo): number => {
		return isTextSubtitleCodec(stream.codec) ? 0 : 1;
	};

	return [...streams].sort((a, b) => {
		// 1. Language
		const langA = langPriority(a.language);
		const langB = langPriority(b.language);
		if (langA !== langB) return langA - langB;

		if (langA === 2 && langB === 2) {
			const la = normalizeLanguageGroup(a.language);
			const lb = normalizeLanguageGroup(b.language);
			if (la !== lb) return la.localeCompare(lb);
		}

		// 2. Type
		const typeA = typePriority(a);
		const typeB = typePriority(b);
		if (typeA !== typeB) return typeA - typeB;

		// 3. Format (text before bitmap)
		const fmtA = formatPriority(a);
		const fmtB = formatPriority(b);
		if (fmtA !== fmtB) return fmtA - fmtB;

		// 4. Source/group
		const sgA = sourceGroupPriority(a);
		const sgB = sourceGroupPriority(b);

		if (sgA.tier !== sgB.tier) return sgA.tier - sgB.tier;
		if (sgA.rank !== sgB.rank) return sgA.rank - sgB.rank;

		// Within release groups (tier 2), sort alphabetically
		if (sgA.tier === 2) {
			return sgA.name.toLowerCase().localeCompare(sgB.name.toLowerCase());
		}

		return 0;
	});
}

interface LanguageDetectorResult {
	file: string;
	total_words: number;
	detected: {
		language: string;
		iso_639_1: string;
		iso_639_2: string;
		bcp47: string | null;
		matched_words: number;
		confidence: number;
	};
}

/**
 * Run language-detector on a subtitle file and return the parsed result.
 */
async function detectLanguage(filePath: string, signal?: AbortSignal): Promise<LanguageDetectorResult | null> {
	const res = await run(["language-detector", "-f", "json", filePath], { signal });

	if (res.code !== 0) {
		if (res.code !== 127) {
			Logger.warn(`[subtitle] language-detector failed for ${filePath}: ${res.stderr || res.stdout}`);
		}
		return null;
	}

	try {
		const result = JSON.parse(res.stdout) as LanguageDetectorResult;
		if (!result.detected || result.total_words === 0) return null;
		return result;
	} catch {
		Logger.warn(`[subtitle] Failed to parse language-detector output for ${filePath}`);
		return null;
	}
}

// Subtitle codec helpers & extraction

const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "subviewer", "microdvd"]);

const ASS_CODECS = new Set(["ass", "ssa"]);

export function isTextSubtitleCodec(codec: string): boolean {
	return TEXT_SUB_CODECS.has(codec.toLowerCase());
}

interface SubtitleExtraction {
	text: string;
	format: "ass" | "srt";
	filePath: string;
}

async function extractSubtitleForAnalysis(
	inputPath: string,
	stream: SubtitleStreamInfo,
	tempDir: string,
	signal?: AbortSignal,
): Promise<SubtitleExtraction | null> {
	const isAss = ASS_CODECS.has(stream.codec.toLowerCase());
	const ext = isAss ? "ass" : "srt";
	const outPath = join(tempDir, `sub_analyze_${stream.index}.${ext}`);
	const codecArgs = isAss ? ["-c:s", "copy"] : ["-c:s", "srt"];

	const res = await run(["ffmpeg", "-y", "-i", inputPath, "-map", `0:${stream.index}`, ...codecArgs, "-vn", "-an", outPath], { signal });

	if (res.code !== 0) {
		Logger.warn(`[subtitle] Failed to extract track ${stream.index} for analysis: ${res.stderr || res.stdout}`);
		return null;
	}

	try {
		const text = readFileSync(outPath, "utf-8");
		return { text, format: isAss ? "ass" : "srt", filePath: outPath };
	} catch {
		return null;
	}
}

function cleanupExtraction(extraction: SubtitleExtraction): void {
	try {
		if (existsSync(extraction.filePath)) unlinkSync(extraction.filePath);
	} catch {}
}

// ASS parsing
interface AssDialogueLine {
	style: string;
	text: string;
}

function parseAssDialogueLines(assContent: string): AssDialogueLine[] {
	const lines = assContent.split("\n");
	let inEvents = false;
	let styleIndex = 3;
	let textIndex = 9;
	let fieldCount = 10;
	const result: AssDialogueLine[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (line.startsWith("[") && line.endsWith("]")) {
			inEvents = line.toLowerCase() === "[events]";
			continue;
		}

		if (!inEvents) continue;

		if (line.toLowerCase().startsWith("format:")) {
			const fields = line
				.substring(7)
				.split(",")
				.map((f) => f.trim().toLowerCase());
			fieldCount = fields.length;
			const si = fields.indexOf("style");
			const ti = fields.indexOf("text");
			if (si >= 0) styleIndex = si;
			if (ti >= 0) textIndex = ti;
			continue;
		}

		if (!line.startsWith("Dialogue:")) continue;

		const afterPrefix = line.substring(line.indexOf(":") + 1);
		const parts = afterPrefix.split(",");
		if (parts.length < fieldCount) continue;

		const style = parts[styleIndex]?.trim() || "";
		const text = parts.slice(textIndex).join(",").trim();
		result.push({ style, text });
	}

	return result;
}

// Content analysis

const SIGN_STYLE_PATTERN =
	/^(sign|song|op|ed|title|typeset|insert|karaoke|kara|logo|preview|eyecatch|next[-_ ]?ep|opening|ending|credit|note|screen|border|italics?[-_ ]?top|top[-_ ]?title|ep[-_ ]?title|chapter|mask|flash|blur|overlap[-_ ]?sign)/i;

const HONORIFIC_PATTERN = /\b\w+[-–](?:san|kun|chan|sama|sensei|senpai|k[oō]hai|dono|tan|n[ei]e|n[ei]i|b[oō]|shi|jo)\b/gi;

const SDH_SPEAKER_PATTERN = /^[A-Z][A-Z\s.'-]{1,30}:/;
const SDH_BRACKET_PATTERN = /\[[^\]]{2,60}\]/;
const SDH_PAREN_PATTERN = /\([^)]{2,60}\)/;
const SDH_MUSIC_PATTERN = /[♪♫♬]/;

const SRT_TIMESTAMP_PATTERN = /^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;

function stripSubtitleTags(text: string): string {
	return text
		.replace(/<[^>]+>/g, "")
		.replace(/\{[^}]*\}/g, "")
		.replace(/\\N/g, "\n")
		.trim();
}

interface SubtitleContentAnalysis {
	dialogueLineCount: number;
	assStyles: {
		signStyleLines: number;
		dialogueStyleLines: number;
		otherStyleLines: number;
		totalLines: number;
	} | null;
	sdhRatio: number;
	honorificCount: number;
}

function analyzeSrtContent(srtText: string): SubtitleContentAnalysis {
	const lines = srtText.split("\n");
	let dialogueLineCount = 0;
	let sdhLineCount = 0;
	let totalTextLines = 0;
	let honorificCount = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (SRT_TIMESTAMP_PATTERN.test(line)) {
			dialogueLineCount++;
			continue;
		}
		if (!line || /^\d+$/.test(line)) continue;

		const cleaned = stripSubtitleTags(line);
		if (!cleaned) continue;
		totalTextLines++;

		if (SDH_SPEAKER_PATTERN.test(cleaned) || SDH_BRACKET_PATTERN.test(cleaned) || SDH_PAREN_PATTERN.test(cleaned) || SDH_MUSIC_PATTERN.test(cleaned)) {
			sdhLineCount++;
		}

		const honMatches = cleaned.match(HONORIFIC_PATTERN);
		if (honMatches) honorificCount += honMatches.length;
	}

	return {
		dialogueLineCount,
		assStyles: null,
		sdhRatio: totalTextLines > 0 ? sdhLineCount / totalTextLines : 0,
		honorificCount,
	};
}

function analyzeAssContent(assText: string): SubtitleContentAnalysis {
	const dialogueLines = parseAssDialogueLines(assText);
	let signStyleLines = 0;
	let dialogueStyleLines = 0;
	let otherStyleLines = 0;
	let sdhLineCount = 0;
	let honorificCount = 0;
	let totalTextLines = 0;

	for (const { style, text } of dialogueLines) {
		if (SIGN_STYLE_PATTERN.test(style)) signStyleLines++;
		else if (/^(default|main|dialogue|dialog|narrat|italic|flashback|thought|internal|alt(?:ernate)?|overlap(?![-_ ]?sign)|top(?![-_ ]?title))/i.test(style))
			dialogueStyleLines++;
		else otherStyleLines++;

		const cleaned = stripSubtitleTags(text);
		if (!cleaned) continue;
		totalTextLines++;

		if (SDH_SPEAKER_PATTERN.test(cleaned) || SDH_BRACKET_PATTERN.test(cleaned) || SDH_PAREN_PATTERN.test(cleaned) || SDH_MUSIC_PATTERN.test(cleaned)) {
			sdhLineCount++;
		}

		const honMatches = cleaned.match(HONORIFIC_PATTERN);
		if (honMatches) honorificCount += honMatches.length;
	}

	return {
		dialogueLineCount: dialogueLines.length,
		assStyles: { signStyleLines, dialogueStyleLines, otherStyleLines, totalLines: dialogueLines.length },
		sdhRatio: totalTextLines > 0 ? sdhLineCount / totalTextLines : 0,
		honorificCount,
	};
}

function analyzeContent(extraction: SubtitleExtraction): SubtitleContentAnalysis {
	return extraction.format === "ass" ? analyzeAssContent(extraction.text) : analyzeSrtContent(extraction.text);
}

/**
 * Comprehensive subtitle analysis. Mutates streams in place.
 *
 * Each text-based stream is extracted once; the file is reused for
 * both language-detector and content analysis before cleanup.
 *
 * Steps:
 *   1. Extract all text-based streams & run content analysis
 *   2. Language detection via language-detector (sets language to BCP47 or ISO 639-2)
 *   3. Bitmap fallback (PGS/VOBSUB when no English found)
 *   4. ASS style-based Signs & Songs detection
 *   5. Line-count-based Signs & Songs detection
 *   6. SDH content detection
 *   7. Honorifics detection (pair comparison)
 */
export async function analyzeSubtitleStreams(streams: SubtitleStreamInfo[], inputPath: string, tempDir: string, signal?: AbortSignal): Promise<void> {
	if (streams.length === 0) return;

	// Step 1: Extract & content-analyze
	const contentCache = new Map<number, SubtitleContentAnalysis>();
	const extractions = new Map<number, SubtitleExtraction>();

	const textStreams = streams.filter((s) => isTextSubtitleCodec(s.codec));
	if (textStreams.length > 0) {
		Logger.info(`[subtitle] Analyzing ${textStreams.length} text-based subtitle track(s)`);
	}

	for (const stream of textStreams) {
		const extraction = await extractSubtitleForAnalysis(inputPath, stream, tempDir, signal);
		if (!extraction) continue;

		extractions.set(stream.index, extraction);
		const analysis = analyzeContent(extraction);
		contentCache.set(stream.index, analysis);

		const styleSummary =
			analysis.assStyles != null
				? `, styles: ${analysis.assStyles.dialogueStyleLines}d/${analysis.assStyles.signStyleLines}s/${analysis.assStyles.otherStyleLines}o`
				: "";

		Logger.info(
			`[subtitle] Track ${stream.index} (${stream.language || "und"}, ${stream.codec}): ` +
				`${analysis.dialogueLineCount} lines, ` +
				`SDH ${(analysis.sdhRatio * 100).toFixed(0)}%, ` +
				`honorifics ${analysis.honorificCount}` +
				styleSummary,
		);
	}

	// Step 2: Language detection via language-detector
	for (const stream of textStreams) {
		const extraction = extractions.get(stream.index);
		if (!extraction) continue;

		const result = await detectLanguage(extraction.filePath, signal);

		if (result === null) {
			continue;
		}

		const langCode = result.detected.bcp47 || result.detected.iso_639_2;
		const confidence = result.detected.confidence;
		const origLang = stream.language || "und";

		if (confidence < 0.05) {
			Logger.info(`[subtitle] Track ${stream.index}: language-detector confidence too low ` + `(${(confidence * 100).toFixed(1)}%) — keeping "${origLang}"`);
			continue;
		}

		const changed = origLang.toLowerCase() !== langCode.toLowerCase();

		Logger[changed ? "warn" : "info"](
			`[subtitle] Track ${stream.index}: language-detector → ${result.detected.language} ` +
				`[${langCode}], ${(confidence * 100).toFixed(1)}% confidence — ` +
				`${changed ? "relabeling" : "confirmed"} from "${origLang}"`,
		);

		stream.language = langCode;
	}

	// Clean up all extracted temp files
	for (const extraction of extractions.values()) {
		cleanupExtraction(extraction);
	}
	extractions.clear();

	// Step 3: Bitmap fallback
	const hasFullEnglishSubs = streams.some((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "full");
	const hasJapaneseSubs = streams.some((s) => isJapanese(s.language));

	if (!hasFullEnglishSubs && hasJapaneseSubs) {
		const hasAnyEnglish = streams.some((s) => isEnglish(s.language));
		const reason = hasAnyEnglish ? "Only Signs & Songs English tracks found" : "No English tracks found (including after language detection)";
		Logger.warn(`[subtitle] ${reason} but Japanese tracks exist — assuming mislabeled, relabeling Japanese to English`);
		for (const s of streams) {
			if (isJapanese(s.language)) {
				s.language = "en";
			}
		}
	}

	// Step 4: ASS style-based Signs & Songs
	for (const stream of streams) {
		if (detectSubtitleTrackType(stream) !== "full") continue;

		const analysis = contentCache.get(stream.index);
		if (!analysis?.assStyles) continue;

		const { signStyleLines, dialogueStyleLines, totalLines } = analysis.assStyles;
		if (totalLines >= 5 && signStyleLines / totalLines >= 0.8 && dialogueStyleLines < 50) {
			Logger.warn(`[subtitle] Track ${stream.index}: ${signStyleLines}/${totalLines} lines use sign/typeset ` + `ASS styles — reclassifying as Signs & Songs`);
			stream.isForced = true;
		}
	}

	// Step 5: Line-count-based Signs & Songs
	const fullStreams = streams.filter((s) => detectSubtitleTrackType(s) === "full" && contentCache.has(s.index));

	if (fullStreams.length >= 2) {
		const lineCounts = new Map<number, number>();
		for (const s of fullStreams) {
			lineCounts.set(s.index, contentCache.get(s.index)!.dialogueLineCount);
		}

		const maxLines = Math.max(...lineCounts.values());
		for (const [streamIndex, lineCount] of lineCounts) {
			if (maxLines > 0 && lineCount > 0 && lineCount * 10 <= maxLines && lineCount < 100) {
				const stream = streams.find((s) => s.index === streamIndex);
				if (stream) {
					Logger.warn(`[subtitle] Track ${streamIndex}: only ${lineCount} lines vs ${maxLines} ` + `in largest full track — reclassifying as Signs & Songs`);
					stream.isForced = true;
				}
			}
		}
	}

	// Step 6: SDH content detection
	for (const stream of streams) {
		const currentType = detectSubtitleTrackType(stream);
		if (currentType === "sdh" || currentType === "forced") continue;

		const analysis = contentCache.get(stream.index);
		if (!analysis) continue;

		if (analysis.sdhRatio >= 0.15 && analysis.dialogueLineCount >= 10) {
			Logger.warn(`[subtitle] Track ${stream.index}: ${(analysis.sdhRatio * 100).toFixed(0)}% SDH markers — reclassifying as SDH`);
			stream.isHearingImpaired = true;
		}
	}

	// Step 7: Honorifics detection
	const englishFullStreams = streams.filter((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "full" && contentCache.has(s.index));
	const hasExistingHonorifics = streams.some((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "honorifics");

	if (englishFullStreams.length >= 2 && !hasExistingHonorifics) {
		let maxHonStream: SubtitleStreamInfo | null = null;
		let maxHon = 0;
		let minHon = Infinity;

		for (const stream of englishFullStreams) {
			const count = contentCache.get(stream.index)!.honorificCount;
			if (count > maxHon) {
				maxHon = count;
				maxHonStream = stream;
			}
			if (count < minHon) {
				minHon = count;
			}
		}

		if (maxHonStream && maxHon >= 5 && (minHon === 0 || maxHon >= minHon * 3)) {
			Logger.warn(`[subtitle] Track ${maxHonStream.index}: ${maxHon} honorific suffixes ` + `(vs ${minHon} in others) — reclassifying as Honorifics`);
			const existingTitle = maxHonStream.title || "";
			if (!SUB_HONORIFICS_PATTERN.test(existingTitle)) {
				maxHonStream.title = existingTitle ? `${existingTitle} [Honorifics]` : "Honorifics";
			}
		}
	}

	// Summary
	const summary = streams.map((s) => {
		const lang = s.language || "und";
		const type = detectSubtitleTrackType(s);
		return `${lang}:${type}`;
	});
	Logger.info(`[subtitle] Final classification: ${summary.join(", ")}`);
}

/**
 * Map a language code (BCP47, ISO 639-1, ISO 639-2/3) to a flag emoji.
 */
export function languageToFlag(lang: string | undefined): string {
	const LANG_TO_COUNTRY: Record<string, string> = {
		en: "US",
		ja: "JP",
		de: "DE",
		fr: "FR",
		es: "ES",
		it: "IT",
		pt: "BR",
		ru: "RU",
		zh: "CN",
		ko: "KR",
		ar: "SA",
		hi: "IN",
		th: "TH",
		vi: "VN",
		pl: "PL",
		nl: "NL",
		sv: "SE",
		da: "DK",
		fi: "FI",
		nb: "NO",
		no: "NO",
		cs: "CZ",
		sk: "SK",
		hu: "HU",
		ro: "RO",
		bg: "BG",
		hr: "HR",
		sr: "RS",
		sl: "SI",
		uk: "UA",
		el: "GR",
		tr: "TR",
		he: "IL",
		id: "ID",
		ms: "MY",
		tl: "PH",
		// ISO 639-2/3
		eng: "US",
		jpn: "JP",
		deu: "DE",
		ger: "DE",
		fra: "FR",
		fre: "FR",
		spa: "ES",
		ita: "IT",
		por: "BR",
		rus: "RU",
		zho: "CN",
		chi: "CN",
		kor: "KR",
		ara: "SA",
		hin: "IN",
		tha: "TH",
		vie: "VN",
		pol: "PL",
		nld: "NL",
		dut: "NL",
		swe: "SE",
		dan: "DK",
		fin: "FI",
		nob: "NO",
		nor: "NO",
		ces: "CZ",
		cze: "CZ",
		slk: "SK",
		slo: "SK",
		hun: "HU",
		ron: "RO",
		rum: "RO",
		bul: "BG",
		hrv: "HR",
		srp: "RS",
		slv: "SI",
		ukr: "UA",
		ell: "GR",
		gre: "GR",
		tur: "TR",
		heb: "IL",
		ind: "ID",
		msa: "MY",
		may: "MY",
		tgl: "PH",
		fil: "PH",
		enm: "US", // Middle English (honorifics)
	};

	const GLOBE = "\u{1F310}";

	if (!lang || lang === "und" || lang === "undetermined") return GLOBE;

	const base = lang.split("-")[0]!.toLowerCase();
	const country = LANG_TO_COUNTRY[base];
	if (!country) return GLOBE;

	return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Compute MKV flags for a subtitle track exactly as the encoder would.
 */
function computeOutputFlags(
	trackType: SubtitleTrackType,
	langGroup: string,
	defaultAssigned: Set<string>,
	forcedAssigned: Set<string>,
): { isDefault: boolean; isForced: boolean; isHearingImpaired: boolean; isCommentary: boolean } {
	switch (trackType) {
		case "full": {
			const isDefault = !defaultAssigned.has(langGroup);
			if (isDefault) defaultAssigned.add(langGroup);
			return { isDefault, isForced: false, isHearingImpaired: false, isCommentary: false };
		}
		case "honorifics":
			return { isDefault: true, isForced: false, isHearingImpaired: false, isCommentary: false };
		case "forced": {
			const alreadyForced = forcedAssigned.has(langGroup);
			if (!alreadyForced) forcedAssigned.add(langGroup);
			return { isDefault: false, isForced: !alreadyForced, isHearingImpaired: false, isCommentary: false };
		}
		case "sdh":
			return { isDefault: false, isForced: false, isHearingImpaired: true, isCommentary: false };
		case "commentary":
			return { isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: true };
		default:
			return { isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: false };
	}
}

/**
 * Run the full subtitle analysis pipeline without encoding and return
 * a before/after comparison.
 */
export async function previewSubtitles(inputPath: string, sourceStreams: SubtitleStreamInfo[], tempDir: string): Promise<SubtitlePreviewResult> {
	const source: SubtitlePreviewTrack[] = sourceStreams.map((s) => {
		const trackType = detectSubtitleTrackType(s);
		return {
			index: s.index,
			codec: s.codec,
			language: s.language || "und",
			flag: languageToFlag(s.language),
			title: s.title || "",
			trackName: s.title || "",
			trackType,
			isDefault: s.isDefault || false,
			isForced: s.isForced || false,
			isHearingImpaired: s.isHearingImpaired || false,
			isCommentary: false,
			isText: isTextSubtitleCodec(s.codec),
		};
	});

	const cloned: SubtitleStreamInfo[] = sourceStreams.map((s) => ({
		index: s.index,
		codec: s.codec,
		language: s.language,
		title: s.title,
		isForced: s.isForced,
		isDefault: s.isDefault,
		isHearingImpaired: s.isHearingImpaired,
	}));

	await analyzeSubtitleStreams(cloned, inputPath, tempDir);

	const sorted = sortSubtitleStreams(cloned);

	const defaultAssigned = new Set<string>();
	const forcedAssigned = new Set<string>();

	const output: SubtitlePreviewTrack[] = sorted.map((s) => {
		const trackType = detectSubtitleTrackType(s);
		const lang = s.language || "und";
		const langGroup = normalizeLanguageGroup(lang);
		const trackName = buildSubtitleTrackName(trackType, s.title);

		let effectiveLang = lang;
		if (trackType === "honorifics") effectiveLang = "enm";

		const flags = computeOutputFlags(trackType, langGroup, defaultAssigned, forcedAssigned);

		return {
			index: s.index,
			codec: s.codec,
			language: effectiveLang,
			flag: languageToFlag(effectiveLang),
			title: s.title || "",
			trackName,
			trackType,
			...flags,
			isText: isTextSubtitleCodec(s.codec),
		};
	});

	return { source, output };
}
