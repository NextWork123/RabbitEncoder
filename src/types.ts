export type EncoderQuality = "low" | "medium" | "high";
export type EncoderSpeed = "slower" | "slow" | "medium" | "fast" | "faster";
export type DenoiseLevel = "off" | "light" | "medium" | "heavy" | "auto";
export type DebandLevel = "off" | "light" | "medium" | "heavy";

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
	audioLanguages: string[];
	subtitleLanguages: string[];
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
