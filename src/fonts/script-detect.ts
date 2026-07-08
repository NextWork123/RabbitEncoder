export type ScriptName = "latin" | "cyrillic" | "greek" | "arabic" | "hebrew" | "japanese" | "korean" | "chinese" | "thai" | "devanagari";

/** Pull plain dialogue text out of ASS or SRT for script sampling. */
export function extractDialogueText(text: string): string {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (/^Dialogue\s*:/i.test(t)) {
			out.push(
				t
					.split(",")
					.slice(9)
					.join(",")
					.replace(/\{[^}]*\}/g, "")
					.replace(/\\N/gi, " "),
			);
		} else if (
			!t ||
			/^\d+$/.test(t) ||
			/-->/.test(t) ||
			/^\[/.test(t) ||
			/^(Format|Style|Title|ScriptType|PlayRes|WrapStyle|Collisions|ScaledBorder|Original|Audio|Video|Last|Comment)/i.test(t)
		) {
			continue;
		} else {
			out.push(t);
		}
	}
	return out.join(" ");
}

function inRange(cp: number, lo: number, hi: number): boolean {
	return cp >= lo && cp <= hi;
}

/** Codepoint histogram → dominant script, with JP/KO/ZH disambiguation. */
export function detectScript(text: string): ScriptName {
	const c = { latin: 0, cyrillic: 0, greek: 0, arabic: 0, hebrew: 0, thai: 0, devanagari: 0, kana: 0, hangul: 0, cjk: 0 };
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (inRange(cp, 0x3040, 0x30ff) || inRange(cp, 0x31f0, 0x31ff)) c.kana++;
		else if (inRange(cp, 0xac00, 0xd7a3) || inRange(cp, 0x1100, 0x11ff) || inRange(cp, 0x3130, 0x318f)) c.hangul++;
		else if (inRange(cp, 0x4e00, 0x9fff) || inRange(cp, 0x3400, 0x4dbf)) c.cjk++;
		else if (inRange(cp, 0x0600, 0x06ff) || inRange(cp, 0x0750, 0x077f) || inRange(cp, 0xfb50, 0xfdff) || inRange(cp, 0xfe70, 0xfeff)) c.arabic++;
		else if (inRange(cp, 0x0590, 0x05ff)) c.hebrew++;
		else if (inRange(cp, 0x0400, 0x052f)) c.cyrillic++;
		else if (inRange(cp, 0x0370, 0x03ff)) c.greek++;
		else if (inRange(cp, 0x0e00, 0x0e7f)) c.thai++;
		else if (inRange(cp, 0x0900, 0x097f)) c.devanagari++;
		else if (inRange(cp, 0x0041, 0x024f)) c.latin++;
	}
	if (c.kana > 0) return "japanese";
	if (c.hangul > 0) return "korean";
	if (c.cjk > 0) return "chinese";
	const rest: [ScriptName, number][] = [
		["arabic", c.arabic],
		["hebrew", c.hebrew],
		["cyrillic", c.cyrillic],
		["greek", c.greek],
		["thai", c.thai],
		["devanagari", c.devanagari],
		["latin", c.latin],
	];
	rest.sort((a, b) => b[1] - a[1]);
	return rest[0]![1] > 0 ? rest[0]![0] : "latin";
}

const SCRIPT_KEY_ALIASES: Record<ScriptName, string[]> = {
	latin: ["latin", "lat", "en", "eng"],
	cyrillic: ["cyrillic", "cyr", "ru", "rus"],
	greek: ["greek", "el", "ell", "gr"],
	arabic: ["arabic", "ar", "ara", "fa", "fas"],
	hebrew: ["hebrew", "he", "heb", "iw"],
	japanese: ["japanese", "ja", "jpn", "jp", "cjk"],
	korean: ["korean", "ko", "kor", "kr", "cjk"],
	chinese: ["chinese", "zh", "zho", "chi", "cn", "sc", "tc", "hans", "hant", "cjk"],
	thai: ["thai", "th", "tha"],
	devanagari: ["devanagari", "hi", "hin", "deva", "mr", "ne"],
};

const ISO3_TO_1: Record<string, string> = {
	jpn: "ja",
	kor: "ko",
	zho: "zh",
	chi: "zh",
	ara: "ar",
	rus: "ru",
	heb: "he",
	ell: "el",
	tha: "th",
	hin: "hi",
	slv: "sl",
	eng: "en",
	deu: "de",
	fra: "fr",
	spa: "es",
	ita: "it",
	por: "pt",
};

/** Ordered list of filename-stem keys to try when picking a face for a track. */
export function faceCandidateKeys(langCode: string | undefined, script: ScriptName): string[] {
	const out: string[] = [];
	const lc = (langCode || "").toLowerCase();
	if (lc && lc !== "und") {
		out.push(lc);
		if (ISO3_TO_1[lc]) out.push(ISO3_TO_1[lc]!);
	}
	for (const k of SCRIPT_KEY_ALIASES[script]) if (!out.includes(k)) out.push(k);
	for (const k of ["latin", "default"]) if (!out.includes(k)) out.push(k);
	return out;
}
