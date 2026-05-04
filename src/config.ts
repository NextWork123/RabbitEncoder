import { parseAutoThresholds } from "./auto-denoise";
import { DEFAULT_NLMEANS_PARAMS, DEFAULT_GRADFUN_PARAMS, normalizeNlmeansLevelParams, normalizeGradfunLevelParams } from "./filters";
import { Logger } from "./logger";
import { isValidDeviceSpec } from "./opencl";
import { run } from "./process";
import type {
	AppConfig,
	AudioChannelBitrates,
	DebandLevel,
	DenoiseBackend,
	DenoiseLevel,
	EncoderQuality,
	EncoderSpeed,
	GradfunLevelParams,
	NlmeansLevelParams,
} from "./types";
import { isValidVulkanDeviceSpec } from "./vulkan";

const DEFAULT_BITRATES: AudioChannelBitrates = {
	mono: 64,
	stereo: 128,
	"2.1": 160,
	"5.1": 256,
	"6.1": 320,
	"7.1": 384,
	"7.1.4": 512,
};

export async function getLanguageDetectorVersion(): Promise<string | null> {
	const res = await run(["language-detector", "--version"]);

	if (res.code !== 0) {
		Logger.error(`[subtitle] language-detector error: ${res.stderr || res.stdout}`);
		return null;
	}

	return res.stdout.replace("Language Detector", "").trim();
}

function parseDenoiseBackend(raw: string | undefined): DenoiseBackend {
	const v = (raw || "auto").trim().toLowerCase();
	if (v === "cpu" || v === "vulkan" || v === "auto" || v === "opencl") return v;
	Logger.warn(`[config] Unrecognized ENCODER_DENOISE_BACKEND="${raw}", falling back to "auto"`);
	return "auto";
}

function normalizeGpuDevice(rawSpec: string, backend: DenoiseBackend): string {
	const trimmed = rawSpec.trim();
	if (backend === "cpu") {
		return trimmed || "0";
	}
	if (backend === "vulkan") {
		if (isValidVulkanDeviceSpec(trimmed)) return trimmed;
		Logger.warn(`[config] ENCODER_DENOISE_GPU_DEVICE="${rawSpec}" is not a valid Vulkan device id (expected single integer), defaulting to "0"`);
		return "0";
	}
	if (isValidDeviceSpec(trimmed) || isValidVulkanDeviceSpec(trimmed)) return trimmed;
	Logger.warn(`[config] ENCODER_DENOISE_GPU_DEVICE="${rawSpec}" is not a valid device id, defaulting to "0.0"`);
	return "0.0";
}

/**
 * Parse a numeric env var (returns the fallback if missing/NaN).
 */
function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const v = parseFloat(raw);
	return Number.isFinite(v) ? v : fallback;
}

function readNlmeansParamsFromEnv(): NlmeansLevelParams {
	const raw: NlmeansLevelParams = {
		light: {
			s: envNum("ENCODER_DENOISE_LIGHT_S", DEFAULT_NLMEANS_PARAMS.light.s),
			p: envNum("ENCODER_DENOISE_LIGHT_P", DEFAULT_NLMEANS_PARAMS.light.p),
			r: envNum("ENCODER_DENOISE_LIGHT_R", DEFAULT_NLMEANS_PARAMS.light.r),
		},
		medium: {
			s: envNum("ENCODER_DENOISE_MEDIUM_S", DEFAULT_NLMEANS_PARAMS.medium.s),
			p: envNum("ENCODER_DENOISE_MEDIUM_P", DEFAULT_NLMEANS_PARAMS.medium.p),
			r: envNum("ENCODER_DENOISE_MEDIUM_R", DEFAULT_NLMEANS_PARAMS.medium.r),
		},
		heavy: {
			s: envNum("ENCODER_DENOISE_HEAVY_S", DEFAULT_NLMEANS_PARAMS.heavy.s),
			p: envNum("ENCODER_DENOISE_HEAVY_P", DEFAULT_NLMEANS_PARAMS.heavy.p),
			r: envNum("ENCODER_DENOISE_HEAVY_R", DEFAULT_NLMEANS_PARAMS.heavy.r),
		},
	};
	return normalizeNlmeansLevelParams(raw, DEFAULT_NLMEANS_PARAMS);
}

function readGradfunParamsFromEnv(): GradfunLevelParams {
	const raw: GradfunLevelParams = {
		light: {
			strength: envNum("ENCODER_DEBAND_LIGHT_STRENGTH", DEFAULT_GRADFUN_PARAMS.light.strength),
			radius: envNum("ENCODER_DEBAND_LIGHT_RADIUS", DEFAULT_GRADFUN_PARAMS.light.radius),
		},
		medium: {
			strength: envNum("ENCODER_DEBAND_MEDIUM_STRENGTH", DEFAULT_GRADFUN_PARAMS.medium.strength),
			radius: envNum("ENCODER_DEBAND_MEDIUM_RADIUS", DEFAULT_GRADFUN_PARAMS.medium.radius),
		},
		heavy: {
			strength: envNum("ENCODER_DEBAND_HEAVY_STRENGTH", DEFAULT_GRADFUN_PARAMS.heavy.strength),
			radius: envNum("ENCODER_DEBAND_HEAVY_RADIUS", DEFAULT_GRADFUN_PARAMS.heavy.radius),
		},
	};
	return normalizeGradfunLevelParams(raw, DEFAULT_GRADFUN_PARAMS);
}

export async function loadConfig(): Promise<AppConfig> {
	const quality = (process.env.ENCODER_QUALITY || "medium") as EncoderQuality;
	const finalSpeed = (process.env.ENCODER_SPEED || "slow") as EncoderSpeed;
	const denoise = (process.env.ENCODER_DENOISE || "off") as DenoiseLevel;

	const denoiseBackend = parseDenoiseBackend(process.env.ENCODER_DENOISE_BACKEND);
	const rawGpuDevice = (process.env.ENCODER_DENOISE_GPU_DEVICE || (denoiseBackend === "vulkan" ? "0" : "0.0")).trim();
	const gpuDevice = normalizeGpuDevice(rawGpuDevice, denoiseBackend);

	const deband = (process.env.ENCODER_DEBAND || "off") as DebandLevel;
	const downscale = ["true", "1", "yes"].includes((process.env.ENCODER_DOWNSCALE || "").toLowerCase());
	const skipBoosting = ["true", "1", "yes"].includes((process.env.ENCODER_SKIP_BOOSTING || "").toLowerCase());
	const noPhaseInv = ["true", "1", "yes"].includes((process.env.AUDIO_NO_PHASE_INV || "").toLowerCase());
	const dedupeSubtitles = ["true", "1", "yes"].includes((process.env.ENCODER_DEDUPE_SUBTITLES || "").toLowerCase());

	const audioLanguages = (process.env.AUDIO_LANGUAGES || "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const subtitleLanguages = (process.env.SUBTITLE_LANGUAGES || "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const bitrates: AudioChannelBitrates = {
		mono: parseInt(process.env.AUDIO_BITRATE_MONO || "") || DEFAULT_BITRATES.mono,
		stereo: parseInt(process.env.AUDIO_BITRATE_STEREO || "") || DEFAULT_BITRATES.stereo,
		"2.1": parseInt(process.env.AUDIO_BITRATE_2_1 || "") || DEFAULT_BITRATES["2.1"],
		"5.1": parseInt(process.env.AUDIO_BITRATE_5_1 || "") || DEFAULT_BITRATES["5.1"],
		"6.1": parseInt(process.env.AUDIO_BITRATE_6_1 || "") || DEFAULT_BITRATES["6.1"],
		"7.1": parseInt(process.env.AUDIO_BITRATE_7_1 || "") || DEFAULT_BITRATES["7.1"],
		"7.1.4": parseInt(process.env.AUDIO_BITRATE_7_1_4 || "") || DEFAULT_BITRATES["7.1.4"],
	};

	const autoDenoiseThresholds = parseAutoThresholds(
		process.env.ENCODER_DENOISE_AUTO_THRESHOLD_LIGHT,
		process.env.ENCODER_DENOISE_AUTO_THRESHOLD_MEDIUM,
		process.env.ENCODER_DENOISE_AUTO_THRESHOLD_HEAVY,
	);

	const nlmeansParams = readNlmeansParamsFromEnv();
	const gradfunParams = readGradfunParamsFromEnv();

	const libraryDirs = (process.env.LIBRARY_DIRS || "")
		.split(",")
		.map((d) => d.trim())
		.filter((d) => d.length > 0);

	const languageDetectorVersion = await getLanguageDetectorVersion();

	return {
		inputDir: process.env.INPUT_DIR || "/data/input",
		outputDir: process.env.OUTPUT_DIR || "/data/output",
		tempDir: process.env.TEMP_DIR || "/data/temp",
		port: parseInt(process.env.PORT || "3000"),
		organization: process.env.ORGANIZATION || "RabbitCompany",
		libraryDirs,
		languageDetector: {
			version: languageDetectorVersion,
		},
		defaults: {
			quality,
			finalSpeed,
			audioBitrates: bitrates,
			denoise,
			autoDenoiseThresholds,
			nlmeansParams,
			gradfunParams,
			denoiseBackend,
			gpuDevice,
			deband,
			downscale,
			skipBoosting,
			noPhaseInv,
			dedupeSubtitles,
			audioLanguages,
			subtitleLanguages,
		},
	};
}
