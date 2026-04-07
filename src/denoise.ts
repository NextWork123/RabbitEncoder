import type { DenoiseLevel } from "./types";
import { Logger } from "./logger";

/** CPU nlmeans filter parameters for each denoise level. */
const NLMEANS_PARAMS: Record<string, string> = {
	light: "s=1:p=3:r=7",
	medium: "s=2:p=5:r=9",
	heavy: "s=3:p=7:r=11",
};

export interface DenoiseConfig {
	/** The -vf filter string to pass to FFmpeg. */
	filter: string;
	/** Extra args to insert before -i (e.g. OpenCL hw device init). */
	preInputArgs: string[];
	/** Whether this config uses GPU acceleration. */
	isGpu: boolean;
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
