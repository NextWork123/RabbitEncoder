import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { run } from "./process";
import { Logger } from "./logger";
import { normalizeFontName } from "./ass-classifier";
import { detectScript, extractDialogueText, faceCandidateKeys } from "./script-detect";
import { readFontAxes, type FontAxis } from "./font-instance";

const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".otc"]);

export interface MkvAttachment {
	id: number;
	fileName: string;
}
export interface FontFace {
	fileName: string;
	path: string;
	keys: string[]; // normalized filename stem(s) + metadata keys
	family: string; // internal family name (fc-scan) — written as ASS Fontname
	names: string[]; // all normalized internal names (for cleanup matching)
	mime: string;
	axes: FontAxis[];
}
export interface FontFamily {
	label: string; // dropdown label = folder name (or internal family for a loose file)
	dir: string | null;
	faces: FontFace[];
}
export interface ResolvedFace {
	family: string;
	names: string[];
	path: string;
	fileName: string;
	mime: string;
	axes: FontAxis[];
}

function mimeForFont(p: string): string {
	const ext = extname(p).toLowerCase();
	if (ext === ".otf" || ext === ".otc") return "font/otf";
	if (ext === ".ttc") return "font/collection";
	return "font/ttf";
}

async function scanFontNames(p: string, signal?: AbortSignal): Promise<{ family: string; names: string[] }> {
	const res = await run(["fc-scan", "--format", "%{family}\n%{fullname}\n%{postscriptname}\n", p], { signal });
	if (res.code !== 0) return { family: "", names: [] };
	const names = new Set<string>();
	let family = "";
	for (const raw of res.stdout.split("\n")) {
		for (const piece of raw.split(",")) {
			const n = piece.trim();
			if (!n) continue;
			if (!family) family = n;
			names.add(normalizeFontName(n));
		}
	}
	return { family, names: [...names] };
}

interface Metadata {
	label?: string;
	faces?: Record<string, { family?: string; keys?: string[] }>;
}

async function buildFace(path: string, stemKey: string, meta: Metadata | null, signal?: AbortSignal): Promise<FontFace> {
	const { family, names } = await scanFontNames(path, signal);
	const fileName = basename(path);
	const override = meta?.faces?.[fileName];
	const keys = new Set<string>([stemKey.toLowerCase()]);
	for (const k of override?.keys ?? []) keys.add(k.toLowerCase());
	const fam = override?.family || family || basename(fileName, extname(fileName));
	const allNames = new Set(names);
	allNames.add(normalizeFontName(fam));
	return { fileName, path, keys: [...keys], family: fam, names: [...allNames], mime: mimeForFont(path), axes: [] };
}

class FontRegistry {
	private stockDir = "/app/fonts";
	private userDir = "/config/fonts";
	private families: FontFamily[] = [];

	configure(stockDir: string, userDir: string): void {
		this.stockDir = stockDir;
		this.userDir = userDir;
	}

	async reload(signal?: AbortSignal): Promise<void> {
		const byLabel = new Map<string, FontFamily>();
		for (const fam of await this.scanDir(this.stockDir, "stock", signal)) byLabel.set(fam.label, fam);
		for (const fam of await this.scanDir(this.userDir, "user", signal)) byLabel.set(fam.label, fam);
		this.families = [...byLabel.values()];

		const faceCount = this.families.reduce((n, f) => n + f.faces.length, 0);
		Logger.info(`[fonts] Loaded ${this.families.length} font famil(ies), ${faceCount} face(s) (stock: ${this.stockDir}, user: ${this.userDir})`);
	}

	private async scanDir(dir: string, origin: "stock" | "user", signal?: AbortSignal): Promise<FontFamily[]> {
		const families: FontFamily[] = [];
		if (!existsSync(dir)) {
			Logger.debug(`[fonts] ${origin} dir does not exist: ${dir}`);
			return families;
		}
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err: any) {
			Logger.warn(`[fonts] Failed to read ${origin} dir ${dir}: ${err?.message || err}`);
			return families;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				let meta: Metadata | null = null;
				const metaPath = join(full, "metadata.json");
				if (existsSync(metaPath)) {
					try {
						meta = JSON.parse(readFileSync(metaPath, "utf-8"));
					} catch (err: any) {
						Logger.warn(`[fonts] Bad metadata.json in ${origin}/${entry}: ${err?.message || err}`);
					}
				}
				const faces: FontFace[] = [];
				for (const f of readdirSync(full)) {
					if (!FONT_EXTS.has(extname(f).toLowerCase())) continue;
					faces.push(await buildFace(join(full, f), basename(f, extname(f)), meta, signal));
				}
				if (faces.length) families.push({ label: meta?.label || entry, dir: full, faces });
			} else if (FONT_EXTS.has(extname(entry).toLowerCase())) {
				const face = await buildFace(full, "default", null, signal);
				families.push({ label: face.family, dir: null, faces: [face] });
			}
		}
		const axesByPath = await readFontAxes(
			families.flatMap((f) => f.faces).map((f) => f.path),
			signal,
		);
		for (const fam of families) for (const f of fam.faces) f.axes = axesByPath.get(f.path) ?? [];
		return families;
	}

	list(): FontFamily[] {
		return this.families;
	}

	findFamily(label: string): FontFamily | undefined {
		return this.families.find((f) => f.label === label);
	}

	findFaceFile(label: string, fileName: string): FontFace | undefined {
		return this.findFamily(label)?.faces.find((f) => f.fileName === fileName);
	}

	/** Pick the face for a track given its language tag and a text sample. */
	resolve(label: string, langCode: string | undefined, text: string): ResolvedFace | null {
		const fam = this.findFamily(label);
		if (!fam || fam.faces.length === 0) return null;
		const script = detectScript(extractDialogueText(text));
		for (const cand of faceCandidateKeys(langCode, script)) {
			const face = fam.faces.find((f) => f.keys.includes(cand));
			if (face) return { family: face.family, names: face.names, path: face.path, fileName: face.fileName, mime: face.mime, axes: face.axes };
		}
		const f = fam.faces[0]!;
		return { family: f.family, names: f.names, path: f.path, fileName: f.fileName, mime: f.mime, axes: f.axes };
	}

	mime = mimeForFont;
}

export const fontRegistry = new FontRegistry();

export async function listMkvAttachments(mkvPath: string, signal?: AbortSignal): Promise<MkvAttachment[]> {
	const res = await run(["mkvmerge", "-J", mkvPath], { signal });
	if (res.code !== 0) return [];
	try {
		const j = JSON.parse(res.stdout);
		return (j.attachments ?? []).map((a: any) => ({ id: Number(a.id), fileName: String(a.file_name) }));
	} catch {
		return [];
	}
}

/**
 * Extract every attachment from `mkvPath`, then return mkvmerge --attach-file
 * args for: all non-font attachments, plus fonts whose names intersect
 * `usedFonts` and are NOT already covered by `alreadyAttached` (e.g. a font we
 * injected from /config/fonts). Returns null on extraction failure - the caller
 * should then fall back to passing source attachments through untouched rather
 * than dropping them.
 */
export async function buildKeptAttachmentArgs(
	mkvPath: string,
	usedFonts: Set<string>,
	tempDir: string,
	alreadyAttached: Set<string>,
	signal?: AbortSignal,
): Promise<string[] | null> {
	const attachments = await listMkvAttachments(mkvPath, signal);
	if (attachments.length === 0) return [];

	const specs: string[] = [];
	const outById = new Map<number, string>();
	for (const a of attachments) {
		const out = join(tempDir, `att_${a.id}_${a.fileName}`);
		specs.push(`${a.id}:${out}`);
		outById.set(a.id, out);
	}

	const ext = await run(["mkvextract", mkvPath, "attachments", ...specs], { signal });
	if (ext.code !== 0) {
		Logger.warn(`[fonts] mkvextract failed (${ext.stderr || ext.stdout}); keeping all source attachments`);
		return null;
	}

	const args: string[] = [];
	for (const a of attachments) {
		const out = outById.get(a.id)!;
		if (!existsSync(out)) continue;
		const isFont = FONT_EXTS.has(extname(a.fileName).toLowerCase());
		if (!isFont) {
			args.push("--attachment-name", a.fileName, "--attach-file", out);
			continue;
		}
		const { names } = await scanFontNames(out, signal);
		if (names.some((n) => alreadyAttached.has(n))) {
			Logger.info(`[fonts] Skipping ${a.fileName} (already injected from /config/fonts)`);
			continue;
		}
		if (names.some((n) => usedFonts.has(n))) {
			args.push("--attachment-mime-type", mimeForFont(out), "--attachment-name", a.fileName, "--attach-file", out);
		} else {
			Logger.info(`[fonts] Dropping unused font: ${a.fileName}`);
		}
	}
	return args;
}
