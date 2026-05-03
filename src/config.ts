import { parseAutoThresholds } from "./auto-denoise";
import { Logger } from "./logger";
import { isValidDeviceSpec } from "./opencl";
import { run } from "./process";
import type { AppConfig, AudioChannelBitrates, DebandLevel, DenoiseLevel, EncoderQuality, EncoderSpeed, GpuBackend } from "./types";
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

function parseGpuBackend(raw: string | undefined): GpuBackend {
	const v = (raw || "opencl").trim().toLowerCase();
	if (v === "vulkan" || v === "auto" || v === "opencl") return v;
	Logger.warn(`[config] Unrecognized ENCODER_GPU_BACKEND="${raw}", falling back to "opencl"`);
	return "opencl";
}

function normalizeGpuDevice(rawSpec: string, backend: GpuBackend): string {
	const trimmed = rawSpec.trim();
	if (backend === "vulkan") {
		if (isValidVulkanDeviceSpec(trimmed)) return trimmed;
		Logger.warn(`[config] ENCODER_GPU_DEVICE="${rawSpec}" is not a valid Vulkan device id (expected single integer), defaulting to "0"`);
		return "0";
	}
	if (isValidDeviceSpec(trimmed) || isValidVulkanDeviceSpec(trimmed)) return trimmed;
	Logger.warn(`[config] ENCODER_GPU_DEVICE="${rawSpec}" is not a valid device id, defaulting to "0.0"`);
	return "0.0";
}

export async function loadConfig(): Promise<AppConfig> {
	const quality = (process.env.ENCODER_QUALITY || "medium") as EncoderQuality;
	const finalSpeed = (process.env.ENCODER_SPEED || "slow") as EncoderSpeed;
	const denoise = (process.env.ENCODER_DENOISE || "off") as DenoiseLevel;
	const denoiseGpu = ["true", "1", "yes"].includes((process.env.ENCODER_DENOISE_GPU || "").toLowerCase());
	const gpuBackend = parseGpuBackend(process.env.ENCODER_GPU_BACKEND);
	const rawGpuDevice = (process.env.ENCODER_GPU_DEVICE || (gpuBackend === "vulkan" ? "0" : "0.0")).trim();
	const gpuDevice = normalizeGpuDevice(rawGpuDevice, gpuBackend);
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
		process.env.ENCODER_DENOISE_AUTO_LIGHT,
		process.env.ENCODER_DENOISE_AUTO_MEDIUM,
		process.env.ENCODER_DENOISE_AUTO_HEAVY,
	);

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
			denoiseGpu,
			gpuBackend,
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
