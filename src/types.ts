export type EncoderQuality = "low" | "medium" | "high";
export type EncoderSpeed = "slower" | "slow" | "medium" | "fast" | "faster";
export type DenoiseLevel = "off" | "light" | "medium" | "heavy";

export type JobStatus = "queued" | "probing" | "encoding_video" | "encoding_audio" | "muxing" | "done" | "error" | "cancelled";

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

export interface JobSettings {
	quality: EncoderQuality;
	finalSpeed: EncoderSpeed;
	audioBitrates: AudioChannelBitrates;
	denoise: DenoiseLevel;
	denoiseGpu: boolean;
	downscale: boolean;
	skipBoosting: boolean;
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
}

export interface ProbeResult {
	filename: string;
	width: number;
	height: number;
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
