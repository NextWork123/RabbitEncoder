import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { resolve, dirname, join, extname, relative, basename } from "path";
import {
	type Job,
	type JobSettings,
	type AppConfig,
	type DenoiseBackend,
	type PreviewState,
	MEDIA_EXTENSIONS,
	type VideoEncodeMode,
	type AudioEncodeMode,
	type SubtitleProcessingMode,
} from "./types";
import { encodeJob, CancelledError } from "./encoder";
import { isAlreadyEncoded } from "./library";
import { Logger } from "./logger";
import { normalizeNlmeansLevelParams, normalizeGradfunLevelParams } from "./filters";
import { runPreviewEncode, deletePreviewDir, previewSettingsFingerprint, DEFAULT_PREVIEW_OPTIONS } from "./preview-encoder";
import { normalizeVsFilterChain } from "./vs-filters";
import { getDefaultJobSettings } from "./config";
import { isValidEncoder } from "./encoders";

const jobs = new Map<string, Job>();
let paused = false;
let processing = false;
let orderCounter = 0;
let appConfig: AppConfig;
let queueFile = "";
let settingsFile = "";
let activeAbortController: AbortController | null = null;
let activeJobId: string | null = null;

const previews = new Map<string, PreviewState>();
let activePreviewJobId: string | null = null;
let activePreviewAbort: AbortController | null = null;

const VALID_VIDEO_ENCODE: VideoEncodeMode[] = ["av1", "off"];
const VALID_AUDIO_ENCODE: AudioEncodeMode[] = ["opus", "copy"];
const VALID_SUBTITLE_PROCESSING: SubtitleProcessingMode[] = ["full", "copy"];
const VALID_DENOISE_BACKENDS: DenoiseBackend[] = ["cpu", "auto", "vulkan", "opencl"];

export function initStore(config: AppConfig) {
	appConfig = config;
	queueFile = join(config.tempDir, "queue.json");
	settingsFile = join(config.tempDir, "settings.json");
	loadSettings();
	loadQueue();
	processQueue();
}

export function isQueuePaused(): boolean {
	return paused;
}

export function pauseQueue(): boolean {
	if (paused) return false;
	paused = true;
	Logger.info("[store] Queue paused");
	if (activeAbortController) {
		activeAbortController.abort();
	}
	return true;
}

export function resumeQueue(): boolean {
	if (!paused) return false;
	paused = false;
	Logger.info("[store] Queue resumed");
	processQueue();
	return true;
}

function saveQueue(): void {
	if (!queueFile) return;
	try {
		const persistable = Array.from(jobs.values())
			.filter((j) => j.status !== "done" && j.status !== "cancelled")
			.map((j) => {
				const isActive = j.status !== "queued" && j.status !== "error";
				return {
					...j,
					status: isActive ? "queued" : j.status,
					progress: isActive ? 0 : j.progress,
					currentStage: isActive ? "Waiting in queue" : j.currentStage,
					steps: isActive ? [] : j.steps,
					startedAt: isActive ? undefined : j.startedAt,
					finishedAt: isActive ? undefined : j.finishedAt,
				};
			});
		writeFileSync(queueFile, JSON.stringify(persistable));
	} catch (err: any) {
		Logger.warn("[store] Failed to save queue:", { "error.message": err?.message });
	}
}

function loadQueue(): void {
	try {
		if (!existsSync(queueFile)) return;
		const data = JSON.parse(readFileSync(queueFile, "utf-8"));
		if (!Array.isArray(data)) return;

		for (const raw of data) {
			if (!raw.id || !raw.filename || !raw.inputPath) continue;
			try {
				statSync(raw.inputPath);
			} catch {
				Logger.info(`[store] Skipping restored job ${raw.id}: input file missing`);
				continue;
			}

			raw.settings = { ...appConfig.defaults, ...(raw.settings ?? {}) };

			jobs.set(raw.id, raw as Job);
			if (raw.queueOrder > orderCounter) {
				orderCounter = raw.queueOrder;
			}
		}

		const count = jobs.size;
		if (count > 0) {
			Logger.info(`[store] Restored ${count} job(s) from queue file`);
		}
	} catch (err: any) {
		Logger.warn("[store] Failed to load queue:", { "error.message": err?.message });
	}
}

function saveSettings(): void {
	if (!settingsFile) return;
	try {
		writeFileSync(settingsFile, JSON.stringify(appConfig.defaults, null, 2));
	} catch (err: any) {
		Logger.warn("[store] Failed to save settings:", { "error.message": err?.message });
	}
}

function loadSettings(): void {
	try {
		if (!existsSync(settingsFile)) return;
		const raw = JSON.parse(readFileSync(settingsFile, "utf-8"));
		if (!raw || typeof raw !== "object") return;
		appConfig.defaults = { ...appConfig.defaults, ...raw };
		Logger.info("[store] Restored defaults from settings.json");
	} catch (err: any) {
		Logger.warn("[store] Failed to load settings:", { "error.message": err?.message });
	}
}

export function getAppConfig(): AppConfig {
	return appConfig;
}

export function updateDefaults(settings: Partial<JobSettings>): JobSettings {
	if (isValidEncoder(settings.encoder)) {
		appConfig.defaults.encoder = settings.encoder;
	}
	if (typeof settings.manualCrf === "number" && Number.isFinite(settings.manualCrf)) {
		appConfig.defaults.manualCrf = Math.min(63, Math.max(0, settings.manualCrf));
	}
	if (typeof settings.manualPreset === "number" && Number.isFinite(settings.manualPreset)) {
		appConfig.defaults.manualPreset = Math.min(13, Math.max(0, Math.round(settings.manualPreset)));
	}
	if (typeof settings.customEncoderParams === "string") {
		appConfig.defaults.customEncoderParams = settings.customEncoderParams.slice(0, 2000);
	}

	if (typeof settings.videoEncode === "string" && VALID_VIDEO_ENCODE.includes(settings.videoEncode)) {
		appConfig.defaults.videoEncode = settings.videoEncode;
	}
	if (typeof settings.audioEncode === "string" && VALID_AUDIO_ENCODE.includes(settings.audioEncode)) {
		appConfig.defaults.audioEncode = settings.audioEncode;
	}
	if (typeof settings.subtitleProcessing === "string" && VALID_SUBTITLE_PROCESSING.includes(settings.subtitleProcessing)) {
		appConfig.defaults.subtitleProcessing = settings.subtitleProcessing;
	}
	if (settings.quality) appConfig.defaults.quality = settings.quality;
	if (settings.finalSpeed) appConfig.defaults.finalSpeed = settings.finalSpeed;
	if (settings.denoise) appConfig.defaults.denoise = settings.denoise;

	if (settings.denoiseBackend && VALID_DENOISE_BACKENDS.includes(settings.denoiseBackend)) {
		appConfig.defaults.denoiseBackend = settings.denoiseBackend;
	}
	if (typeof settings.gpuDevice === "string" && settings.gpuDevice.length > 0) {
		appConfig.defaults.gpuDevice = settings.gpuDevice;
	}

	if (settings.deband) appConfig.defaults.deband = settings.deband;
	if (typeof settings.downscale === "boolean") appConfig.defaults.downscale = settings.downscale;
	if (typeof settings.skipBoosting === "boolean") appConfig.defaults.skipBoosting = settings.skipBoosting;
	if (typeof settings.noPhaseInv === "boolean") appConfig.defaults.noPhaseInv = settings.noPhaseInv;
	if (typeof settings.dedupeSubtitles === "boolean") appConfig.defaults.dedupeSubtitles = settings.dedupeSubtitles;
	if (typeof settings.keepBestAudioChannelsOnly === "boolean") appConfig.defaults.keepBestAudioChannelsOnly = settings.keepBestAudioChannelsOnly;
	if (typeof settings.removeCommentaryAudio === "boolean") appConfig.defaults.removeCommentaryAudio = settings.removeCommentaryAudio;
	if (Array.isArray(settings.audioLanguages)) {
		appConfig.defaults.audioLanguages = settings.audioLanguages.map((s) => String(s).trim()).filter((s) => s.length > 0);
	}
	if (Array.isArray(settings.subtitleLanguages)) {
		appConfig.defaults.subtitleLanguages = settings.subtitleLanguages.map((s) => String(s).trim()).filter((s) => s.length > 0);
	}
	if (settings.autoDenoiseThresholds) {
		const t = settings.autoDenoiseThresholds;
		if (typeof t.light === "number" && typeof t.medium === "number" && typeof t.heavy === "number") {
			appConfig.defaults.autoDenoiseThresholds = { light: t.light, medium: t.medium, heavy: t.heavy };
		}
	}
	if (settings.nlmeansParams) {
		appConfig.defaults.nlmeansParams = normalizeNlmeansLevelParams(settings.nlmeansParams, appConfig.defaults.nlmeansParams);
	}
	if (settings.gradfunParams) {
		appConfig.defaults.gradfunParams = normalizeGradfunLevelParams(settings.gradfunParams, appConfig.defaults.gradfunParams);
	}
	if (Array.isArray(settings.vsFilters)) {
		appConfig.defaults.vsFilters = normalizeVsFilterChain(settings.vsFilters);
	}
	if (settings.audioBitrates) {
		appConfig.defaults.audioBitrates = {
			...appConfig.defaults.audioBitrates,
			...settings.audioBitrates,
		};
	}

	saveSettings();
	return appConfig.defaults;
}

export function resetDefaults(): JobSettings {
	appConfig.defaults = getDefaultJobSettings();
	try {
		if (settingsFile && existsSync(settingsFile)) unlinkSync(settingsFile);
	} catch (err: any) {
		Logger.warn("[store] Failed to delete settings.json:", { "error.message": err?.message });
	}
	Logger.info("[store] Defaults reset");
	return appConfig.defaults;
}

export function getAllJobs(): Job[] {
	return Array.from(jobs.values()).sort((a, b) => {
		const order: Record<string, number> = {
			probing: 0,
			encoding_video: 0,
			encoding_audio: 0,
			muxing: 0,
			queued: 1,
			done: 2,
			error: 3,
			cancelled: 3,
		};
		const diff = (order[a.status] ?? 1) - (order[b.status] ?? 1);
		if (diff !== 0) return diff;
		if (a.status === "queued" && b.status === "queued") {
			return a.queueOrder - b.queueOrder;
		}
		return (a.startedAt || 0) - (b.startedAt || 0);
	});
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id);
}

export function addJob(filename: string, inputPath: string, relativePath: string = "", replaceSource: boolean = false): Job {
	for (const job of jobs.values()) {
		if (job.inputPath === inputPath && job.status !== "error" && job.status !== "done") {
			return job;
		}
	}

	const id = crypto.randomUUID().slice(0, 8);
	const job: Job = {
		id,
		filename,
		inputPath,
		relativePath,
		status: "queued",
		progress: 0,
		queueOrder: ++orderCounter,
		currentStage: "Waiting in queue",
		steps: [],
		settings: {
			...appConfig.defaults,
			audioBitrates: { ...appConfig.defaults.audioBitrates },
			autoDenoiseThresholds: { ...appConfig.defaults.autoDenoiseThresholds },
			nlmeansParams: {
				light: { ...appConfig.defaults.nlmeansParams.light },
				medium: { ...appConfig.defaults.nlmeansParams.medium },
				heavy: { ...appConfig.defaults.nlmeansParams.heavy },
			},
			gradfunParams: {
				light: { ...appConfig.defaults.gradfunParams.light },
				medium: { ...appConfig.defaults.gradfunParams.medium },
				heavy: { ...appConfig.defaults.gradfunParams.heavy },
			},
		},
		replaceSource,
	};

	jobs.set(id, job);
	saveQueue();
	processQueue();
	return job;
}

export function scanLibraryFolder(folderPath: string): { added: number; skipped: number; alreadyEncoded: number } {
	let added = 0;
	let skipped = 0;
	let alreadyEncoded = 0;

	function scan(dir: string) {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					scan(fullPath);
					continue;
				}

				const ext = extname(entry.name).toLowerCase();
				if (!MEDIA_EXTENSIONS.has(ext)) continue;

				if (isAlreadyEncoded(entry.name, appConfig.organization)) {
					alreadyEncoded++;
					continue;
				}

				let alreadyExists = false;
				for (const job of jobs.values()) {
					if (job.inputPath === fullPath && job.status !== "error" && job.status !== "done") {
						alreadyExists = true;
						break;
					}
				}

				if (alreadyExists) {
					skipped++;
					continue;
				}

				const folderName = basename(folderPath);
				const rel = relative(folderPath, dir);
				const relativePath = rel === "." ? folderName : `${folderName}/${rel}`;
				const displayName = relativePath ? `${relativePath}/${entry.name}` : entry.name;

				Logger.info(`[library] Queuing: ${displayName}`);
				addJob(entry.name, fullPath, relativePath, true);
				added++;
			}
		} catch (err: any) {
			Logger.error(`[library] Error scanning ${dir}:`, { "error.message": err?.message });
		}
	}

	scan(folderPath);
	return { added, skipped, alreadyEncoded };
}

export function scanLibraryPath(targetPath: string): { added: number; skipped: number; alreadyEncoded: number } {
	const resolved = resolve(targetPath);

	try {
		const stat = statSync(resolved);
		if (stat.isDirectory()) {
			return scanLibraryFolder(resolved);
		}
	} catch {
		return { added: 0, skipped: 0, alreadyEncoded: 0 };
	}

	const filename = basename(resolved);
	const ext = extname(filename).toLowerCase();

	if (!MEDIA_EXTENSIONS.has(ext)) {
		return { added: 0, skipped: 0, alreadyEncoded: 0 };
	}

	if (isAlreadyEncoded(filename, appConfig.organization)) {
		return { added: 0, skipped: 0, alreadyEncoded: 1 };
	}

	for (const job of jobs.values()) {
		if (job.inputPath === resolved && job.status !== "error" && job.status !== "done") {
			return { added: 0, skipped: 1, alreadyEncoded: 0 };
		}
	}

	const dir = dirname(resolved);
	const folderName = basename(dir);
	addJob(filename, resolved, folderName, true);
	return { added: 1, skipped: 0, alreadyEncoded: 0 };
}

export function updateJobSettings(id: string, settings: Partial<JobSettings>): Job | null {
	const job = jobs.get(id);
	if (!job || job.status !== "queued") return null;

	if (isValidEncoder(settings.encoder)) {
		job.settings.encoder = settings.encoder;
	}
	if (typeof settings.manualCrf === "number" && Number.isFinite(settings.manualCrf)) {
		job.settings.manualCrf = Math.min(63, Math.max(0, settings.manualCrf));
	}
	if (typeof settings.manualPreset === "number" && Number.isFinite(settings.manualPreset)) {
		job.settings.manualPreset = Math.min(13, Math.max(0, Math.round(settings.manualPreset)));
	}
	if (typeof settings.customEncoderParams === "string") {
		job.settings.customEncoderParams = settings.customEncoderParams.slice(0, 2000);
	}

	if (typeof settings.videoEncode === "string" && VALID_VIDEO_ENCODE.includes(settings.videoEncode)) {
		job.settings.videoEncode = settings.videoEncode;
	}
	if (typeof settings.audioEncode === "string" && VALID_AUDIO_ENCODE.includes(settings.audioEncode)) {
		job.settings.audioEncode = settings.audioEncode;
	}
	if (typeof settings.subtitleProcessing === "string" && VALID_SUBTITLE_PROCESSING.includes(settings.subtitleProcessing)) {
		job.settings.subtitleProcessing = settings.subtitleProcessing;
	}

	if (settings.quality) job.settings.quality = settings.quality;
	if (settings.finalSpeed) job.settings.finalSpeed = settings.finalSpeed;
	if (settings.denoise) job.settings.denoise = settings.denoise;

	if (settings.denoiseBackend && VALID_DENOISE_BACKENDS.includes(settings.denoiseBackend)) {
		job.settings.denoiseBackend = settings.denoiseBackend;
	}
	if (typeof settings.gpuDevice === "string" && settings.gpuDevice.length > 0) {
		job.settings.gpuDevice = settings.gpuDevice;
	}

	if (settings.deband) job.settings.deband = settings.deband;
	if (typeof settings.downscale === "boolean") job.settings.downscale = settings.downscale;
	if (typeof settings.skipBoosting === "boolean") job.settings.skipBoosting = settings.skipBoosting;
	if (typeof settings.noPhaseInv === "boolean") job.settings.noPhaseInv = settings.noPhaseInv;
	if (typeof settings.dedupeSubtitles === "boolean") job.settings.dedupeSubtitles = settings.dedupeSubtitles;
	if (typeof settings.keepBestAudioChannelsOnly === "boolean") job.settings.keepBestAudioChannelsOnly = settings.keepBestAudioChannelsOnly;
	if (typeof settings.removeCommentaryAudio === "boolean") job.settings.removeCommentaryAudio = settings.removeCommentaryAudio;
	if (Array.isArray(settings.audioLanguages)) {
		job.settings.audioLanguages = settings.audioLanguages.map((s) => String(s).trim()).filter((s) => s.length > 0);
	}
	if (Array.isArray(settings.subtitleLanguages)) {
		job.settings.subtitleLanguages = settings.subtitleLanguages.map((s) => String(s).trim()).filter((s) => s.length > 0);
	}
	if (settings.autoDenoiseThresholds) {
		const t = settings.autoDenoiseThresholds;
		if (typeof t.light === "number" && typeof t.medium === "number" && typeof t.heavy === "number") {
			job.settings.autoDenoiseThresholds = { light: t.light, medium: t.medium, heavy: t.heavy };
		}
	}
	if (settings.nlmeansParams) {
		job.settings.nlmeansParams = normalizeNlmeansLevelParams(settings.nlmeansParams, job.settings.nlmeansParams);
	}
	if (settings.gradfunParams) {
		job.settings.gradfunParams = normalizeGradfunLevelParams(settings.gradfunParams, job.settings.gradfunParams);
	}

	if (Array.isArray(settings.vsFilters)) {
		job.settings.vsFilters = normalizeVsFilterChain(settings.vsFilters);
	}

	if (settings.audioBitrates) {
		job.settings.audioBitrates = {
			...job.settings.audioBitrates,
			...settings.audioBitrates,
		};
	}

	saveQueue();
	return job;
}

export function removeJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job) return false;
	if (job.status !== "queued" && job.status !== "done" && job.status !== "error" && job.status !== "cancelled") return false;
	jobs.delete(id);
	clearPreviewFor(id);
	saveQueue();
	return true;
}

export function retryJob(id: string): Job | null {
	const job = jobs.get(id);
	if (!job || job.status !== "error") return null;

	job.status = "queued";
	job.progress = 0;
	job.queueOrder = ++orderCounter;
	job.currentStage = "Waiting in queue";
	job.steps = [];
	job.error = undefined;
	job.startedAt = undefined;
	job.finishedAt = undefined;

	saveQueue();
	processQueue();
	return job;
}

export function cancelJob(id: string): boolean {
	if (!activeJobId || activeJobId !== id || !activeAbortController) return false;
	Logger.info(`[store] Cancelling job ${id}`);
	activeAbortController.abort();
	return true;
}

export function moveJob(id: string, direction: "up" | "down" | "top" | "bottom"): boolean {
	const job = jobs.get(id);
	if (!job || job.status !== "queued") return false;

	const queued = Array.from(jobs.values())
		.filter((j) => j.status === "queued")
		.sort((a, b) => a.queueOrder - b.queueOrder);

	const idx = queued.findIndex((j) => j.id === id);
	if (idx === -1) return false;

	if (direction === "up" && idx > 0) {
		const prev = queued[idx - 1]!;
		const tmp = job.queueOrder;
		job.queueOrder = prev.queueOrder;
		prev.queueOrder = tmp;
	} else if (direction === "down" && idx < queued.length - 1) {
		const next = queued[idx + 1]!;
		const tmp = job.queueOrder;
		job.queueOrder = next.queueOrder;
		next.queueOrder = tmp;
	} else if (direction === "top" && idx > 0) {
		const minOrder = queued[0]!.queueOrder;
		job.queueOrder = minOrder - 1;
	} else if (direction === "bottom" && idx < queued.length - 1) {
		const maxOrder = queued[queued.length - 1]!.queueOrder;
		job.queueOrder = maxOrder + 1;
	} else {
		return false;
	}

	saveQueue();
	return true;
}

export function reorderJobs(orderedIds: string[]): boolean {
	let seq = 1;
	for (const id of orderedIds) {
		const job = jobs.get(id);
		if (job && job.status === "queued") {
			job.queueOrder = seq++;
		}
	}
	saveQueue();
	return true;
}

async function processQueue() {
	if (processing || paused) return;

	const next = Array.from(jobs.values())
		.filter((j) => j.status === "queued")
		.sort((a, b) => a.queueOrder - b.queueOrder)[0];
	if (!next) return;

	clearPreviewFor(next.id);

	processing = true;
	next.startedAt = Date.now();
	saveQueue();

	const controller = new AbortController();
	activeAbortController = controller;
	activeJobId = next.id;

	const updateFn = (partial: Partial<Job>) => {
		Object.assign(next, partial);
	};

	try {
		await encodeJob(next, appConfig, updateFn, controller.signal);
	} catch (err: any) {
		if (err instanceof CancelledError) {
			if (paused) {
				next.status = "queued";
				next.progress = 0;
				next.currentStage = "Waiting in queue";
				next.steps = [];
				next.startedAt = undefined;
				next.finishedAt = undefined;
				next.error = undefined;
				Logger.info(`[store] Job ${next.id} paused and returned to queue`);
			} else {
				jobs.delete(next.id);
				Logger.info(`[store] Job ${next.id} cancelled and removed`);
			}
		} else {
			next.status = "error";
			next.error = err?.message || String(err);
		}
	}

	activeAbortController = null;
	activeJobId = null;
	processing = false;
	saveQueue();
	processQueue();
}

export function getPreviewState(jobId: string): PreviewState | null {
	return previews.get(jobId) ?? null;
}

export function isPreviewRunning(): boolean {
	return activePreviewJobId !== null;
}

export type StartPreviewResult = { ok: true; state: PreviewState } | { ok: false; error: string; status: 400 | 404 | 409 };

export function startPreview(jobId: string): StartPreviewResult {
	if (activePreviewJobId !== null) {
		return { ok: false, error: `Another preview is already running (job ${activePreviewJobId})`, status: 409 };
	}

	const job = jobs.get(jobId);
	if (!job) return { ok: false, error: "Job not found", status: 404 };
	if (job.status === "done") return { ok: false, error: "Preview only available for unfinished jobs", status: 400 };

	const controller = new AbortController();
	activePreviewJobId = jobId;
	activePreviewAbort = controller;

	const state: PreviewState = {
		jobId,
		status: "running",
		progress: 0,
		currentDetail: "Starting…",
		samples: [],
		settingsFingerprint: previewSettingsFingerprint(job.settings),
		sampleCount: DEFAULT_PREVIEW_OPTIONS.sampleCount,
		windowSeconds: DEFAULT_PREVIEW_OPTIONS.windowSeconds,
		startedAt: Date.now(),
	};
	previews.set(jobId, state);

	(async () => {
		try {
			await runPreviewEncode({
				job,
				config: appConfig,
				signal: controller.signal,
				onUpdate: (partial) => {
					const cur = previews.get(jobId);
					if (cur) Object.assign(cur, partial);
				},
			});
			const cur = previews.get(jobId);
			if (cur) {
				cur.status = "done";
				cur.progress = 100;
				cur.currentDetail = "Complete";
				cur.finishedAt = Date.now();
			}
			Logger.info(`[preview] Job ${jobId} preview complete`);
		} catch (err) {
			const cur = previews.get(jobId);
			if (cur) {
				if (err instanceof CancelledError) {
					cur.status = "cancelled";
					cur.currentDetail = "Cancelled";
				} else {
					cur.status = "error";
					cur.error = err instanceof Error ? err.message : String(err);
					cur.currentDetail = "Failed";
				}
				cur.finishedAt = Date.now();
			}
			Logger.warn(`[preview] Job ${jobId} preview ended: ${err instanceof Error ? err.message : err}`);
		} finally {
			if (activePreviewJobId === jobId) {
				activePreviewJobId = null;
				activePreviewAbort = null;
			}
		}
	})();

	return { ok: true, state };
}

export function cancelPreview(jobId: string): boolean {
	if (activePreviewJobId !== jobId || !activePreviewAbort) return false;
	Logger.info(`[preview] Cancelling preview for job ${jobId}`);
	activePreviewAbort.abort();
	return true;
}

export function clearPreviewFor(jobId: string): void {
	if (activePreviewJobId === jobId && activePreviewAbort) {
		activePreviewAbort.abort();
		activePreviewJobId = null;
		activePreviewAbort = null;
	}
	previews.delete(jobId);
	deletePreviewDir(appConfig, jobId);
}
