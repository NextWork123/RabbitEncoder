import { Logger } from "./logger";
import { isOpenClAvailable, NLMEANS_PARAMS } from "./filters";
import { getAllJobs } from "./store";
import { getCpuName } from "./system";
import { listOpenClDevices } from "./opencl";

const DURATION = 10;
const SIZE = "1920x1080";
const RATE = 24;
const TOTAL_FRAMES = DURATION * RATE;

export type BenchmarkLevel = "light" | "medium" | "heavy";
export type BenchmarkMode = "cpu" | "gpu";
export type BenchmarkStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface StartBenchmarkOptions {
	gpuDevice: string;
}

export interface BenchmarkResult {
	mode: BenchmarkMode;
	level: BenchmarkLevel;
	/** Frames-per-second computed from the wall time reported by ffmpeg's -benchmark. */
	fps: number | null;
	/** Last 'fps=' value reported by ffmpeg in its progress lines. */
	ffmpegFps: number | null;
	/** Last 'speed=' value (e.g. '1.04x'). */
	speed: string | null;
	/** Wall-clock time of the ffmpeg process in seconds. */
	rtime: number | null;
	/** User CPU time in seconds. */
	utime: number | null;
	/** System CPU time in seconds. */
	stime: number | null;
	/** Non-null when this run failed. */
	error: string | null;
}

export interface BenchmarkState {
	status: BenchmarkStatus;
	startedAt: number | null;
	completedAt: number | null;
	/** Synthetic source duration (seconds). */
	duration: number;
	/** Synthetic source size, e.g. '1920x1080'. */
	size: string;
	/** Synthetic source frame rate. */
	rate: number;
	/** Total frames per run (duration * rate). */
	totalFrames: number;
	/** Total runs that will be performed (3 if GPU unavailable, 6 otherwise). */
	totalSteps: number;
	/** Index (1-based) of the run currently in flight. */
	currentStep: number;
	/** Human-readable label for the run currently in flight. */
	currentLabel: string | null;
	/** Completed and in-progress results, in execution order. */
	results: BenchmarkResult[];
	/** null until the OpenCL probe completes. */
	gpuAvailable: boolean | null;
	/** Set when the whole run failed (not when an individual ffmpeg returned non-zero). */
	error: string | null;
	/** CPU model name. */
	cpuName: string | null;
	/** GPU model name being (or to be) benchmarked. */
	gpuName: string | null;
	/** GPU device id (e.g. "0.0"). */
	gpuDevice: string | null;
}

let state: BenchmarkState = newIdleState();
let abortController: AbortController | null = null;

function newIdleState(): BenchmarkState {
	return {
		status: "idle",
		startedAt: null,
		completedAt: null,
		duration: DURATION,
		size: SIZE,
		rate: RATE,
		totalFrames: TOTAL_FRAMES,
		totalSteps: 6,
		currentStep: 0,
		currentLabel: null,
		results: [],
		gpuAvailable: null,
		error: null,
		cpuName: getCpuName(),
		gpuName: null,
		gpuDevice: null,
	};
}

export async function getBenchmarkState(currentGpuDevice: string): Promise<BenchmarkState> {
	if (state.status !== "running") {
		state.cpuName = getCpuName();
		state.gpuDevice = currentGpuDevice;
		const devices = await listOpenClDevices();
		state.gpuName = devices.find((d) => d.id === currentGpuDevice)?.deviceName ?? null;
	}
	return state;
}

export function isBenchmarkRunning(): boolean {
	return state.status === "running";
}

function isAnythingEncoding(): boolean {
	return getAllJobs().some((j) => j.status !== "queued" && j.status !== "done" && j.status !== "error" && j.status !== "cancelled");
}

/** Last `\d+(\.\d+)?` capture from a /g regex, or null. */
function findLastNumber(text: string, regex: RegExp): number | null {
	let last: number | null = null;
	for (const m of text.matchAll(regex)) {
		const v = parseFloat(m[1]!);
		if (!isNaN(v)) last = v;
	}
	return last;
}

/** Last group-1 capture from a /g regex, or null. */
function findLastString(text: string, regex: RegExp): string | null {
	let last: string | null = null;
	for (const m of text.matchAll(regex)) {
		last = m[1]!;
	}
	return last;
}

async function runFfmpeg(args: string[], signal: AbortSignal): Promise<{ code: number; stderr: string }> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	} catch (err: any) {
		return { code: -1, stderr: `Failed to spawn ffmpeg: ${err?.message || err}` };
	}

	const onAbort = () => {
		try {
			proc.kill("SIGTERM");
		} catch {}
		setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 3000);
	};

	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	const [, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	const code = await proc.exited;

	signal.removeEventListener("abort", onAbort);

	return { code, stderr };
}

async function runSingle(mode: BenchmarkMode, level: BenchmarkLevel, signal: AbortSignal): Promise<BenchmarkResult> {
	const params = NLMEANS_PARAMS[level]!;

	const args: string[] =
		mode === "gpu"
			? [
					"ffmpeg",
					"-hide_banner",
					"-benchmark",
					"-v",
					"info",
					"-init_hw_device",
					"opencl=gpu:0.0",
					"-filter_hw_device",
					"gpu",
					"-f",
					"lavfi",
					"-i",
					`testsrc2=size=${SIZE}:rate=${RATE}:duration=${DURATION}`,
					"-vf",
					`format=yuv420p,hwupload,nlmeans_opencl=${params},hwdownload,format=yuv420p`,
					"-f",
					"null",
					"-",
				]
			: [
					"ffmpeg",
					"-hide_banner",
					"-benchmark",
					"-v",
					"info",
					"-f",
					"lavfi",
					"-i",
					`testsrc2=size=${SIZE}:rate=${RATE}:duration=${DURATION}`,
					"-vf",
					`format=yuv420p,nlmeans=${params}`,
					"-f",
					"null",
					"-",
				];

	const { code, stderr } = await runFfmpeg(args, signal);

	if (code !== 0) {
		const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
		return {
			mode,
			level,
			fps: null,
			ffmpegFps: null,
			speed: null,
			rtime: null,
			utime: null,
			stime: null,
			error: tail || `ffmpeg exited with code ${code}`,
		};
	}

	const rtime = findLastNumber(stderr, /rtime=\s*([\d.]+)/g);
	const utime = findLastNumber(stderr, /utime=\s*([\d.]+)/g);
	const stime = findLastNumber(stderr, /stime=\s*([\d.]+)/g);
	const ffmpegFps = findLastNumber(stderr, /\bfps=\s*([\d.]+)/g);
	const speed = findLastString(stderr, /\bspeed=\s*([\d.]+x)/g);
	const fps = rtime && rtime > 0 ? Math.round((TOTAL_FRAMES / rtime) * 100) / 100 : null;

	if (rtime === null) {
		const tail = stderr.trim().split("\n").slice(-6).join(" | ").slice(0, 800);
		Logger.warn(
			`[benchmark] Could not parse rtime from ffmpeg stderr ` +
				`(stderr length=${stderr.length}, mode=${mode}, level=${level}). ` +
				`Last lines: ${tail || "<empty>"}`,
		);
	}

	return {
		mode,
		level,
		fps,
		ffmpegFps,
		speed,
		rtime,
		utime,
		stime,
		error: null,
	};
}

export interface StartResult {
	ok: boolean;
	error?: string;
}

export async function startBenchmark(options: StartBenchmarkOptions): Promise<StartResult> {
	if (state.status === "running") return { ok: false, error: "Benchmark already running" };
	if (isAnythingEncoding()) return { ok: false, error: "Cannot run benchmark while encoding is in progress" };

	abortController = new AbortController();
	state = { ...newIdleState(), status: "running", startedAt: Date.now() };

	runBenchmarkAsync(abortController.signal, options).catch((err) => {
		Logger.error(`[benchmark] Unhandled error: ${err?.message || err}`);
		state.status = "failed";
		state.error = err?.message || String(err);
		state.completedAt = Date.now();
	});

	return { ok: true };
}

export function cancelBenchmark(): boolean {
	if (state.status !== "running") return false;
	abortController?.abort();
	state.status = "cancelled";
	state.completedAt = Date.now();
	return true;
}

async function runBenchmarkAsync(signal: AbortSignal, options: StartBenchmarkOptions): Promise<void> {
	Logger.info(`[benchmark] Starting denoise benchmark on device ${options.gpuDevice}`);

	state.cpuName = getCpuName();
	state.gpuDevice = options.gpuDevice;
	const devices = await listOpenClDevices();
	state.gpuName = devices.find((d) => d.id === options.gpuDevice)?.deviceName ?? null;

	state.currentLabel = "Probing OpenCL availability";
	const gpuAvailable = await isOpenClAvailable();
	state.gpuAvailable = gpuAvailable;
	if (!gpuAvailable) {
		Logger.warn(`[benchmark] OpenCL not available on ${options.gpuDevice}, GPU runs will be skipped`);
	}

	if (signal.aborted) {
		state.status = "cancelled";
		state.completedAt = Date.now();
		return;
	}

	const levels: BenchmarkLevel[] = ["light", "medium", "heavy"];
	const modes: BenchmarkMode[] = gpuAvailable ? ["cpu", "gpu"] : ["cpu"];
	state.totalSteps = levels.length * modes.length;

	for (const mode of modes) {
		for (const level of levels) {
			if (signal.aborted) {
				state.status = "cancelled";
				state.completedAt = Date.now();
				return;
			}

			state.currentStep++;
			state.currentLabel = `${mode === "gpu" ? "GPU nlmeans_opencl" : "CPU nlmeans"} - ${level}`;
			Logger.info(`[benchmark] ${state.currentLabel}`);

			const result = await runSingle(mode, level, signal);
			state.results.push(result);

			if (result.error) {
				Logger.warn(`[benchmark] ${state.currentLabel} failed: ${result.error}`);
			} else {
				const fpsStr = result.fps !== null ? result.fps.toFixed(2) : "?";
				const rtimeStr = result.rtime !== null ? result.rtime.toFixed(2) : "?";
				const speedStr = result.speed ?? "?";
				Logger.info(`[benchmark] ${state.currentLabel} → ${fpsStr} fps (rtime=${rtimeStr}s, speed=${speedStr})`);
			}
		}
	}

	state.status = "completed";
	state.currentLabel = null;
	state.completedAt = Date.now();
	Logger.info("[benchmark] Completed");
}
