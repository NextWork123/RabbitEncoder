import { describe, expect, it } from "bun:test";
import { getDefaultJobSettings } from "../../src/core/config";
import type { JobSettings } from "../../src/core/types";
import { encodeSettingsCode, decodeSettingsCode } from "../../src/settings/settings-code";

describe("settings code — font/style not carried (RE1 compat)", () => {
	it("never emits font/style/group fields", () => {
		const s: JobSettings = { ...getDefaultJobSettings(), fontGroup: "Anime old", convertSrtToAss: true };
		const code = encodeSettingsCode(s);
		expect(code).not.toMatch(/fn=/);
		expect(code).not.toMatch(/fs=/);
		expect(code).not.toMatch(/Anime/);
		expect(code).toContain("cv=1"); // behavioral toggle still encoded
	});

	it("silently ignores legacy style keys and never sets fontGroup", () => {
		const partial = decodeSettingsCode("RE1|st~cv=1,fn=Trebuchet MS,fs=90,pc=&H00FF00FF");
		expect(partial.convertSrtToAss).toBe(true);
		expect((partial as Record<string, unknown>).subtitleStyle).toBeUndefined();
		expect(partial.fontGroup).toBeUndefined(); // group is environment-specific
	});
});
