import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { fontRegistry } from "../fonts/fonts";
import type { GroupStyleConfig } from "../subtitles/subtitle-style";
import { isInsideRoots, listSystemFonts } from "../fonts/system-fonts";
import { renameFontGroupReferences } from "../queue/store";

export function registerFontRoutes(app: Web, config: AppConfig): void {
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
}
