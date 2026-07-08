import type { Web } from "@rabbit-company/web";
import { makeDefaultVsFilterEntry, vsRegistry } from "../video/vs-filters";

export function registerVsPresetRoutes(app: Web): void {
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
}
