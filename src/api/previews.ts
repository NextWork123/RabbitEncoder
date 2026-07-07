import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { cancelPreview, clearPreviewFor, getPreviewState, startPreview } from "../queue/store";
import { resolvePreviewArtifact, type PreviewEncodeOptions } from "../pipeline/preview-encoder";

export function registerPreviewRoutes(app: Web, config: AppConfig): void {
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
}
