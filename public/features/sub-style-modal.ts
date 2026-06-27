import type { AdvancedTarget } from "../ui/models";
import type { FontOption } from "../api/client";
import type { JobSettings, SubtitleStyle } from "../types";
import { DEFAULT_SUBTITLE_STYLE } from "../config/options";
import { fetchFonts } from "../api/client";
import { renderFontDropdown, renderLabeledToggle, renderNumberControl, renderTextControl } from "./settings-controls";
import { renderFontPreview } from "./font-preview";
import { byId } from "../shared/dom";

function resolveSettings(target: AdvancedTarget): JobSettings | null {
	if (target === "default") return window._tempDefaults ?? null;
	if (target === "job") return window._tempJobSettings ?? null;
	return null;
}

interface AxisInfo {
	tag: string;
	min: number;
	default: number;
	max: number;
	name: string;
}

export function openSubStyleModal(target: AdvancedTarget): void {
	const settings = resolveSettings(target);
	if (!settings) return;
	const style: SubtitleStyle = (settings.subtitleStyle ??= { ...DEFAULT_SUBTITLE_STYLE });
	style.fontAxes ??= {};

	byId("sub-style-modal-title").textContent = target === "default" ? "Subtitle Style — Defaults" : "Subtitle Style — Job";

	// Collect the variable axes exposed by the currently-selected family (union across its faces).
	function renderAxes(fonts: FontOption[]): void {
		const host = byId("sub-style-axes");

		// Fonts not loaded yet - show a placeholder and DON'T touch saved axis values.
		if (fonts.length === 0) {
			host.innerHTML = `<div class="setting-help">Loading font axes…</div>`;
			return;
		}

		host.innerHTML = "";
		const fam = fonts.find((f) => f.label === style.fontName);
		const axes = new Map<string, AxisInfo>();
		for (const face of fam?.faces ?? []) {
			for (const a of (face.axes ?? []) as AxisInfo[]) {
				if (!axes.has(a.tag)) axes.set(a.tag, a);
			}
		}

		if (axes.size === 0) {
			const help = document.createElement("div");
			help.className = "setting-help";
			help.textContent = fam ? "Selected font is not variable — no adjustable axes." : "Font not found — no adjustable axes.";
			host.appendChild(help);
			// Only clear when we positively identified the family as non-variable.
			if (fam) style.fontAxes = {};
			return;
		}

		// We have real axis data - safe to prune tags that don't exist on this family.
		for (const tag of Object.keys(style.fontAxes!)) {
			if (!axes.has(tag)) delete style.fontAxes![tag];
		}

		for (const [tag, a] of axes) {
			const group = document.createElement("div");
			group.className = "setting-group";
			host.appendChild(group);
			renderNumberControl(group, `${a.name} (${tag})`, style.fontAxes![tag] ?? a.default, { min: a.min, max: a.max, step: tag === "wght" ? 1 : 0.5 }, (v) => {
				style.fontAxes![tag] = v;
			});
		}
	}

	renderFontDropdown(byId("sub-style-font"), style.fontName, [], (v) => (style.fontName = v));

	fetchFonts().then((fonts) => {
		const onFontChange = (v: string) => {
			style.fontName = v;
			renderAxes(fonts); // axes depend on the selected family
		};
		renderFontDropdown(byId("sub-style-font"), style.fontName, fonts, onFontChange);
		renderAxes(fonts);
	});

	renderNumberControl(byId("sub-style-font-size"), "Font size (px)", style.fontSize, { min: 1, max: 400, step: 1 }, (v) => (style.fontSize = v));
	renderNumberControl(byId("sub-style-outline"), "Outline (px)", style.outline, { min: 0, max: 50, step: 0.5 }, (v) => (style.outline = v));
	renderNumberControl(byId("sub-style-shadow"), "Shadow (px)", style.shadow, { min: 0, max: 50, step: 0.5 }, (v) => (style.shadow = v));
	renderNumberControl(byId("sub-style-margin-v"), "Bottom margin (px)", style.marginV, { min: 0, max: 1000, step: 1 }, (v) => (style.marginV = v));
	renderNumberControl(byId("sub-style-margin-l"), "Left margin (px)", style.marginL, { min: 0, max: 1000, step: 1 }, (v) => (style.marginL = v));
	renderNumberControl(byId("sub-style-margin-r"), "Right margin (px)", style.marginR, { min: 0, max: 1000, step: 1 }, (v) => (style.marginR = v));
	renderNumberControl(byId("sub-style-alignment"), "Alignment (numpad 1–9)", style.alignment, { min: 1, max: 9, step: 1 }, (v) => (style.alignment = v));
	renderTextControl(byId("sub-style-primary-colour"), "Text colour", style.primaryColour, "&H00FFFFFF", (v) => (style.primaryColour = v));
	renderTextControl(byId("sub-style-outline-colour"), "Outline colour", style.outlineColour, "&H00000000", (v) => (style.outlineColour = v));
	renderTextControl(byId("sub-style-back-colour"), "Shadow colour", style.backColour, "&H80000000", (v) => (style.backColour = v));
	renderLabeledToggle(byId("sub-style-bold"), style.bold ?? false, "Bold flag (leave off when using a weight axis)", (v) => (style.bold = v));

	renderFontPreview(byId("sub-style-preview"), style);

	byId("sub-style-modal").style.display = "";
}

export function closeSubStyleModal(): void {
	byId("sub-style-modal").style.display = "none";
}

export function closeSubStyleModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeSubStyleModal();
}
