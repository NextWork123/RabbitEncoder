import { existsSync, mkdirSync, statSync, unlinkSync, rmSync, readdirSync, symlinkSync, renameSync } from "fs";
import { join, parse as parsePath, dirname, extname } from "path";
import type { Job, JobStep, AppConfig, ProbeResult } from "./types";
import { probeFile, getOpusBitrateForLayout, getAudioReplacementLabel, normalizeLayout } from "./probe";
import { Logger } from "./logger";
import { CancelledError, run, humanSize, fmtFrames, pct2, escapeXml, describeExitCode, isTimecodesVFR, computeFps } from "./process";
import {
	detectAudioTrackType,
	sortAudioStreams,
	deduplicateAudioStreams,
	detectSubtitleTrackType,
	extractGroupFromTitle,
	buildSubtitleTrackName,
	sortSubtitleStreams,
	isEnglish,
	isJapanese,
} from "./tracks";
import { detectSourceTag, detectReleaseGroup, getResolutionTag, getDenoiseFilter, extractBaseTitle } from "./naming";
import pkg from "../package.json";
import { buildDenoiseConfig, buildPrepareFilterConfig } from "./denoise";

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

function fmtFramesWithFps(current: number, total: number, startedAt: number | undefined): string {
	const base = fmtFrames(current, total);
	const fps = computeFps(current, startedAt);
	return fps ? `${base} (${fps} fps)` : base;
}

export async function encodeJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });

	const stem = parsePath(job.filename).name;
	const sourceTag = detectSourceTag(stem);
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

		// Prepare filter pass (downscale + denoise)
		const prepareFilter = await buildPrepareFilterConfig(job.settings.downscale, probe.height, job.settings.denoise, job.settings.denoiseGpu);
		if (prepareFilter) {
			checkCancelled();

			const totalFrames = Math.round(probe.duration * probe.videoStreamFps);
			setStep(S_PREPARE, { progress: 5, detail: `${prepareFilter.label} — ${fmtFrames(0, totalFrames)}` });
			Logger.info(`[prepare] Applying filters: ${prepareFilter.filter} (${totalFrames} frames)`);

			const filteredVideo = join(tempDir, "source_video_filtered.mkv");
			const filterStartedAt = Date.now();

			const filterProc = Bun.spawn(
				[
					"ffmpeg",
					"-y",
					...prepareFilter.preInputArgs,
					"-i",
					preparedVideo,
					"-vf",
					prepareFilter.filter,
					"-c:v",
					"ffv1",
					"-level",
					"3",
					"-threads",
					"0",
					"-an",
					"-sn",
					filteredVideo,
				],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);

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

				const reader = filterProc.stderr.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let lastUpdate = 0;

				while (true) {
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
						}
					}
				}

				buffer += decoder.decode();
				return buffer;
			})();

			const stdoutTask = new Response(filterProc.stdout).text();

			const [filterCode, stderrTail] = await Promise.all([filterProc.exited, stderrTask, stdoutTask]);
			signal?.removeEventListener("abort", onAbortFilter);
			checkCancelled();

			if (filterCode !== 0) {
				throw new Error(`Prepare filter failed (exit ${filterCode}): ${stderrTail.trim().slice(-500)}`);
			}

			unlinkSync(preparedVideo);
			renameSync(filteredVideo, preparedVideo);

			Logger.info(`[prepare] Filter pass complete`);
		}

		setStep(S_PREPARE, { status: "done", progress: 100 });

		// ABE (scenes + fast + metrics + zones + final)
		checkCancelled();
		updateJob({ status: "encoding_video" });

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
			"--json-stream",
		];

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
				setStep(si, {
					progress: pct2(evt.current, evt.total),
					detail: evt.total ? fmtFramesWithFps(evt.current, evt.total, steps[si]!.startedAt) : undefined,
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

			const reader = abeProc.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
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
		})();

		const abeStderrTask = (async () => {
			if (!abeProc.stderr) return;

			const reader = abeProc.stderr.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				abeStderr += chunk;

				if (chunk.trim()) {
					Logger.error("[ABE stderr]", { error: chunk.trimEnd() });
				}
			}

			abeStderr += decoder.decode();
		})();

		const [abeCode] = await Promise.all([abeProc.exited, abeStdoutTask, abeStderrTask]);
		signal?.removeEventListener("abort", onAbortAbe);
		checkCancelled();

		if (abeCode !== 0) {
			const exitSignal = abeCode > 128 ? describeExitCode(abeCode) : null;
			const detail = abeLastError || abeStderr.trim().slice(-500) || exitSignal || "No error details available";
			throw new Error(`Auto-Boost-Essential failed (exit ${abeCode}): ${detail}`);
		}

		const ivfFile = join(tempDir, "source_video.ivf");
		if (!existsSync(ivfFile)) {
			throw new Error("ABE did not produce output .ivf file");
		}

		const videoMkv = join(tempDir, "video_only.mkv");
		const muxVidRes = await run(["mkvmerge", "-o", videoMkv, ivfFile], { signal });
		if (muxVidRes.code !== 0 && muxVidRes.code !== 1) {
			throw new Error(`mkvmerge video: ${muxVidRes.stderr || muxVidRes.stdout}`);
		}
		updateJob({ encodedVideoSize: humanSize(statSync(videoMkv).size) });

		checkCancelled();
		setStep(S_AUDIO, { status: "active", progress: 0 });
		updateJob({ status: "encoding_audio" });

		const allAudioStreams = probe.audioStreams || [];
		const filteredStreams = allAudioStreams.filter((s) => !s.title || !/compatibility/i.test(s.title));
		const skippedCompat = allAudioStreams.length - filteredStreams.length;
		if (skippedCompat > 0) {
			Logger.info(`[audio] Skipped ${skippedCompat} compatibility track(s)`);
		}

		const audioStreams = deduplicateAudioStreams(sortAudioStreams(filteredStreams));

		if (filteredStreams.length !== audioStreams.length) {
			Logger.info(`[audio] Deduplicated ${filteredStreams.length - audioStreams.length} redundant track(s)`);
		}

		const sortedTypes = audioStreams.map((s) => `${s.language || "und"}:${detectAudioTrackType(s)}:${s.channels || "?"}ch`);
		Logger.info(`[audio] Track order: ${sortedTypes.join(", ")}`);

		const encodedAudioFiles: string[] = [];

		if (audioStreams.length === 0) {
			setStep(S_AUDIO, { status: "done", progress: 100, detail: "No audio streams" });
		} else {
			setStep(S_AUDIO, { progress: 10, detail: `Encoding ${audioStreams.length} audio stream(s)` });

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

				const opusArgs = ["opusenc", "--bitrate", String(bitrate), "--discard-comments", "--discard-pictures"];

				opusArgs.push(flacFile, opusFile);

				const opusRes = await run(opusArgs, { signal });
				if (opusRes.code !== 0) {
					throw new Error(`Audio encoding failed for stream ${i}: ${opusRes.stderr || opusRes.stdout}`);
				}

				setStep(S_AUDIO, {
					progress: 10 + Math.round(((i + 1) / audioStreams.length) * 80),
				});
			}

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
		const outputFilename = `${baseTitle} [${sourceTag}-${resTag}][${audioLabel}][AV1]-${config.organization}.mkv`;
		const finalOutput = join(tempDir, "final.mkv");

		const xmlTags = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<Tags><Tag>",
			"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
			`<Simple><Name>Title</Name><String>${escapeXml(baseTitle)}</String></Simple>`,
			`<Simple><Name>Encoder</Name><String>RabbitEncoder v${pkg.version}</String></Simple>`,
			`<Simple><Name>Encoder Settings</Name><String>Quality ${job.settings.quality}, Speed ${job.settings.finalSpeed}${job.settings.downscale && probe.height > 1080 ? ", Downscale 1080p" : ""}${job.settings.denoise !== "off" ? ", Denoise " + job.settings.denoise : ""}</String></Simple>`,
			...(releaseGroup ? [`<Simple><Name>Source</Name><String>${escapeXml(releaseGroup)}</String></Simple>`] : []),
			"</Tag></Tags>",
		].join("\n");

		const xmlPath = join(tempDir, "tags.xml");
		await Bun.write(xmlPath, xmlTags);

		setStep(S_MUX, { progress: 5, detail: "Preparing tracks" });

		const mkvArgs = ["mkvmerge", "-o", finalOutput, "--title", baseTitle, "--global-tags", xmlPath, "--no-audio", "--no-subtitles"];

		if (existsSync(timecodesFile) && isTimecodesVFR(timecodesFile)) {
			mkvArgs.push("--timestamps", `0:${timecodesFile}`);
		}

		mkvArgs.push("--language", "0:und");
		mkvArgs.push("--track-name", `0:${config.organization}`);
		mkvArgs.push(videoMkv);

		// Audio tracks
		const defaultAssigned = new Set<string>();

		for (let i = 0; i < audioStreams.length; i++) {
			const stream = audioStreams[i]!;
			const trackType = detectAudioTrackType(stream);
			const lang = stream.language || "und";

			const isDefault = trackType === "main" && !defaultAssigned.has(lang);
			if (isDefault) defaultAssigned.add(lang);

			if (stream.language) {
				mkvArgs.push("--language", `0:${stream.language}`);
			}

			mkvArgs.push("--track-name", `0:`);
			mkvArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
			mkvArgs.push("--forced-display-flag", "0:0");

			if (trackType === "commentary") {
				mkvArgs.push("--commentary-flag", "0:1");
			}

			if (trackType === "descriptive") {
				mkvArgs.push("--visual-impaired-flag", "0:1");
			}

			mkvArgs.push(encodedAudioFiles[i]!);
		}

		// Subtitle tracks
		const allSubtitleStreams = probe.subtitleStreams || [];

		const hasEnglishSubs = allSubtitleStreams.some((s) => isEnglish(s.language));
		const hasFullEnglishSubs = allSubtitleStreams.some((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "full");
		const hasJapaneseSubs = allSubtitleStreams.some((s) => isJapanese(s.language));

		if (!hasFullEnglishSubs && hasJapaneseSubs) {
			const reason = hasEnglishSubs ? "Only Signs & Songs English tracks found" : "No English tracks found";
			Logger.warn(`[subtitle] ${reason} but Japanese tracks exist - assuming mislabeled, relabeling Japanese to English`);
			for (const s of allSubtitleStreams) {
				if (isJapanese(s.language)) {
					s.language = "eng";
				}
			}
		}

		const subtitleStreams = sortSubtitleStreams(allSubtitleStreams);

		if (subtitleStreams.length > 0) {
			const subSortedTypes = subtitleStreams.map((s) => `${s.language || "und"}:${detectSubtitleTrackType(s)}`);
			Logger.info(`[subtitle] Track order: ${subSortedTypes.join(", ")}`);

			const subDefaultAssigned = new Set<string>();
			const subForcedAssigned = new Set<string>();

			for (const stream of subtitleStreams) {
				checkCancelled();

				const trackType = detectSubtitleTrackType(stream);
				const lang = stream.language || "und";

				const group = extractGroupFromTitle(stream.title);
				const trackName = buildSubtitleTrackName(trackType, group);

				let effectiveLang = lang;
				if (trackType === "honorifics") {
					effectiveLang = "enm";
				}

				const subFile = join(tempDir, `sub_${stream.index}.mkv`);
				const extractSubRes = await run(
					[
						"ffmpeg",
						"-y",
						"-i",
						job.inputPath,
						"-map",
						`0:${stream.index}`,
						"-c:s",
						"copy",
						"-vn",
						"-an",
						"-map_chapters",
						"-1",
						"-map_metadata",
						"-1",
						subFile,
					],
					{ signal },
				);

				if (extractSubRes.code !== 0) {
					Logger.warn(`[subtitle] Failed to extract track ${stream.index}, skipping: ${extractSubRes.stderr || extractSubRes.stdout}`);
					continue;
				}

				const subIdx = subtitleStreams.indexOf(stream);
				const subProgress = 5 + Math.round(((subIdx + 1) / subtitleStreams.length) * 40);
				setStep(S_MUX, { progress: subProgress, detail: `Extracting subtitles (${subIdx + 1}/${subtitleStreams.length})` });

				mkvArgs.push("--language", `0:${effectiveLang}`);
				mkvArgs.push("--track-name", `0:${trackName}`);

				switch (trackType) {
					case "full": {
						const isDefault = !subDefaultAssigned.has(lang);
						if (isDefault) subDefaultAssigned.add(lang);
						mkvArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
						mkvArgs.push("--forced-display-flag", "0:0");
						mkvArgs.push("--hearing-impaired-flag", "0:0");
						mkvArgs.push("--commentary-flag", "0:0");
						break;
					}
					case "forced": {
						if (subForcedAssigned.has(lang)) {
							Logger.warn(`[subtitle] Duplicate forced track for ${lang}, skipping index ${stream.index}`);
							continue;
						}
						subForcedAssigned.add(lang);
						mkvArgs.push("--default-track-flag", "0:0");
						mkvArgs.push("--forced-display-flag", "0:1");
						mkvArgs.push("--hearing-impaired-flag", "0:0");
						mkvArgs.push("--commentary-flag", "0:0");
						break;
					}
					case "honorifics": {
						mkvArgs.push("--default-track-flag", "0:1");
						mkvArgs.push("--forced-display-flag", "0:0");
						mkvArgs.push("--hearing-impaired-flag", "0:0");
						mkvArgs.push("--commentary-flag", "0:0");
						break;
					}
					case "sdh": {
						mkvArgs.push("--default-track-flag", "0:0");
						mkvArgs.push("--forced-display-flag", "0:0");
						mkvArgs.push("--hearing-impaired-flag", "0:1");
						mkvArgs.push("--commentary-flag", "0:0");
						break;
					}
					case "commentary": {
						mkvArgs.push("--default-track-flag", "0:0");
						mkvArgs.push("--forced-display-flag", "0:0");
						mkvArgs.push("--hearing-impaired-flag", "0:0");
						mkvArgs.push("--commentary-flag", "0:1");
						break;
					}
				}

				mkvArgs.push(subFile);
			}
		} else {
			Logger.info("[subtitle] No subtitle streams found");
		}

		const sourceExt = extname(job.inputPath).toLowerCase();
		if (sourceExt === ".mkv" || sourceExt === ".mks") {
			const safeSourceLink = join(tempDir, `source_ref${sourceExt}`);
			try {
				unlinkSync(safeSourceLink);
			} catch {}
			symlinkSync(job.inputPath, safeSourceLink);
			mkvArgs.push("--no-video", "--no-audio", "--no-subtitles", "--no-global-tags", "--no-track-tags", safeSourceLink);
			Logger.info("[mux] Including font attachments and chapters from source");
		}

		setStep(S_MUX, { progress: 50, detail: `Merging MKV (${subtitleStreams.length} subs, ${audioStreams.length} audio)` });

		const mergeRes = await run(mkvArgs, { signal });
		if (mergeRes.code !== 0 && mergeRes.code !== 1) {
			throw new Error(`mkvmerge failed: ${mergeRes.stderr || mergeRes.stdout}`);
		}

		if (probe.isHDR) {
			setStep(S_MUX, { progress: 75, detail: "Applying HDR metadata" });
			await applyHDRMetadata(finalOutput, probe, signal);
		}

		setStep(S_MUX, { progress: 85, detail: "Moving to output" });

		let outputPath: string;

		if (job.replaceSource) {
			const sourceDir = dirname(job.inputPath);
			outputPath = join(sourceDir, outputFilename);

			cleanupAssociatedFiles(job.inputPath);

			try {
				unlinkSync(job.inputPath);
				Logger.info(`[library] Removed source: ${job.filename}`);
			} catch (err: any) {
				Logger.warn(`[library] Failed to remove source ${job.filename}:`, { "error.message": err?.message });
			}

			const moveRes = await run(["mv", finalOutput, outputPath], { signal });
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath], { signal });
				unlinkSync(finalOutput);
			}

			Logger.info(`[library] Replaced with: ${outputFilename}`);
		} else {
			const outputSubDir = job.relativePath ? join(config.outputDir, job.relativePath) : config.outputDir;
			mkdirSync(outputSubDir, { recursive: true });
			outputPath = join(outputSubDir, outputFilename);

			const moveRes = await run(["mv", finalOutput, outputPath], { signal });
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath], { signal });
				unlinkSync(finalOutput);
			}
		}

		setStep(S_MUX, { status: "done", progress: 100 });

		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: job.replaceSource ? outputFilename : job.relativePath ? `${job.relativePath}/${outputFilename}` : outputFilename,
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

async function applyHDRMetadata(mkvPath: string, probe: ProbeResult, signal?: AbortSignal) {
	const cmd: string[] = ["mkvpropedit", mkvPath, "--edit", "track:v1"];
	cmd.push("--set", "colour-transfer-characteristics=16");
	if (probe.colorPrimaries === "BT.2020") cmd.push("--set", "colour-primaries=9");
	if (probe.matrixCoefficients === "BT.2020 non-constant") cmd.push("--set", "color-matrix-coefficients=9");
	if (probe.colorRange === "Limited") cmd.push("--set", "colour-range=1");
	if (/^\d+$/.test(probe.maxCLL) && /^\d+$/.test(probe.maxFALL)) {
		cmd.push("--set", `max-content-light=${probe.maxCLL}`, "--set", `max-frame-light=${probe.maxFALL}`);
	}
	if (probe.masteringDisplay && probe.masteringLuminance) {
		let RX: string, RY: string, GX: string, GY: string, BX: string, BY: string;
		if (probe.masteringDisplay === "Display P3") {
			[RX, RY, GX, GY, BX, BY] = ["0.6800", "0.3200", "0.2650", "0.6900", "0.1500", "0.0600"];
		} else {
			[RX, RY, GX, GY, BX, BY] = ["0.7080", "0.2920", "0.1700", "0.7970", "0.1310", "0.0460"];
		}
		const maxLum = probe.masteringLuminance.match(/max:\s*([0-9.]+)/)?.[1];
		const minLum = probe.masteringLuminance.match(/min:\s*([0-9.]+)/)?.[1];
		if (maxLum && minLum) {
			cmd.push(
				"--set",
				`chromaticity-coordinates-red-x=${RX}`,
				"--set",
				`chromaticity-coordinates-red-y=${RY}`,
				"--set",
				`chromaticity-coordinates-green-x=${GX}`,
				"--set",
				`chromaticity-coordinates-green-y=${GY}`,
				"--set",
				`chromaticity-coordinates-blue-x=${BX}`,
				"--set",
				`chromaticity-coordinates-blue-y=${BY}`,
				"--set",
				"white-coordinates-x=0.3127",
				"--set",
				"white-coordinates-y=0.3290",
				"--set",
				`max-luminance=${maxLum}`,
				"--set",
				`min-luminance=${minLum}`,
			);
		}
	}
	await run(cmd, { signal });
}
