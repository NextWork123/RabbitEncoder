import type { SubtitleStyle } from "./types";
import { faceCandidateKeys, type ScriptName } from "./script-detect";

/** Subtitle appearance, minus the family name (which is always face-derived). */
export type StyleAppearance = Omit<SubtitleStyle, "fontName">;

/** Stored in a font group's metadata.json. `overrides` keys match face keys. */
export interface GroupStyleConfig {
	style?: Partial<StyleAppearance>;
	overrides?: Record<string, Partial<StyleAppearance>>;
}

/** Built-in fallback appearance */
export const DEFAULT_STYLE_APPEARANCE: StyleAppearance = {
	fontSize: 80,
	primaryColour: "&H00FFFFFF",
	outlineColour: "&H00000000",
	backColour: "&H80000000",
	outline: 4,
	shadow: 1.5,
	alignment: 2,
	marginV: 50,
	marginL: 135,
	marginR: 135,
	bold: false,
	fontAxes: { wght: 700 },
};

/** Merge b over a (b wins where defined). fontAxes is replaced wholesale, not merged. */
function merge(a: StyleAppearance, b: Partial<StyleAppearance> | undefined): StyleAppearance {
	if (!b) return a;
	const out: StyleAppearance = { ...a, ...b };
	out.fontAxes = b.fontAxes ? { ...b.fontAxes } : { ...a.fontAxes };
	return out;
}

/**
 * Resolve appearance for a track: DEFAULT <- group global (`style`)
 * <- first matching override, where override keys are tried in the SAME order
 * as face selection (language code first, then script/writing-system, then
 * `default`). So precedence is language -> script -> group-global -> built-in.
 */
export function resolveStyleAppearance(group: GroupStyleConfig | null, langCode: string | undefined, script: ScriptName): StyleAppearance {
	let resolved = merge({ ...DEFAULT_STYLE_APPEARANCE }, group?.style);
	const overrides = group?.overrides;
	if (overrides) {
		for (const key of faceCandidateKeys(langCode, script)) {
			if (overrides[key]) {
				resolved = merge(resolved, overrides[key]);
				break; // highest-priority match wins
			}
		}
	}
	return resolved;
}
