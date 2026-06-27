import type { SubtitleStyle } from "../../src/types";

/**
 * A known SubtitleStyle authored in 1080p space, used across styling tests.
 * Values are deliberately distinct from the default fixture style lines below
 * so assertions can tell "was overwritten" from "was left alone".
 */
export const sampleStyle: SubtitleStyle = {
	fontName: "Noto Sans",
	fontSize: 64,
	primaryColour: "&H00FFFFFF",
	outlineColour: "&H0000FF00",
	backColour: "&H80000000",
	outline: 3.5,
	shadow: 1,
	alignment: 2,
	marginV: 60,
	marginL: 80,
	marginR: 80,
	bold: false,
	fontAxes: {},
};

const STYLE_FORMAT =
	"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

/** A dialogue-classifiable Default style (alignment 2, BorderStyle 1) at 40px. */
export const DEFAULT_STYLE_LINE = "Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00FF0000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,40,40,40,1";

/** A clearly sign-styled line (alignment 7) the classifier should leave alone. */
export const SIGN_STYLE_LINE = "Style: Signs,Comic Sans MS,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,10,10,10,1";

export interface AssOpts {
	playResX?: number;
	playResY?: number;
	scaledBorder?: boolean;
	/** Raw `Style: ...` lines (defaults to a single dialogue Default). */
	styles?: string[];
	/** Raw `Dialogue: ...` lines (defaults to one Default line). */
	events?: string[];
}

/** Build a minimal but valid ASS document from parts. */
export function buildAss(opts: AssOpts = {}): string {
	const styles = opts.styles ?? [DEFAULT_STYLE_LINE];
	const events = opts.events ?? ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello world"];
	const info: string[] = ["[Script Info]", "ScriptType: v4.00+"];
	if (opts.playResX !== undefined) info.push(`PlayResX: ${opts.playResX}`);
	if (opts.playResY !== undefined) info.push(`PlayResY: ${opts.playResY}`);
	if (opts.scaledBorder !== undefined) info.push(`ScaledBorderAndShadow: ${opts.scaledBorder ? "yes" : "no"}`);
	return [...info, "", "[V4+ Styles]", STYLE_FORMAT, ...styles, "", "[Events]", EVENT_FORMAT, ...events, ""].join("\n");
}

export const ass1080 = (): string => buildAss({ playResX: 1920, playResY: 1080 });
export const ass4k = (): string => buildAss({ playResX: 3840, playResY: 2160 });
export const ass720 = (): string => buildAss({ playResX: 1280, playResY: 720 });
export const assNoPlayRes = (): string => buildAss({});

/** A 4K file containing both a dialogue and a sign style. */
export const ass4kWithSign = (): string =>
	buildAss({
		playResX: 3840,
		playResY: 2160,
		styles: [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE],
		events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello world", "Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,{\\pos(100,100)}SHOP"],
	});

/**
 * Parse a Style line back into a `{ column: value }` map (columns lowercased),
 * so tests can assert individual fields without depending on column order.
 */
export function getStyle(ass: string, name: string): Record<string, string> {
	let cols: string[] = [];
	let inStyles = false;
	for (const raw of ass.split(/\r?\n/)) {
		const t = raw.trim();
		if (/^\[.*\]$/.test(t)) {
			inStyles = /^\[v4\+? styles\]$/i.test(t);
			continue;
		}
		if (!inStyles) continue;
		if (/^Format\s*:/i.test(t)) {
			cols = t
				.slice(t.indexOf(":") + 1)
				.split(",")
				.map((s) => s.trim().toLowerCase());
			continue;
		}
		if (/^Style\s*:/i.test(t) && cols.length) {
			const vals = t
				.slice(t.indexOf(":") + 1)
				.split(",")
				.map((s) => s.trim());
			if ((vals[cols.indexOf("name")] ?? "") === name) {
				const out: Record<string, string> = {};
				cols.forEach((c, i) => (out[c] = vals[i] ?? ""));
				return out;
			}
		}
	}
	throw new Error(`Style "${name}" not found`);
}

/** Read a Script Info key (e.g. "PlayResX") from an ASS document. */
export function getScriptInfo(ass: string, key: string): string | undefined {
	let inInfo = false;
	for (const raw of ass.split(/\r?\n/)) {
		const t = raw.trim();
		if (/^\[.*\]$/.test(t)) {
			inInfo = /^\[script info\]$/i.test(t);
			continue;
		}
		if (inInfo && new RegExp(`^${key}\\s*:`, "i").test(t)) {
			return t.slice(t.indexOf(":") + 1).trim();
		}
	}
	return undefined;
}
