import { existsSync, mkdirSync, statSync, unlinkSync, rmSync, readdirSync, symlinkSync, renameSync } from "fs";
import { join, parse as parsePath, dirname, extname, basename, resolve } from "path";
import type { Job, JobStep, AppConfig } from "./types";
import { probeFile, getOpusBitrateForLayout, getAudioReplacementLabel, normalizeLayout } from "./probe";
import { Logger } from "./logger";
import { CancelledError, run, humanSize, fmtFrames, pct2, escapeXml, describeExitCode, isTimecodesVFR, computeFps } from "./process";
import {
	detectAudioTrackType,
	sortAudioStreams,
	deduplicateAudioStreams,
	detectSubtitleTrackType,
	buildSubtitleTrackName,
	sortSubtitleStreams,
	analyzeSubtitleStreams,
	normalizeLanguageGroup,
	deduplicateSubtitleStreams,
	filterStreamsByLanguage,
	sanitizeLanguageTag,
	filterOutCommentaryAudio,
	filterSubtitleTypes,
} from "./tracks";
import { detectSourceTag, detectReleaseGroup, getResolutionTag, extractBaseTitle, inferSourceFromStream } from "./naming";
import pkg from "../package.json";
import { buildPrepareFilterConfig } from "./filters";
import { FFV1_ENCODE_ARGS, runAnalysisPass, runSegmentedAutoDenoiseGpu, type DenoisePlan } from "./auto-denoise";
import { formatVsProgressDetail, runVsPass, vsRegistry } from "./vs-filters";
import { applyColorMetadata, svtColorParamsFromProbe } from "./color-metadata";
import { combineCumulativeSettings, encodeSettingsCode } from "./settings-code";
import { decodePriorSettings } from "./mkv-tags";
import { cpus } from "os";
import { getEncoder } from "./encoders";

export { CancelledError } from "./process";

const S_PROBE = 0;
const S_PREPARE = 1;
const S_FAST = 2;
const S_METRICS = 3;
const S_SCENES = 4;
const S_ZONES = 5;
const S_FINAL = 6;
const S_AUDIO = 7;
const S_MUX = 8;

function makeSteps(): JobStep[] {
	return [
		{ label: "Analyze", status: "pending", progress: 0 },
		{ label: "Prepare", status: "pending", progress: 0 },
		{ label: "Fast Pass", status: "pending", progress: 0 },
		{ label: "Metrics", status: "pending", progress: 0 },
		{ label: "Scenes", status: "pending", progress: 0 },
		{ label: "Zones", status: "pending", progress: 0 },
		{ label: "Final Encode", status: "pending", progress: 0 },
		{ label: "Audio", status: "pending", progress: 0 },
		{ label: "Mux & Finish", status: "pending", progress: 0 },
	];
}

/**
 * Remove .nfo, .srt, .jpg and .png files associated with a video file.
 */
function cleanupAssociatedFiles(videoPath: string): void {
	const dir = dirname(videoPath);
	const stem = parsePath(videoPath).name;

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const entryStem = parsePath(entry).name;
			const entryExt = extname(entry).toLowerCase();

			const isAssociated = entryStem.startsWith(stem);

			if (isAssociated && [".nfo", ".srt", ".jpg", ".png"].includes(entryExt)) {
				const fullPath = join(dir, entry);
				try {
					unlinkSync(fullPath);
					Logger.info(`[library] Removed associated file: ${entry}`);
				} catch (err: any) {
					Logger.warn(`[library] Failed to remove ${entry}:`, { "error.message": err?.message });
				}
			}
		}
	} catch {}
}

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

function fmtFramesWithFps(current: number, total: number, startedAt: number | undefined, estVideoSize?: string, estTotalSize?: string): string {
	const base = fmtFrames(current, total);
	const fps = computeFps(current, startedAt);
	const fpsStr = fps ? ` (${fps} fps)` : "";
	const estStr = estVideoSize && estTotalSize ? ` — Video: ~${estVideoSize} · Total: ~${estTotalSize}` : "";
	return `${base}${fpsStr}${estStr}`;
}

/**
 * Resolve a non-colliding absolute output path.
 *
 * If `dir/filename` already exists (and is not `ignorePath` - the source we are
 * about to replace in place), a numeric suffix is appended before the
 * extension: `name.mkv`, `name (2).mkv`, ... - until a free path
 * is found. This guarantees two distinct source files can never be written to
 * the same output, so an encode can never silently overwrite an earlier one
 * even if the computed names happen to be identical.
 */
function resolveUniqueOutputPath(dir: string, filename: string, ignorePath?: string): string {
	const ext = extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	const ignore = ignorePath ? resolve(ignorePath) : null;

	let candidate = join(dir, filename);
	let n = 2;
	while (existsSync(candidate) && resolve(candidate) !== ignore) {
		candidate = join(dir, `${stem} (${n})${ext}`);
		n++;
	}
	return candidate;
}

export async function encodeJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });

	const stem = parsePath(job.filename).name;
	const releaseGroup = detectReleaseGroup(stem);
	const baseTitle = extractBaseTitle(stem);

	const steps = makeSteps();

	function setStep(idx: number, partial: Partial<JobStep>) {
		const step = steps[idx]!;

		if (partial.status === "active" && step.status !== "active") {
			step.startedAt = Date.now();
			step.finishedAt = undefined;
		}

		if ((partial.status === "done" || partial.status === "error") && step.status !== "done" && step.status !== "error") {
			step.finishedAt = Date.now();

			if (!step.startedAt) {
				step.startedAt = step.finishedAt;
			}
		}

		Object.assign(step, partial);
		const overall = steps.reduce((sum, s) => sum + s.progress, 0) / steps.length;
		const activeStep = steps.find((s) => s.status === "active");

		updateJob({
			steps: [...steps],
			progress: Math.round(overall * 100) / 100,
			currentStage: activeStep?.label || job.currentStage,
		});
	}

	function checkCancelled() {
		if (signal?.aborted) throw new CancelledError();
	}

	try {
		// Probe
		checkCancelled();
		setStep(S_PROBE, { status: "active", progress: 0 });
		updateJob({ status: "probing" });

		const probe = await probeFile(job.inputPath);
		updateJob({ probe });

		let sourceTag = detectSourceTag(stem);
		if (sourceTag === "Bluray") {
			const inferred = inferSourceFromStream(probe.videoCodec, probe.width, probe.height);
			if (inferred) {
				sourceTag = inferred;
				Logger.info(`[probe] Inferred source from stream: ${inferred} (${probe.videoCodec}, ${probe.width}x${probe.height})`);
			}
		}

		setStep(S_PROBE, { status: "done", progress: 100 });

		// Prepare
		checkCancelled();
		setStep(S_PREPARE, { status: "active", progress: 0 });

		const preparedVideo = join(tempDir, "source_video.mkv");
		const timecodesFile = join(tempDir, "timecodes_v2.txt");

		const tcRes = await run(["mkvextract", job.inputPath, "timestamps_v2", `${probe.videoStreamIndex}:${timecodesFile}`], { signal });
		if (tcRes.code !== 0) {
			Logger.warn(`[prepare] Timecodes extraction failed, will use default timing: ${tcRes.stderr || tcRes.stdout}`);
		}

		const extractRes = await run(["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:v:0`, "-c:v", "copy", "-an", "-sn", preparedVideo], { signal });

		if (extractRes.code !== 0) {
			throw new Error(`Failed to extract video stream: ${extractRes.stderr || extractRes.stdout}`);
		}

		// VapourSynth filter chain
		const activeVsEntries = (job.settings.vsFilters ?? []).filter((e) => e.level !== "off");

		if (activeVsEntries.length > 0) {
			const totalFrames = Math.round(probe.duration * probe.videoStreamFps);
			let currentInput = preparedVideo;

			for (let i = 0; i < activeVsEntries.length; i++) {
				checkCancelled();
				const entry = activeVsEntries[i]!;
				const manifest = vsRegistry.get(entry.presetId);
				if (!manifest) {
					Logger.warn(`[prepare] Skipping unknown VS preset: ${entry.presetId}`);
					continue;
				}

				const outPath = join(tempDir, `vs_${i}_${manifest.bareId}.mkv`);
				const label = `${manifest.name} (${entry.level})`;
				const passBaseProgress = (i / activeVsEntries.length) * 4.5;
				const passShare = 4.5 / activeVsEntries.length;

				setStep(S_PREPARE, { progress: passBaseProgress, detail: `${label} — ${fmtFrames(0, totalFrames)}` });
				Logger.info(`[prepare] VS pass ${i + 1}/${activeVsEntries.length}: ${manifest.id} level=${entry.level}`);

				await runVsPass({
					manifest,
					entry,
					inputPath: currentInput,
					outputPath: outPath,
					totalFrames,
					signal,
					onProgress: (current, fps) => {
						const passFrac = totalFrames > 0 ? current / totalFrames : 0;
						setStep(S_PREPARE, {
							progress: passBaseProgress + passShare * passFrac,
							detail: formatVsProgressDetail(manifest.name, entry.level, current, totalFrames, fps),
						});
					},
				});

				if (currentInput !== preparedVideo) {
					try {
						unlinkSync(currentInput);
					} catch {}
				}
				currentInput = outPath;
			}

			if (currentInput !== preparedVideo) {
				try {
					unlinkSync(preparedVideo);
				} catch {}
				renameSync(currentInput, preparedVideo);
			}

			Logger.info(`[prepare] VapourSynth chain complete (${activeVsEntries.length} pass(es))`);
		}

		// Prepare filter pass (downscale + deband + denoise)
		let autoPlan: DenoisePlan | null = null;
		if (job.settings.denoise === "auto") {
			checkCancelled();
			setStep(S_PREPARE, { progress: 4.7, detail: "Analyzing noise..." });
			try {
				autoPlan = await runAnalysisPass(preparedVideo, tempDir, probe.duration, job.settings.autoDenoiseThresholds, signal);
			} catch (err) {
				if (err instanceof CancelledError) throw err;
				Logger.warn(`[auto-denoise] Analysis failed, proceeding without denoise: ${err instanceof Error ? err.message : err}`);
				autoPlan = null;
			}
		}

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
			totalDuration: probe.duration,
		});

		if (prepareFilter) {
			checkCancelled();

			const totalFrames = Math.round(probe.duration * probe.videoStreamFps);
			setStep(S_PREPARE, { progress: 5, detail: `${prepareFilter.label} — ${fmtFrames(0, totalFrames)}` });
			Logger.debug(`[prepare] Applying filters: ${prepareFilter.filter} (${totalFrames} frames)`);

			const filteredVideo = join(tempDir, "source_video_filtered.mkv");
			const filterStartedAt = Date.now();

			const filterArgs = ["ffmpeg", "-y", ...prepareFilter.preInputArgs, "-i", preparedVideo];
			if (prepareFilter.filter) {
				filterArgs.push("-vf", prepareFilter.filter);
			}
			filterArgs.push(...FFV1_ENCODE_ARGS, "-an", "-sn", filteredVideo);

			const filterProc = Bun.spawn(filterArgs, {
				stdout: "pipe",
				stderr: "pipe",
			});

			const onAbortFilter = () => {
				try {
					filterProc.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						filterProc.kill("SIGKILL");
					} catch {}
				}, 3000);
			};
			signal?.addEventListener("abort", onAbortFilter, { once: true });

			const stderrTask = (async () => {
				if (!filterProc.stderr) return "";

				try {
					const reader = filterProc.stderr.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let lastUpdate = 0;
					const errLines: string[] = [];

					while (true) {
						try {
							const { done, value } = await reader.read();
							if (done) break;
							buffer += decoder.decode(value, { stream: true });
							const parts = buffer.split(/[\r\n]/);
							buffer = parts.pop() || "";

							for (const part of parts) {
								const frameMatch = part.match(/frame=\s*(\d+)/);
								if (frameMatch && totalFrames > 0) {
									const current = parseInt(frameMatch[1]!);
									const now = Date.now();
									if (now - lastUpdate >= 1000) {
										lastUpdate = now;
										const fps = computeFps(current, filterStartedAt);
										const fpsStr = fps ? ` (${fps} fps)` : "";
										setStep(S_PREPARE, {
											progress: 5 + pct2(current, totalFrames) * 0.95,
											detail: `${prepareFilter.label} — ${fmtFrames(current, totalFrames)}${fpsStr}`,
										});
									}
								} else if (part.trim()) {
									errLines.push(part);
									if (errLines.length > 200) errLines.shift();
								}
							}
						} catch {
							break;
						}
					}

					buffer += decoder.decode();
					if (buffer.trim()) errLines.push(buffer);
					return errLines.join("\n");
				} catch {}
			})();

			const stdoutTask = new Response(filterProc.stdout).text();

			const [filterCode, stderrTail] = await Promise.all([filterProc.exited, stderrTask, stdoutTask]);
			signal?.removeEventListener("abort", onAbortFilter);
			checkCancelled();

			if (filterCode !== 0) {
				throw new Error(`Prepare filter failed (exit ${filterCode}): ${stderrTail?.trim().slice(-500)}`);
			}

			unlinkSync(preparedVideo);
			renameSync(filteredVideo, preparedVideo);

			Logger.info(`[prepare] Filter pass complete`);
		}

		if (prepareFilter?.deferredAutoDenoise) {
			checkCancelled();
			const { plan, backend, gpuDevice, nlmeansParams } = prepareFilter.deferredAutoDenoise;
			const denoisedVideo = join(tempDir, "source_video_denoised.mkv");

			Logger.info(`[prepare] Running segmented GPU auto-denoise (${plan.length} ranges, ${backend} on device ${gpuDevice})`);

			await runSegmentedAutoDenoiseGpu(
				preparedVideo,
				denoisedVideo,
				plan,
				probe.duration,
				backend,
				gpuDevice,
				tempDir,
				nlmeansParams,
				(i, n, label) => {
					setStep(S_PREPARE, {
						progress: 5 + (95 * i) / n,
						detail: `Auto denoise GPU — segment ${i}/${n} (${label})`,
					});
				},
				signal,
			);

			unlinkSync(preparedVideo);
			renameSync(denoisedVideo, preparedVideo);

			Logger.info(`[prepare] Segmented GPU auto-denoise complete`);
		}

		setStep(S_PREPARE, { status: "done", progress: 100 });

		const skipVideoEncode = job.settings.videoEncode === "off";
		const skipAudioEncode = job.settings.audioEncode === "copy";
		const skipSubtitleProcessing = job.settings.subtitleProcessing === "copy";

		if (skipVideoEncode) {
			for (const si of [S_FAST, S_METRICS, S_SCENES, S_ZONES, S_FINAL]) {
				setStep(si, { status: "done", progress: 100, detail: "Skipped — video encoding off" });
			}
		}

		let videoMkv: string;

		if (!skipVideoEncode) {
			// ABE or direct encode
			checkCancelled();
			updateJob({ status: "encoding_video" });

			const ivfFile = join(tempDir, "source_video.ivf");
			const inProgressIvf = join(tempDir, "abe_temp", "source_video.ivf");
			const enc = getEncoder(job.settings.encoder);

			const estimatedAudioStreams = (probe.audioStreams || []).filter((s) => !s.title || !/compatibility/i.test(s.title));
			const estimatedAudioBytes = Math.round(
				((estimatedAudioStreams.reduce((sum, s) => {
					const layout = normalizeLayout(s.channelLayout);
					return sum + getOpusBitrateForLayout(layout, job.settings.audioBitrates);
				}, 0) *
					1000) /
					8) *
					probe.duration,
			);

			if (enc.usesAutoBoost) {
				const colorParams = svtColorParamsFromProbe(probe);
				const custom = job.settings.customEncoderParams?.trim() ?? "";
				const finalParams = custom ? `${colorParams} ${custom}` : colorParams;

				const abeArgs = [
					"python3",
					"-u",
					"/opt/Auto-Boost-Essential/Auto-Boost-Essential.py",
					"-i",
					preparedVideo,
					"-t",
					join(tempDir, "abe_temp"),
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

				if (job.settings.skipBoosting) {
					abeArgs.push("-nb");
				}

				const abeProc = Bun.spawn(abeArgs, {
					stdout: "pipe",
					stderr: "pipe",
					cwd: tempDir,
				});

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
				signal?.addEventListener("abort", onAbortAbe, { once: true });

				const abeStageToStep: Record<number, number> = {
					0: S_FAST,
					1: S_METRICS,
					2: S_SCENES,
					3: S_ZONES,
					4: S_FINAL,
				};

				let abeStderr = "";
				let abeLastError = "";

				const handleAbeEvent = (evt: any) => {
					const si = abeStageToStep[evt.stage];

					if (evt.event === "stage" && si !== undefined) {
						setStep(si, {
							status: "active",
							progress: 0,
							detail: evt.total_frames ? fmtFrames(0, evt.total_frames) : undefined,
						});
						return;
					}

					if (evt.event === "progress" && si !== undefined) {
						let estVideo: string | undefined;
						let estTotal: string | undefined;

						if (evt.stage === 4 && evt.current > 0 && evt.total > 0) {
							const frac = evt.current / evt.total;
							if (frac >= 0.02) {
								try {
									const curBytes = statSync(inProgressIvf).size;
									const estVideoBytes = curBytes / frac;
									const estTotalBytes = estVideoBytes + estimatedAudioBytes + 2 * 1024 * 1024;
									estVideo = humanSize(estVideoBytes);
									estTotal = humanSize(estTotalBytes);
									updateJob({
										estimatedVideoSize: estVideo,
										estimatedFinalSize: estTotal,
									});
								} catch {}
							}
						}

						setStep(si, {
							progress: pct2(evt.current, evt.total),
							detail: evt.total ? fmtFramesWithFps(evt.current, evt.total, steps[si]!.startedAt, estVideo, estTotal) : undefined,
						});
						return;
					}

					if (evt.event === "stage_complete" && si !== undefined) {
						setStep(si, {
							status: "done",
							progress: 100,
							detail: evt.total_frames ? fmtFramesWithFps(evt.total_frames, evt.total_frames, steps[si]!.startedAt) : steps[si]!.detail,
						});
						return;
					}

					if (evt.event === "error") {
						abeLastError = evt.message || "Unknown error";
						Logger.error("[ABE error]", { message: evt.message });
					}
				};

				const abeStdoutTask = (async () => {
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

								for (const rawLine of lines) {
									const line = rawLine.trim();
									if (!line) continue;

									try {
										const evt = JSON.parse(line);
										handleAbeEvent(evt);
									} catch {
										Logger.warn(`[ABE stdout non-json]`, { output: rawLine });
									}
								}
							} catch {
								break;
							}
						}

						buffer += decoder.decode();

						const trailing = buffer.trim();
						if (trailing) {
							try {
								const evt = JSON.parse(trailing);
								handleAbeEvent(evt);
							} catch {
								Logger.warn(`[ABE stdout trailing non-json]`, { output: trailing });
							}
						}
					} catch {}
				})();

				const abeStderrTask = (async () => {
					if (!abeProc.stderr) return;

					try {
						const reader = abeProc.stderr.getReader();
						const decoder = new TextDecoder();

						while (true) {
							try {
								const { done, value } = await reader.read();
								if (done) break;

								const chunk = decoder.decode(value, { stream: true });
								abeStderr += chunk;

								if (chunk.trim()) {
									Logger.error("[ABE stderr]", { error: chunk.trimEnd() });
								}
							} catch {
								break;
							}
						}

						abeStderr += decoder.decode();
					} catch {}
				})();

				const [abeCode] = await Promise.all([abeProc.exited, abeStdoutTask, abeStderrTask]);
				signal?.removeEventListener("abort", onAbortAbe);
				checkCancelled();

				if (abeCode !== 0) {
					const exitSignal = abeCode > 128 ? describeExitCode(abeCode) : null;
					const detail = abeLastError || abeStderr.trim().slice(-500) || exitSignal || "No error details available";
					throw new Error(`Auto-Boost-Essential failed (exit ${abeCode}): ${detail}`);
				}

				if (job.settings.skipBoosting) {
					// Skip boosting: mark ABE-only steps as done (skipped)
					for (const si of [S_FAST, S_METRICS, S_SCENES, S_ZONES]) {
						setStep(si, { status: "done", progress: 100, detail: "Skipped" });
					}
				}
			} else {
				// DIRECT ENCODE
				// ABE-only steps don't apply (mark them skipped)
				for (const si of [S_FAST, S_METRICS, S_SCENES, S_ZONES]) {
					setStep(si, { status: "done", progress: 100, detail: `Skipped — ${enc.label}` });
				}

				setStep(S_FINAL, { status: "active", progress: 0 });

				const colorParams = svtColorParamsFromProbe(probe); // string of SVT --flags
				const totalFrames = Math.max(1, Math.round(probe.duration * probe.videoStreamFps));

				const customParams = (job.settings.customEncoderParams || "").trim();
				const customList = customParams.length > 0 ? customParams.split(/\s+/) : [];

				const y4mFifo = join(tempDir, "direct_y4m.fifo");
				try {
					unlinkSync(y4mFifo);
				} catch {}
				const mkfifoRes = await run(["mkfifo", y4mFifo], { signal });
				if (mkfifoRes.code !== 0) {
					throw new Error(`Failed to create encode FIFO: ${mkfifoRes.stderr || mkfifoRes.stdout}`);
				}

				const ffArgs = ["ffmpeg", "-nostdin", "-y", "-i", preparedVideo, "-f", "yuv4mpegpipe", "-strict", "-1", "-pix_fmt", "yuv420p10le", y4mFifo];
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
					inProgressIvf,
				];

				mkdirSync(join(tempDir, "abe_temp"), { recursive: true });

				const ffProc = Bun.spawn(ffArgs, { stdout: "ignore", stderr: "ignore", cwd: tempDir });
				const encProc = Bun.spawn(encArgs, {
					stdout: "ignore",
					stderr: "pipe",
					cwd: tempDir,
				});

				const onAbort = () => {
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
				signal?.addEventListener("abort", onAbort, { once: true });

				// Parse SVT stderr/stdout progress for the current frame count.
				let encStderr = "";

				const stderrTask = (async () => {
					if (!encProc.stderr) return;

					const reader = encProc.stderr.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					const handleProgressLine = (rawLine: string) => {
						const line = stripAnsiAndControls(rawLine).trim();

						// Supports:
						//   Encoding frame   123
						//   Encoding:   123 Frames @ 8.67 fps | ...
						const m = line.match(/Encoding frame\s+(\d+)/i) || line.match(/Encoding:\s*(\d+)\s+Frames?\b/i);

						if (!m) return;

						const current = parseInt(m[1]!, 10);
						if (!Number.isFinite(current) || current <= 0) return;

						let estVideo: string | undefined;
						let estTotal: string | undefined;

						const frac = current / totalFrames;

						if (frac >= 0.02) {
							try {
								const curBytes = statSync(inProgressIvf).size;
								const estVideoBytes = curBytes / frac;
								const estTotalBytes = estVideoBytes + estimatedAudioBytes + 2 * 1024 * 1024;

								estVideo = humanSize(estVideoBytes);
								estTotal = humanSize(estTotalBytes);

								updateJob({
									estimatedVideoSize: estVideo,
									estimatedFinalSize: estTotal,
								});
							} catch {}
						}

						setStep(S_FINAL, {
							progress: pct2(current, totalFrames),
							detail: fmtFramesWithFps(current, totalFrames, steps[S_FINAL]!.startedAt, estVideo, estTotal),
						});
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

						for (const line of lines) {
							handleProgressLine(line);
						}
					}

					if (buffer.trim()) {
						handleProgressLine(buffer);
					}
				})();

				const encCode = await encProc.exited;

				try {
					ffProc.kill("SIGTERM");
				} catch {}
				await ffProc.exited;
				await stderrTask;

				signal?.removeEventListener("abort", onAbort);

				try {
					unlinkSync(y4mFifo);
				} catch {}

				checkCancelled();

				if (encCode !== 0) {
					const detail = encStderr.trim().slice(-500) || describeExitCode(encCode);
					throw new Error(`${enc.label} failed (exit ${encCode}): ${detail}`);
				}

				setStep(S_FINAL, { status: "done", progress: 100 });

				if (existsSync(inProgressIvf)) renameSync(inProgressIvf, ivfFile);
			}

			if (!existsSync(ivfFile)) {
				throw new Error("Encoder did not produce output .ivf file");
			}

			videoMkv = join(tempDir, "video_only.mkv");
			const muxVidRes = await run(["mkvmerge", "-o", videoMkv, ivfFile], { signal });
			if (muxVidRes.code !== 0 && muxVidRes.code !== 1) {
				throw new Error(`mkvmerge video: ${muxVidRes.stderr || muxVidRes.stdout}`);
			}
			updateJob({ encodedVideoSize: humanSize(statSync(videoMkv).size) });
		} else {
			// FFV1 prepared video is the final video track.
			videoMkv = preparedVideo;
			setStep(S_FINAL, { status: "done", progress: 100, detail: "Skipped — video encoding off" });
		}

		checkCancelled();
		setStep(S_AUDIO, { status: "active", progress: 0 });
		updateJob({ status: "encoding_audio" });

		const allAudioStreams = probe.audioStreams || [];

		const compatFiltered = allAudioStreams.filter((s) => !s.title || !/compatibility/i.test(s.title));
		const skippedCompat = allAudioStreams.length - compatFiltered.length;
		if (skippedCompat > 0) {
			Logger.info(`[audio] Skipped ${skippedCompat} compatibility track(s)`);
		}

		const allowedAudioLangs = job.settings.audioLanguages || [];
		const langFiltered = filterStreamsByLanguage(compatFiltered, allowedAudioLangs, "audio");
		const skippedLang = compatFiltered.length - langFiltered.length;
		if (skippedLang > 0) {
			Logger.info(`[audio] Filtered ${skippedLang} track(s) not in [${allowedAudioLangs.join(", ")}]`);
		}

		const commentaryFiltered = job.settings.removeCommentaryAudio ? filterOutCommentaryAudio(langFiltered) : langFiltered;
		if (job.settings.removeCommentaryAudio && commentaryFiltered.length !== langFiltered.length) {
			Logger.info(`[audio] Removed ${langFiltered.length - commentaryFiltered.length} commentary track(s)`);
		}

		const audioStreams = deduplicateAudioStreams(sortAudioStreams(commentaryFiltered), { collapseChannels: job.settings.keepBestAudioChannelsOnly });

		if (langFiltered.length !== audioStreams.length) {
			Logger.info(`[audio] Deduplicated ${langFiltered.length - audioStreams.length} redundant track(s)`);
		}

		const sortedTypes = audioStreams.map((s) => `${s.language || "und"}:${detectAudioTrackType(s)}:${s.channels || "?"}ch`);
		Logger.info(`[audio] Track order: ${sortedTypes.join(", ")}`);

		const encodedAudioFiles: string[] = [];

		if (skipAudioEncode) {
			setStep(S_AUDIO, {
				status: "done",
				progress: 100,
				detail: "Skipped — audio copied from source",
			});
		} else if (audioStreams.length === 0) {
			setStep(S_AUDIO, { status: "done", progress: 100, detail: "No audio streams" });
		} else {
			setStep(S_AUDIO, { progress: 5, detail: `Extracting ${audioStreams.length} audio stream(s)` });

			interface AudioEncodeJob {
				index: number;
				flacFile: string;
				opusFile: string;
				bitrate: number;
				copy: boolean;
			}

			const audioJobs: AudioEncodeJob[] = [];

			for (let i = 0; i < audioStreams.length; i++) {
				checkCancelled();

				const stream = audioStreams[i]!;
				const flacFile = join(tempDir, `audio_${i}.flac`);
				const opusFile = join(tempDir, `audio_${i}.opus`);
				encodedAudioFiles.push(opusFile);

				const layout = normalizeLayout(stream.channelLayout);
				const bitrate = getOpusBitrateForLayout(layout, job.settings.audioBitrates);

				const delayMs = stream.delayMs;
				const delaySec = delayMs / 1000;

				const isOpusSource = (stream.codec || "").toLowerCase() === "opus";
				const sourceKbps = stream.bitrate ? stream.bitrate / 1000 : undefined;
				const canCopy = isOpusSource && delayMs === 0 && sourceKbps !== undefined && sourceKbps <= bitrate;

				if (canCopy) {
					const copyArgs = [
						"ffmpeg",
						"-y",
						"-i",
						job.inputPath,
						"-map",
						`0:${stream.index}`,
						"-vn",
						"-sn",
						"-dn",
						"-map_metadata",
						"-1",
						"-map_chapters",
						"-1",
						"-c:a",
						"copy",
						opusFile,
					];
					const copyRes = await run(copyArgs, { signal });
					if (copyRes.code !== 0) {
						throw new Error(`FFmpeg audio copy failed for stream ${i}: ${copyRes.stderr || copyRes.stdout}`);
					}

					audioJobs.push({ index: i, flacFile, opusFile, bitrate, copy: true });
					Logger.info(`[audio] Stream ${i} already Opus @ ~${Math.round(sourceKbps)}kbps (<= ${bitrate}kbps target) — copying without re-encode`);

					setStep(S_AUDIO, {
						progress: 5 + Math.round(((i + 1) / audioStreams.length) * 35),
						detail: `Copying audio (${i + 1}/${audioStreams.length})`,
					});
					continue;
				}

				const ffArgs = ["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:${stream.index}`, "-vn", "-sn", "-dn", "-c:a", "flac"];

				if (delaySec < 0) {
					ffArgs.push("-af", `atrim=start=${Math.abs(delaySec)}`);
				} else if (delaySec > 0) {
					ffArgs.push("-af", `adelay=${delayMs}:all=1`);
				}

				ffArgs.push(flacFile);

				const ffRes = await run(ffArgs, { signal });
				if (ffRes.code !== 0) {
					throw new Error(`FFmpeg audio extraction failed for stream ${i}: ${ffRes.stderr || ffRes.stdout}`);
				}

				audioJobs.push({ index: i, flacFile, opusFile, bitrate, copy: false });

				setStep(S_AUDIO, {
					progress: 5 + Math.round(((i + 1) / audioStreams.length) * 35),
					detail: `Extracting audio (${i + 1}/${audioStreams.length})`,
				});
			}

			setStep(S_AUDIO, { progress: 40, detail: `Encoding ${audioJobs.length} audio stream(s)` });

			const concurrency = Math.max(1, Math.min(audioJobs.length, cpus().length));
			let nextJob = 0;
			let completed = 0;
			let failed = false;

			const encodeWorker = async (): Promise<void> => {
				while (!failed) {
					const jobIdx = nextJob++;
					if (jobIdx >= audioJobs.length) return;

					try {
						checkCancelled();

						const aj = audioJobs[jobIdx]!;

						if (aj.copy) {
							completed++;
							setStep(S_AUDIO, {
								progress: 40 + Math.round((completed / audioJobs.length) * 60),
								detail: `Encoding audio (${completed}/${audioJobs.length})`,
							});
							continue;
						}

						const opusArgs = ["opusenc", "--bitrate", String(aj.bitrate)];
						if (job.settings.noPhaseInv) {
							opusArgs.push("--no-phase-inv");
						}
						opusArgs.push("--discard-comments");
						opusArgs.push("--discard-pictures");
						opusArgs.push(aj.flacFile, aj.opusFile);

						const opusRes = await run(opusArgs, { signal });
						if (opusRes.code !== 0) {
							throw new Error(`Audio encoding failed for stream ${aj.index}: ${opusRes.stderr || opusRes.stdout}`);
						}

						completed++;
						setStep(S_AUDIO, {
							progress: 40 + Math.round((completed / audioJobs.length) * 60),
							detail: `Encoding audio (${completed}/${audioJobs.length})`,
						});
					} catch (err) {
						failed = true;
						throw err;
					}
				}
			};

			await Promise.all(Array.from({ length: concurrency }, () => encodeWorker()));

			setStep(S_AUDIO, { status: "done", progress: 100 });
		}

		checkCancelled();
		setStep(S_MUX, { status: "active", progress: 0, detail: "Merging MKV" });
		updateJob({ status: "muxing" });

		const firstSortedLayout = audioStreams.length > 0 ? normalizeLayout(audioStreams[0]!.channelLayout) : probe.audioLayout;
		const audioLabel = getAudioReplacementLabel(firstSortedLayout);
		const shouldDownscale = job.settings.downscale && probe.height > 1080;
		const outputHeight = shouldDownscale ? 1080 : probe.height;
		const outputWidth = shouldDownscale ? Math.round((probe.width * 1080) / probe.height / 2) * 2 : probe.width;
		const resTag = getResolutionTag(outputWidth, outputHeight);
		const videoCodecTag = skipVideoEncode ? "FFV1" : "AV1";
		const audioCodecTag = skipAudioEncode ? "Source" : audioLabel;
		const outputFilename = `${baseTitle} [${sourceTag}-${resTag}][${audioCodecTag}][${videoCodecTag}]-${config.organization}.mkv`;
		const finalOutput = join(tempDir, "final.mkv");

		const effectiveSourceTag = probe.priorSource ?? releaseGroup;

		const priorSettings = decodePriorSettings(probe.priorRabbitSettings);
		const cumulativeSettings = combineCumulativeSettings(priorSettings, job.settings);
		const settingsCode = encodeSettingsCode(cumulativeSettings);

		const xmlTags = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<Tags><Tag>",
			"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
			//`<Simple><Name>TITLE</Name><String>${escapeXml(baseTitle)}</String></Simple>`,
			`<Simple><Name>ENCODED_BY</Name><String>${escapeXml(config.organization)}</String></Simple>`,

			"<Simple>",
			"<Name>RABBIT_ENCODER</Name>",
			`<Simple><Name>VERSION</Name><String>v${escapeXml(pkg.version)}</String></Simple>`,
			`<Simple><Name>SETTINGS</Name><String>${escapeXml(settingsCode)}</String></Simple>`,
			"</Simple>",

			"<Simple>",
			"<Name>LANGUAGE_DETECTOR</Name>",
			`<Simple><Name>VERSION</Name><String>${escapeXml(config.languageDetector.version || "unknown")}</String></Simple>`,
			"</Simple>",

			...(effectiveSourceTag ? [`<Simple><Name>SOURCE</Name><String>${escapeXml(effectiveSourceTag)}</String></Simple>`] : []),
			"</Tag></Tags>",
		].join("\n");

		const xmlPath = join(tempDir, "tags.xml");
		await Bun.write(xmlPath, xmlTags);

		setStep(S_MUX, { progress: 5, detail: "Preparing tracks" });

		const mkvArgs = ["mkvmerge", "-o", finalOutput, "--title", baseTitle, "--global-tags", xmlPath, "--no-audio", "--no-subtitles"];

		if (existsSync(timecodesFile) && isTimecodesVFR(timecodesFile)) {
			mkvArgs.push("--timestamps", `0:${timecodesFile}`);
		}

		mkvArgs.push("--language", `0:${sanitizeLanguageTag(probe.videoLanguage, "video")}`);
		mkvArgs.push("--track-name", `0:${config.organization}`);
		mkvArgs.push("--original-flag", `0:${probe.videoOriginalFlag ? "1" : "0"}`);

		if (probe.displayAspectRatio && probe.displayAspectRatio !== "0:1" && probe.displayAspectRatio !== "N/A") {
			const dar = probe.displayAspectRatio.replace(":", "/");
			mkvArgs.push("--aspect-ratio", `0:${dar}`);
			Logger.info(`[mux] Preserving display aspect ratio: ${probe.displayAspectRatio}`);
		}

		mkvArgs.push(videoMkv);

		if (!skipAudioEncode) {
			// Audio tracks
			const defaultAssigned = new Set<string>();

			for (let i = 0; i < audioStreams.length; i++) {
				const stream = audioStreams[i]!;
				const trackType = detectAudioTrackType(stream);
				const lang = stream.language || "und";
				const langGroup = normalizeLanguageGroup(lang);

				const isDefault = trackType === "main" && !defaultAssigned.has(langGroup);
				if (isDefault) defaultAssigned.add(langGroup);

				if (stream.language) {
					mkvArgs.push("--language", `0:${sanitizeLanguageTag(stream.language, `audio idx ${stream.index}`)}`);
				}

				mkvArgs.push("--track-name", `0:`);
				mkvArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
				mkvArgs.push("--forced-display-flag", "0:0");
				mkvArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);

				if (trackType === "commentary") {
					mkvArgs.push("--commentary-flag", "0:1");
				}

				if (trackType === "descriptive") {
					mkvArgs.push("--visual-impaired-flag", "0:1");
				}

				mkvArgs.push(encodedAudioFiles[i]!);
			}
		}

		if (!skipSubtitleProcessing) {
			// Subtitle tracks
			const allSubtitleStreams = probe.subtitleStreams || [];

			await analyzeSubtitleStreams(
				allSubtitleStreams,
				job.inputPath,
				tempDir,
				{
					langDetect: job.settings.subtitleLangDetect,
					langDetectConfidence: job.settings.subtitleLangDetectConfidence,
					detectSignsSongs: job.settings.detectSignsSongs,
					detectSDH: job.settings.detectSDH,
					detectHonorifics: job.settings.detectHonorifics,
					signsSongsStyleRatio: job.settings.signsSongsStyleRatio,
					signsSongsLineRatio: job.settings.signsSongsLineRatio,
					sdhRatioThreshold: job.settings.sdhRatioThreshold,
					sdhMinLines: job.settings.sdhMinLines,
					honorificsMinCount: job.settings.honorificsMinCount,
					honorificsRatio: job.settings.honorificsRatio,
					assumeMislabeled: job.settings.assumeMislabeledTracks,
				},
				signal,
			);

			const sortedSubtitleStreams = sortSubtitleStreams(allSubtitleStreams, {
				sourcePriority: job.settings.subtitleSourcePriority,
				fansubTiebreak: job.settings.subtitleFansubTiebreak,
				formatPriority: job.settings.subtitleFormatPriority,
			});

			const allowedSubLangs = job.settings.subtitleLanguages || [];
			const langFilteredSubs = filterStreamsByLanguage(sortedSubtitleStreams, allowedSubLangs, "subtitle");
			const skippedSubLang = sortedSubtitleStreams.length - langFilteredSubs.length;
			if (skippedSubLang > 0) {
				Logger.info(`[subtitle] Filtered ${skippedSubLang} track(s) not in [${allowedSubLangs.join(", ")}]`);
			}

			const typeFilteredSubs = filterSubtitleTypes(langFilteredSubs, {
				removeSDH: job.settings.removeSDHSubtitles,
				removeCommentary: job.settings.removeCommentarySubtitles,
				removeForcedSignsSongs: job.settings.removeForcedSignsSongs,
				removeStoryboard: job.settings.removeStoryboardSubtitles,
				removeHonorifics: job.settings.removeHonorificsSubtitles,
				dropPicture: job.settings.dropPictureSubtitles,
			});
			const droppedByType = langFilteredSubs.length - typeFilteredSubs.length;
			if (droppedByType > 0) {
				Logger.info(`[subtitle] Dropped ${droppedByType} track(s) by type/format filters`);
			}

			const subtitleStreams = job.settings.dedupeSubtitles
				? deduplicateSubtitleStreams(typeFilteredSubs, { acrossFormat: job.settings.dedupeAcrossFormat })
				: typeFilteredSubs;

			if (job.settings.dedupeSubtitles && typeFilteredSubs.length !== subtitleStreams.length) {
				Logger.info(`[subtitle] Deduplicated ${typeFilteredSubs.length - subtitleStreams.length} redundant track(s)`);
			}

			if (subtitleStreams.length > 0) {
				const subSortedTypes = subtitleStreams.map((s) => `${s.language || "und"}:${detectSubtitleTrackType(s)}`);
				Logger.info(`[subtitle] Track order: ${subSortedTypes.join(", ")}`);

				const subDefaultAssigned = new Set<string>();
				const subForcedAssigned = new Set<string>();

				interface PlannedSubtitle {
					stream: (typeof subtitleStreams)[number];
					subFile: string;
					effectiveLang: string;
					trackName: string;
					flagArgs: string[];
				}

				const plannedSubs: PlannedSubtitle[] = [];

				for (const stream of subtitleStreams) {
					const trackType = detectSubtitleTrackType(stream);
					const lang = stream.language || "und";
					const langGroup = normalizeLanguageGroup(lang);
					const trackName = job.settings.renameSubtitleTracks
						? buildSubtitleTrackName(trackType, stream.title)
						: stream.title || buildSubtitleTrackName(trackType, stream.title);

					let effectiveLang = lang;
					if (trackType === "honorifics") {
						effectiveLang = "en-JP";
					}

					const flagArgs: string[] = [];

					switch (trackType) {
						case "full": {
							const isDefault = !subDefaultAssigned.has(langGroup);
							if (isDefault) subDefaultAssigned.add(langGroup);
							flagArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "forced": {
							if (subForcedAssigned.has(langGroup)) {
								Logger.warn(`[subtitle] Duplicate forced track for ${lang}, skipping index ${stream.index}`);
								continue;
							}
							subForcedAssigned.add(langGroup);
							flagArgs.push("--default-track-flag", "0:0");
							flagArgs.push("--forced-display-flag", "0:1");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "honorifics": {
							flagArgs.push("--default-track-flag", "0:1");
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "sdh": {
							flagArgs.push("--default-track-flag", "0:0");
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:1");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "commentary": {
							flagArgs.push("--default-track-flag", "0:0");
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:1");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
					}

					plannedSubs.push({
						stream,
						subFile: join(tempDir, `sub_${stream.index}.mkv`),
						effectiveLang,
						trackName,
						flagArgs,
					});
				}

				if (plannedSubs.length > 0) {
					checkCancelled();
					setStep(S_MUX, { progress: 5, detail: `Extracting ${plannedSubs.length} subtitle track(s)` });

					const extractArgs: string[] = ["ffmpeg", "-y", "-i", job.inputPath];
					for (const planned of plannedSubs) {
						extractArgs.push("-map", `0:${planned.stream.index}`, "-c:s", "copy", "-vn", "-an", "-map_chapters", "-1", "-map_metadata", "-1", planned.subFile);
					}

					const extractRes = await run(extractArgs, { signal });

					if (extractRes.code !== 0) {
						// One bad track fails the whole batch (fall back to per-track extraction so the rest still go through).
						Logger.warn(`[subtitle] Single-pass extraction failed, falling back to per-track: ${extractRes.stderr || extractRes.stdout}`);
						for (const planned of plannedSubs) {
							checkCancelled();
							const res = await run(
								[
									"ffmpeg",
									"-y",
									"-i",
									job.inputPath,
									"-map",
									`0:${planned.stream.index}`,
									"-c:s",
									"copy",
									"-vn",
									"-an",
									"-map_chapters",
									"-1",
									"-map_metadata",
									"-1",
									planned.subFile,
								],
								{ signal },
							);
							if (res.code !== 0) {
								Logger.warn(`[subtitle] Failed to extract track ${planned.stream.index}, skipping: ${res.stderr || res.stdout}`);
							}
						}
					}

					setStep(S_MUX, { progress: 45, detail: `Extracted ${plannedSubs.length} subtitle track(s)` });
				}

				for (const planned of plannedSubs) {
					checkCancelled();
					if (!existsSync(planned.subFile)) {
						Logger.warn(`[subtitle] Extracted file missing for track ${planned.stream.index}, skipping`);
						continue;
					}
					mkvArgs.push("--language", `0:${sanitizeLanguageTag(planned.effectiveLang, `sub idx ${planned.stream.index}`)}`);
					mkvArgs.push("--track-name", `0:${planned.trackName}`);
					mkvArgs.push(...planned.flagArgs);
					mkvArgs.push(planned.subFile);
				}
			} else {
				Logger.info("[subtitle] No subtitle streams found");
			}
		} else {
			Logger.info("[subtitle] subtitleProcessing=copy — including source subs verbatim via mkvmerge passthrough");
		}

		const sourceExt = extname(job.inputPath).toLowerCase();
		if (sourceExt === ".mkv" || sourceExt === ".mks") {
			const safeSourceLink = join(tempDir, `source_ref${sourceExt}`);
			try {
				unlinkSync(safeSourceLink);
			} catch {}
			symlinkSync(job.inputPath, safeSourceLink);

			const refFlags = ["--no-video", "--no-global-tags", "--no-track-tags"];
			if (!skipAudioEncode) refFlags.push("--no-audio");
			if (!skipSubtitleProcessing) refFlags.push("--no-subtitles");
			mkvArgs.push(...refFlags, safeSourceLink);

			const passes: string[] = ["chapters", "fonts"];
			if (skipAudioEncode) passes.push("audio");
			if (skipSubtitleProcessing) passes.push("subtitles");
			Logger.info(`[mux] Passthrough from source: ${passes.join(", ")}`);
		} else if (skipAudioEncode || skipSubtitleProcessing) {
			Logger.warn(
				`[mux] Source is ${sourceExt} (not MKV), but a copy-through stage is enabled. Audio/subtitle passthrough may not work; consider remuxing the source to MKV first.`,
			);
		}

		setStep(S_MUX, { progress: 50, detail: `Merging MKV` });

		const mergeRes = await run(mkvArgs, { signal });
		if (mergeRes.code !== 0 && mergeRes.code !== 1) {
			throw new Error(`mkvmerge failed: ${mergeRes.stderr || mergeRes.stdout}`);
		}

		setStep(S_MUX, { progress: 75, detail: "Applying color metadata" });
		await applyColorMetadata(finalOutput, probe, signal);

		setStep(S_MUX, { progress: 85, detail: "Moving to output" });

		let outputPath: string;

		if (job.replaceSource) {
			const sourceDir = dirname(job.inputPath);
			outputPath = resolveUniqueOutputPath(sourceDir, outputFilename, job.inputPath);

			const moveRes = await run(["mv", finalOutput, outputPath], { signal });
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath], { signal });
				unlinkSync(finalOutput);
			}

			if (resolve(outputPath) !== resolve(job.inputPath)) {
				cleanupAssociatedFiles(job.inputPath);
				try {
					unlinkSync(job.inputPath);
					Logger.info(`[library] Removed source: ${job.filename}`);
				} catch (err: any) {
					Logger.warn(`[library] Failed to remove source ${job.filename}:`, { "error.message": err?.message });
				}
			}

			Logger.info(`[library] Replaced with: ${basename(outputPath)}`);
		} else {
			const outputSubDir = job.relativePath ? join(config.outputDir, job.relativePath) : config.outputDir;
			mkdirSync(outputSubDir, { recursive: true });
			outputPath = resolveUniqueOutputPath(outputSubDir, outputFilename);

			const moveRes = await run(["mv", finalOutput, outputPath], { signal });
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath], { signal });
				unlinkSync(finalOutput);
			}
		}

		const finalName = basename(outputPath);

		setStep(S_MUX, { status: "done", progress: 100 });

		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: job.replaceSource ? finalName : job.relativePath ? `${job.relativePath}/${finalName}` : finalName,
			encodedFileSize: humanSize(statSync(outputPath).size),
			finishedAt: Date.now(),
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		if (!job.replaceSource) {
			try {
				unlinkSync(job.inputPath);
			} catch {}
		}
	} catch (err: any) {
		Logger.error(err?.message);
		const activeIdx = steps.findIndex((s) => s.status === "active");
		if (activeIdx >= 0) steps[activeIdx]!.status = "error";

		if (err instanceof CancelledError) {
			updateJob({
				status: "cancelled",
				currentStage: "Cancelled",
				steps: [...steps],
			});
		} else {
			updateJob({
				status: "error",
				currentStage: "Failed",
				steps: [...steps],
				error: err?.message || String(err),
			});
		}

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		if (err instanceof CancelledError) throw err;
	}
}
