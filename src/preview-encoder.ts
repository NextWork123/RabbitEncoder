import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { join, parse as parsePath } from "path";
import type { AppConfig, Job, JobSettings, PreviewSample, PreviewState, ProbeResult } from "./types";
import { probeFile } from "./probe";
import { CancelledError, describeExitCode, humanSize, run } from "./process";
import { Logger } from "./logger";
import { buildPrepareFilterConfig } from "./filters";
import { FFV1_ENCODE_ARGS, runAnalysisPass, runSegmentedAutoDenoiseGpu } from "./auto-denoise";

export interface PreviewEncodeOptions {
	sampleCount: number;
	windowSeconds: number;
}

export const DEFAULT_PREVIEW_OPTIONS: PreviewEncodeOptions = {
	sampleCount: 6,
	windowSeconds: 5,
};

export function previewDirFor(config: AppConfig, jobId: string): string {
	return join(config.tempDir, `${jobId}_preview`);
}

export function previewSettingsFingerprint(s: JobSettings): string {
	return JSON.stringify({
		quality: s.quality,
		finalSpeed: s.finalSpeed,
		denoise: s.denoise,
		denoiseBackend: s.denoiseBackend,
		gpuDevice: s.gpuDevice,
		deband: s.deband,
		downscale: s.downscale,
		skipBoosting: s.skipBoosting,
		nlmeansParams: s.nlmeansParams,
		gradfunParams: s.gradfunParams,
		autoDenoiseThresholds: s.autoDenoiseThresholds,
	});
}

interface PreviewColorInfo {
	args: string[];
	range: "tv" | "pc" | null;
	space: string | null;
}

function previewMatrixFromColorSpace(space: string | null, height: number): string {
	if (space === "bt2020nc" || space === "bt2020c") return "bt2020";
	if (space === "smpte170m" || space === "bt470bg") return "bt601";
	if (space === "bt709") return "bt709";

	// Fallback: HD is normally BT.709, SD is normally BT.601.
	return height >= 720 ? "bt709" : "bt601";
}

function buildPreviewPngExtractArgs(inputPath: string, seekSec: string, outputPath: string, color: PreviewColorInfo, probe: ProbeResult): string[] {
	const inRange = color.range === "pc" ? "pc" : "tv";
	const matrix = previewMatrixFromColorSpace(color.space, probe.height);

	return [
		"ffmpeg",
		"-y",
		"-ss",
		seekSec,
		"-i",
		inputPath,
		"-frames:v",
		"1",
		"-vf",
		`scale=in_range=${inRange}:out_range=pc:in_color_matrix=${matrix}:out_color_matrix=bt709,format=rgb24,setparams=range=pc:colorspace=gbr:color_primaries=bt709:color_trc=iec61966-2-1`,
		"-map_metadata",
		"-1",
		"-update",
		"1",
		outputPath,
	];
}

async function probeColorInfo(inputPath: string): Promise<PreviewColorInfo> {
	const proc = Bun.spawn(
		["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_range,color_primaries,color_trc,color_space", "-of", "json", inputPath],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;

	let s: any = {};
	try {
		s = JSON.parse(out)?.streams?.[0] ?? {};
	} catch {}

	const clean = (v: unknown): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		if (!t || t === "unknown" || t === "N/A") return undefined;
		return t;
	};

	const args: string[] = [];
	const range = clean(s.color_range);
	const primaries = clean(s.color_primaries);
	const trc = clean(s.color_trc);
	const space = clean(s.color_space);
	if (range) args.push("-color_range", range);
	if (primaries) args.push("-color_primaries", primaries);
	if (trc) args.push("-color_trc", trc);
	if (space) args.push("-colorspace", space);

	return {
		args,
		range: range === "pc" ? "pc" : range === "tv" ? "tv" : null,
		space: space || null,
	};
}

function pickSampleTimestamps(duration: number, count: number, windowSeconds: number): number[] {
	if (count <= 0 || duration <= 0) return [];

	const headMargin = duration * 0.05;
	const tailMargin = duration * 0.05 + windowSeconds;
	const usable = duration - headMargin - tailMargin;

	if (usable <= 0) {
		const stamps: number[] = [];
		for (let i = 0; i < count; i++) {
			stamps.push(Math.min(i * windowSeconds, Math.max(0, duration - windowSeconds)));
		}
		return stamps;
	}

	const stamps: number[] = [];
	for (let i = 0; i < count; i++) {
		const frac = count === 1 ? 0.5 : i / (count - 1);
		stamps.push(headMargin + frac * usable);
	}
	return stamps;
}

interface SampleContext {
	index: number;
	startSec: number;
	windowSec: number;
	dir: string;
}

async function encodeSample(
	ctx: SampleContext,
	job: Job,
	probe: ProbeResult,
	colorArgs: string[],
	colorInfo: PreviewColorInfo,
	signal: AbortSignal,
	onProgress: (frac: number, detail: string) => void,
): Promise<PreviewSample> {
	mkdirSync(ctx.dir, { recursive: true });

	const sourceClip = join(ctx.dir, "source.mkv");
	const filteredClip = join(ctx.dir, "filtered.mkv");
	const encodedClip = join(ctx.dir, "encoded.mkv");
	const sourceFrame = join(ctx.dir, "source.png");
	const encodeFrame = join(ctx.dir, "encode.png");

	const checkCancelled = () => {
		if (signal.aborted) throw new CancelledError();
	};

	// 1. Extract source window with FFV1 (lossless, frame-accurate).
	checkCancelled();
	onProgress(0.05, "Extracting source clip");

	const extractRes = await run(
		[
			"ffmpeg",
			"-y",
			"-ss",
			ctx.startSec.toFixed(3),
			"-i",
			job.inputPath,
			"-t",
			ctx.windowSec.toFixed(3),
			"-map",
			"0:v:0",
			"-an",
			"-sn",
			...colorArgs,
			...FFV1_ENCODE_ARGS,
			sourceClip,
		],
		{ signal },
	);
	if (extractRes.code !== 0) {
		throw new Error(`Source clip extraction failed: ${extractRes.stderr.slice(-500)}`);
	}

	// 2. Optional per-clip auto-denoise analysis.
	let autoPlan = null;
	if (job.settings.denoise === "auto") {
		checkCancelled();
		onProgress(0.1, "Analysing clip noise");
		try {
			autoPlan = await runAnalysisPass(sourceClip, ctx.dir, ctx.windowSec, job.settings.autoDenoiseThresholds, signal);
		} catch (err) {
			if (err instanceof CancelledError) throw err;
			Logger.warn(`[preview] Auto-denoise analysis failed for sample ${ctx.index}: ${err instanceof Error ? err.message : err}`);
		}
	}

	// 3. Apply the prepare filter the real encode uses.
	checkCancelled();
	onProgress(0.15, "Applying filters");

	const prepareFilter = await buildPrepareFilterConfig({
		downscale: job.settings.downscale,
		sourceHeight: probe.height,
		denoise: job.settings.denoise,
		denoiseBackend: job.settings.denoiseBackend,
		deband: job.settings.deband,
		gpuDevice: job.settings.gpuDevice,
		nlmeansParams: job.settings.nlmeansParams,
		gradfunParams: job.settings.gradfunParams,
		autoPlan,
		totalDuration: ctx.windowSec,
	});

	let abeInput = sourceClip;
	if (prepareFilter) {
		const filterArgs = ["ffmpeg", "-y", ...prepareFilter.preInputArgs, "-i", sourceClip, ...colorArgs];
		if (prepareFilter.filter) filterArgs.push("-vf", prepareFilter.filter);
		filterArgs.push(...FFV1_ENCODE_ARGS, "-an", "-sn", filteredClip);

		const filterRes = await run(filterArgs, { signal });
		if (filterRes.code !== 0) {
			throw new Error(`Filter pass failed: ${filterRes.stderr.slice(-500)}`);
		}
		abeInput = filteredClip;
	}

	if (prepareFilter?.deferredAutoDenoise) {
		checkCancelled();
		onProgress(0.2, "Auto-denoise (segmented GPU)");

		const { plan, backend, gpuDevice, nlmeansParams } = prepareFilter.deferredAutoDenoise;
		const denoisedClip = join(ctx.dir, "denoised.mkv");

		Logger.info(`[preview] Sample ${ctx.index}: running segmented GPU auto-denoise ` + `(${plan.length} ranges, ${backend} on device ${gpuDevice})`);

		await runSegmentedAutoDenoiseGpu(
			filteredClip,
			denoisedClip,
			plan,
			ctx.windowSec,
			backend,
			gpuDevice,
			ctx.dir,
			nlmeansParams,
			(i, n, label) => {
				const segFrac = n > 0 ? i / n : 1;
				onProgress(0.2 + 0.04 * segFrac, `Auto denoise — segment ${i}/${n} (${label})`);
			},
			signal,
		);

		try {
			rmSync(filteredClip);
		} catch {}
		renameSync(denoisedClip, filteredClip);
		abeInput = filteredClip;
	}

	// 4. Run Auto-Boost-Essential on the filtered clip.
	checkCancelled();
	onProgress(0.25, "Encoding (Auto-Boost-Essential)");

	const abeArgs = [
		"python3",
		"-u",
		"/opt/Auto-Boost-Essential/Auto-Boost-Essential.py",
		"-i",
		abeInput,
		"-t",
		join(ctx.dir, "abe_temp"),
		"--quality",
		job.settings.quality,
		"--final-speed",
		job.settings.finalSpeed,
		"--json-stream",
	];
	if (job.settings.skipBoosting) abeArgs.push("-nb");

	const abeProc = Bun.spawn(abeArgs, { stdout: "pipe", stderr: "pipe", cwd: ctx.dir });

	const onAbortAbe = () => {
		try {
			abeProc.kill("SIGTERM");
		} catch {}
		setTimeout(() => {
			try {
				abeProc.kill("SIGKILL");
			} catch {}
		}, 3000);
	};
	signal.addEventListener("abort", onAbortAbe, { once: true });

	let abeStderr = "";
	let abeLastError = "";

	const stdoutTask = (async () => {
		if (!abeProc.stdout) return;
		const reader = abeProc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const evt = JSON.parse(line);
					if (evt.event === "stage_complete" && typeof evt.stage === "number") {
						const stagePct = Math.min(1, (evt.stage + 1) / 5);
						onProgress(0.25 + 0.7 * stagePct, `Encoding — stage ${evt.stage + 1}/5 done`);
					} else if (evt.event === "error" && typeof evt.message === "string") {
						abeLastError = evt.message;
					}
				} catch {
					// Non-JSON line; ignore — only the JSON events matter here.
				}
			}
		}
	})();

	const stderrTask = (async () => {
		if (!abeProc.stderr) return;
		abeStderr = await new Response(abeProc.stderr).text();
	})();

	const abeCode = await abeProc.exited;
	await Promise.all([stdoutTask, stderrTask]);
	signal.removeEventListener("abort", onAbortAbe);
	checkCancelled();

	if (abeCode !== 0) {
		const detail = abeLastError || abeStderr.trim().slice(-500) || describeExitCode(abeCode);
		throw new Error(`Auto-Boost-Essential failed (exit ${abeCode}): ${detail}`);
	}

	const abeInputParsed = parsePath(abeInput);
	const ivfFile = join(abeInputParsed.dir, `${abeInputParsed.name}.ivf`);
	if (!existsSync(ivfFile)) {
		throw new Error(`Encoder did not produce output .ivf file (expected ${ivfFile})`);
	}

	// 5. Mux .ivf to .mkv so browsers can play it back.
	checkCancelled();
	onProgress(0.95, "Muxing encoded clip");

	const muxRes = await run(["mkvmerge", "-o", encodedClip, ivfFile], { signal });
	if (muxRes.code !== 0 && muxRes.code !== 1) {
		throw new Error(`mkvmerge failed: ${muxRes.stderr || muxRes.stdout}`);
	}

	// 6. Pull a representative frame out of both clips at the centre of the
	// window. Seek before -i for speed; both clips were re-encoded as keyframe
	// every-frame (FFV1 / ABE output) so seek is exact.
	checkCancelled();
	onProgress(0.98, "Extracting comparison frames");

	const frameOffset = (ctx.windowSec / 2).toFixed(3);

	const sourceFrameRes = await run(buildPreviewPngExtractArgs(sourceClip, frameOffset, sourceFrame, colorInfo, probe), {
		signal,
	});
	if (sourceFrameRes.code !== 0) {
		throw new Error(`Source frame extraction failed: ${sourceFrameRes.stderr.slice(-500)}`);
	}

	const encodeFrameRes = await run(buildPreviewPngExtractArgs(encodedClip, frameOffset, encodeFrame, colorInfo, probe), {
		signal,
	});
	if (encodeFrameRes.code !== 0) {
		throw new Error(`Encode frame extraction failed: ${encodeFrameRes.stderr.slice(-500)}`);
	}

	const encodedSize = statSync(encodedClip).size;
	const projectedTotalBytes = Math.round((encodedSize / ctx.windowSec) * probe.duration);
	const encodedBitrateKbps = Math.round((encodedSize * 8) / 1000 / ctx.windowSec);

	try {
		if (existsSync(sourceClip)) rmSync(sourceClip);
		if (existsSync(filteredClip)) rmSync(filteredClip);
		if (existsSync(ivfFile)) rmSync(ivfFile);
		rmSync(join(ctx.dir, "abe_temp"), { recursive: true, force: true });
	} catch {}

	onProgress(1, "Complete");

	return {
		index: ctx.index,
		timestampSec: ctx.startSec,
		windowSeconds: ctx.windowSec,
		encodedSizeBytes: encodedSize,
		encodedSizeHuman: humanSize(encodedSize),
		projectedTotalBytes,
		projectedTotalHuman: humanSize(projectedTotalBytes),
		encodedBitrateKbps,
	};
}

export interface RunPreviewArgs {
	job: Job;
	config: AppConfig;
	options?: Partial<PreviewEncodeOptions>;
	signal: AbortSignal;
	onUpdate: (partial: Partial<PreviewState>) => void;
}

export async function runPreviewEncode(args: RunPreviewArgs): Promise<PreviewSample[]> {
	const { job, config, signal, onUpdate } = args;
	const opts: PreviewEncodeOptions = { ...DEFAULT_PREVIEW_OPTIONS, ...(args.options || {}) };

	if (!existsSync(job.inputPath)) {
		throw new Error("Source file no longer accessible");
	}

	const probe = job.probe ?? (await probeFile(job.inputPath));

	const colorInfo = await probeColorInfo(job.inputPath);
	const colorArgs = colorInfo.args;
	Logger.info(`[preview] Color tags: ${colorArgs.join(" ") || "(none)"}`);

	if (probe.duration <= opts.windowSeconds) {
		throw new Error(`Source is shorter than one preview window (${probe.duration.toFixed(1)}s ≤ ${opts.windowSeconds}s)`);
	}

	const baseDir = previewDirFor(config, job.id);

	try {
		rmSync(baseDir, { recursive: true, force: true });
	} catch {}
	mkdirSync(baseDir, { recursive: true });

	const stamps = pickSampleTimestamps(probe.duration, opts.sampleCount, opts.windowSeconds);
	Logger.info(`[preview] Job ${job.id}: ${stamps.length} sample(s) at ${stamps.map((s) => s.toFixed(1) + "s").join(", ")}`);

	const completed: PreviewSample[] = [];

	for (let i = 0; i < stamps.length; i++) {
		if (signal.aborted) throw new CancelledError();

		const sampleDir = join(baseDir, `sample_${String(i).padStart(2, "0")}`);
		const ctx: SampleContext = {
			index: i,
			startSec: stamps[i]!,
			windowSec: opts.windowSeconds,
			dir: sampleDir,
		};

		try {
			const sample = await encodeSample(ctx, job, probe, colorArgs, colorInfo, signal, (frac, detail) => {
				const overall = (i + frac) / stamps.length;
				onUpdate({
					progress: Math.round(overall * 1000) / 10,
					currentDetail: `Sample ${i + 1}/${stamps.length} — ${detail}`,
				});
			});
			completed.push(sample);
			onUpdate({ samples: [...completed] });
		} catch (err) {
			if (err instanceof CancelledError) throw err;
			throw new Error(`Sample ${i + 1}/${stamps.length} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return completed;
}

export function resolvePreviewArtifact(config: AppConfig, jobId: string, sampleIndex: number, kind: "source" | "encode" | "clip"): string | null {
	const dir = join(previewDirFor(config, jobId), `sample_${String(sampleIndex).padStart(2, "0")}`);
	let file: string;
	switch (kind) {
		case "source":
			file = join(dir, "source.png");
			break;
		case "encode":
			file = join(dir, "encode.png");
			break;
		case "clip":
			file = join(dir, "encoded.mkv");
			break;
		default:
			return null;
	}
	return existsSync(file) ? file : null;
}

export function deletePreviewDir(config: AppConfig, jobId: string): void {
	try {
		rmSync(previewDirFor(config, jobId), { recursive: true, force: true });
	} catch {}
}
