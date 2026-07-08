import { describe, expect, it } from "bun:test";
import { resolveStyleAppearance, DEFAULT_STYLE_APPEARANCE, type GroupStyleConfig } from "../../src/subtitles/subtitle-style";
import { fontAttachmentFileName } from "../../src/fonts/font-instance";

describe("resolveStyleAppearance — precedence", () => {
	const group: GroupStyleConfig = {
		style: { fontSize: 80, marginV: 50 },
		overrides: {
			japanese: { fontSize: 74, fontAxes: { wght: 600 } }, // per-writing-system
			jpn: { fontSize: 72, marginV: 60 }, // per-language
			latin: { fontAxes: {} },
		},
	};

	it("prefers a language override over a writing-system override", () => {
		// langCode "jpn" with japanese script: the "jpn" (language) override must
		// win over the "japanese" (script) override, since language is tried first.
		const r = resolveStyleAppearance(group, "jpn", "japanese");
		expect(r.fontSize).toBe(72);
		expect(r.marginV).toBe(60);
	});

	it("uses the writing-system override when no language override matches", () => {
		// "de" has no override; falls through to the "japanese" script override.
		const r = resolveStyleAppearance(group, "de", "japanese");
		expect(r.fontSize).toBe(74);
		expect(r.fontAxes).toEqual({ wght: 600 });
	});

	it("falls back to group-global, then built-in default, for unset fields", () => {
		// "fre" has no language override; "latin" matches via script.
		const r = resolveStyleAppearance(group, "fre", "latin");
		expect(r.fontAxes).toEqual({}); // from the latin override
		expect(r.fontSize).toBe(80); // group-global
		expect(r.outline).toBe(DEFAULT_STYLE_APPEARANCE.outline); // built-in default
		expect(r.shadow).toBe(DEFAULT_STYLE_APPEARANCE.shadow); // built-in default
	});

	it("returns the built-in default for an unknown / null group", () => {
		expect(resolveStyleAppearance(null, "eng", "latin")).toEqual(DEFAULT_STYLE_APPEARANCE);
	});

	it("replaces fontAxes wholesale rather than merging axis maps", () => {
		const g: GroupStyleConfig = {
			style: { fontAxes: { wght: 700, wdth: 100 } },
			overrides: { latin: { fontAxes: { wght: 400 } } },
		};
		const r = resolveStyleAppearance(g, "eng", "latin");
		expect(r.fontAxes).toEqual({ wght: 400 }); // wdth from group-global is NOT inherited
	});

	it("ignores overrides entirely when none of the candidate keys match", () => {
		const g: GroupStyleConfig = { style: { fontSize: 90 }, overrides: { thai: { fontSize: 50 } } };
		const r = resolveStyleAppearance(g, "eng", "latin");
		expect(r.fontSize).toBe(90); // group-global, thai override never applies
	});
});

describe("fontAttachmentFileName — slug", () => {
	it("slugifies spaces and keeps the extension", () => {
		expect(fontAttachmentFileName("Noto Sans", ".ttf")).toBe("noto_sans.ttf");
		expect(fontAttachmentFileName("Noto Sans 2", ".ttf")).toBe("noto_sans_2.ttf");
		expect(fontAttachmentFileName("Trebuchet MS", ".otf")).toBe("trebuchet_ms.otf");
	});

	it("collapses runs of punctuation and trims leading/trailing separators", () => {
		expect(fontAttachmentFileName("  --Weird@@Name--  ", ".ttf")).toBe("weird_name.ttf");
	});

	it("falls back to 'font' when nothing usable remains", () => {
		expect(fontAttachmentFileName("@@@", ".ttf")).toBe("font.ttf");
	});
});
