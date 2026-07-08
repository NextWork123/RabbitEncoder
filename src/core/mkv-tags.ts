import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { run } from "./process";
import { Logger } from "./logger";
import { decodeSettingsCode, SettingsCodeError } from "../settings/settings-code";
import type { JobSettings } from "./types";

export interface InputMkvTags {
	source: string | null;
	encodedBy: string | null;
	rabbitSettings: string | null;
	rabbitVersion: string | null;
}

const EMPTY_TAGS: InputMkvTags = {
	source: null,
	encodedBy: null,
	rabbitSettings: null,
	rabbitVersion: null,
};

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

function extractSimpleValue(xml: string, name: string): string | null {
	const re = new RegExp(`<Simple>\\s*<Name>${name}</Name>([\\s\\S]*?)</Simple>`, "i");
	const m = xml.match(re);
	if (!m) return null;

	const inner = m[1] ?? "";
	const strMatch = inner.match(/<String>([\s\S]*?)<\/String>/);
	if (!strMatch) return null;

	const val = decodeXmlEntities(strMatch[1] ?? "").trim();
	return val.length > 0 ? val : null;
}

export function parseMkvTagsXml(xml: string): InputMkvTags {
	if (!xml || xml.length === 0) return { ...EMPTY_TAGS };

	const source = extractSimpleValue(xml, "SOURCE");
	const encodedBy = extractSimpleValue(xml, "ENCODED_BY");

	const rabbitSettings = extractSimpleValue(xml, "SETTINGS");

	let rabbitVersion: string | null = null;
	const rabbitBlockMatch = xml.match(/<Simple>\s*<Name>RABBIT_ENCODER<\/Name>([\s\S]*?)<\/Simple>\s*(?=<Simple>|<\/Tag>)/i);
	if (rabbitBlockMatch) {
		rabbitVersion = extractSimpleValue(rabbitBlockMatch[1] ?? "", "VERSION");
	}

	return { source, encodedBy, rabbitSettings, rabbitVersion };
}

export async function readMkvTags(inputPath: string, tempDir: string, signal?: AbortSignal): Promise<InputMkvTags> {
	const lower = inputPath.toLowerCase();
	if (!lower.endsWith(".mkv") && !lower.endsWith(".mks")) {
		return { ...EMPTY_TAGS };
	}

	const xmlFile = join(tempDir, "input_tags.xml");

	try {
		try {
			if (existsSync(xmlFile)) unlinkSync(xmlFile);
		} catch {}

		const res = await run(["mkvextract", inputPath, "tags", xmlFile], { signal });
		if (res.code !== 0) {
			Logger.warn(`[mkv-tags] mkvextract exit ${res.code}: ${res.stderr.slice(-200)}`);
			return { ...EMPTY_TAGS };
		}

		if (!existsSync(xmlFile)) {
			return { ...EMPTY_TAGS };
		}

		const xml = await Bun.file(xmlFile).text();

		try {
			unlinkSync(xmlFile);
		} catch {}

		return parseMkvTagsXml(xml);
	} catch (err: any) {
		Logger.warn(`[mkv-tags] Failed to read tags: ${err?.message || err}`);
		return { ...EMPTY_TAGS };
	}
}

export function decodePriorSettings(rabbitSettings: string | null): Partial<JobSettings> | null {
	if (!rabbitSettings) return null;
	const trimmed = rabbitSettings.trim();
	if (!/^RE\d+\b/.test(trimmed)) return null;
	try {
		return decodeSettingsCode(trimmed);
	} catch (err) {
		if (err instanceof SettingsCodeError) {
			Logger.warn(`[mkv-tags] Could not decode prior settings code: ${err.message}`);
			return null;
		}
		throw err;
	}
}

export interface PriorProcessingFlags {
	hadDenoise: boolean;
	hadVsFilters: boolean;
	hadDeband: boolean;
	hadDownscale: boolean;
}

export function detectPriorProcessing(rabbitSettings: string | null): PriorProcessingFlags {
	const none: PriorProcessingFlags = { hadDenoise: false, hadVsFilters: false, hadDeband: false, hadDownscale: false };
	if (!rabbitSettings) return none;

	const decoded = decodePriorSettings(rabbitSettings);
	if (decoded) {
		const hadVsFilters = (decoded.vsFilters ?? []).some((e) => e && e.level !== "off");
		return {
			hadDenoise: !!decoded.denoise && decoded.denoise !== "off",
			hadVsFilters,
			hadDeband: !!decoded.deband && decoded.deband !== "off",
			hadDownscale: !!decoded.downscale,
		};
	}

	// Legacy fallback: human-readable SETTINGS from older builds: "Quality medium, Speed slow, Denoise auto, VS finedehalo/medium".
	return {
		hadDenoise: /\bDenoise\b/i.test(rabbitSettings),
		hadVsFilters: /\bVS\s+/i.test(rabbitSettings),
		hadDeband: /\bDeband\b/i.test(rabbitSettings),
		hadDownscale: /\bDownscale\b/i.test(rabbitSettings),
	};
}
