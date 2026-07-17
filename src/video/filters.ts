import type {
	DenoiseLevel,
	DebandLevel,
	GpuBackend,
	DenoiseBackend,
	NlmeansParams,
	NlmeansLevelParams,
	GradfunParams,
	GradfunLevelParams,
	CropMode,
} from "../core/types";
import { Logger } from "../core/logger";
import { buildAutoDenoiseFilter, type DenoisePlan } from "./auto-denoise";
import { run } from "../core/process";

/** Default nlmeans parameters per level. Used when env vars / settings don't override. */
export const DEFAULT_NLMEANS_PARAMS: NlmeansLevelParams = {
	light: { s: 1.0, p: 3, r: 7 },
	medium: { s: 1.5, p: 3, r: 9 },
	heavy: { s: 2.0, p: 3, r: 11 },
};

/**
 * Default gradfun parameters per level.
 *
 *   strength (0.51 – 64): max change per pixel / flatness threshold. Higher = more smoothing.
 *   radius   (8 – 32)   : neighbourhood size. Larger = smoother gradients, less detail protection.
 */
export const DEFAULT_GRADFUN_PARAMS: GradfunLevelParams = {
	light: { strength: 0.8, radius: 8 },
	medium: { strength: 1.4, radius: 16 },
	heavy: { strength: 2.8, radius: 24 },
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

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

function nearestOdd(v: number, min: number, max: number): number {
	const clamped = clamp(Math.round(v), min, max);
	return clamped % 2 === 0 ? clamped + 1 : clamped;
}

/** Validate & clamp a single nlmeans param triplet to legal ranges. */
export function normalizeNlmeansParams(p: Partial<NlmeansParams>, fallback: NlmeansParams): NlmeansParams {
	const sRaw = typeof p.s === "number" && Number.isFinite(p.s) ? p.s : fallback.s;
	const pRaw = typeof p.p === "number" && Number.isFinite(p.p) ? p.p : fallback.p;
	const rRaw = typeof p.r === "number" && Number.isFinite(p.r) ? p.r : fallback.r;
	return {
		s: clamp(sRaw, 1.0, 30.0),
		p: nearestOdd(pRaw, 1, 99),
		r: nearestOdd(rRaw, 1, 99),
	};
}

/** Validate & clamp a level-keyed nlmeans param object. */
export function normalizeNlmeansLevelParams(p: Partial<NlmeansLevelParams> | undefined, fallback: NlmeansLevelParams): NlmeansLevelParams {
	return {
		light: normalizeNlmeansParams(p?.light ?? {}, fallback.light),
		medium: normalizeNlmeansParams(p?.medium ?? {}, fallback.medium),
		heavy: normalizeNlmeansParams(p?.heavy ?? {}, fallback.heavy),
	};
}

/** Validate & clamp a single gradfun param pair to legal ranges. */
export function normalizeGradfunParams(p: Partial<GradfunParams>, fallback: GradfunParams): GradfunParams {
	const strengthRaw = typeof p.strength === "number" && Number.isFinite(p.strength) ? p.strength : fallback.strength;
	const radiusRaw = typeof p.radius === "number" && Number.isFinite(p.radius) ? p.radius : fallback.radius;
	return {
		strength: clamp(strengthRaw, 0.51, 64),
		radius: clamp(Math.round(radiusRaw), 8, 32),
	};
}

/** Validate & clamp a level-keyed gradfun param object. */
export function normalizeGradfunLevelParams(p: Partial<GradfunLevelParams> | undefined, fallback: GradfunLevelParams): GradfunLevelParams {
	return {
		light: normalizeGradfunParams(p?.light ?? {}, fallback.light),
		medium: normalizeGradfunParams(p?.medium ?? {}, fallback.medium),
		heavy: normalizeGradfunParams(p?.heavy ?? {}, fallback.heavy),
	};
}

/** Format an nlmeans param triplet as the `s=...:p=...:r=...` string passed to FFmpeg. */
export function formatNlmeansParams(p: NlmeansParams): string {
	return `s=${p.s}:p=${p.p}:r=${p.r}`;
}

/** Format a gradfun param pair as the `strength=...:radius=...` string passed to FFmpeg. */
export function formatGradfunParams(p: GradfunParams): string {
	return `strength=${p.strength}:radius=${p.radius}`;
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

interface CropRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PrepareFilterStep {
	/** Discrete kind — used for artifact filenames and frontend routing. */
	kind: "crop" | "downscale" | "deband" | "denoise";
	/** The -vf filter string for this step alone. */
	filter: string;
	/** Args to insert before -i (only the denoise step needs hw device init). */
	preInputArgs: string[];
	/** Human-readable label (e.g. "Debanding (medium)"). */
	label: string;
}

export interface PrepareFilterConfig {
	/** The combined -vf filter string (scale + deband + denoise). */
	filter: string;
	/** Extra args to insert before -i (e.g. OpenCL hw device init). */
	preInputArgs: string[];
	/** Human-readable label for the step detail. */
	label: string;
	/** Per-step breakdown of the same filter chain. */
	steps: PrepareFilterStep[];
	/** When set, the encoder runs runSegmentedAutoDenoiseGpu after the filter pass to apply per-range GPU denoise. */
	deferredAutoDenoise?: {
		plan: DenoisePlan;
		backend: GpuBackend;
		gpuDevice: string;
		nlmeansParams: NlmeansLevelParams;
	};
}

export async function isOpenClAvailable(deviceId: string = DEFAULT_OPENCL_DEVICE_ID): Promise<boolean> {
	const probeParams = formatNlmeansParams(DEFAULT_NLMEANS_PARAMS.light);
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
		`format=yuv420p,hwupload,nlmeans_opencl=${probeParams},hwdownload,format=yuv420p`,
		"-frames:v",
		"1",
		"-f",
		"null",
		"-",
	]);
}

export async function isVulkanAvailable(deviceId: string = DEFAULT_VULKAN_DEVICE_ID): Promise<boolean> {
	const probeParams = formatNlmeansParams(DEFAULT_NLMEANS_PARAMS.light);
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
		`format=yuv420p,hwupload,nlmeans_vulkan=${probeParams},hwdownload,format=yuv420p`,
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

function buildOpenClChunk(level: DenoiseLevel, deviceId: string, params: NlmeansLevelParams): BackendBuild {
	const lvl = params[level as keyof NlmeansLevelParams];
	const formatted = formatNlmeansParams(lvl);
	return {
		filter: `format=yuv420p,hwupload,nlmeans_opencl=${formatted},hwdownload,format=yuv420p`,
		preInputArgs: ["-init_hw_device", buildOpenClDeviceSpec(deviceId), "-filter_hw_device", HW_DEVICE_NAME],
	};
}

function buildVulkanChunk(level: DenoiseLevel, deviceId: string, params: NlmeansLevelParams): BackendBuild {
	const lvl = params[level as keyof NlmeansLevelParams];
	const formatted = formatNlmeansParams(lvl);
	return {
		filter: `format=yuv420p,hwupload,nlmeans_vulkan=${formatted},hwdownload,format=yuv420p`,
		preInputArgs: ["-init_hw_device", buildVulkanDeviceSpec(deviceId), "-filter_hw_device", HW_DEVICE_NAME],
	};
}

function cpuFallback(level: DenoiseLevel, params: NlmeansLevelParams): DenoiseConfig | null {
	const lvl = params[level as keyof NlmeansLevelParams];
	if (!lvl) return null;
	return {
		filter: `nlmeans=${formatNlmeansParams(lvl)}`,
		preInputArgs: [],
		isGpu: false,
		gpuBackend: null,
	};
}

/**
 * Build the DenoiseConfig for a given level and backend.
 *
 * The backend semantics:
 *   - "cpu"    : never probe, always run on CPU.
 *   - "auto"   : probe Vulkan, then OpenCL, then fall back to CPU.
 *   - "vulkan" : probe Vulkan only; fall back to CPU on failure.
 *   - "opencl" : probe OpenCL only; fall back to CPU on failure.
 *
 * `gpuDevice` is interpreted per-backend; if omitted, the backend default is
 * used ("0.0" for OpenCL, "0" for Vulkan).
 */
export async function buildDenoiseConfig(
	level: DenoiseLevel,
	backend: DenoiseBackend,
	gpuDevice: string | undefined,
	nlmeansParams: NlmeansLevelParams,
): Promise<DenoiseConfig | null> {
	if (level === "off" || level === "auto") return null;
	if (!nlmeansParams[level as keyof NlmeansLevelParams]) return null;

	if (backend === "cpu") return cpuFallback(level, nlmeansParams);

	const tryVulkan = async (): Promise<DenoiseConfig | null> => {
		const deviceId = gpuDevice ?? DEFAULT_VULKAN_DEVICE_ID;
		if (await isVulkanAvailable(deviceId)) {
			Logger.info(`[denoise] Vulkan nlmeans verified on device ${deviceId}, using nlmeans_vulkan`);
			const part = buildVulkanChunk(level, deviceId, nlmeansParams);
			return { ...part, isGpu: true, gpuBackend: "vulkan" };
		}
		Logger.warn(`[denoise] Vulkan probe failed on device ${deviceId}`);
		return null;
	};

	const tryOpenCl = async (): Promise<DenoiseConfig | null> => {
		const deviceId = gpuDevice ?? DEFAULT_OPENCL_DEVICE_ID;
		if (await isOpenClAvailable(deviceId)) {
			Logger.info(`[denoise] OpenCL nlmeans verified on device ${deviceId}, using nlmeans_opencl`);
			const part = buildOpenClChunk(level, deviceId, nlmeansParams);
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
		// auto
		result = (await tryVulkan()) ?? (await tryOpenCl());
	}

	if (result) return result;

	Logger.warn(`[denoise] No GPU backend available (requested: ${backend}), falling back to CPU nlmeans`);
	return cpuFallback(level, nlmeansParams);
}

/**
 * Build the DebandConfig for a given level using user-supplied gradfun params.
 *
 * Uses FFmpeg's native `gradfun` filter. gradfun has no GPU variant, so this
 * is CPU-only. It's light enough that this is rarely a bottleneck.
 */
export function buildDebandConfig(level: DebandLevel, params: GradfunLevelParams): DebandConfig | null {
	if (level === "off") return null;
	const lvl = params[level as keyof GradfunLevelParams];
	if (!lvl) return null;

	return {
		filter: `gradfun=${formatGradfunParams(lvl)}`,
	};
}

interface CropRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface FrameSize {
	width: number;
	height: number;
}

export function isFullFrameCrop(rect: CropRect, frame?: FrameSize): boolean {
	if (!frame || !frame.width || !frame.height) return false;
	return rect.x === 0 && rect.y === 0 && rect.w >= frame.width && rect.h >= frame.height;
}

/**
 * Detect non‑black crop rectangle using ffmpeg's cropdetect filter.
 * Returns null if no significant crop is found (or detection fails).
 */
export async function detectCrop(inputPath: string, limit: number, signal?: AbortSignal, frame?: FrameSize): Promise<CropRect | null> {
	const args = ["ffmpeg", "-hide_banner", "-i", inputPath, "-vf", `cropdetect=round=2:skip=0:reset=0:limit=${limit}`, "-t", "30", "-f", "null", "-"];

	const { code, stderr } = await run(args, { signal });
	if (code !== 0) return null;

	const cropRe = /crop=(\d+):(\d+):(\d+):(\d+)/;
	let lastCrop: CropRect | null = null;
	for (const line of stderr.split("\n")) {
		const m = line.match(cropRe);
		if (!m) continue;
		const rect = { w: +m[1]!, h: +m[2]!, x: +m[3]!, y: +m[4]! };
		if (rect.w <= 0 || rect.h <= 0) continue;
		if (isFullFrameCrop(rect, frame)) continue; // nothing to cut
		lastCrop = rect;
	}

	return lastCrop;
}

export function buildCropFilter(rect: CropRect): string {
	return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
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
export interface PrepareFilterInput {
	inputPath: string;
	downscale: boolean;
	crop: CropMode;
	cropLimit: number;
	sourceHeight: number;
	sourceWidth: number;
	denoise: DenoiseLevel;
	denoiseBackend: DenoiseBackend;
	deband: DebandLevel;
	gpuDevice: string;
	nlmeansParams: NlmeansLevelParams;
	gradfunParams: GradfunLevelParams;
	autoPlan?: DenoisePlan | null;
	totalDuration?: number;
}

export async function buildPrepareFilterConfig(input: PrepareFilterInput): Promise<PrepareFilterConfig | null> {
	const {
		downscale,
		crop,
		cropLimit,
		sourceHeight,
		sourceWidth,
		denoise,
		denoiseBackend,
		deband,
		gpuDevice,
		nlmeansParams,
		gradfunParams,
		autoPlan = null,
		totalDuration,
	} = input;

	let cropFilter: string | null = null;
	let cropLabel: string | null = null;
	let cropRect: CropRect | null = null;

	if (crop === "auto") {
		const frame = { width: input.sourceWidth, height: input.sourceHeight };
		cropRect = await detectCrop(input.inputPath, cropLimit, undefined, frame);

		if (cropRect && isFullFrameCrop(cropRect, frame)) cropRect = null;

		if (cropRect) {
			cropFilter = buildCropFilter(cropRect);
			cropLabel = `Cropping to ${cropRect.w}x${cropRect.h}`;
		} else {
			Logger.info(`[crop] No bars detected at ${input.sourceWidth}x${input.sourceHeight} — skipping crop step`);
		}
	}

	let denoiseFilter: string | null = null;
	let denoisePreInputArgs: string[] = [];
	let denoiseLabel: string | null = null;
	let deferredAutoDenoise: PrepareFilterConfig["deferredAutoDenoise"] = undefined;

	if (denoise === "auto") {
		if (autoPlan && autoPlan.length > 0) {
			const auto = await buildAutoDenoiseFilter(autoPlan, denoiseBackend, gpuDevice, nlmeansParams, totalDuration);
			if (auto) {
				denoiseLabel = auto.label;

				if (auto.deferredPlan && auto.deferredBackend && auto.deferredGpuDevice) {
					// GPU path: defer to segmented stage, contribute nothing to the -vf graph.
					deferredAutoDenoise = {
						plan: auto.deferredPlan,
						backend: auto.deferredBackend,
						gpuDevice: auto.deferredGpuDevice,
						nlmeansParams,
					};
				} else {
					// CPU path: inline filter with enable= timeline expressions.
					denoiseFilter = auto.filter;
					denoisePreInputArgs = auto.preInputArgs;
				}
			}
		}
	} else if (denoise !== "off") {
		const denoiseConfig = await buildDenoiseConfig(denoise, denoiseBackend, gpuDevice, nlmeansParams);
		if (denoiseConfig) {
			denoiseFilter = denoiseConfig.filter;
			denoisePreInputArgs = denoiseConfig.preInputArgs;
			const tag = denoiseConfig.gpuBackend === "vulkan" ? " [GPU/Vulkan]" : denoiseConfig.gpuBackend === "opencl" ? " [GPU/OpenCL]" : " [CPU]";
			denoiseLabel = `Denoising (${denoise}${tag})`;
		}
	}

	const parts: string[] = [];
	const preInputArgs: string[] = [];
	const labelParts: string[] = [];
	const steps: PrepareFilterStep[] = [];

	if (cropFilter) {
		parts.push(cropFilter);
		labelParts.push(cropLabel!);
		steps.push({ kind: "crop", filter: cropFilter, preInputArgs: [], label: cropLabel! });
	}

	const needsScale = downscale && sourceHeight > 1080;
	if (needsScale) {
		const scaleFilter = "scale=-2:1080:flags=lanczos";
		parts.push(scaleFilter);
		labelParts.push("Downscaling");
		steps.push({ kind: "downscale", filter: scaleFilter, preInputArgs: [], label: "Downscaling" });
	}

	const debandConfig = buildDebandConfig(deband, gradfunParams);
	if (debandConfig) {
		parts.push(debandConfig.filter);
		labelParts.push(`Debanding (${deband})`);
		steps.push({ kind: "deband", filter: debandConfig.filter, preInputArgs: [], label: `Debanding (${deband})` });
	}

	if (denoiseFilter) {
		parts.push(denoiseFilter);
		preInputArgs.push(...denoisePreInputArgs);
		labelParts.push(denoiseLabel!);
		steps.push({ kind: "denoise", filter: denoiseFilter, preInputArgs: denoisePreInputArgs, label: denoiseLabel! });
	}

	// Return only if something changed
	if (parts.length === 0 && !deferredAutoDenoise) return null;

	return {
		filter: parts.join(","),
		preInputArgs,
		label: labelParts.join(" + "),
		steps,
		deferredAutoDenoise,
	};
}
