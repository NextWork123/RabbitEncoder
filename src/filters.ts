import type { DenoiseLevel, DebandLevel, GpuBackend } from "./types";
import { Logger } from "./logger";
import { buildAutoDenoiseFilter, type DenoisePlan } from "./auto-denoise";

/** CPU/GPU nlmeans filter parameters for each denoise level. */
export const NLMEANS_PARAMS: Record<string, string> = {
	light: "s=1.0:p=3:r=7",
	medium: "s=1.5:p=3:r=9",
	heavy: "s=2.0:p=3:r=11",
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
export const GRADFUN_PARAMS: Record<string, string> = {
	light: "strength=0.8:radius=8",
	medium: "strength=1.4:radius=16",
	heavy: "strength=2.8:radius=24",
};

const HW_DEVICE_NAME = "gpu";
const DEFAULT_OPENCL_DEVICE_ID = "0.0";
const DEFAULT_VULKAN_DEVICE_ID = "0";

export function defaultDeviceFor(backend: GpuBackend): string {
	return backend === "vulkan" ? DEFAULT_VULKAN_DEVICE_ID : DEFAULT_OPENCL_DEVICE_ID;
}

function buildOpenClDeviceSpec(deviceId: string): string {
	return `opencl=${HW_DEVICE_NAME}:${deviceId}`;
}

function buildVulkanDeviceSpec(deviceId: string): string {
	return `vulkan=${HW_DEVICE_NAME}:${deviceId}`;
}

export interface DenoiseConfig {
	/** The -vf filter string to pass to FFmpeg. */
	filter: string;
	/** Extra args to insert before -i (e.g. hw device init). */
	preInputArgs: string[];
	/** Whether this config uses GPU acceleration. */
	isGpu: boolean;
	/** Which backend was actually selected (null when running on CPU). */
	gpuBackend: GpuBackend | null;
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
	/** When set, the encoder runs runSegmentedAutoDenoiseGpu after the filter pass to apply per-range GPU denoise. */
	deferredAutoDenoise?: {
		plan: DenoisePlan;
		backend: GpuBackend;
		gpuDevice: string;
	};
}

export async function isOpenClAvailable(deviceId: string = DEFAULT_OPENCL_DEVICE_ID): Promise<boolean> {
	return runProbe([
		"-init_hw_device",
		buildOpenClDeviceSpec(deviceId),
		"-filter_hw_device",
		HW_DEVICE_NAME,
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=64x64:rate=1:duration=1",
		"-vf",
		`format=yuv420p,hwupload,nlmeans_opencl=${NLMEANS_PARAMS.light},hwdownload,format=yuv420p`,
		"-frames:v",
		"1",
		"-f",
		"null",
		"-",
	]);
}

export async function isVulkanAvailable(deviceId: string = DEFAULT_VULKAN_DEVICE_ID): Promise<boolean> {
	return runProbe([
		"-init_hw_device",
		buildVulkanDeviceSpec(deviceId),
		"-filter_hw_device",
		HW_DEVICE_NAME,
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=64x64:rate=1:duration=1",
		"-vf",
		`format=yuv420p,hwupload,nlmeans_vulkan=${NLMEANS_PARAMS.light},hwdownload,format=yuv420p`,
		"-frames:v",
		"1",
		"-f",
		"null",
		"-",
	]);
}

async function runProbe(extraArgs: string[]): Promise<boolean> {
	try {
		const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-v", "error", ...extraArgs], { stdout: "ignore", stderr: "pipe" });
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

interface BackendBuild {
	filter: string;
	preInputArgs: string[];
}

function buildOpenClChunk(level: DenoiseLevel, deviceId: string): BackendBuild {
	const params = NLMEANS_PARAMS[level]!;
	return {
		filter: `format=yuv420p,hwupload,nlmeans_opencl=${params},hwdownload,format=yuv420p`,
		preInputArgs: ["-init_hw_device", buildOpenClDeviceSpec(deviceId), "-filter_hw_device", HW_DEVICE_NAME],
	};
}

function buildVulkanChunk(level: DenoiseLevel, deviceId: string): BackendBuild {
	const params = NLMEANS_PARAMS[level]!;
	return {
		filter: `format=yuv420p,hwupload,nlmeans_vulkan=${params},hwdownload,format=yuv420p`,
		preInputArgs: ["-init_hw_device", buildVulkanDeviceSpec(deviceId), "-filter_hw_device", HW_DEVICE_NAME],
	};
}

/**
 * Build the DenoiseConfig for a given level, GPU preference, and backend.
 *
 * Probes the requested backend(s) and falls back to CPU nlmeans transparently
 * if no GPU path is usable.
 *
 *   - backend = "opencl": probe OpenCL only.
 *   - backend = "vulkan": probe Vulkan only.
 *   - backend = "auto"  : probe Vulkan first, then OpenCL, then CPU.
 *
 * `gpuDevice` is interpreted per-backend; if omitted, the backend default is
 * used ("0.0" for OpenCL, "0" for Vulkan).
 */
export async function buildDenoiseConfig(
	level: DenoiseLevel,
	useGpu: boolean,
	backend: GpuBackend = "opencl",
	gpuDevice?: string,
): Promise<DenoiseConfig | null> {
	if (!NLMEANS_PARAMS[level]) return null;

	if (!useGpu) return cpuFallback(level);

	const tryVulkan = async (): Promise<DenoiseConfig | null> => {
		const deviceId = gpuDevice ?? DEFAULT_VULKAN_DEVICE_ID;
		if (await isVulkanAvailable(deviceId)) {
			Logger.info(`[denoise] Vulkan nlmeans verified on device ${deviceId}, using nlmeans_vulkan`);
			const part = buildVulkanChunk(level, deviceId);
			return { ...part, isGpu: true, gpuBackend: "vulkan" };
		}
		Logger.warn(`[denoise] Vulkan probe failed on device ${deviceId}`);
		return null;
	};

	const tryOpenCl = async (): Promise<DenoiseConfig | null> => {
		const deviceId = gpuDevice ?? DEFAULT_OPENCL_DEVICE_ID;
		if (await isOpenClAvailable(deviceId)) {
			Logger.info(`[denoise] OpenCL nlmeans verified on device ${deviceId}, using nlmeans_opencl`);
			const part = buildOpenClChunk(level, deviceId);
			return { ...part, isGpu: true, gpuBackend: "opencl" };
		}
		Logger.warn(`[denoise] OpenCL probe failed on device ${deviceId}`);
		return null;
	};

	let result: DenoiseConfig | null = null;
	if (backend === "vulkan") {
		result = await tryVulkan();
	} else if (backend === "opencl") {
		result = await tryOpenCl();
	} else {
		result = (await tryVulkan()) ?? (await tryOpenCl());
	}

	if (result) return result;

	Logger.warn(`[denoise] No GPU backend available (requested: ${backend}), falling back to CPU nlmeans`);
	return cpuFallback(level);
}

function cpuFallback(level: DenoiseLevel): DenoiseConfig | null {
	const params = NLMEANS_PARAMS[level];
	if (!params) return null;
	return {
		filter: `nlmeans=${params}`,
		preInputArgs: [],
		isGpu: false,
		gpuBackend: null,
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
 *
 * Auto-denoise on GPU is handled via deferral: nlmeans_vulkan/nlmeans_opencl
 * don't honor enable= timeline expressions, so per-range gating can't be
 * baked into a single -vf graph. When buildAutoDenoiseFilter returns a
 * config with deferredPlan set, this function leaves the denoise out of the
 * filter graph and surfaces deferredAutoDenoise on the returned config; the
 * encoder then runs runSegmentedAutoDenoiseGpu after the filter pass.
 */
export async function buildPrepareFilterConfig(
	downscale: boolean,
	sourceHeight: number,
	denoise: DenoiseLevel,
	useGpuDenoise: boolean,
	deband: DebandLevel,
	backend: GpuBackend = "opencl",
	gpuDevice?: string,
	autoPlan: DenoisePlan | null = null,
	totalDuration?: number,
): Promise<PrepareFilterConfig | null> {
	const needsScale = downscale && sourceHeight > 1080;
	const scaleFilter = "scale=-2:1080:flags=lanczos";

	const debandConfig = buildDebandConfig(deband);

	let denoiseFilter: string | null = null;
	let denoisePreInputArgs: string[] = [];
	let denoiseLabel: string | null = null;
	let deferredAutoDenoise: PrepareFilterConfig["deferredAutoDenoise"] = undefined;

	if (denoise === "auto") {
		if (autoPlan && autoPlan.length > 0) {
			const auto = await buildAutoDenoiseFilter(autoPlan, useGpuDenoise, backend, gpuDevice, totalDuration);
			if (auto) {
				denoiseLabel = auto.label;

				if (auto.deferredPlan && auto.deferredBackend && auto.deferredGpuDevice) {
					// GPU path: defer to segmented stage, contribute nothing to the -vf graph.
					deferredAutoDenoise = {
						plan: auto.deferredPlan,
						backend: auto.deferredBackend,
						gpuDevice: auto.deferredGpuDevice,
					};
				} else {
					// CPU path: inline filter with enable= timeline expressions.
					denoiseFilter = auto.filter;
					denoisePreInputArgs = auto.preInputArgs;
				}
			}
		}
	} else {
		const denoiseConfig = await buildDenoiseConfig(denoise, useGpuDenoise, backend, gpuDevice);
		if (denoiseConfig) {
			denoiseFilter = denoiseConfig.filter;
			denoisePreInputArgs = denoiseConfig.preInputArgs;
			const tag = denoiseConfig.gpuBackend === "vulkan" ? " [GPU/Vulkan]" : denoiseConfig.gpuBackend === "opencl" ? " [GPU/OpenCL]" : " [CPU]";
			denoiseLabel = `Denoising (${denoise}${tag})`;
		}
	}

	if (!needsScale && !debandConfig && !denoiseFilter && !deferredAutoDenoise) return null;

	const parts: string[] = [];
	const preInputArgs: string[] = [];
	const labelParts: string[] = [];

	if (needsScale) {
		parts.push(scaleFilter);
		labelParts.push("Downscaling");
	}
	if (debandConfig) {
		parts.push(debandConfig.filter);
		labelParts.push(`Debanding (${deband})`);
	}
	if (denoiseFilter) {
		parts.push(denoiseFilter);
		preInputArgs.push(...denoisePreInputArgs);
	}
	if (denoiseLabel) {
		labelParts.push(denoiseLabel);
	}

	return {
		filter: parts.join(","),
		preInputArgs,
		label: labelParts.join(" + "),
		deferredAutoDenoise,
	};
}
