import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { loadConfig } from "./config";
import {
	initStore,
	getAllJobs,
	getJob,
	updateJobSettings,
	removeJob,
	retryJob,
	updateDefaults,
	scanLibraryPath,
	moveJob,
	reorderJobs,
	cancelJob,
	isQueuePaused,
	pauseQueue,
	resumeQueue,
	getPreviewState,
	startPreview,
	cancelPreview,
	clearPreviewFor,
	resetDefaults,
} from "./store";
import { startWatcher } from "./watcher";
import { browseFolder, isPathAllowed } from "./library";
import { Web } from "@rabbit-company/web";
import { cors } from "@rabbit-company/web-middleware/cors";
import type { JobSettings } from "./types";
import { Logger } from "./logger";
import indexHtml from "../public/index.html";
import { bearerAuth } from "@rabbit-company/web-middleware/bearer-auth";
import { previewAudio, previewSubtitles } from "./tracks";
import { join } from "path";
import { probeFile } from "./probe";
import { cancelBenchmark, getBenchmarkState, startBenchmark } from "./benchmark";
import { listOpenClDevices } from "./opencl";
import { listVulkanDevices } from "./vulkan";
import { resolvePreviewArtifact } from "./preview-encoder";
import { makeDefaultVsFilterEntry, vsRegistry } from "./vs-filters";

export const config = await loadConfig();

vsRegistry.configure(
	process.env.VS_PRESETS_STOCK_DIR ?? "/app/vapoursynth/presets",
	process.env.VS_PRESETS_USER_DIR ?? "/config/vapoursynth/presets",
	process.env.VS_RABBIT_MODULE_DIR ?? "/app/vapoursynth",
);
vsRegistry.reload();

const hashedPassword = new Bun.CryptoHasher("blake2b512").update(`rabbitencoder-${process.env.PASSWORD || "rabbitencoder"}`).digest("hex");

mkdirSync(config.inputDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
mkdirSync(config.tempDir, { recursive: true });

initStore(config);

startWatcher(config.inputDir);

const app = new Web();
app.use(cors());
app.use(
	bearerAuth({
		validate(token, ctx) {
			if (token.length !== hashedPassword.length) {
				return !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(token));
			}

			return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(hashedPassword));
		},
	}),
);

app.get("/api/opencl-devices", async (c) => {
	const devices = await listOpenClDevices();
	return c.json({ devices });
});

app.get("/api/vulkan-devices", async (c) => {
	const devices = await listVulkanDevices();
	return c.json({ devices });
});

app.get("/api/jobs", (c) => {
	return c.json(getAllJobs());
});

app.get("/api/jobs/:id", (c) => {
	const job = getJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found" }, 404);
	return c.json(job);
});

app.patch("/api/jobs/:id", async (c) => {
	const body = (await c.req.json()) as Partial<JobSettings>;
	const job = updateJobSettings(c.params.id!, body);
	if (!job) return c.json({ error: "Job not found or not editable" }, 400);
	return c.json(job);
});

app.delete("/api/jobs/:id", (c) => {
	const ok = removeJob(c.params.id!);
	if (!ok) return c.json({ error: "Cannot remove active job" }, 400);
	return c.json({ ok: true });
});

app.post("/api/jobs/:id/retry", (c) => {
	const job = retryJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found or not retryable" }, 400);
	return c.json(job);
});

app.post("/api/jobs/:id/cancel", (c) => {
	const ok = cancelJob(c.params.id!);
	if (!ok) return c.json({ error: "Job not found or not currently encoding" }, 400);
	return c.json({ ok: true });
});

app.get("/api/jobs/:id/subtitle-preview", async (c) => {
	const job = getJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found" }, 404);

	if (!existsSync(job.inputPath)) {
		return c.json({ error: "Source file no longer accessible" }, 400);
	}

	let probe = job.probe;
	if (!job.probe) {
		probe = await probeFile(job.inputPath);
	}

	const subtitleStreams = probe!.subtitleStreams || [];
	if (subtitleStreams.length === 0) {
		return c.json({ source: [], output: [] });
	}

	try {
		const tempDir = mkdtempSync(join(config.tempDir, "sub-preview-"));

		const result = await previewSubtitles(job.inputPath, subtitleStreams, tempDir, {
			dedupe: job.settings.dedupeSubtitles,
			languages: job.settings.subtitleLanguages || [],
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		return c.json(result);
	} catch (err: any) {
		return c.json({ error: `Preview failed: ${err.message || err}` }, 500);
	}
});

app.get("/api/jobs/:id/audio-preview", async (c) => {
	const job = getJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found" }, 404);

	if (!existsSync(job.inputPath)) {
		return c.json({ error: "Source file no longer accessible" }, 400);
	}

	let probe = job.probe;
	if (!probe) {
		probe = await probeFile(job.inputPath);
	}

	const audioStreams = probe.audioStreams || [];
	if (audioStreams.length === 0) {
		return c.json({ source: [], output: [] });
	}

	try {
		const result = previewAudio(audioStreams, job.settings.audioBitrates, {
			languages: job.settings.audioLanguages || [],
		});
		return c.json(result);
	} catch (err: any) {
		return c.json({ error: `Preview failed: ${err.message || err}` }, 500);
	}
});

app.get("/api/jobs/:id/mediainfo", async (c) => {
	const job = getJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found" }, 404);

	if (!existsSync(job.inputPath)) {
		return c.json({ error: "Source file no longer accessible" }, 400);
	}

	try {
		const proc = Bun.spawn(["mediainfo", job.inputPath], { stdout: "pipe", stderr: "pipe" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return c.json({ filename: job.filename, text: text.trim() });
	} catch (err: any) {
		return c.json({ error: `mediainfo failed: ${err.message || err}` }, 500);
	}
});

app.post("/api/jobs/:id/move", async (c) => {
	const body = (await c.req.json()) as { direction?: string };
	const direction = body.direction;
	if (!direction || !["up", "down", "top", "bottom"].includes(direction)) {
		return c.json({ error: "Invalid direction. Use: up, down, top, bottom" }, 400);
	}
	const ok = moveJob(c.params.id!, direction as "up" | "down" | "top" | "bottom");
	if (!ok) return c.json({ error: "Job not found, not queued, or already at boundary" }, 400);
	return c.json({ ok: true });
});

app.post("/api/jobs/reorder", async (c) => {
	const body = (await c.req.json()) as { ids?: string[] };
	if (!body.ids || !Array.isArray(body.ids)) {
		return c.json({ error: "Missing 'ids' array in request body" }, 400);
	}
	reorderJobs(body.ids);
	return c.json({ ok: true });
});

app.get("/api/jobs/:id/preview", (c) => {
	const state = getPreviewState(c.params.id!);
	if (!state) return c.json({ status: "idle" });
	return c.json(state);
});

app.post("/api/jobs/:id/preview", (c) => {
	const result = startPreview(c.params.id!);
	if (!result.ok) return c.json({ error: result.error }, result.status);
	return c.json(result.state);
});

app.delete("/api/jobs/:id/preview", (c) => {
	const cancelled = cancelPreview(c.params.id!);
	if (!cancelled) {
		clearPreviewFor(c.params.id!);
		return c.json({ ok: true, cleared: true });
	}
	return c.json({ ok: true, cancelled: true });
});

app.get("/api/jobs/:id/preview/sample/:index/:kind", (c) => {
	const jobId = c.params.id!;
	const idx = parseInt(c.params.index!, 10);
	const kind = c.params.kind!;

	if (Number.isNaN(idx)) return c.json({ error: "Bad request" }, 400);

	const isStandard = kind === "source" || kind === "encode" || kind === "clip";
	const isVsStep = /^vs:\d+$/.test(kind);
	const isPrepareStep = /^pf:(?:downscale|deband|denoise)$/.test(kind);
	if (!isStandard && !isVsStep && !isPrepareStep) {
		return c.json({ error: "Bad request" }, 400);
	}

	const path = resolvePreviewArtifact(config, jobId, idx, kind);
	if (!path) return c.json({ error: "Artifact not found" }, 404);

	const file = Bun.file(path);

	if (kind === "clip") {
		return new Response(file, {
			headers: {
				"Content-Type": "video/x-matroska",
				"Content-Disposition": `attachment; filename="job_${jobId}_sample_${idx + 1}.mkv"`,
				"Cache-Control": "private, max-age=0, must-revalidate",
			},
		});
	}

	return new Response(file, {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "private, max-age=60",
		},
	});
});

app.get("/api/config", (c) => {
	return c.json(config.defaults);
});

app.patch("/api/config", async (c) => {
	const body = (await c.req.json()) as Partial<JobSettings>;
	const updated = updateDefaults(body);
	return c.json(updated);
});

app.post("/api/config/reset", (c) => {
	return c.json(resetDefaults());
});

app.get("/api/queue", (c) => {
	return c.json({ paused: isQueuePaused() });
});

app.post("/api/queue/pause", (c) => {
	const ok = pauseQueue();
	if (!ok) return c.json({ error: "Queue is already paused", paused: true }, 400);
	return c.json({ ok: true, paused: true });
});

app.post("/api/queue/resume", (c) => {
	const ok = resumeQueue();
	if (!ok) return c.json({ error: "Queue is not paused", paused: false }, 400);
	return c.json({ ok: true, paused: false });
});

app.get("/api/benchmark", async (c) => {
	return c.json(await getBenchmarkState(config.defaults.gpuDevice, config.defaults.denoiseBackend));
});

app.post("/api/benchmark", async (c) => {
	const result = await startBenchmark({
		gpuDevice: config.defaults.gpuDevice,
		denoiseBackend: config.defaults.denoiseBackend,
	});
	if (!result.ok) return c.json({ error: result.error || "Failed to start benchmark" }, 409);
	return c.json(await getBenchmarkState(config.defaults.gpuDevice, config.defaults.denoiseBackend));
});

app.delete("/api/benchmark", (c) => {
	const ok = cancelBenchmark();
	if (!ok) return c.json({ error: "No benchmark currently running" }, 400);
	return c.json({ ok: true });
});

app.get("/api/library", (c) => {
	return c.json({
		dirs: config.libraryDirs.map((dir) => ({
			path: dir,
			name: dir.split("/").filter(Boolean).pop() || dir,
		})),
	});
});

app.get("/api/library/browse", (c) => {
	const path = c.query().get("path");
	if (!path) {
		return c.json({ error: "Missing 'path' query parameter" }, 400);
	}

	if (!isPathAllowed(path, config.libraryDirs)) {
		return c.json({ error: "Path is not within any configured library directory" }, 403);
	}

	const entries = browseFolder(path, config.organization);
	return c.json({ path, entries });
});

app.post("/api/library/encode", async (c) => {
	const body = (await c.req.json()) as { paths?: string[]; path?: string };

	const paths = body.paths || (body.path ? [body.path] : []);
	if (paths.length === 0) {
		return c.json({ error: "Missing 'paths' in request body" }, 400);
	}

	for (const p of paths) {
		if (!isPathAllowed(p, config.libraryDirs)) {
			return c.json({ error: `Path is not within any configured library directory: ${p}` }, 403);
		}
	}

	let totalAdded = 0;
	let totalSkipped = 0;
	let totalAlreadyEncoded = 0;

	for (const p of paths) {
		Logger.info(`[library] Encoding: ${p}`);
		const result = scanLibraryPath(p);
		totalAdded += result.added;
		totalSkipped += result.skipped;
		totalAlreadyEncoded += result.alreadyEncoded;
	}

	Logger.info(`[library] Queued ${totalAdded} files (${totalSkipped} already queued, ${totalAlreadyEncoded} already encoded)`);
	return c.json({ ok: true, added: totalAdded, skipped: totalSkipped, alreadyEncoded: totalAlreadyEncoded });
});

app.get("/api/vs-presets", (c) => {
	return c.json({ presets: vsRegistry.list() });
});

app.post("/api/vs-presets/reload", (c) => {
	vsRegistry.reload();
	return c.json({ ok: true, count: vsRegistry.list().length });
});

app.get("/api/vs-presets/:id/default-entry", (c) => {
	const entry = makeDefaultVsFilterEntry(c.params.id!);
	if (!entry) return c.json({ error: "Unknown preset" }, 404);
	return c.json(entry);
});

Logger.info(`Rabbit Encoder started on http://0.0.0.0:${config.port}`);

if (config.libraryDirs.length > 0) {
	Logger.info(`Library directories: ${config.libraryDirs.join(", ")}`);
}

Bun.serve({
	hostname: "0.0.0.0",
	port: config.port,
	idleTimeout: 255,
	routes: {
		"/": indexHtml,
	},
	fetch: app.handleBun,
});
