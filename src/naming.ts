import type { DenoiseLevel } from "./types";

/**
 * Detect the source tag from a filename (Bluray, WEBDL, WEBRip, etc.).
 * REMUX files are tagged as Bluray after re-encoding.
 */
export function detectSourceTag(filename: string): string {
	const upper = filename.toUpperCase();

	if (/\bREMUX\b/.test(upper)) return "Bluray";

	const sources = ["WEBDL", "WEBRIP", "BLURAY", "HDTV", "DVD", "SDTV", "CAM"] as const;

	for (const source of sources) {
		if (new RegExp(`\\b${source}\\b`).test(upper)) {
			switch (source) {
				case "BLURAY":
					return "Bluray";
				case "WEBRIP":
					return "WEBRip";
				case "WEBDL":
					return "WEBDL";
				case "HDTV":
					return "HDTV";
				case "DVD":
					return "DVD";
				case "SDTV":
					return "SDTV";
				case "CAM":
					return "CAM";
			}
		}
	}

	return "Bluray";
}

/**
 * Extract release group from the end of a filename.
 * Pattern: `]-GroupName` at the end of the stem.
 */
export function detectReleaseGroup(filename: string): string | null {
	const match = filename.match(/\]-([A-Za-z0-9._-]+)$/);
	return match?.[1] ?? null;
}

/**
 * Map resolution dimensions to a standard tag (2160p, 1080p, 720p, etc.).
 */
export function getResolutionTag(width: number, height: number): string {
	if (width >= 3200 || height >= 2100) return "2160p";
	if (width >= 1800 || height >= 1000) return "1080p";
	if (width >= 1200 || height >= 700) return "720p";
	if (width >= 1000 || height >= 560) return "576p";
	if (width > 0 && height > 0) return "480p";
	return "1080p";
}

/**
 * Return an FFmpeg video filter string for the given denoise level, or null if off.
 * Uses the nlmeans filter which is excellent for film grain and anime.
 */
export function getDenoiseFilter(level: DenoiseLevel): string | null {
	switch (level) {
		case "light":
			return "nlmeans=s=1:p=3:r=7";
		case "medium":
			return "nlmeans=s=2:p=5:r=9";
		case "heavy":
			return "nlmeans=s=3:p=7:r=11";
		default:
			return null;
	}
}

/**
 * Strip scene/release metadata from a filename stem to get the base title.
 * Removes everything from `- [` or `[` onwards.
 */
export function extractBaseTitle(stem: string): string {
	return stem.replace(/\s*[\-–—]*\s*\[.*/, "").trim();
}
