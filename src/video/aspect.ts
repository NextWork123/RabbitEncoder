export interface Rational {
	num: number;
	den: number;
}

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a || 1;
}

export function reduceRatio(r: Rational): Rational {
	const g = gcd(r.num, r.den);
	return { num: r.num / g, den: r.den / g };
}

/** Parse "16:9", "32/27". Returns null for "", "N/A", "0:1" (= unspecified). */
export function parseRatio(s: string | null | undefined): Rational | null {
	const m = (s ?? "").trim().match(/^(\d+)\s*[:/]\s*(\d+)$/);
	if (!m) return null;
	const num = Number(m[1]);
	const den = Number(m[2]);
	if (!num || !den) return null; // 0:1 / N/A / garbage
	return reduceRatio({ num, den });
}

/**
 * The source's pixel aspect ratio - the one property that survives cropping.
 * Prefer ffprobe's sample_aspect_ratio; derive from DAR only as a fallback.
 */
export function resolveSourceSar(probe: { sampleAspectRatio: string; displayAspectRatio: string; width: number; height: number }): Rational {
	const sar = parseRatio(probe.sampleAspectRatio);
	if (sar) return sar;

	const dar = parseRatio(probe.displayAspectRatio);
	if (dar && probe.width > 0 && probe.height > 0) {
		// SAR = DAR ÷ (W/H)
		return reduceRatio({ num: dar.num * probe.height, den: dar.den * probe.width });
	}
	return { num: 1, den: 1 };
}

/**
 * Matroska DisplayWidth/DisplayHeight for a frame of outW×outH with pixel
 * shape `sar`. Always scales the *larger* axis up so nothing is implied to
 * shrink below coded resolution.
 */
export function computeDisplayDimensions(outW: number, outH: number, sar: Rational): { width: number; height: number } {
	if (sar.num === sar.den) return { width: outW, height: outH };
	if (sar.num > sar.den) return { width: Math.round((outW * sar.num) / sar.den), height: outH };
	return { width: outW, height: Math.round((outH * sar.den) / sar.num) };
}

/** Sanity guard: refuse to stamp absurd aspect ratios from a mis-flagged source. */
export function isPlausibleDar(width: number, height: number): boolean {
	const dar = width / height;
	return Number.isFinite(dar) && dar >= 0.5 && dar <= 4.0;
}
