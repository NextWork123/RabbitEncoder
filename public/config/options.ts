import type {
	AudioChannelBitrates,
	AudioEncodeMode,
	DebandLevel,
	DenoiseBackend,
	DenoiseLevel,
	EncoderId,
	EncoderQuality,
	EncoderSpeed,
	SubtitleProcessingMode,
	VideoEncodeMode,
} from "../types";
import type { PipelinePreset } from "../ui/models";

export const ENCODERS: Record<
	EncoderId,
	{ label: string; usesAutoBoost: boolean; crfMin: number; crfMax: number; presetMin: number; presetMax: number; defaultCrf: number; defaultPreset: number }
> = {
	"svt-av1-essential": {
		label: "SVT-AV1-Essential",
		usesAutoBoost: true,
		crfMin: 0,
		crfMax: 63,
		presetMin: 0,
		presetMax: 13,
		defaultCrf: 28,
		defaultPreset: 4,
	},
	"svt-av1-hdr": { label: "SVT-AV1-HDR", usesAutoBoost: false, crfMin: 0, crfMax: 63, presetMin: 0, presetMax: 13, defaultCrf: 24, defaultPreset: 4 },
};
export const ENCODER_IDS = Object.keys(ENCODERS) as EncoderId[];
export const ENCODER_HELP: Record<EncoderId, string> = {
	"svt-av1-essential": "Auto-Boost-Essential: per-scene CRF optimization.",
	"svt-av1-hdr": "Direct encode with manual CRF / preset. No auto-boost.",
};

export const TUNE_OPTIONS = [
	{ value: 0, label: "0 - VQ (max detail retention)" },
	{ value: 1, label: "1 - PSNR (default)" },
	{ value: 2, label: "2 - SSIM" },
	{ value: 4, label: "4 - MS-SSIM" },
	{ value: 5, label: "5 - Film Grain" },
];

export const QUALITIES: readonly EncoderQuality[] = ["low", "medium", "high"];
export const SPEEDS: readonly EncoderSpeed[] = ["slower", "slow", "medium", "fast", "faster"];
export const DENOISE_LEVELS: readonly DenoiseLevel[] = ["off", "auto", "light", "medium", "heavy"];
export const DEBAND_LEVELS: readonly DebandLevel[] = ["off", "light", "medium", "heavy"];
export const PARAM_LEVELS = ["light", "medium", "heavy"] as const;

export const DENOISE_BACKENDS: readonly DenoiseBackend[] = ["cpu", "auto", "vulkan", "opencl"];

export const DEFAULT_NLMEANS_PARAMS = {
	light: { s: 1.0, p: 3, r: 7 },
	medium: { s: 1.5, p: 3, r: 9 },
	heavy: { s: 2.0, p: 3, r: 11 },
};
export const DEFAULT_GRADFUN_PARAMS = {
	light: { strength: 0.8, radius: 8 },
	medium: { strength: 1.4, radius: 16 },
	heavy: { strength: 2.8, radius: 24 },
};
export const DEFAULT_AUTO_THRESHOLDS = { light: 0.5, medium: 0.7, heavy: 0.9 };

export const CHANNELS: readonly { key: keyof AudioChannelBitrates; label: string }[] = [
	{ key: "mono", label: "Mono" },
	{ key: "stereo", label: "Stereo" },
	{ key: "2.1", label: "2.1" },
	{ key: "5.1", label: "5.1" },
	{ key: "6.1", label: "6.1" },
	{ key: "7.1", label: "7.1" },
	{ key: "7.1.4", label: "7.1.4 Atmos" },
];

export const PIPELINE_PRESETS: readonly PipelinePreset[] = ["full", "prepare", "custom"];
export const VIDEO_ENCODE_OPTIONS: readonly VideoEncodeMode[] = ["av1", "off"];
export const AUDIO_ENCODE_OPTIONS: readonly AudioEncodeMode[] = ["opus", "copy"];
export const SUBTITLE_PROCESSING_OPTIONS: readonly SubtitleProcessingMode[] = ["full", "copy"];

export const PIPELINE_PRESET_HELP: Record<PipelinePreset, string> = {
	full: "Denoise, AV1, Opus, full subtitle pipeline.",
	prepare: "Run denoise & VS only; pass audio/subs/video through (FFV1). For GPU-only servers.",
	custom: "Configure each pipeline stage individually below.",
};
