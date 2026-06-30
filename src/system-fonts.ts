import { existsSync } from "fs";
import { extname, basename, resolve } from "path";
import { run } from "./process";
import { Logger } from "./logger";

const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".otc"]);

export interface SystemFont {
	path: string;
	fileName: string;
	family: string;
}

/** True if `target` resolves inside one of the (read-only) system font roots. */
export function isInsideRoots(target: string, roots: string[]): boolean {
	const r = resolve(target);
	return roots.some((root) => {
		const rr = resolve(root);
		return r === rr || r.startsWith(rr + "/");
	});
}

/**
 * Recursively enumerate font files under the configured read-only system font
 * roots. Uses a single `fc-scan` per root (one process, not one per file) so
 * large host directories stay fast. Returns one entry per unique file path.
 */
export async function listSystemFonts(roots: string[], signal?: AbortSignal): Promise<SystemFont[]> {
	const byPath = new Map<string, SystemFont>();
	for (const root of roots) {
		if (!existsSync(root)) {
			Logger.debug(`[system-fonts] root does not exist: ${root}`);
			continue;
		}
		// "%{file}\t%{family}\n" — family may be a comma list; we take the first.
		const res = await run(["fc-scan", "--format", "%{file}\t%{family}\n", root], { signal });
		if (res.code !== 0) {
			Logger.warn(`[system-fonts] fc-scan failed for ${root}: ${res.stderr || res.stdout}`);
			continue;
		}
		for (const line of res.stdout.split("\n")) {
			const tab = line.indexOf("\t");
			if (tab < 0) continue;
			const path = line.slice(0, tab).trim();
			if (!path || !FONT_EXTS.has(extname(path).toLowerCase())) continue;
			const family = (line.slice(tab + 1).split(",")[0] ?? "").trim();
			if (!byPath.has(path)) {
				byPath.set(path, { path, fileName: basename(path), family: family || basename(path) });
			}
		}
	}
	return [...byPath.values()].sort((a, b) => a.family.localeCompare(b.family) || a.fileName.localeCompare(b.fileName));
}
