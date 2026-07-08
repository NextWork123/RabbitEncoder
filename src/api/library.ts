import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { browseFolder, isPathAllowed } from "../queue/library";
import { Logger } from "../core/logger";
import { scanLibraryPath } from "../queue/store";

export function registerLibraryRoutes(app: Web, config: AppConfig): void {
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
}
