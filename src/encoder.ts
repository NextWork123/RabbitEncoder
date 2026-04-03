import { existsSync, mkdirSync, statSync, unlinkSync, rmSync, readdirSync, readFileSync } from "fs";
import { join, parse as parsePath, dirname, extname } from "path";
import type { Job, JobStep, AppConfig, ProbeResult, AudioStreamInfo, SubtitleStreamInfo } from "./types";
import { probeFile, getOpusBitrateForLayout, getAudioReplacementLabel, normalizeLayout } from "./probe";
import { Logger } from "./logger";
import pkg from "../package.json";

type AudioTrackType = "main" | "commentary" | "descriptive";

const COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary)\b/i;
const DESCRIPTIVE_PATTERN = /\b(descriptive|description|audio\s*desc(?:ription)?|visually\s*impaired|\bAD\b)\b/i;

function detectAudioTrackType(stream: AudioStreamInfo): AudioTrackType {
	if (!stream.title) return "main";
	if (COMMENTARY_PATTERN.test(stream.title)) return "commentary";
	if (DESCRIPTIVE_PATTERN.test(stream.title)) return "descriptive";
	return "main";
}

/**
 * Sort audio streams: Japanese first, English second, then everything else
 * alphabetically by language code. Within each language group, main tracks
 * come before commentary/descriptive tracks.
 */
function sortAudioStreams(streams: AudioStreamInfo[]): AudioStreamInfo[] {
	const langPriority = (lang: string | undefined): number => {
		const l = (lang || "und").toLowerCase();
		if (l === "jpn" || l === "ja" || l === "japanese") return 0;
		if (l === "eng" || l === "en" || l === "english") return 1;
		return 2;
	};

	const typePriority = (stream: AudioStreamInfo): number => {
		const type = detectAudioTrackType(stream);
		if (type === "main") return 0;
		if (type === "commentary") return 1;
		return 2; // descriptive
	};

	return [...streams].sort((a, b) => {
		const langA = langPriority(a.language);
		const langB = langPriority(b.language);
		if (langA !== langB) return langA - langB;

		// Within the "other" group, sort alphabetically by language code
		if (langA === 2 && langB === 2) {
			const la = (a.language || "und").toLowerCase();
			const lb = (b.language || "und").toLowerCase();
			if (la !== lb) return la.localeCompare(lb);
		}

		// Within same language, main tracks first
		const typeA = typePriority(a);
		const typeB = typePriority(b);
		if (typeA !== typeB) return typeA - typeB;

		// Within same language + same type, sort by channel count ascending
		// (stereo before 5.1 = better default for compatibility)
		return (a.channels || 2) - (b.channels || 2);
	});
}

type SubtitleTrackType = "full" | "forced" | "sdh" | "commentary" | "honorifics";

const SUB_FORCED_PATTERN = /\b(signs?|songs?|forced)\b/i;
const SUB_SDH_PATTERN = /\b(sdh|cc|closed\s*captions?|hearing\s*impaired)\b/i;
const SUB_COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary)\b/i;
const SUB_HONORIFICS_PATTERN = /\b(honorifics?|honours?)\b/i;

function detectSubtitleTrackType(stream: SubtitleStreamInfo): SubtitleTrackType {
	const title = stream.title || "";

	// Check title-based patterns first (more specific than flags)
	if (SUB_HONORIFICS_PATTERN.test(title)) return "honorifics";
	if (SUB_COMMENTARY_PATTERN.test(title)) return "commentary";
	if (SUB_SDH_PATTERN.test(title)) return "sdh";
	if (SUB_FORCED_PATTERN.test(title)) return "forced";

	// Fall back to stream disposition flags
	if (stream.isHearingImpaired) return "sdh";
	if (stream.isForced) return "forced";

	return "full";
}

/**
 * Extract fansub/release group name from a subtitle track title.
 * Looks for text inside brackets or parentheses at the end of the title.
 *
 * Examples:
 *   "English (SubsPlease)" = "SubsPlease"
 *   "Full Subtitles [Erai-raws]" = "Erai-raws"
 *   "Signs/Songs [MTBB]" = "MTBB"
 *   "English" = null
 */
function extractGroupFromTitle(title: string | undefined): string | null {
	if (!title) return null;
	const match = title.match(/[\[(]([A-Za-z0-9._@-]+)[\])](?:\s*$)/);
	return match?.[1] ?? null;
}

/**
 * Build a clean track name for a subtitle stream.
 * Format: "{Type Label} [{Group}]" or just "{Type Label}" if no group.
 */
function buildSubtitleTrackName(trackType: SubtitleTrackType, group: string | null): string {
	const labels: Record<SubtitleTrackType, string> = {
		full: "Full Subtitles",
		forced: "Signs & Songs",
		sdh: "SDH",
		commentary: "Commentary",
		honorifics: "Full Subtitles (Honorifics)",
	};

	const label = labels[trackType];
	return group ? `${label} [${group}]` : label;
}

/**
 * Sort subtitle streams:
 *   - Japanese first, English second, others alphabetically
 *   - Within each language: full -> forced -> honorifics -> sdh -> commentary
 */
function sortSubtitleStreams(streams: SubtitleStreamInfo[]): SubtitleStreamInfo[] {
	const langPriority = (lang: string | undefined): number => {
		const l = (lang || "und").toLowerCase();
		if (l === "jpn" || l === "ja" || l === "japanese") return 0;
		if (l === "eng" || l === "en" || l === "english") return 1;
		return 2;
	};

	const typePriority = (stream: SubtitleStreamInfo): number => {
		const type = detectSubtitleTrackType(stream);
		switch (type) {
			case "full":
				return 0;
			case "forced":
				return 1;
			case "honorifics":
				return 2;
			case "sdh":
				return 3;
			case "commentary":
				return 4;
			default:
				return 5;
		}
	};

	return [...streams].sort((a, b) => {
		const langA = langPriority(a.language);
		const langB = langPriority(b.language);
		if (langA !== langB) return langA - langB;

		// Within the "other" group, sort alphabetically by language code
		if (langA === 2 && langB === 2) {
			const la = (a.language || "und").toLowerCase();
			const lb = (b.language || "und").toLowerCase();
			if (la !== lb) return la.localeCompare(lb);
		}

		// Within same language, sort by type priority
		return typePriority(a) - typePriority(b);
	});
}

const LOSSLESS_CODECS = new Set(["flac", "truehd", "mlp", "dts", "pcm_s16le", "pcm_s24le", "pcm_s32le"]);

/**
 * Deduplicate audio streams: keep only the best source per
 * language + channel count + track type combination.
 * Prefer lossless codecs, then highest bitrate.
 */
function deduplicateAudioStreams(streams: AudioStreamInfo[]): AudioStreamInfo[] {
	const bestMap = new Map<string, AudioStreamInfo>();

	for (const stream of streams) {
		const lang = (stream.language || "und").toLowerCase();
		const type = detectAudioTrackType(stream);
		const key = `${lang}:${stream.channels}:${type}`;

		const existing = bestMap.get(key);
		if (!existing) {
			bestMap.set(key, stream);
			continue;
		}

		const isLossless = LOSSLESS_CODECS.has(stream.codec?.toLowerCase() || "");
		const existingIsLossless = LOSSLESS_CODECS.has(existing.codec?.toLowerCase() || "");

		if (isLossless && !existingIsLossless) {
			bestMap.set(key, stream);
		} else if (isLossless === existingIsLossless && (stream.bitrate || 0) > (existing.bitrate || 0)) {
			bestMap.set(key, stream);
		}
	}

	// Preserve original sort order
	return streams.filter((s) => {
		const lang = (s.language || "und").toLowerCase();
		const type = detectAudioTrackType(s);
		const key = `${lang}:${s.channels}:${type}`;
		return bestMap.get(key) === s;
	});
}

function detectReleaseGroup(filename: string): string | null {
	const match = filename.match(/\]-([A-Za-z0-9._-]+)$/);
	return match?.[1] ?? null;
}

async function run(cmd: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		cwd: opts?.cwd,
	});
	const stdoutText = await new Response(proc.stdout).text();
	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, stdout: stdoutText.trim(), stderr: stderrText.trim() };
}

function humanSize(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(2)} ${units[i]}`;
}

function getResolutionTag(width: number, height: number) {
	if (width >= 3200 || height >= 2100) return "2160p";
	if (width >= 1800 || height >= 1000) return "1080p";
	if (width >= 1200 || height >= 700) return "720p";
	if (width >= 1000 || height >= 560) return "576p";
	if (width > 0 && height > 0) return "480p";
	return "1080p";
}

function fmtFrames(current: number, total: number): string {
	return `${current.toLocaleString()} / ${total.toLocaleString()} frames`;
}

function pct2(current: number, total: number): number {
	if (total <= 0) return 0;
	return Math.round((current / total) * 10000) / 100;
}

function isTimecodesVFR(timecodesPath: string, toleranceMs = 2): boolean {
	const lines = readFileSync(timecodesPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"));

	if (lines.length < 3) return false;

	const timestamps = lines.map(Number);
	const deltas = [];
	for (let i = 1; i < timestamps.length; i++) {
		deltas.push(timestamps[i]! - timestamps[i - 1]!);
	}

	const median = deltas.toSorted((a, b) => a - b)[Math.floor(deltas.length / 2)];
	return deltas.some((d) => Math.abs(d - median!) > toleranceMs);
}

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

export async function encodeJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void): Promise<void> {
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });

	const stem = parsePath(job.filename).name;
	const sourceTag = detectSourceTag(stem);
	const releaseGroup = detectReleaseGroup(stem);
	const baseTitle = stem.replace(/\s*[\-–—]*\s*\[.*/, "").trim();

	const steps = makeSteps();

	function setStep(idx: number, partial: Partial<JobStep>) {
		const step = steps[idx]!;

		// Auto-set startedAt when transitioning to active
		if (partial.status === "active" && step.status !== "active") {
			step.startedAt = Date.now();
			step.finishedAt = undefined;
		}

		// Auto-set finishedAt when transitioning to done or error
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

	try {
		// Probe
		setStep(S_PROBE, { status: "active", progress: 0 });
		updateJob({ status: "probing" });

		const probe = await probeFile(job.inputPath);
		updateJob({ probe });

		setStep(S_PROBE, { status: "done", progress: 100 });

		// Prepare
		setStep(S_PREPARE, { status: "active", progress: 0 });

		const preparedVideo = join(tempDir, "source_video.mkv");
		const timecodesFile = join(tempDir, "timecodes_v2.txt");

		const tcRes = await run(["mkvextract", job.inputPath, "timestamps_v2", `${probe.videoStreamIndex}:${timecodesFile}`]);
		if (tcRes.code !== 0) {
			Logger.warn(`[prepare] Timecodes extraction failed, will use default timing: ${tcRes.stderr || tcRes.stdout}`);
		}

		const extractRes = await run(["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:v:0`, "-c:v", "copy", "-an", "-sn", preparedVideo]);

		if (extractRes.code !== 0) {
			throw new Error(`Failed to extract video stream: ${extractRes.stderr || extractRes.stdout}`);
		}

		setStep(S_PREPARE, { status: "done", progress: 100 });

		// ABE (scenes + fast + metrics + zones + final)
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

		const abeStageToStep: Record<number, number> = {
			0: S_FAST,
			1: S_METRICS,
			2: S_SCENES,
			3: S_ZONES,
			4: S_FINAL,
		};

		let abeStderr = "";

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
					detail: evt.total ? fmtFrames(evt.current, evt.total) : undefined,
				});
				return;
			}

			if (evt.event === "stage_complete" && si !== undefined) {
				setStep(si, {
					status: "done",
					progress: 100,
					detail: evt.total_frames ? fmtFrames(evt.total_frames, evt.total_frames) : steps[si]!.detail,
				});
				return;
			}

			if (evt.event === "error") {
				Logger.error("[ABE error]", { message: evt.message });
			}
		};

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

		const stderrTask = (async () => {
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

		const [abeCode] = await Promise.all([abeProc.exited, stdoutTask, stderrTask]);

		if (abeCode !== 0) {
			throw new Error(`Auto-Boost-Essential failed (exit ${abeCode}): ${abeStderr.slice(-500)}`);
		}

		const ivfFile = join(tempDir, "source_video.ivf");
		if (!existsSync(ivfFile)) {
			throw new Error("ABE did not produce output .ivf file");
		}

		const videoMkv = join(tempDir, "video_only.mkv");
		const muxVidRes = await run(["mkvmerge", "-o", videoMkv, ivfFile]);
		if (muxVidRes.code !== 0 && muxVidRes.code !== 1) {
			throw new Error(`mkvmerge video: ${muxVidRes.stderr || muxVidRes.stdout}`);
		}
		updateJob({ encodedVideoSize: humanSize(statSync(videoMkv).size) });

		// Audio
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

			const delayOutput = await run(["mediainfo", "--Inform=Audio;%Delay%\\n", job.inputPath]).then((r) => r.stdout.trim());
			const delays = delayOutput.split("\n").map((s) => parseFloat(s.trim()) || 0);

			for (let i = 0; i < audioStreams.length; i++) {
				const stream = audioStreams[i]!;
				const flacFile = join(tempDir, `audio_${i}.flac`);
				const opusFile = join(tempDir, `audio_${i}.opus`);
				encodedAudioFiles.push(opusFile);

				const layout = normalizeLayout(stream.channelLayout);
				const bitrate = getOpusBitrateForLayout(layout, job.settings.audioBitrates);

				const delayMs = delays[i] ?? 0;
				const delaySec = delayMs / 1000;

				const ffArgs = ["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:${stream.index}`, "-vn", "-sn", "-dn", "-c:a", "flac"];

				if (delaySec < 0) {
					ffArgs.push("-af", `atrim=start=${Math.abs(delaySec)}`);
				} else if (delaySec > 0) {
					ffArgs.push("-af", `adelay=${delayMs}:all=1`);
				}

				ffArgs.push(flacFile);

				const ffRes = await run(ffArgs);
				if (ffRes.code !== 0) {
					throw new Error(`FFmpeg audio extraction failed for stream ${i}: ${ffRes.stderr || ffRes.stdout}`);
				}

				const opusArgs = ["opusenc", "--bitrate", String(bitrate), "--discard-comments", "--discard-pictures"];

				opusArgs.push(flacFile, opusFile);

				const opusRes = await run(opusArgs);
				if (opusRes.code !== 0) {
					throw new Error(`Audio encoding failed for stream ${i}: ${opusRes.stderr || opusRes.stdout}`);
				}

				setStep(S_AUDIO, {
					progress: 10 + Math.round(((i + 1) / audioStreams.length) * 80),
				});
			}

			setStep(S_AUDIO, { status: "done", progress: 100 });
		}

		// Mux & Finish
		setStep(S_MUX, { status: "active", progress: 0, detail: "Merging MKV" });
		updateJob({ status: "muxing" });

		const firstSortedLayout = audioStreams.length > 0 ? normalizeLayout(audioStreams[0]!.channelLayout) : probe.audioLayout;
		const audioLabel = getAudioReplacementLabel(firstSortedLayout);
		const resTag = getResolutionTag(probe.width, probe.height);
		const outputFilename = `${baseTitle} [${sourceTag}-${resTag}][${audioLabel}][AV1]-${config.organization}.mkv`;
		const finalOutput = join(tempDir, "final.mkv");

		const xmlTags = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<Tags><Tag>",
			"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
			`<Simple><Name>Title</Name><String>${escapeXml(baseTitle)}</String></Simple>`,
			`<Simple><Name>Encoder</Name><String>RabbitEncoder v${pkg.version}</String></Simple>`,
			`<Simple><Name>Encoder Settings</Name><String>Quality ${job.settings.quality}, Speed ${job.settings.finalSpeed}</String></Simple>`,
			...(releaseGroup ? [`<Simple><Name>Source</Name><String>${escapeXml(releaseGroup)}</String></Simple>`] : []),
			"</Tag></Tags>",
		].join("\n");

		const xmlPath = join(tempDir, "tags.xml");
		await Bun.write(xmlPath, xmlTags);

		setStep(S_MUX, { progress: 30, detail: "Merging MKV" });

		const mkvArgs = ["mkvmerge", "-o", finalOutput, "--title", baseTitle, "--global-tags", xmlPath, "--no-audio", "--no-subtitles"];

		if (existsSync(timecodesFile) && isTimecodesVFR(timecodesFile)) {
			mkvArgs.push("--timestamps", `0:${timecodesFile}`);
		}

		mkvArgs.push("--language", "0:und");
		mkvArgs.push("--track-name", `0:${config.organization}`);
		mkvArgs.push(videoMkv);

		// Track which languages already have a default main track assigned
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

		const allSubtitleStreams = probe.subtitleStreams || [];

		// Fix mislabeled subtitles: some sources tag English subs as Japanese.
		// If no English subs exist but Japanese ones do, relabel them as English.
		const isEng = (l: string | undefined) => {
			const lc = (l || "").toLowerCase();
			return lc === "eng" || lc === "en" || lc === "english";
		};
		const isJpn = (l: string | undefined) => {
			const lc = (l || "").toLowerCase();
			return lc === "jpn" || lc === "ja" || lc === "japanese";
		};

		const hasEnglishSubs = allSubtitleStreams.some((s) => isEng(s.language));
		const hasJapaneseSubs = allSubtitleStreams.some((s) => isJpn(s.language));

		if (!hasEnglishSubs && hasJapaneseSubs) {
			Logger.warn("[subtitle] No English tracks found but Japanese tracks exist - assuming mislabeled, relabeling Japanese to English");
			for (const s of allSubtitleStreams) {
				if (isJpn(s.language)) {
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
				const trackType = detectSubtitleTrackType(stream);
				const lang = stream.language || "und";

				const group = extractGroupFromTitle(stream.title);
				const trackName = buildSubtitleTrackName(trackType, group);

				let effectiveLang = lang;
				if (trackType === "honorifics") {
					effectiveLang = "enm";
				}

				const subFile = join(tempDir, `sub_${stream.index}.mkv`);
				const extractSubRes = await run(["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:${stream.index}`, "-c:s", "copy", "-vn", "-an", subFile]);

				if (extractSubRes.code !== 0) {
					Logger.warn(`[subtitle] Failed to extract track ${stream.index}, skipping: ${extractSubRes.stderr || extractSubRes.stdout}`);
					continue;
				}

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

		const mergeRes = await run(mkvArgs);
		if (mergeRes.code !== 0 && mergeRes.code !== 1) {
			throw new Error(`mkvmerge failed: ${mergeRes.stderr || mergeRes.stdout}`);
		}

		if (probe.isHDR) {
			setStep(S_MUX, { progress: 60, detail: "Applying HDR metadata" });
			await applyHDRMetadata(finalOutput, probe);
		}

		setStep(S_MUX, { progress: 80, detail: "Moving to output" });

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

			const moveRes = await run(["mv", finalOutput, outputPath]);
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath]);
				unlinkSync(finalOutput);
			}

			Logger.info(`[library] Replaced with: ${outputFilename}`);
		} else {
			const outputSubDir = job.relativePath ? join(config.outputDir, job.relativePath) : config.outputDir;
			mkdirSync(outputSubDir, { recursive: true });
			outputPath = join(outputSubDir, outputFilename);

			const moveRes = await run(["mv", finalOutput, outputPath]);
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath]);
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

		updateJob({
			status: "error",
			currentStage: "Failed",
			steps: [...steps],
			error: err?.message || String(err),
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
}

async function applyHDRMetadata(mkvPath: string, probe: ProbeResult) {
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
	await run(cmd);
}

function detectSourceTag(filename: string): string {
	const upper = filename.toUpperCase();

	// Remux should become Bluray after encode
	if (/\bREMUX\b/.test(upper)) return "Bluray";

	const sources = ["WEBDL", "WEBRIP", "BLURAY", "HDTV", "DVD", "SDTV", "CAM"] as const;

	for (const source of sources) {
		if (new RegExp(`\\b${source}\\b`).test(upper)) {
			switch (source) {
				case "BLURAY":
					return "Bluray";
				case "WEBRIP":
					return "WEBRip";
				case "WEBDL":
					return "WEBDL";
				case "HDTV":
					return "HDTV";
				case "DVD":
					return "DVD";
				case "SDTV":
					return "SDTV";
				case "CAM":
					return "CAM";
			}
		}
	}

	return "Bluray";
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
