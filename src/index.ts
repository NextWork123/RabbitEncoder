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
	renameFontGroupReferences,
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
import { resolvePreviewArtifact, type PreviewEncodeOptions } from "./preview-encoder";
import { makeDefaultVsFilterEntry, vsRegistry } from "./vs-filters";
import { decodeSettingsCode, encodeSettingsCode, SettingsCodeError } from "./settings-code";
import { getSystemStats } from "./system";
import { fontRegistry } from "./fonts";
import type { GroupStyleConfig } from "./subtitle-style";
import { isInsideRoots, listSystemFonts } from "./system-fonts";
import { checkOllama, translateOne } from "./ollama";
import { resolveTranslateLang } from "./translate-languages";
import { checkGenericChat, checkGenericModel } from "./ollama-generic";
import { resolveTranslateStrategy, type TranslateProvider } from "./translate-provider";
import { checkDeepseek } from "./deepseek";

export const config = await loadConfig();

vsRegistry.configure(
	process.env.VS_PRESETS_STOCK_DIR ?? "/app/vapoursynth/presets",
	process.env.VS_PRESETS_USER_DIR ?? "/config/vapoursynth/presets",
	process.env.VS_RABBIT_MODULE_DIR ?? "/app/vapoursynth",
);
vsRegistry.reload();

fontRegistry.configure(process.env.FONTS_STOCK_DIR ?? "/app/fonts", process.env.FONTS_USER_DIR ?? "/config/fonts");
fontRegistry.seed(["Noto Sans", "Noto Serif"]);
await fontRegistry.reload();

const hashedPassword = new Bun.CryptoHasher("blake2b512").update(`rabbitencoder-${process.env.PASSWORD || "rabbitencoder"}`).digest("hex");

mkdirSync(config.inputDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
mkdirSync(config.tempDir, { recursive: true });
mkdirSync(config.fontsUserDir, { recursive: true });

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

app.get("/api/system", async (c) => {
	const stats = await getSystemStats(config.tempDir);
	return c.json(stats);
});

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
			langDetect: job.settings.subtitleLangDetect,
			langDetectConfidence: job.settings.subtitleLangDetectConfidence,
			detectSignsSongs: job.settings.detectSignsSongs,
			detectSDH: job.settings.detectSDH,
			detectHonorifics: job.settings.detectHonorifics,
			// Source / format ordering
			sourcePriority: job.settings.subtitleSourcePriority,
			fansubTiebreak: job.settings.subtitleFansubTiebreak,
			formatPriority: job.settings.subtitleFormatPriority,
			// Drop filters
			dropPicture: job.settings.dropPictureSubtitles,
			removeSDH: job.settings.removeSDHSubtitles,
			removeCommentary: job.settings.removeCommentarySubtitles,
			removeForcedSignsSongs: job.settings.removeForcedSignsSongs,
			removeStoryboard: job.settings.removeStoryboardSubtitles,
			removeHonorifics: job.settings.removeHonorificsSubtitles,
			// Dedupe + naming
			dedupeAcrossFormat: job.settings.dedupeAcrossFormat,
			renameTracks: job.settings.renameSubtitleTracks,
			// Advanced detection tuning
			signsSongsStyleRatio: job.settings.signsSongsStyleRatio,
			signsSongsLineRatio: job.settings.signsSongsLineRatio,
			sdhRatioThreshold: job.settings.sdhRatioThreshold,
			sdhMinLines: job.settings.sdhMinLines,
			honorificsMinCount: job.settings.honorificsMinCount,
			honorificsRatio: job.settings.honorificsRatio,
			assumeMislabeled: job.settings.assumeMislabeledTracks,
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
			languagePriority: job.settings.audioLanguagePriority,
			collapseChannels: job.settings.keepBestAudioChannelsOnly,
			dedupe: job.settings.dedupeAudio,
			removeCommentary: job.settings.removeCommentaryAudio,
			removeDescriptive: job.settings.removeDescriptiveAudio,
			removeKaraoke: job.settings.removeKaraokeAudio,
			dropCompatibility: job.settings.dropCompatibilityAudio,
			codecPriority: job.settings.audioCodecPriority,
			preferUncensored: job.settings.preferUncensoredAudio,
			renameTracks: job.settings.renameAudioTracks,
			detect: {
				commentary: job.settings.detectCommentaryAudio,
				descriptive: job.settings.detectDescriptiveAudio,
				karaoke: job.settings.detectKaraokeAudio,
			},
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

app.post("/api/jobs/:id/preview", async (c) => {
	let body: { clipCount?: number; clipDuration?: number } = {};
	try {
		body = (await c.req.json()) as typeof body;
	} catch {
		// no body (fall back to defaults)
	}

	const options: Partial<PreviewEncodeOptions> = {};

	if (body.clipCount !== undefined) {
		const n = Math.round(Number(body.clipCount));
		if (!Number.isFinite(n) || n < 1 || n > 20) {
			return c.json({ error: "clipCount must be a whole number between 1 and 20" }, 400);
		}
		options.sampleCount = n;
	}

	if (body.clipDuration !== undefined) {
		const d = Number(body.clipDuration);
		if (!Number.isFinite(d) || d < 1 || d > 30) {
			return c.json({ error: "clipDuration must be between 1 and 30 seconds" }, 400);
		}
		options.windowSeconds = d;
	}

	const result = startPreview(c.params.id!, options);
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

	const isStandard = kind === "source" || kind === "encode" || kind === "clip" || kind === "source-clip";
	const isVsStep = /^vs:\d+$/.test(kind);
	const isPrepareStep = /^pf:(?:downscale|deband|denoise|crop)$/.test(kind);
	if (!isStandard && !isVsStep && !isPrepareStep) {
		return c.json({ error: "Bad request" }, 400);
	}

	const path = resolvePreviewArtifact(config, jobId, idx, kind);
	if (!path) return c.json({ error: "Artifact not found" }, 404);

	const file = Bun.file(path);

	if (kind === "clip" || kind === "source-clip") {
		const clipName = kind === "source-clip" ? "source" : "encode";
		return new Response(file, {
			headers: {
				"Content-Type": "video/x-matroska",
				"Content-Disposition": `attachment; filename="job_${jobId}_sample_${idx + 1}_${clipName}.mkv"`,
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

app.post("/api/config/import-code", async (c) => {
	const body = (await c.req.json()) as { code?: string };
	if (typeof body.code !== "string") return c.json({ error: "Missing 'code' string" }, 400);
	try {
		return c.json(updateDefaults(decodeSettingsCode(body.code)));
	} catch (err) {
		if (err instanceof SettingsCodeError) return c.json({ error: err.message }, 400);
		throw err;
	}
});

app.post("/api/translate/test", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		provider?: string;
		url?: string;
		model?: string;
		apiKey?: string;
		target?: string;
	};
	const provider: TranslateProvider = body.provider === "deepseek" ? "deepseek" : "ollama";
	const model = (body.model || "").trim();
	const source = { name: "English", code: "en" };
	const target = resolveTranslateLang(body.target || "slv") ?? { name: "Slovenian", code: "sl" };

	if (provider === "deepseek") {
		const apiKey = (body.apiKey || "").trim();
		if (!apiKey || !model) return c.json({ ok: false, error: "Missing DeepSeek API key or model" }, 400);

		const health = await checkDeepseek(apiKey, model);
		if (!health.ok) return c.json({ ok: false, error: health.detail });

		const r = await checkGenericChat({ provider: "deepseek", url: "", apiKey, model, source, target });
		return c.json(r.ok ? { ok: true, sample: r.sample, model, target: target.name } : { ok: false, error: r.detail });
	}

	const url = (body.url || "").trim();
	if (!url || !model) return c.json({ ok: false, error: "Missing Ollama URL or model" }, 400);

	const health = await checkOllama(url, model);
	if (!health.ok) return c.json({ ok: false, error: health.detail });

	const strategy = resolveTranslateStrategy(provider, model);

	if (strategy === "generic") {
		const r = await checkGenericModel(url, model, source, target);
		return c.json(r.ok ? { ok: true, sample: r.sample, model, target: target.name } : { ok: false, error: r.detail });
	}

	try {
		const sample = await translateOne("The goal of all life is death.", {
			url,
			model,
			source,
			target,
			timeoutMs: 30000,
		});
		return c.json({ ok: true, sample, model, target: target.name });
	} catch (err: any) {
		return c.json({ ok: false, error: `Model reachable but translation failed: ${err?.message || err}` });
	}
});

app.get("/api/fonts", (c) => {
	return c.json({
		fonts: fontRegistry.list().map((f) => ({
			label: f.label,
			faces: f.faces.map((x) => ({ fileName: x.fileName, family: x.family, keys: x.keys, axes: x.axes })),
		})),
	});
});

app.post("/api/fonts/reload", async (c) => {
	await fontRegistry.reload();
	return c.json({ fonts: fontRegistry.list().map((f) => ({ label: f.label })) });
});

app.get("/api/fonts/resolve", (c) => {
	const label = c.query().get("family") || "";
	const lang = c.query().get("lang") || undefined;
	const text = c.query().get("text") || "";
	const face = fontRegistry.resolve(label, lang, text);
	return face ? c.json({ fileName: face.fileName, family: face.family }) : c.json({ fileName: null, family: null });
});

app.get("/api/fonts/face/:family/:name", (c) => {
	const face = fontRegistry.findFaceFile(decodeURIComponent(c.params.family!), decodeURIComponent(c.params.name!));
	if (!face) return c.json({ error: "Font not found" }, 404);
	return new Response(Bun.file(face.path), { headers: { "Content-Type": face.mime, "Cache-Control": "private, max-age=300" } });
});

app.get("/api/fonts/:label/style", (c) => {
	const label = decodeURIComponent(c.params.label!);
	const fam = fontRegistry.findFamily(label);
	if (!fam) return c.json({ error: "Font group not found" }, 404);
	const keys = [...new Set(fam.faces.flatMap((f) => f.keys))].sort();
	const cfg = fontRegistry.getGroupStyle(label);
	return c.json({ style: cfg.style ?? {}, overrides: cfg.overrides ?? {}, keys });
});

app.put("/api/fonts/:label/style", async (c) => {
	const label = decodeURIComponent(c.params.label!);
	if (!fontRegistry.findFamily(label)) return c.json({ error: "Font group not found" }, 404);
	const body = (await c.req.json()) as { style?: unknown; overrides?: unknown };
	const ok = fontRegistry.saveGroupStyle(label, {
		style: (body.style as GroupStyleConfig["style"]) ?? {},
		overrides: (body.overrides as GroupStyleConfig["overrides"]) ?? {},
	});
	if (!ok) return c.json({ error: "Failed to save group style" }, 500);
	await fontRegistry.reload();
	return c.json({ ok: true });
});

app.get("/api/system-fonts", async (c) => {
	const roots = config.systemFontDirs;
	if (roots.length === 0) return c.json({ roots: [], fonts: [], enabled: false });
	return c.json({ roots, fonts: await listSystemFonts(roots), enabled: true });
});

app.post("/api/fonts/groups", async (c) => {
	const body = (await c.req.json()) as { label?: string };
	if (typeof body.label !== "string" || !body.label.trim()) return c.json({ error: "Missing 'label'" }, 400);
	const r = fontRegistry.createGroup(body.label);
	if (!r.ok) return c.json({ error: r.error || "Failed to create group" }, 400);
	await fontRegistry.reload();
	return c.json({ ok: true });
});

app.patch("/api/fonts/groups/:label", async (c) => {
	const oldLabel = decodeURIComponent(c.params.label!);
	const body = (await c.req.json()) as { label?: string };
	if (typeof body.label !== "string" || !body.label.trim()) return c.json({ error: "Missing 'label'" }, 400);
	const newLabel = body.label.trim();
	const r = fontRegistry.renameGroup(oldLabel, newLabel);
	if (!r.ok) return c.json({ error: r.error || "Failed to rename group" }, 400);
	const updatedReferences = renameFontGroupReferences(oldLabel, newLabel);
	await fontRegistry.reload();
	return c.json({ ok: true, updatedReferences });
});

app.delete("/api/fonts/groups/:label", async (c) => {
	const label = decodeURIComponent(c.params.label!);
	const r = fontRegistry.deleteGroup(label);
	if (!r.ok) return c.json({ error: r.error || "Failed to delete group" }, 400);
	await fontRegistry.reload();
	return c.json({ ok: true });
});

app.post("/api/fonts/groups/:label/faces", async (c) => {
	const label = decodeURIComponent(c.params.label!);
	const body = (await c.req.json()) as { source?: string; keys?: string[] };
	if (typeof body.source !== "string" || !body.source) return c.json({ error: "Missing 'source'" }, 400);
	if (!isInsideRoots(body.source, config.systemFontDirs)) return c.json({ error: "Source is not within a system font directory" }, 403);
	const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
	const r = await fontRegistry.importFace(label, body.source, keys);
	if (!r.ok) return c.json({ error: r.error || "Failed to import font" }, 400);
	await fontRegistry.reload();
	return c.json({ ok: true, fileName: r.fileName });
});

app.patch("/api/fonts/groups/:label/faces/:file", async (c) => {
	const label = decodeURIComponent(c.params.label!);
	const file = decodeURIComponent(c.params.file!);
	const body = (await c.req.json()) as { keys?: string[]; family?: string };
	const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
	const r = fontRegistry.setFaceKeys(label, file, keys, typeof body.family === "string" ? body.family : undefined);
	if (!r.ok) return c.json({ error: r.error || "Failed to update font" }, 400);
	await fontRegistry.reload();
	return c.json({ ok: true });
});

app.delete("/api/fonts/groups/:label/faces/:file", async (c) => {
	const label = decodeURIComponent(c.params.label!);
	const file = decodeURIComponent(c.params.file!);
	const r = fontRegistry.deleteFace(label, file);
	if (!r.ok) return c.json({ error: r.error || "Failed to delete font" }, 400);
	await fontRegistry.reload();
	return c.json({ ok: true });
});

app.post("/api/jobs/:id/import-code", async (c) => {
	const body = (await c.req.json()) as { code?: string };
	if (typeof body.code !== "string") return c.json({ error: "Missing 'code' string" }, 400);
	let partial;
	try {
		partial = decodeSettingsCode(body.code);
	} catch (err) {
		if (err instanceof SettingsCodeError) return c.json({ error: err.message }, 400);
		throw err;
	}
	const job = updateJobSettings(c.params.id!, partial);
	if (!job) return c.json({ error: "Job not found or not editable" }, 400);
	return c.json(job);
});

app.post("/api/settings/encode", async (c) => {
	const body = (await c.req.json()) as Partial<JobSettings>;
	try {
		return c.json({ code: encodeSettingsCode({ ...config.defaults, ...body } as JobSettings) });
	} catch {
		return c.json({ code: "" });
	}
});

app.post("/api/settings/decode", async (c) => {
	const body = (await c.req.json()) as { code?: string };
	if (typeof body.code !== "string") return c.json({ error: "Missing 'code' string" }, 400);
	try {
		return c.json({ settings: decodeSettingsCode(body.code) });
	} catch (err) {
		if (err instanceof SettingsCodeError) return c.json({ error: err.message }, 400);
		throw err;
	}
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
