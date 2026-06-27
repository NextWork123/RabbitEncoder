import type { SubtitleStyle } from "../types";
import { fetchFontFace, resolveFontFace } from "../api/client";

interface PreviewEl extends HTMLElement {
	_timer?: ReturnType<typeof setInterval> | null;
	_onKey?: (e: KeyboardEvent) => void;
	_ro?: ResizeObserver | null;
}

const BG_PRESETS = [
	{ key: "1", label: "Black", color: "#000000" },
	{ key: "2", label: "White", color: "#ffffff" },
	{ key: "3", label: "Red", color: "#c0152f" },
	{ key: "4", label: "Green", color: "#1f7a34" },
	{ key: "5", label: "Blue", color: "#1f4fd1" },
	{ key: "6", label: "Gray", color: "#808080" },
];

/** ASS &HAABBGGRR (AA: 00=opaque, FF=transparent) → CSS rgba(). */
function assColourToCss(ass: string): string {
	const m = /^&H([0-9A-Fa-f]{1,8})$/i.exec((ass || "").trim());
	if (!m) return "rgba(255,255,255,1)";
	const hex = m[1]!.padStart(8, "0");
	const a = parseInt(hex.slice(0, 2), 16);
	const b = parseInt(hex.slice(2, 4), 16);
	const g = parseInt(hex.slice(4, 6), 16);
	const r = parseInt(hex.slice(6, 8), 16);
	return `rgba(${r},${g},${b},${(1 - a / 255).toFixed(3)})`;
}

/** ASS numpad alignment (1–9) -> flex placement + text-align. */
function alignToFlex(al: number) {
	const col = (al - 1) % 3; // 0 left, 1 center, 2 right
	const row = Math.floor((al - 1) / 3); // 0 bottom, 1 middle, 2 top
	return {
		justify: row === 0 ? "flex-end" : row === 1 ? "center" : "flex-start",
		align: col === 0 ? "flex-start" : col === 1 ? "center" : "flex-end",
		textAlign: col === 0 ? "left" : col === 1 ? "center" : ("right" as CanvasTextAlign),
	};
}

export function renderFontPreview(container: PreviewEl, style: SubtitleStyle): void {
	// Tear down a previous instance (modals are hidden, not removed, so reuse is common).
	if (container._timer) clearInterval(container._timer);
	if (container._onKey) document.removeEventListener("keydown", container._onKey);
	if (container._ro) container._ro.disconnect();
	container._timer = null;
	container._onKey = undefined;
	container._ro = null;
	container.innerHTML = "";

	let bg = "#000000";
	let sampleText = "Bow before the one\nwho conquered death itself.";
	let loadedFamily = "";
	let resolveTimer: ReturnType<typeof setTimeout> | null = null;

	// toolbar
	const bar = document.createElement("div");
	bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px";

	for (const p of BG_PRESETS) {
		const sw = document.createElement("button");
		sw.type = "button";
		sw.title = `${p.label}  (key ${p.key})`;
		sw.style.cssText = `width:24px;height:24px;border-radius:4px;border:1px solid rgba(128,128,128,.5);cursor:pointer;background:${p.color}`;
		sw.onclick = () => setBg(p.color);
		bar.appendChild(sw);
	}

	const picker = document.createElement("input");
	picker.type = "color";
	picker.value = "#000000";
	picker.title = "Custom background";
	picker.style.cssText = "width:28px;height:24px;padding:0;border:1px solid rgba(128,128,128,.5);border-radius:4px;cursor:pointer;background:none";
	picker.oninput = () => setBg(picker.value);
	bar.appendChild(picker);

	const textInput = document.createElement("input");
	textInput.type = "text";
	textInput.className = "lang-filter-input";
	textInput.value = sampleText.replace(/\n/g, " / ");
	textInput.placeholder = "Sample text ( / = line break )";
	textInput.style.cssText = "flex:1;min-width:140px";
	textInput.oninput = () => {
		sampleText = textInput.value.replace(/\s*\/\s*/g, "\n");
		applyStyles();
	};
	bar.appendChild(textInput);

	// stage (16:9, represents 1920×1080)
	const stage = document.createElement("div");
	stage.style.cssText = "position:relative;width:100%;aspect-ratio:16 / 9;border-radius:6px;overflow:hidden;border:1px solid rgba(128,128,128,.4)";

	const flex = document.createElement("div");
	flex.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box";
	const textEl = document.createElement("div");
	textEl.style.cssText = "max-width:100%;overflow-wrap:anywhere";
	flex.appendChild(textEl);
	stage.appendChild(flex);

	const hint = document.createElement("div");
	hint.className = "setting-help";
	hint.style.marginTop = "6px";
	hint.textContent = "Approximate preview. Keys 1-6 switch backgrounds or use the colour picker. libass rendering may differ slightly.";

	container.appendChild(bar);
	container.appendChild(stage);
	container.appendChild(hint);

	function setBg(color: string) {
		bg = color;
		if (/^#[0-9a-f]{6}$/i.test(color)) picker.value = color;
		applyStyles();
	}

	function ensureFace() {
		if (resolveTimer) clearTimeout(resolveTimer);
		resolveTimer = setTimeout(async () => {
			const familyLabel = style.fontName;
			if (!familyLabel) return;
			const { fileName, family } = await resolveFontFace(familyLabel, sampleText);
			if (!fileName || !family || family === loadedFamily) {
				if (family) {
					textEl.style.fontFamily = `"${family}", "Arial", sans-serif`;
				}
				return;
			}
			try {
				const blob = await fetchFontFace(familyLabel, fileName);
				const face = new FontFace(family, `url(${URL.createObjectURL(blob)})`);
				await face.load();
				document.fonts.add(face);
				loadedFamily = family;
				textEl.style.fontFamily = `"${family}", "Arial", sans-serif`;
			} catch {
				/* fall back to system rendering */
			}
		}, 250);
	}

	function applyStyles() {
		const w = stage.getBoundingClientRect().width || 0;
		const h = stage.getBoundingClientRect().height || 0;
		const scale = w > 0 ? w / 1920 : 0;
		const a = alignToFlex(style.alignment || 2);

		flex.style.background = bg;
		flex.style.justifyContent = a.justify;
		flex.style.alignItems = a.align;
		flex.style.paddingBottom = `${style.marginV * scale}px`;
		flex.style.paddingLeft = `${style.marginL * scale}px`;
		flex.style.paddingRight = `${style.marginR * scale}px`;

		const ol = Math.max(0, style.outline * scale);
		const sh = Math.max(0, style.shadow * scale);
		textEl.textContent = sampleText;
		textEl.style.fontFamily = `"${style.fontName}", "Arial", sans-serif`;
		const axisCss = Object.entries(style.fontAxes ?? {})
			.map(([t, v]) => `"${t}" ${v}`)
			.join(", ");
		textEl.style.fontVariationSettings = axisCss || "normal";
		if (style.fontAxes?.wght) textEl.style.fontWeight = String(style.fontAxes.wght);
		textEl.style.fontSize = `${Math.max(1, style.fontSize * scale)}px`;
		textEl.style.fontWeight = style.bold ? "700" : "400";
		textEl.style.color = assColourToCss(style.primaryColour);
		textEl.style.textAlign = a.textAlign;
		textEl.style.lineHeight = "1.2";
		textEl.style.whiteSpace = "pre-line";
		// -webkit-text-stroke is centred, so ~half sits inside the glyph; double it and
		// paint stroke behind fill to approximate libass's outside outline.
		(textEl.style as any).webkitTextStrokeWidth = ol > 0 ? `${ol * 2}px` : "0";
		(textEl.style as any).webkitTextStrokeColor = assColourToCss(style.outlineColour);
		(textEl.style as any).paintOrder = "stroke fill";
		textEl.style.textShadow = sh > 0 ? `${sh}px ${sh}px 0 ${assColourToCss(style.backColour)}` : "none";

		ensureFace();
	}

	const onKey = (e: KeyboardEvent) => {
		if (container.offsetParent === null) return; // modal hidden
		const ae = document.activeElement;
		if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
		const preset = BG_PRESETS.find((p) => p.key === e.key);
		if (preset) {
			setBg(preset.color);
			e.preventDefault();
		}
	};
	container._onKey = onKey;
	document.addEventListener("keydown", onKey);

	applyStyles();

	const ro = new ResizeObserver(() => applyStyles());
	ro.observe(stage);
	container._ro = ro;

	let last = "";
	container._timer = setInterval(() => {
		if (!container.isConnected) {
			if (container._timer) clearInterval(container._timer);
			container._timer = null;
			document.removeEventListener("keydown", onKey);
			if (container._ro) container._ro.disconnect();
			container._ro = null;
			return;
		}
		const snap = JSON.stringify(style) + "|" + bg + "|" + sampleText;
		if (snap === last) return;
		last = snap;
		applyStyles();
	}, 250);
}
