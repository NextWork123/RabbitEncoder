import { run } from "./process";
import { normalizeFontName } from "./ass-classifier";

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
coords = {}
for kv in sys.argv[4:]:
    t, v = kv.split("=")
    coords[t] = float(v)
f = TTFont(src)
instantiateVariableFont(f, coords, inplace=True)  # coords cover all axes -> fully static
nm = f["name"]
ps = "".join(family.split())
for nid, val in [(1, family), (16, family), (4, family), (6, ps), (2, "Regular"), (17, "Regular")]:
    nm.setName(val, nid, 3, 1, 0x409)
    nm.setName(val, nid, 1, 0, 0)
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
 * Pin `coords` (which must cover every axis) into a static font at `outPath`,
 * stamping a deterministic, collision-free family name. Returns null on failure
 * so the caller can fall back to the original (variable) face.
 */
export async function instanceFont(
	src: string,
	coords: Record<string, number>,
	family: string,
	outPath: string,
	signal?: AbortSignal,
): Promise<InstancedFace | null> {
	const args = Object.entries(coords).map(([t, v]) => `${t}=${v}`);
	const res = await run(["python3", "-c", INSTANCE_PY, src, outPath, family, ...args], { signal });
	if (res.code !== 0) return null;
	let ps = family.replace(/\s+/g, "");
	try {
		ps = JSON.parse(res.stdout).ps ?? ps;
	} catch {
		/* keep default ps */
	}
	return { path: outPath, family, names: [normalizeFontName(family), normalizeFontName(ps)] };
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
