export type EncoderId = "svt-av1-essential" | "svt-av1-hdr";
export type EncoderQuality = "low" | "medium" | "high";
export type EncoderSpeed = "slower" | "slow" | "medium" | "fast" | "faster";
export type DenoiseLevel = "off" | "light" | "medium" | "heavy" | "auto";
export type DebandLevel = "off" | "light" | "medium" | "heavy";

export type VideoEncodeMode = "av1" | "off";
export type AudioEncodeMode = "opus" | "copy";
export type SubtitleProcessingMode = "full" | "copy";

/**
 * Backend used for the nlmeans denoise filter.
 *
 *   - "cpu"    : never use GPU; run nlmeans on CPU.
 *   - "auto"   : probe Vulkan first, then OpenCL; fall back to CPU.
 *   - "vulkan" : use nlmeans_vulkan (falls back to CPU if probe fails).
 *   - "opencl" : use nlmeans_opencl (falls back to CPU if probe fails).
 */
export type DenoiseBackend = "cpu" | "auto" | "vulkan" | "opencl";

export type GpuBackend = "auto" | "vulkan" | "opencl";

export type JobStatus = "queued" | "probing" | "encoding_video" | "encoding_audio" | "muxing" | "done" | "error" | "cancelled";

export type AudioTrackType = "main" | "commentary" | "descriptive";

export const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".webm", ".flv", ".ts", ".mov"]);

export interface AudioChannelBitrates {
	mono: number;
	stereo: number;
	"2.1": number;
	"5.1": number;
	"6.1": number;
	"7.1": number;
	"7.1.4": number;
}

export interface AutoDenoiseThresholds {
	light: number;
	medium: number;
	heavy: number;
}

/**
 * Parameters for FFmpeg's nlmeans / nlmeans_opencl / nlmeans_vulkan filter.
 *
 *   s : denoising strength    [1.0 – 30.0]
 *   p : patch size (odd)      [0 – 99]
 *   r : research size (odd)   [0 – 99]
 */
export interface NlmeansParams {
	s: number;
	p: number;
	r: number;
}

export interface NlmeansLevelParams {
	light: NlmeansParams;
	medium: NlmeansParams;
	heavy: NlmeansParams;
}

/**
 * Parameters for FFmpeg's gradfun deband filter.
 *
 *   strength : max change per pixel / flatness threshold [0.51 – 64]
 *   radius   : neighbourhood size                        [8 – 32]
 */
export interface GradfunParams {
	strength: number;
	radius: number;
}

export interface GradfunLevelParams {
	light: GradfunParams;
	medium: GradfunParams;
	heavy: GradfunParams;
}

export interface JobSettings {
	encoder: EncoderId;
	manualCrf: number;
	manualPreset: number;
	tune: number;
	customEncoderParams: string;
	videoEncode: VideoEncodeMode;
	audioEncode: AudioEncodeMode;
	subtitleProcessing: SubtitleProcessingMode;
	quality: EncoderQuality;
	finalSpeed: EncoderSpeed;
	audioBitrates: AudioChannelBitrates;
	denoise: DenoiseLevel;
	autoDenoiseThresholds: AutoDenoiseThresholds;
	/** Filter parameters used for nlmeans at each level. */
	nlmeansParams: NlmeansLevelParams;
	/** Filter parameters used for gradfun at each level. */
	gradfunParams: GradfunLevelParams;
	/** Backend selection for nlmeans. "cpu" forces CPU; the others may fall back. */
	denoiseBackend: DenoiseBackend;
	/** Device id for vulkan/opencl backends (e.g. "0" / "0.0"); ignored for cpu. */
	gpuDevice: string;
	deband: DebandLevel;
	downscale: boolean;
	skipBoosting: boolean;
	noPhaseInv: boolean;
	dedupeSubtitles: boolean;
	keepBestAudioChannelsOnly: boolean;
	removeCommentaryAudio: boolean;
	audioLanguages: string[];
	subtitleLanguages: string[];
	/**
	 * Ordered list of VapourSynth filter passes to apply during the prepare
	 * stage, before the FFmpeg -vf chain. Each entry references a preset by
	 * namespaced id ("stock:finedehalo" or "user:my_dehalo"), selects an
	 * active level, and stores per-level param values.
	 */
	vsFilters: VsFilterEntry[];
}

export interface AudioStreamInfo {
	index: number;
	channels: number;
	channelLayout: string;
	language?: string;
	title?: string;
	codec?: string;
	bitrate?: number;
	delayMs: number;
	isOriginal?: boolean;
}

export interface SubtitleStreamInfo {
	index: number;
	codec: string;
	/** BCP47 or ISO 639-2 */
	language?: string;
	title?: string;
	isForced?: boolean;
	isDefault?: boolean;
	isHearingImpaired?: boolean;
	isOriginal?: boolean;
}

export interface ProbeResult {
	filename: string;
	width: number;
	height: number;
	videoCodec: string;
	displayAspectRatio: string;
	duration: number;
	audioLayout: string;
	audioChannels: number;
	audioStreams: AudioStreamInfo[];
	subtitleStreams: SubtitleStreamInfo[];
	isHDR: boolean;
	hasHDR10Plus: boolean;
	hasDolbyVision: boolean;
	transferCharacteristics: string;
	colorPrimaries: string;
	matrixCoefficients: string;
	colorRange: string;
	maxCLL: string;
	maxFALL: string;
	masteringDisplay: string;
	masteringLuminance: string;
	videoStreamIndex: number;
	videoFrameRate: string;
	videoStreamFps: number;
	videoDisplayFps: number;
	videoLanguage: string;
	videoOriginalFlag: boolean;
	isFrameRateMismatch: boolean;
	priorSource: string | null;
	priorRabbitSettings: string | null;
	priorRabbitVersion: string | null;
	priorEncodedBy: string | null;
}

export interface JobStep {
	label: string;
	status: "pending" | "active" | "done" | "error";
	progress: number;
	detail?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface Job {
	id: string;
	filename: string;
	inputPath: string;
	relativePath: string;
	status: JobStatus;
	progress: number;
	queueOrder: number;
	currentStage: string;
	steps: JobStep[];
	settings: JobSettings;
	probe?: ProbeResult;
	outputFilename?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	estimatedVideoSize?: string;
	estimatedFinalSize?: string;
	encodedVideoSize?: string;
	encodedFileSize?: string;
	replaceSource: boolean;
}

export interface LanguageDetector {
	version: string | null;
}

export interface AppConfig {
	inputDir: string;
	outputDir: string;
	tempDir: string;
	port: number;
	defaults: JobSettings;
	organization: string;
	libraryDirs: string[];
	languageDetector: LanguageDetector;
}

export interface SubtitlePreviewTrack {
	index: number;
	codec: string;
	language: string;
	/** Country flag emoji derived from language */
	flag: string;
	title: string;
	trackName: string;
	trackType: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	isCommentary: boolean;
	isText: boolean;
}

export interface SubtitlePreviewResult {
	source: SubtitlePreviewTrack[];
	output: SubtitlePreviewTrack[];
}

export interface AudioPreviewTrack {
	index: number;
	codec: string;
	language: string;
	flag: string;
	title: string;
	trackType: AudioTrackType; // "main" | "commentary" | "descriptive"
	channels: number;
	channelLayout: string;
	bitrate?: number; // source: input bitrate from probe (raw)
	outputBitrate?: number; // output: predicted Opus bitrate in kbps
	isDefault: boolean;
	isOriginal: boolean;
}

export interface AudioPreviewResult {
	source: AudioPreviewTrack[];
	output: AudioPreviewTrack[];
}

export interface PreviewSampleVsFrame {
	/** Zero-based index in the active VS chain. */
	index: number;
	/** Namespaced preset id (e.g. "stock:f3k_deband"). */
	presetId: string;
	/** Bare preset id, useful for filenames or download labels. */
	bareId: string;
	/** Human-readable label like "F3K Deband (heavy)". */
	label: string;
}

export interface PreviewSamplePrepareFrame {
	/** Which prepare-filter step this snapshot came from. */
	kind: "downscale" | "deband" | "denoise";
	/** Human-readable label like "Debanding (medium)" or "Auto denoise (GPU/Vulkan)". */
	label: string;
}

export interface PreviewSample {
	index: number;
	timestampSec: number;
	windowSeconds: number;
	encodedSizeBytes: number;
	encodedSizeHuman: string;
	projectedTotalBytes: number;
	projectedTotalHuman: string;
	encodedBitrateKbps: number;
	vsFrames: PreviewSampleVsFrame[];
	prepareFrames: PreviewSamplePrepareFrame[];
}

export interface PreviewState {
	jobId: string;
	status: "idle" | "running" | "done" | "error" | "cancelled";
	progress: number;
	currentDetail: string;
	samples: PreviewSample[];
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	settingsFingerprint: string;
	sampleCount: number;
	windowSeconds: number;
}

export type VsParamType = "float" | "int" | "bool" | "enum";
export type VsParamValue = number | boolean | string;
export type VsPresetSource = "stock" | "user";

export interface VsParamSpec {
	key: string;
	label: string;
	type: VsParamType;
	min?: number;
	max?: number;
	step?: number;
	enum?: string[];
	help?: string;
	/** Per-level default values. Keys must match the preset's `levels` array. */
	defaults: Record<string, VsParamValue>;
}

export interface VsPresetManifest {
	/** Namespaced id: "stock:finedehalo" or "user:my_dehalo". */
	id: string;
	/** Bare id from the manifest file (without source prefix). */
	bareId: string;
	name: string;
	description: string;
	category?: string;
	supports: { bitDepth: number[]; hdr: boolean };
	/** Ordered list of level names this preset offers (e.g. ["light","medium","heavy"]). */
	levels: string[];
	params: VsParamSpec[];
	source: VsPresetSource;
	/** Absolute path to the .vpy script. */
	scriptPath: string;
	/** Absolute path to the .json manifest. */
	manifestPath: string;
}

/**
 * One entry in a job's VapourSynth filter chain.
 *
 *   presetId : namespaced id of the preset to run.
 *   level    : "off" disables this entry without removing it; otherwise must
 *              be one of the preset's declared levels.
 *   params   : per-level override map. Pre-populated from manifest defaults
 *              when the entry is created; users can edit individual values
 *              in Advanced settings without losing other levels' tweaks.
 *              Shape: { [level]: { [paramKey]: value } }
 */
export interface VsFilterEntry {
	presetId: string;
	level: string;
	params: Record<string, Record<string, VsParamValue>>;
}
