import { join } from "path";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { Logger } from "./logger";
import { CancelledError } from "./process";
import { NLMEANS_PARAMS } from "./filters";
import type { AutoDenoiseThresholds, GpuBackend } from "./types";

export const DEFAULT_AUTO_THRESHOLDS: AutoDenoiseThresholds = {
	light: 0.3,
	medium: 0.5,
	heavy: 0.7,
};

export interface DenoiseRange {
	/** Start time in seconds (inclusive). */
	start: number;
	/** End time in seconds (inclusive). */
	end: number;
	level: "light" | "medium" | "heavy";
}

export type DenoisePlan = DenoiseRange[];

export interface AutoDenoiseConfig {
	/** The -vf filter string to inject into the prepare filter graph. */
	filter: string;
	/** Args to insert before -i (hw device init when GPU is used). */
	preInputArgs: string[];
	/** Whether the GPU path was selected. */
	isGpu: boolean;
	/** Which backend was selected, or null when running on CPU. */
	gpuBackend: GpuBackend | null;
	/** Human-readable label, e.g. "Auto denoise (12×light + 3×medium, GPU/Vulkan)". */
	label: string;
	/** Total seconds covered by the plan (for logging / progress reporting). */
	denoisedSeconds: number;
}

interface NoiseSample {
	time: number;
	y: number;
}

const SAMPLE_EVERY_N_FRAMES = 12;
const SCDET_THRESHOLD = 10;
const SCENE_DETECT_HEIGHT = 480;
const MIN_SCENE_DURATION = 1.0;

/**
 * Parse three threshold env vars into an AutoDenoiseThresholds.
 * Falls back to defaults (with a warning) if values are missing, malformed,
 * or out of order.
 */
export function parseAutoThresholds(light: string | undefined, medium: string | undefined, heavy: string | undefined): AutoDenoiseThresholds {
	const fl = parseFloat(light || "");
	const fm = parseFloat(medium || "");
	const fh = parseFloat(heavy || "");

	const parsed: AutoDenoiseThresholds = {
		light: Number.isFinite(fl) ? fl : DEFAULT_AUTO_THRESHOLDS.light,
		medium: Number.isFinite(fm) ? fm : DEFAULT_AUTO_THRESHOLDS.medium,
		heavy: Number.isFinite(fh) ? fh : DEFAULT_AUTO_THRESHOLDS.heavy,
	};

	if (!(parsed.light <= parsed.medium && parsed.medium <= parsed.heavy)) {
		Logger.warn(
			`[auto-denoise] Thresholds out of order ` +
				`(light=${parsed.light}, medium=${parsed.medium}, heavy=${parsed.heavy}); ` +
				`require light ≤ medium ≤ heavy. Falling back to defaults.`,
		);
		return { ...DEFAULT_AUTO_THRESHOLDS };
	}

	return parsed;
}

export async function runAnalysisPass(
	inputPath: string,
	tempDir: string,
	totalDuration: number,
	thresholds: AutoDenoiseThresholds,
	signal?: AbortSignal,
): Promise<DenoisePlan | null> {
	const scenesLog = join(tempDir, "denoise_scenes.log");
	const noiseLog = join(tempDir, "denoise_noise.log");

	for (const p of [scenesLog, noiseLog]) {
		try {
			if (existsSync(p)) unlinkSync(p);
		} catch {}
	}

	// Filter chain notes:
	//   - split=2 fans the decoded stream into two parallel chains
	//   - chain A: downscale before scdet so cut detection is cheap; scdet must
	//     see consecutive frames, so no select before it
	//   - chain B: select samples first to drop ~91% of frames, then bitplanenoise
	//     measures noise on the survivors at full resolution
	//   - metadata=mode=print writes the lavfi.* k/v pairs to a file we parse later
	const filterComplex = [
		`[0:v]split=2[a][b];`,
		`[a]scale=-2:${SCENE_DETECT_HEIGHT},scdet=s=1:t=${SCDET_THRESHOLD},`,
		`metadata=mode=print:file='${escapeFilterPath(scenesLog)}'[s];`,
		`[b]select='not(mod(n\\,${SAMPLE_EVERY_N_FRAMES}))',`,
		`bitplanenoise=bitplane=4,`,
		`metadata=mode=print:file='${escapeFilterPath(noiseLog)}'[n]`,
	].join("");

	Logger.info(`[auto-denoise] Running analysis pass on ${inputPath}`);

	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-v",
			"error",
			"-i",
			inputPath,
			"-filter_complex",
			filterComplex,
			"-map",
			"[s]",
			"-an",
			"-sn",
			"-f",
			"null",
			"-",
			"-map",
			"[n]",
			"-an",
			"-sn",
			"-f",
			"null",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	let onAbort: (() => void) | undefined;
	if (signal) {
		onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 3000);
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;

	if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	if (signal?.aborted) throw new CancelledError();

	if (code !== 0) {
		Logger.warn(`[auto-denoise] Analysis pass failed (exit ${code}): ${stderrText.trim().slice(-500)}`);
		return null;
	}

	const cuts = parseSceneCuts(scenesLog);
	const samples = parseNoiseSamples(noiseLog);

	if (samples.length === 0) {
		Logger.warn(`[auto-denoise] No noise samples parsed from ${noiseLog}, skipping auto denoise`);
		return null;
	}

	const plan = buildPlan(samples, cuts, totalDuration, thresholds);

	const totalDenoised = plan.reduce((s, r) => s + (r.end - r.start), 0);
	const pct = totalDuration > 0 ? (100 * totalDenoised) / totalDuration : 0;
	const counts = { light: 0, medium: 0, heavy: 0 };
	for (const r of plan) counts[r.level]++;
	Logger.info(
		`[auto-denoise] Plan: ${plan.length} ranges ` +
			`(${counts.light}×light + ${counts.medium}×medium + ${counts.heavy}×heavy), ` +
			`${totalDenoised.toFixed(1)}s denoised (${pct.toFixed(1)}% of ${totalDuration.toFixed(1)}s)`,
	);

	// Cleanup the log files; we no longer need them.
	for (const p of [scenesLog, noiseLog]) {
		try {
			unlinkSync(p);
		} catch {}
	}

	return plan;
}

/**
 * Build a DenoiseConfig-shaped object from a plan.
 *
 * Chains one nlmeans per level, each gated by FFmpeg's `enable=` timeline
 * expression. When a frame is outside `enable`, the filter framework skips
 * invocation entirely — pass-through cost only.
 *
 * NOTE: This is currently CPU-only. nlmeans_vulkan and nlmeans_opencl don't
 * yet honor the `enable=` option, so per-range gating doesn't work on the
 * GPU variants — every frame would get denoised. When `useGpu` is true we
 * log a warning and fall back to CPU. GPU auto-denoise is planned for a
 * later pass that splits the source into per-range segments and encodes
 * each one independently, side-stepping the `enable=` limitation.
 *
 * Returns null if plan is empty (no scenes need denoising).
 */
export async function buildAutoDenoiseFilter(
	plan: DenoisePlan,
	useGpu: boolean,
	backend: GpuBackend = "opencl",
	gpuDevice?: string,
	totalDuration?: number,
): Promise<AutoDenoiseConfig | null> {
	if (plan.length === 0) return null;

	if (useGpu) {
		Logger.warn(
			`[auto-denoise] GPU backend (${backend}) requested but nlmeans_vulkan/nlmeans_opencl ` +
				`do not support enable= timeline expressions; falling back to CPU nlmeans. ` +
				`(gpuDevice=${gpuDevice ?? "default"})`,
		);
	}

	const byLevel = new Map<DenoiseRange["level"], DenoiseRange[]>();
	for (const r of plan) {
		const arr = byLevel.get(r.level);
		if (arr) arr.push(r);
		else byLevel.set(r.level, [r]);
	}

	const counts: Record<DenoiseRange["level"], number> = { light: 0, medium: 0, heavy: 0 };
	const seconds: Record<DenoiseRange["level"], number> = { light: 0, medium: 0, heavy: 0 };
	for (const r of plan) {
		counts[r.level]++;
		seconds[r.level] += r.end - r.start;
	}

	const filterParts: string[] = [];
	for (const level of ["light", "medium", "heavy"] as const) {
		const ranges = byLevel.get(level);
		if (!ranges || ranges.length === 0) continue;
		const params = NLMEANS_PARAMS[level]!;
		const enable = ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join("+");
		filterParts.push(`nlmeans=${params}:enable='${enable}'`);
	}

	const filter = filterParts.join(",");

	const showPct = totalDuration !== undefined && totalDuration > 0;
	const labelBits = (["light", "medium", "heavy"] as const)
		.filter((l) => counts[l] > 0)
		.map((l) => {
			if (showPct) {
				const pct = Math.round((100 * seconds[l]) / totalDuration!);
				return `${counts[l]}×${l} (${pct}%)`;
			}
			return `${counts[l]}×${l}`;
		});
	const label = `Auto denoise (${labelBits.join(" + ")}, CPU)`;

	const denoisedSeconds = plan.reduce((s, r) => s + (r.end - r.start), 0);

	return { filter, preInputArgs: [], isGpu: false, gpuBackend: null, label, denoisedSeconds };
}

/**
 * Build the per-scene plan from raw samples and cut times.
 *
 * Steps:
 *   1. Build scene boundaries [0, cut₁, cut₂, ..., totalDuration].
 *   2. For each scene, compute median Y bitplane-4 of contained samples
 *      and classify against thresholds. Empty scenes inherit from the
 *      previous scene's level.
 *   3. Short scenes (< MIN_SCENE_DURATION) inherit their level from the
 *      longer neighbor -> avoids filter thrashing on rapid cuts where the
 *      noise estimate is unreliable anyway.
 *   4. Drop 'off' scenes and merge consecutive same-level scenes into
 *      contiguous ranges.
 */
export function buildPlan(samples: NoiseSample[], cuts: number[], totalDuration: number, thresholds: AutoDenoiseThresholds): DenoisePlan {
	if (totalDuration <= 0) return [];

	const sortedCuts = cuts
		.slice()
		.sort((a, b) => a - b)
		.filter((c) => c > 0 && c < totalDuration);
	const boundaries = [0, ...sortedCuts, totalDuration];

	type Scene = { start: number; end: number; level: "off" | "light" | "medium" | "heavy" };
	const scenes: Scene[] = [];

	let sIdx = 0;
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i]!;
		const end = boundaries[i + 1]!;
		if (end <= start) continue;

		const ys: number[] = [];
		while (sIdx < samples.length && samples[sIdx]!.time < start) sIdx++;
		let probe = sIdx;
		while (probe < samples.length && samples[probe]!.time < end) {
			ys.push(samples[probe]!.y);
			probe++;
		}

		let level: Scene["level"];
		if (ys.length === 0) {
			level = scenes.length > 0 ? scenes[scenes.length - 1]!.level : "off";
		} else {
			level = classifyNoise(median(ys), thresholds);
		}

		scenes.push({ start, end, level });
	}

	for (let i = 0; i < scenes.length; i++) {
		const s = scenes[i]!;
		if (s.end - s.start >= MIN_SCENE_DURATION) continue;
		const prev = scenes[i - 1];
		const next = scenes[i + 1];
		if (prev && next) {
			const prevLen = prev.end - prev.start;
			const nextLen = next.end - next.start;
			s.level = prevLen >= nextLen ? prev.level : next.level;
		} else if (prev) {
			s.level = prev.level;
		} else if (next) {
			s.level = next.level;
		}
	}

	const plan: DenoisePlan = [];
	for (const s of scenes) {
		if (s.level === "off") continue;
		const last = plan[plan.length - 1];
		if (last && last.level === s.level && Math.abs(last.end - s.start) < 0.01) {
			last.end = s.end;
		} else {
			plan.push({ start: s.start, end: s.end, level: s.level });
		}
	}

	return plan;
}

function classifyNoise(value: number, t: AutoDenoiseThresholds): "off" | "light" | "medium" | "heavy" {
	if (value < t.light) return "off";
	if (value < t.medium) return "light";
	if (value < t.heavy) return "medium";
	return "heavy";
}

function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) return 0;
	if (n % 2 === 1) return sorted[(n - 1) / 2]!;
	return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function parseSceneCuts(path: string): number[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const cuts: number[] = [];
	// scdet only emits scd.time when a cut is actually detected, so every
	// match here is a real cut. (Other lavfi.* keys appear on every frame.)
	const re = /lavfi\.scd\.time=(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const v = parseFloat(m[1]!);
		if (Number.isFinite(v)) cuts.push(v);
	}
	return cuts;
}

function parseNoiseSamples(path: string): NoiseSample[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const samples: NoiseSample[] = [];
	// pts_time is on the `frame:` header line, bitplanenoise.0.4 follows it
	// later. The DOTALL-ish window between them is bounded by the next frame.
	const re = /pts_time:(\S+)[^]*?lavfi\.bitplanenoise\.0\.4=(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const t = parseFloat(m[1]!);
		const y = parseFloat(m[2]!);
		if (Number.isFinite(t) && Number.isFinite(y)) samples.push({ time: t, y });
	}
	return samples;
}

function escapeFilterPath(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}
