import { DEFAULT_AUTO_THRESHOLDS } from "./auto-denoise";
import { DEFAULT_NLMEANS_PARAMS, DEFAULT_GRADFUN_PARAMS } from "./filters";
import { Logger } from "./logger";
import { run } from "./process";
import type { AppConfig, AudioChannelBitrates, JobSettings } from "./types";

const DEFAULT_BITRATES: AudioChannelBitrates = {
	mono: 64,
	stereo: 128,
	"2.1": 160,
	"5.1": 256,
	"6.1": 320,
	"7.1": 384,
	"7.1.4": 512,
};

const DEFAULT_JOB_SETTINGS: JobSettings = {
	encoder: "svt-av1-essential",
	manualCrf: 24,
	manualPreset: 4,
	tune: 1,
	customEncoderParams: "",
	videoEncode: "av1",
	audioEncode: "opus",
	subtitleProcessing: "full",
	quality: "medium",
	finalSpeed: "slow",
	denoise: "off",
	autoDenoiseThresholds: DEFAULT_AUTO_THRESHOLDS,
	nlmeansParams: DEFAULT_NLMEANS_PARAMS,
	gradfunParams: DEFAULT_GRADFUN_PARAMS,
	denoiseBackend: "auto",
	gpuDevice: "0.0",
	deband: "off",
	downscale: false,
	skipBoosting: false,
	noPhaseInv: false,
	dedupeSubtitles: false,
	keepBestAudioChannelsOnly: false,
	removeCommentaryAudio: false,
	audioLanguages: [],
	subtitleLanguages: [],
	audioBitrates: DEFAULT_BITRATES,
	vsFilters: [],
};

export function getDefaultJobSettings(): JobSettings {
	return structuredClone(DEFAULT_JOB_SETTINGS);
}

export async function getLanguageDetectorVersion(): Promise<string | null> {
	const res = await run(["language-detector", "--version"]);
	if (res.code !== 0) {
		Logger.error(`[subtitle] language-detector error: ${res.stderr || res.stdout}`);
		return null;
	}
	return res.stdout.replace("Language Detector", "").trim();
}

export async function loadConfig(): Promise<AppConfig> {
	const libraryDirs = (process.env.LIBRARY_DIRS || "")
		.split(",")
		.map((d) => d.trim())
		.filter((d) => d.length > 0);

	return {
		inputDir: process.env.INPUT_DIR || "/data/input",
		outputDir: process.env.OUTPUT_DIR || "/data/output",
		tempDir: process.env.TEMP_DIR || "/data/temp",
		port: parseInt(process.env.PORT || "3000"),
		organization: process.env.ORGANIZATION || "RabbitCompany",
		libraryDirs,
		languageDetector: { version: await getLanguageDetectorVersion() },
		defaults: getDefaultJobSettings(),
	};
}
