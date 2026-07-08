import { run } from "../core/process";
import { normalizeFontName } from "../subtitles/ass-classifier";

const AXES_PY = `
import sys, json
from fontTools.ttLib import TTFont
out = {}
for p in sys.argv[1:]:
    rec = {"variable": False, "axes": []}
    try:
        f = TTFont(p, lazy=True)
        if "fvar" in f:
            rec["variable"] = True
            nm = f["name"]
            for a in f["fvar"].axes:
                rec["axes"].append({"tag": a.axisTag, "min": a.minValue,
                    "default": a.defaultValue, "max": a.maxValue,
                    "name": (nm.getDebugName(a.axisNameID) or a.axisTag)})
    except Exception as e:
        rec["error"] = str(e)
    out[p] = rec
print(json.dumps(out))
`;

const INSTANCE_PY = `
import sys, json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
src, out, family = sys.argv[1], sys.argv[2], sys.argv[3]
style_bold = sys.argv[4] == "1"
coords = {}
for kv in sys.argv[5:]:
    t, v = kv.split("=")
    coords[t] = float(v)
f = TTFont(src)
if "fvar" in f:
    instantiateVariableFont(f, coords, inplace=True)  # coords cover all axes -> fully static
nm = f["name"]
subfamily = "Bold" if style_bold else "Regular"
full = family + (" Bold" if style_bold else "")
ps = "".join(family.split()) + ("-Bold" if style_bold else "")

# Remove stale localized/typographic/WWS names left by the variable instance,
# then publish one deterministic family/style identity.
for nid in (1, 2, 4, 6, 16, 17, 21, 22):
    nm.names = [r for r in nm.names if r.nameID != nid]
for nid, val in [(1, family), (16, family), (21, family),
                 (2, subfamily), (17, subfamily), (22, subfamily),
                 (4, full), (6, ps)]:
    nm.setName(val, nid, 3, 1, 0x409)
    nm.setName(val, nid, 1, 0, 0)

# The chosen variable coordinates define the glyph appearance, but libass and
# fontconfig must match this attachment as the ASS style requested by the user.
# Otherwise a source/system Regular face can beat an instanced face even when
# the ASS document points at the intended collision-free family.
if "OS/2" in f:
    os2 = f["OS/2"]
    os2.usWeightClass = 700 if style_bold else 400
    os2.usWidthClass = 5
    os2.fsSelection &= ~((1 << 0) | (1 << 5) | (1 << 6) | (1 << 9))
    os2.fsSelection |= (1 << 5) if style_bold else (1 << 6)
if "head" in f:
    f["head"].macStyle &= ~0x3
    if style_bold:
        f["head"].macStyle |= 0x1
if "post" in f:
    f["post"].italicAngle = 0
f.save(out)
print(json.dumps({"family": family, "ps": ps}))
`;

export interface FontAxis {
	tag: string;
	min: number;
	default: number;
	max: number;
	name: string;
}

export async function readFontAxes(paths: string[], signal?: AbortSignal): Promise<Map<string, FontAxis[]>> {
	const map = new Map<string, FontAxis[]>();
	if (paths.length === 0) return map;
	const res = await run(["python3", "-c", AXES_PY, ...paths], { signal });
	if (res.code !== 0) return map;
	try {
		const parsed = JSON.parse(res.stdout) as Record<string, { variable: boolean; axes: FontAxis[] }>;
		for (const [p, rec] of Object.entries(parsed)) map.set(p, rec.variable ? rec.axes : []);
	} catch {
		/* leave empty */
	}
	return map;
}

export interface InstancedFace {
	path: string;
	family: string;
	names: string[];
}

/**
 * Materialize a font at `outPath`, pinning variable axes when present and
 * stamping the family name supplied by the caller. `coords` may be empty for a
 * static font that only needs a collision-free internal family alias.
 *
 * Axis coordinates never appear in the visible family or attachment name.
 * Returns null on failure so the caller can fall back to the original face.
 */
export async function instanceFont(
	src: string,
	coords: Record<string, number>,
	family: string,
	styleBold: boolean,
	outPath: string,
	signal?: AbortSignal,
): Promise<InstancedFace | null> {
	const args = Object.entries(coords).map(([t, v]) => `${t}=${v}`);
	const res = await run(["python3", "-c", INSTANCE_PY, src, outPath, family, styleBold ? "1" : "0", ...args], { signal });
	if (res.code !== 0) return null;
	let ps = `${family.replace(/\s+/g, "")}${styleBold ? "-Bold" : ""}`;
	try {
		ps = JSON.parse(res.stdout).ps ?? ps;
	} catch {
		/* keep default ps */
	}
	return { path: outPath, family, names: instancedFontNames(family, styleBold, ps) };
}

/**
 * All normalized names published by `instanceFont` for collision checks.
 * `postScriptName` is optional so callers can use the exact value returned by
 * fontTools, while the normal resolver uses the deterministic local value.
 */
export function instancedFontNames(family: string, styleBold: boolean, postScriptName?: string): string[] {
	const fullName = `${family}${styleBold ? " Bold" : ""}`;
	const ps = postScriptName ?? `${family.replace(/\s+/g, "")}${styleBold ? "-Bold" : ""}`;
	return [...new Set([family, fullName, ps].map((name) => normalizeFontName(name)))];
}

/**
 * Build the on-disk / MKV attachment filename for an injected face. libass
 * matches embedded fonts by their internal name table, not the filename, so the
 * family ("Noto Sans 2") keeps spaces while the file becomes "noto_sans_2.ttf".
 * `ext` includes the leading dot.
 */
export function fontAttachmentFileName(family: string, ext: string): string {
	const slug = family
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${slug || "font"}${ext}`;
}

/**
 * Pick the first family identity not already present in source attachments or
 * reserved by another injected face:
 *
 *   Noto Sans -> Noto Sans 2 -> Noto Sans 3 -> ...
 */
export function chooseAvailableFontFamily(baseFamily: string, occupiedNames: ReadonlySet<string>, styleBold: boolean): string {
	for (let index = 1; ; index++) {
		const candidate = index === 1 ? baseFamily : `${baseFamily} ${index}`;
		const candidateNames = instancedFontNames(candidate, styleBold);
		if (candidateNames.every((name) => !occupiedNames.has(name))) return candidate;
	}
}

/** Suffix encoding the non-default axis values, e.g. "wght350 wdth87". Empty if all default. */
export function axisSuffix(axes: FontAxis[], chosen: Record<string, number>): { suffix: string; coords: Record<string, number> } {
	const coords: Record<string, number> = {};
	const parts: string[] = [];
	for (const a of axes) {
		const raw = chosen[a.tag];
		const v = typeof raw === "number" ? Math.min(a.max, Math.max(a.min, raw)) : a.default;
		coords[a.tag] = v;
		if (v !== a.default) parts.push(`${a.tag}${Math.round(v)}`);
	}
	return { suffix: parts.join(" "), coords };
}
