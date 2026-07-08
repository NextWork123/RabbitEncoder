import type { Web } from "@rabbit-company/web";
import type { AppConfig, JobSettings } from "../core/types";
import { updateDefaults, resetDefaults } from "../queue/store";
import { decodeSettingsCode, encodeSettingsCode, SettingsCodeError } from "../settings/settings-code";

export function registerSettingsRoutes(app: Web, config: AppConfig): void {
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
}
