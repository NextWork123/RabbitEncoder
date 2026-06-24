import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { join, parse as parsePath } from "path";
import type { AppConfig, Job, JobSettings, PreviewSample, PreviewSamplePrepareFrame, PreviewSampleVsFrame, PreviewState, ProbeResult } from "./types";
import { probeFile } from "./probe";
import { CancelledError, describeExitCode, humanSize, run } from "./process";
import { Logger } from "./logger";
import { buildPrepareFilterConfig } from "./filters";
import { FFV1_ENCODE_ARGS, runAnalysisPass, runSegmentedAutoDenoiseGpu } from "./auto-denoise";
import { formatVsProgressDetail, runVsPass, vsRegistry } from "./vs-filters";
import { applyColorMetadata, svtColorParamsFromProbe } from "./color-metadata";
import { getEncoder } from "./encoders";

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
		vsFilters: s.vsFilters ?? [],
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
	const sourceClipKept = join(ctx.dir, "source_clip.mkv");

	const checkCancelled = () => {
		if (signal.aborted) throw new CancelledError();
	};

	const frameOffset = (ctx.windowSec / 2).toFixed(3);
	const vsFrames: PreviewSampleVsFrame[] = [];
	const prepareFrames: PreviewSamplePrepareFrame[] = [];

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

	// 1a. Capture the source PNG NOW, before any VS pass touches source
	checkCancelled();
	const sourceFrameRes = await run(buildPreviewPngExtractArgs(sourceClip, frameOffset, sourceFrame, colorInfo, probe), { signal });
	if (sourceFrameRes.code !== 0) {
		throw new Error(`Source frame extraction failed: ${sourceFrameRes.stderr.slice(-500)}`);
	}

	// 1b. Preserve the raw (pre-filter) source clip for A/B download. The working
	// `sourceClip` is overwritten by the VS chain and deleted on cleanup, so copy
	// the untouched FFV1 extract now.
	checkCancelled();
	try {
		copyFileSync(sourceClip, sourceClipKept);
	} catch (err: any) {
		Logger.warn(`[preview] Failed to preserve source clip for sample ${ctx.index}: ${err?.message || err}`);
	}

	// 1.5. VapourSynth filter chain
	const activeVsEntries = (job.settings.vsFilters ?? []).filter((e) => e.level !== "off");

	if (activeVsEntries.length > 0) {
		const totalFrames = Math.max(1, Math.round(ctx.windowSec * probe.videoStreamFps));
		let currentInput = sourceClip;

		for (let i = 0; i < activeVsEntries.length; i++) {
			checkCancelled();
			const entry = activeVsEntries[i]!;
			const manifest = vsRegistry.get(entry.presetId);
			if (!manifest) {
				Logger.warn(`[preview] Skipping unknown VS preset: ${entry.presetId}`);
				continue;
			}

			const outPath = join(ctx.dir, `vs_${i}_${manifest.bareId}.mkv`);
			const passBaseFrac = i / activeVsEntries.length;
			const passShareFrac = 1 / activeVsEntries.length;

			Logger.info(`[preview] Sample ${ctx.index} VS pass ${i + 1}/${activeVsEntries.length}: ` + `${manifest.id} level=${entry.level}`);
			onProgress(0.05 + 0.05 * passBaseFrac, formatVsProgressDetail(manifest.name, entry.level, 0, totalFrames, null));

			await runVsPass({
				manifest,
				entry,
				inputPath: currentInput,
				outputPath: outPath,
				totalFrames,
				signal,
				onProgress: (current, fps) => {
					const passFrac = totalFrames > 0 ? current / totalFrames : 0;
					onProgress(0.05 + 0.05 * (passBaseFrac + passShareFrac * passFrac), formatVsProgressDetail(manifest.name, entry.level, current, totalFrames, fps));
				},
			});

			// Snapshot a PNG from this pass's output BEFORE we delete/rename the .mkv.
			checkCancelled();
			const vsPng = join(ctx.dir, `vs_${i}.png`);
			const vsFrameRes = await run(buildPreviewPngExtractArgs(outPath, frameOffset, vsPng, colorInfo, probe), { signal });
			if (vsFrameRes.code !== 0) {
				Logger.warn(`[preview] VS snapshot failed for sample ${ctx.index} pass ${i + 1} ` + `(${manifest.id}): ${vsFrameRes.stderr.slice(-300)}`);
			} else {
				vsFrames.push({
					index: i,
					presetId: manifest.id,
					bareId: manifest.bareId,
					label: `${manifest.name} (${entry.level})`,
				});
			}

			if (currentInput !== sourceClip) {
				try {
					rmSync(currentInput);
				} catch {}
			}
			currentInput = outPath;
		}

		if (currentInput !== sourceClip) {
			try {
				rmSync(sourceClip);
			} catch {}
			renameSync(currentInput, sourceClip);
		}

		Logger.info(`[preview] Sample ${ctx.index}: VS chain complete (${activeVsEntries.length} pass(es))`);
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

	// 3. Apply the prepare filter the real encode uses, one step at a time so
	// each filter pass gets its own PNG snapshot for the comparison viewer.
	checkCancelled();
	onProgress(0.15, "Applying filters");

	const prepareFilter = await buildPrepareFilterConfig({
		inputPath: job.inputPath,
		crop: job.settings.crop,
		cropLimit: job.settings.cropLimit,
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

	if (prepareFilter && (prepareFilter.steps.length > 0 || prepareFilter.deferredAutoDenoise)) {
		let currentInput = sourceClip;

		// CPU-side steps: downscale, deband, denoise (or auto-denoise CPU path).
		for (let i = 0; i < prepareFilter.steps.length; i++) {
			checkCancelled();
			const step = prepareFilter.steps[i]!;
			const isLastStep = i === prepareFilter.steps.length - 1 && !prepareFilter.deferredAutoDenoise;
			const outPath = isLastStep ? filteredClip : join(ctx.dir, `prepare_${i}_${step.kind}.mkv`);

			const baseFrac = i / (prepareFilter.steps.length + (prepareFilter.deferredAutoDenoise ? 1 : 0));
			Logger.info(`[preview] Sample ${ctx.index} prepare step ${i + 1}/${prepareFilter.steps.length}: ${step.label}`);
			onProgress(0.15 + 0.05 * baseFrac, step.label);

			const filterArgs = [
				"ffmpeg",
				"-y",
				...step.preInputArgs,
				"-i",
				currentInput,
				...colorArgs,
				"-vf",
				step.filter,
				...FFV1_ENCODE_ARGS,
				"-an",
				"-sn",
				outPath,
			];
			const filterRes = await run(filterArgs, { signal });
			if (filterRes.code !== 0) {
				throw new Error(`Filter pass (${step.kind}) failed: ${filterRes.stderr.slice(-500)}`);
			}

			// Snapshot the PNG BEFORE we overwrite/delete this intermediate later.
			checkCancelled();
			const pngPath = join(ctx.dir, `prepare_${step.kind}.png`);
			const pngRes = await run(buildPreviewPngExtractArgs(outPath, frameOffset, pngPath, colorInfo, probe), { signal });
			if (pngRes.code !== 0) {
				Logger.warn(`[preview] Prepare snapshot failed for sample ${ctx.index} step ${step.kind}: ${pngRes.stderr.slice(-300)}`);
			} else {
				prepareFrames.push({ kind: step.kind, label: step.label });
			}

			if (currentInput !== sourceClip) {
				try {
					rmSync(currentInput);
				} catch {}
			}
			currentInput = outPath;
		}

		// Deferred GPU auto-denoise
		if (prepareFilter.deferredAutoDenoise) {
			checkCancelled();
			onProgress(0.2, "Auto-denoise (segmented GPU)");

			const { plan, backend, gpuDevice, nlmeansParams } = prepareFilter.deferredAutoDenoise;
			const denoiseInput = currentInput;
			const denoiseOutput = filteredClip;

			Logger.info(`[preview] Sample ${ctx.index}: running segmented GPU auto-denoise (${plan.length} ranges, ${backend} on device ${gpuDevice})`);

			if (existsSync(denoiseOutput) && denoiseOutput !== denoiseInput) {
				try {
					rmSync(denoiseOutput);
				} catch {}
			}

			await runSegmentedAutoDenoiseGpu(
				denoiseInput,
				denoiseOutput,
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

			checkCancelled();
			const pngPath = join(ctx.dir, "prepare_denoise.png");
			const pngRes = await run(buildPreviewPngExtractArgs(denoiseOutput, frameOffset, pngPath, colorInfo, probe), { signal });
			const tag = backend === "vulkan" ? "GPU/Vulkan" : "GPU/OpenCL";
			if (pngRes.code !== 0) {
				Logger.warn(`[preview] Prepare snapshot failed for sample ${ctx.index} step denoise: ${pngRes.stderr.slice(-300)}`);
			} else {
				prepareFrames.push({ kind: "denoise", label: `Auto denoise (${tag})` });
			}

			if (denoiseInput !== sourceClip) {
				try {
					rmSync(denoiseInput);
				} catch {}
			}
			currentInput = denoiseOutput;
		}

		// If the final intermediate isn't already at filteredClip's path, move it there.
		if (currentInput !== filteredClip) {
			if (existsSync(filteredClip)) {
				try {
					rmSync(filteredClip);
				} catch {}
			}
			renameSync(currentInput, filteredClip);
		}
		abeInput = filteredClip;
	}

	// 4. Encode the filtered clip.
	checkCancelled();

	const enc = getEncoder(job.settings.encoder);
	let ivfFile: string;

	if (enc.usesAutoBoost) {
		onProgress(0.25, "Encoding (Auto-Boost-Essential)");

		const colorParams = svtColorParamsFromProbe(probe);
		const custom = job.settings.customEncoderParams?.trim() ?? "";
		const finalParams = custom ? `${colorParams} ${custom}` : colorParams;

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
			"--fast-params",
			colorParams,
			"--final-params",
			finalParams,
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

			try {
				const reader = abeProc.stdout.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					try {
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
								// Non-JSON line, just ignore
							}
						}
					} catch {
						break;
					}
				}
			} catch {}
		})();

		const stderrTask = (async () => {
			if (!abeProc.stderr) return;

			try {
				abeStderr = await new Response(abeProc.stderr).text();
			} catch {}
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
		ivfFile = join(abeInputParsed.dir, `${abeInputParsed.name}.ivf`);
		if (!existsSync(ivfFile)) {
			throw new Error(`Encoder did not produce output .ivf file (expected ${ivfFile})`);
		}
	} else {
		// DIRECT ENCODE
		onProgress(0.25, `Encoding (${enc.label})`);

		ivfFile = join(ctx.dir, "direct.ivf");
		const totalFrames = Math.max(1, Math.round(ctx.windowSec * probe.videoStreamFps));
		const startedAt = Date.now();

		const colorParams = svtColorParamsFromProbe(probe);
		const customParams = (job.settings.customEncoderParams || "").trim();
		const customList = customParams.length > 0 ? customParams.split(/\s+/) : [];

		const y4mFifo = join(ctx.dir, "direct_y4m.fifo");
		rmSync(y4mFifo, { force: true });
		const mkfifoRes = await run(["mkfifo", y4mFifo], { signal });
		if (mkfifoRes.code !== 0) {
			throw new Error(`Failed to create encode FIFO: ${mkfifoRes.stderr || mkfifoRes.stdout}`);
		}

		const ffArgs = ["ffmpeg", "-nostdin", "-y", "-i", abeInput, "-f", "yuv4mpegpipe", "-strict", "-1", "-pix_fmt", "yuv420p10le", y4mFifo];
		const encArgs = [
			enc.binary,
			"-i",
			y4mFifo,
			"--progress",
			"2",
			...colorParams.split(/\s+/).filter(Boolean),
			"--crf",
			String(job.settings.manualCrf),
			"--preset",
			String(job.settings.manualPreset),
			...customList,
			"-b",
			ivfFile,
		];

		const ffProc = Bun.spawn(ffArgs, { stdout: "ignore", stderr: "ignore", cwd: ctx.dir });
		const encProc = Bun.spawn(encArgs, { stdout: "ignore", stderr: "pipe", cwd: ctx.dir });

		const onAbortDirect = () => {
			for (const p of [ffProc, encProc]) {
				try {
					p.kill("SIGTERM");
				} catch {}
			}
			setTimeout(() => {
				for (const p of [ffProc, encProc]) {
					try {
						p.kill("SIGKILL");
					} catch {}
				}
			}, 3000);
		};
		signal.addEventListener("abort", onAbortDirect, { once: true });

		let encStderr = "";

		const stderrTask = (async () => {
			if (!encProc.stderr) return;

			const reader = encProc.stderr.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			const stripAnsiAndControls = (s: string) =>
				s
					// CSI sequences: ESC [ ... command
					.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
					// OSC sequences: ESC ] ... BEL or ST
					.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
					// Other ESC sequences
					.replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, "")
					// Remaining non-printing controls except \r and \n
					.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

			const handleProgressLine = (rawLine: string) => {
				const line = stripAnsiAndControls(rawLine).trim();
				const m = line.match(/Encoding frame\s+(\d+)/i) || line.match(/Encoding:\s*(\d+)\s+Frames?\b/i);
				if (!m) return;

				const current = parseInt(m[1]!, 10);
				if (!Number.isFinite(current) || current <= 0) return;

				const frac = Math.min(1, current / totalFrames);
				const elapsedSec = (Date.now() - startedAt) / 1000;
				const fps = elapsedSec > 0 ? current / elapsedSec : 0;
				const detail = `Encoding (${enc.label}) — frame ${current}/${totalFrames}` + (fps > 0 ? ` @ ${fps.toFixed(1)} fps` : "");

				onProgress(0.25 + 0.7 * frac, detail);
			};

			while (true) {
				let chunk;
				try {
					chunk = await reader.read();
				} catch {
					break;
				}
				if (chunk.done) break;

				const text = decoder.decode(chunk.value, { stream: true });
				encStderr += text;
				buffer += text;

				const lines = buffer.split(/\r|\n/);
				buffer = lines.pop() || "";
				for (const line of lines) handleProgressLine(line);
			}

			if (buffer.trim()) handleProgressLine(buffer);
		})();

		const encCode = await encProc.exited;

		try {
			ffProc.kill("SIGTERM");
		} catch {}
		await ffProc.exited;
		await stderrTask;

		signal.removeEventListener("abort", onAbortDirect);

		rmSync(y4mFifo, { force: true });

		checkCancelled();

		if (encCode !== 0) {
			const detail = encStderr.trim().slice(-500) || describeExitCode(encCode);
			throw new Error(`${enc.label} failed (exit ${encCode}): ${detail}`);
		}

		if (!existsSync(ivfFile)) {
			throw new Error(`${enc.label} did not produce output .ivf file (expected ${ivfFile})`);
		}
	}

	// 5. Mux .ivf to .mkv so browsers can play it back.
	checkCancelled();
	onProgress(0.95, "Muxing encoded clip");

	const muxRes = await run(["mkvmerge", "-o", encodedClip, ivfFile], { signal });
	if (muxRes.code !== 0 && muxRes.code !== 1) {
		throw new Error(`mkvmerge failed: ${muxRes.stderr || muxRes.stdout}`);
	}

	// 5a. Tag the muxed clip with colour metadata so it plays correctly
	checkCancelled();
	onProgress(0.97, "Tagging color metadata");
	try {
		await applyColorMetadata(encodedClip, probe, signal);
	} catch (err: any) {
		Logger.warn(`[preview] applyColorMetadata failed: ${err?.message || err}`);
	}

	// 6. Pull the encode frame
	checkCancelled();
	onProgress(0.98, "Extracting comparison frame");

	const encodeFrameRes = await run(buildPreviewPngExtractArgs(encodedClip, frameOffset, encodeFrame, colorInfo, probe), { signal });
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
		vsFrames,
		prepareFrames,
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

export function resolvePreviewArtifact(config: AppConfig, jobId: string, sampleIndex: number, kind: string): string | null {
	const dir = join(previewDirFor(config, jobId), `sample_${String(sampleIndex).padStart(2, "0")}`);
	let file: string;

	if (kind === "source") {
		file = join(dir, "source.png");
	} else if (kind === "encode") {
		file = join(dir, "encode.png");
	} else if (kind === "clip") {
		file = join(dir, "encoded.mkv");
	} else if (kind === "source-clip") {
		file = join(dir, "source_clip.mkv");
	} else if (kind.startsWith("vs:")) {
		const m = kind.match(/^vs:(\d+)$/);
		if (!m) return null;
		const idx = parseInt(m[1]!, 10);
		if (!Number.isFinite(idx) || idx < 0) return null;
		file = join(dir, `vs_${idx}.png`);
	} else if (kind.startsWith("pf:")) {
		// Prepare-filter intermediate snapshot: pf:downscale | pf:deband | pf:denoise | pf:crop
		const m = kind.match(/^pf:(downscale|deband|denoise|crop)$/);
		if (!m) return null;
		file = join(dir, `prepare_${m[1]}.png`);
	} else {
		return null;
	}

	return existsSync(file) ? file : null;
}

export function deletePreviewDir(config: AppConfig, jobId: string): void {
	try {
		rmSync(previewDirFor(config, jobId), { recursive: true, force: true });
	} catch {}
}
