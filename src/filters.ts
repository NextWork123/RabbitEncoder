import type { DenoiseLevel, DebandLevel } from "./types";
import { Logger } from "./logger";

/** CPU nlmeans filter parameters for each denoise level. */
const NLMEANS_PARAMS: Record<string, string> = {
	light: "s=1:p=3:r=7",
	medium: "s=2:p=5:r=9",
	heavy: "s=3:p=7:r=11",
};

/**
 * gradfun parameters for each deband level.
 *
 *   strength (0.51 – 64): max change per pixel / flatness threshold. Higher = more smoothing.
 *   radius   (8 – 32)   : neighbourhood size. Larger = smoother gradients, less detail protection.
 *
 * The filter also adds dither, which is why it must come before any denoise pass
 * (denoise would otherwise strip the dither and the bands come back).
 */
const GRADFUN_PARAMS: Record<string, string> = {
	light: "strength=0.8:radius=8",
	medium: "strength=1.4:radius=16",
	heavy: "strength=2.8:radius=24",
};

export interface DenoiseConfig {
	/** The -vf filter string to pass to FFmpeg. */
	filter: string;
	/** Extra args to insert before -i (e.g. OpenCL hw device init). */
	preInputArgs: string[];
	/** Whether this config uses GPU acceleration. */
	isGpu: boolean;
}

export interface DebandConfig {
	/** The -vf filter string to pass to FFmpeg. */
	filter: string;
}

export interface PrepareFilterConfig {
	/** The combined -vf filter string (scale + deband + denoise). */
	filter: string;
	/** Extra args to insert before -i (e.g. OpenCL hw device init). */
	preInputArgs: string[];
	/** Human-readable label for the step detail. */
	label: string;
}

/**
 * Probe whether FFmpeg can initialize an OpenCL device.
 * Runs `ffmpeg -init_hw_device opencl=gpu -f lavfi -i nullsrc -frames:v 1 -f null -`
 * and checks for a zero exit code.
 */
export async function isOpenClAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(
			["ffmpeg", "-hide_banner", "-init_hw_device", "opencl=gpu", "-f", "lavfi", "-i", "nullsrc=s=16x16:d=0.04", "-frames:v", "1", "-f", "null", "-"],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

/**
 * Build the DenoiseConfig for a given level and GPU preference.
 *
 * When `useGpu` is true, probes for OpenCL availability first.
 * Falls back to CPU nlmeans transparently if OpenCL is not available.
 */
export async function buildDenoiseConfig(level: DenoiseLevel, useGpu: boolean): Promise<DenoiseConfig | null> {
	const params = NLMEANS_PARAMS[level];
	if (!params) return null;

	if (useGpu) {
		const gpuAvailable = await isOpenClAvailable();
		if (gpuAvailable) {
			Logger.info("[denoise] OpenCL device detected, using GPU-accelerated nlmeans_opencl");
			return {
				filter: `hwupload,nlmeans_opencl=${params},hwdownload,format=yuv420p`,
				preInputArgs: ["-init_hw_device", "opencl=gpu", "-filter_hw_device", "gpu"],
				isGpu: true,
			};
		}
		Logger.warn("[denoise] GPU denoise requested but no OpenCL device found, falling back to CPU nlmeans");
	}

	return {
		filter: `nlmeans=${params}`,
		preInputArgs: [],
		isGpu: false,
	};
}

/**
 * Build the DebandConfig for a given level.
 *
 * Uses FFmpeg's native `gradfun` filter. gradfun has no OpenCL variant, so this
 * is CPU-only. It's light enough that this is rarely a bottleneck.
 */
export function buildDebandConfig(level: DebandLevel): DebandConfig | null {
	const params = GRADFUN_PARAMS[level];
	if (!params) return null;
	return {
		filter: `gradfun=${params}`,
	};
}

/**
 * Build a combined prepare filter config (downscale + deband + denoise).
 * Returns null if no filtering is needed.
 *
 * Filter order: scale → deband → denoise
 *   - Scale first so subsequent filters work on fewer pixels.
 *   - Deband before denoise because gradfun re-introduces dither; denoise
 *     (nlmeans) would otherwise smooth that dither out and the banding
 *     could return at low encode bitrates.
 *   - When GPU denoise is active, deband still runs on CPU and its output
 *     is handed to hwupload for the GPU pass.
 */
export async function buildPrepareFilterConfig(
	downscale: boolean,
	sourceHeight: number,
	denoise: DenoiseLevel,
	useGpuDenoise: boolean,
	deband: DebandLevel,
): Promise<PrepareFilterConfig | null> {
	const needsScale = downscale && sourceHeight > 1080;
	const scaleFilter = "scale=-2:1080:flags=lanczos";

	const debandConfig = buildDebandConfig(deband);
	const denoiseConfig = await buildDenoiseConfig(denoise, useGpuDenoise);

	if (!needsScale && !debandConfig && !denoiseConfig) return null;

	const parts: string[] = [];
	const preInputArgs: string[] = [];
	const labelParts: string[] = [];

	if (needsScale) {
		// Scale must come before GPU upload
		parts.push(scaleFilter);
		labelParts.push("Downscaling");
	}

	if (debandConfig) {
		parts.push(debandConfig.filter);
		labelParts.push(`Debanding (${deband})`);
	}

	if (denoiseConfig) {
		parts.push(denoiseConfig.filter);
		preInputArgs.push(...denoiseConfig.preInputArgs);
		const gpuLabel = denoiseConfig.isGpu ? " [GPU]" : " [CPU]";
		labelParts.push(`Denoising (${denoise}${gpuLabel})`);
	}

	return {
		filter: parts.join(","),
		preInputArgs,
		label: labelParts.join(" + "),
	};
}
