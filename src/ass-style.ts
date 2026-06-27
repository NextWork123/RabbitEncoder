import { dialogueStyleNames } from "./ass-classifier";
import type { SubtitleStyle } from "./types";

/** Column indices we overwrite, resolved from the Format line (names are case-insensitive). */
const RESTYLE_COLUMNS: Record<string, (s: SubtitleStyle) => string> = {
	fontname: (s) => s.fontName,
	fontsize: (s) => String(s.fontSize),
	primarycolour: (s) => s.primaryColour,
	outlinecolour: (s) => s.outlineColour,
	backcolour: (s) => s.backColour,
	bold: (s) => (s.bold ? "-1" : "0"),
	outline: (s) => String(s.outline),
	shadow: (s) => String(s.shadow),
	alignment: (s) => String(s.alignment),
	marginl: (s) => String(s.marginL),
	marginr: (s) => String(s.marginR),
	marginv: (s) => String(s.marginV),
};

/**
 * V4+ Style line for a given style name. Field order is the ASS standard:
 * Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,
 * BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing,
 * Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV,
 * Encoding. ASS bold is -1 (true) / 0 (false).
 */
function buildStyleLine(name: string, s: SubtitleStyle): string {
	const bold = s.bold ? "-1" : "0";
	return (
		`Style: ${name},${s.fontName},${s.fontSize},${s.primaryColour},&H000000FF,` +
		`${s.outlineColour},${s.backColour},${bold},0,0,0,100,100,0,0,1,` +
		`${s.outline},${s.shadow},${s.alignment},${s.marginL},${s.marginR},${s.marginV},1`
	);
}

/**
 * Patch an ffmpeg-generated SRT→ASS file: pin PlayRes to 1920×1080 (so px
 * sizes hold "at 1080p" and libass rescales to the real frame), enable scaled
 * borders/shadows, and replace the Default style with the configured look.
 */
export function styleSrtAss(assText: string, style: SubtitleStyle): string {
	const lines = assText.split(/\r?\n/);
	const out: string[] = [];
	let section = "";
	let scriptInfoIdx = -1;
	let hasPlayResX = false;
	let hasPlayResY = false;
	let hasScaled = false;
	let replacedDefault = false;
	let stylesHeaderIdx = -1;

	for (const line of lines) {
		const t = line.trim();
		if (/^\[.*\]$/.test(t)) {
			section = t.slice(1, -1).toLowerCase();
			out.push(line);
			if (section === "script info") scriptInfoIdx = out.length - 1;
			if (section === "v4+ styles" || section === "v4 styles") stylesHeaderIdx = out.length - 1;
			continue;
		}
		if (section === "script info") {
			if (/^PlayResX\s*:/i.test(t)) {
				out.push("PlayResX: 1920");
				hasPlayResX = true;
				continue;
			}
			if (/^PlayResY\s*:/i.test(t)) {
				out.push("PlayResY: 1080");
				hasPlayResY = true;
				continue;
			}
			if (/^ScaledBorderAndShadow\s*:/i.test(t)) {
				out.push("ScaledBorderAndShadow: yes");
				hasScaled = true;
				continue;
			}
		}
		if ((section === "v4+ styles" || section === "v4 styles") && /^Style\s*:/i.test(t)) {
			const name = t
				.slice(t.indexOf(":") + 1)
				.split(",")[0]
				?.trim();
			if (name && name.toLowerCase() === "default") {
				out.push(buildStyleLine("Default", style));
				replacedDefault = true;
				continue;
			}
		}
		out.push(line);
	}

	// Backfill missing Script Info keys.
	const inject: string[] = [];
	if (!hasPlayResX) inject.push("PlayResX: 1920");
	if (!hasPlayResY) inject.push("PlayResY: 1080");
	if (!hasScaled) inject.push("ScaledBorderAndShadow: yes");
	if (inject.length && scriptInfoIdx >= 0) out.splice(scriptInfoIdx + 1, 0, ...inject);

	// If ffmpeg named the style something else, add a Default and a styles section if needed.
	if (!replacedDefault) {
		if (stylesHeaderIdx >= 0) {
			out.splice(stylesHeaderIdx + 1, 0, buildStyleLine("Default", style));
		}
	}
	return out.join("\n");
}

/**
 * Restyle dialogue-classified styles in an existing ASS file. The font is always
 * replaced; appearance columns (colours, border, shadow, alignment, margins) are
 * replaced too when `restyleAppearance` is true. Sign/song styles are left alone.
 */
export function restyleAssDialogueFont(assText: string, style: SubtitleStyle, restyleAppearance: boolean): string {
	const dialogue = dialogueStyleNames(assText);
	if (dialogue.size === 0) return assText;

	const lines = assText.split(/\r?\n/);
	let section = "";
	let cols: string[] = [];
	const out = lines.map((line) => {
		const t = line.trim();
		if (/^\[.*\]$/.test(t)) {
			section = t.slice(1, -1).toLowerCase();
			return line;
		}
		if (section !== "v4+ styles" && section !== "v4 styles") return line;
		if (/^Format\s*:/i.test(t)) {
			cols = t
				.slice(t.indexOf(":") + 1)
				.split(",")
				.map((k) => k.trim().toLowerCase());
			return line;
		}
		if (/^Style\s*:/i.test(line) && cols.length) {
			const cut = line.indexOf(":") + 1;
			const values = line.slice(cut).split(",");
			const nameIdx = cols.indexOf("name");
			const name = (values[nameIdx] ?? "").trim();
			if (!dialogue.has(name)) return line;

			for (const [colName, getter] of Object.entries(RESTYLE_COLUMNS)) {
				if (colName !== "fontname" && !restyleAppearance) continue; // font always; rest only if asked
				const idx = cols.indexOf(colName);
				if (idx >= 0 && idx < values.length) {
					const lead = values[idx]!.match(/^\s*/)?.[0] ?? "";
					values[idx] = lead + getter(style);
				}
			}
			return line.slice(0, cut) + values.join(",");
		}
		return line;
	});
	return out.join("\n");
}
