import { LANG_ALIASES } from "./naming";

/**
 * A language TranslateGemma can translate to/from, described the way its prompt
 * template expects it: a human-readable `name` and a BCP-47-ish `code`
 * (for example "en", "pt-BR", or "zh-Hant").
 */
export interface TranslateLang {
	/** Human-readable language name used in the TranslateGemma prompt. */
	name: string;
	/** Language code used in the TranslateGemma prompt. */
	code: string;
}

/**
 * Base languages exposed by the supported-language table on Ollama's
 * TranslateGemma page. The model headline mentions 55 benchmarked languages,
 * while the table/template exposes 161 base languages; languages outside the
 * benchmarked set should be treated as potentially lower quality.
 *
 * Regional and script subtags are retained by `resolveTranslateLang`, so
 * inputs such as "pt-BR", "sr-Latn", and "es-419" keep their requested
 * variant while still being validated against this base-language list.
 */
const TRANSLATE_LANGS: Record<string, TranslateLang> = {
	aa: { name: "Afar", code: "aa" },
	ab: { name: "Abkhazian", code: "ab" },
	af: { name: "Afrikaans", code: "af" },
	ak: { name: "Akan", code: "ak" },
	am: { name: "Amharic", code: "am" },
	an: { name: "Aragonese", code: "an" },
	ar: { name: "Arabic", code: "ar" },
	as: { name: "Assamese", code: "as" },
	az: { name: "Azerbaijani", code: "az" },
	ba: { name: "Bashkir", code: "ba" },
	be: { name: "Belarusian", code: "be" },
	bg: { name: "Bulgarian", code: "bg" },
	bm: { name: "Bambara", code: "bm" },
	bn: { name: "Bengali", code: "bn" },
	bo: { name: "Tibetan", code: "bo" },
	br: { name: "Breton", code: "br" },
	bs: { name: "Bosnian", code: "bs" },
	ca: { name: "Catalan", code: "ca" },
	ce: { name: "Chechen", code: "ce" },
	co: { name: "Corsican", code: "co" },
	cs: { name: "Czech", code: "cs" },
	cv: { name: "Chuvash", code: "cv" },
	cy: { name: "Welsh", code: "cy" },
	da: { name: "Danish", code: "da" },
	de: { name: "German", code: "de" },
	dv: { name: "Divehi", code: "dv" },
	dz: { name: "Dzongkha", code: "dz" },
	ee: { name: "Ewe", code: "ee" },
	el: { name: "Greek", code: "el" },
	en: { name: "English", code: "en" },
	eo: { name: "Esperanto", code: "eo" },
	es: { name: "Spanish", code: "es" },
	et: { name: "Estonian", code: "et" },
	eu: { name: "Basque", code: "eu" },
	fa: { name: "Persian", code: "fa" },
	ff: { name: "Fulah", code: "ff" },
	fi: { name: "Finnish", code: "fi" },
	fil: { name: "Filipino", code: "fil-PH" },
	fo: { name: "Faroese", code: "fo" },
	fr: { name: "French", code: "fr" },
	fy: { name: "Western Frisian", code: "fy" },
	ga: { name: "Irish", code: "ga" },
	gd: { name: "Scottish Gaelic", code: "gd" },
	gl: { name: "Galician", code: "gl" },
	gn: { name: "Guarani", code: "gn" },
	gu: { name: "Gujarati", code: "gu" },
	gv: { name: "Manx", code: "gv" },
	ha: { name: "Hausa", code: "ha" },
	he: { name: "Hebrew", code: "he" },
	hi: { name: "Hindi", code: "hi" },
	hr: { name: "Croatian", code: "hr" },
	ht: { name: "Haitian", code: "ht" },
	hu: { name: "Hungarian", code: "hu" },
	hy: { name: "Armenian", code: "hy" },
	ia: { name: "Interlingua", code: "ia" },
	id: { name: "Indonesian", code: "id" },
	ie: { name: "Interlingue", code: "ie" },
	ig: { name: "Igbo", code: "ig" },
	ii: { name: "Sichuan Yi", code: "ii" },
	ik: { name: "Inupiaq", code: "ik" },
	io: { name: "Ido", code: "io" },
	is: { name: "Icelandic", code: "is" },
	it: { name: "Italian", code: "it" },
	iu: { name: "Inuktitut", code: "iu" },
	ja: { name: "Japanese", code: "ja" },
	jv: { name: "Javanese", code: "jv" },
	ka: { name: "Georgian", code: "ka" },
	ki: { name: "Kikuyu", code: "ki" },
	kk: { name: "Kazakh", code: "kk" },
	kl: { name: "Kalaallisut", code: "kl" },
	km: { name: "Central Khmer", code: "km" },
	kn: { name: "Kannada", code: "kn" },
	ko: { name: "Korean", code: "ko" },
	ks: { name: "Kashmiri", code: "ks" },
	ku: { name: "Kurdish", code: "ku" },
	kw: { name: "Cornish", code: "kw" },
	ky: { name: "Kyrgyz", code: "ky" },
	la: { name: "Latin", code: "la" },
	lb: { name: "Luxembourgish", code: "lb" },
	lg: { name: "Ganda", code: "lg" },
	ln: { name: "Lingala", code: "ln" },
	lo: { name: "Lao", code: "lo" },
	lt: { name: "Lithuanian", code: "lt" },
	lu: { name: "Luba-Katanga", code: "lu" },
	lv: { name: "Latvian", code: "lv" },
	mg: { name: "Malagasy", code: "mg" },
	mi: { name: "Maori", code: "mi" },
	mk: { name: "Macedonian", code: "mk" },
	ml: { name: "Malayalam", code: "ml" },
	mn: { name: "Mongolian", code: "mn" },
	mr: { name: "Marathi", code: "mr" },
	ms: { name: "Malay", code: "ms" },
	mt: { name: "Maltese", code: "mt" },
	my: { name: "Burmese", code: "my" },
	nb: { name: "Norwegian Bokmål", code: "nb" },
	nd: { name: "North Ndebele", code: "nd" },
	ne: { name: "Nepali", code: "ne" },
	nl: { name: "Dutch", code: "nl" },
	nn: { name: "Norwegian Nynorsk", code: "nn" },
	no: { name: "Norwegian", code: "no" },
	nr: { name: "South Ndebele", code: "nr" },
	nv: { name: "Navajo", code: "nv" },
	ny: { name: "Chichewa", code: "ny" },
	oc: { name: "Occitan", code: "oc" },
	om: { name: "Oromo", code: "om" },
	or: { name: "Oriya", code: "or" },
	os: { name: "Ossetian", code: "os" },
	pa: { name: "Punjabi", code: "pa" },
	pl: { name: "Polish", code: "pl" },
	ps: { name: "Pashto", code: "ps" },
	pt: { name: "Portuguese", code: "pt" },
	qu: { name: "Quechua", code: "qu" },
	rm: { name: "Romansh", code: "rm" },
	rn: { name: "Rundi", code: "rn" },
	ro: { name: "Romanian", code: "ro" },
	ru: { name: "Russian", code: "ru" },
	rw: { name: "Kinyarwanda", code: "rw" },
	sa: { name: "Sanskrit", code: "sa" },
	sc: { name: "Sardinian", code: "sc" },
	sd: { name: "Sindhi", code: "sd" },
	se: { name: "Northern Sami", code: "se" },
	sg: { name: "Sango", code: "sg" },
	si: { name: "Sinhala", code: "si" },
	sk: { name: "Slovak", code: "sk" },
	sl: { name: "Slovenian", code: "sl" },
	sn: { name: "Shona", code: "sn" },
	so: { name: "Somali", code: "so" },
	sq: { name: "Albanian", code: "sq" },
	sr: { name: "Serbian", code: "sr" },
	ss: { name: "Swati", code: "ss" },
	st: { name: "Southern Sotho", code: "st" },
	su: { name: "Sundanese", code: "su" },
	sv: { name: "Swedish", code: "sv" },
	sw: { name: "Swahili", code: "sw" },
	ta: { name: "Tamil", code: "ta" },
	te: { name: "Telugu", code: "te" },
	tg: { name: "Tajik", code: "tg" },
	th: { name: "Thai", code: "th" },
	ti: { name: "Tigrinya", code: "ti" },
	tk: { name: "Turkmen", code: "tk" },
	tl: { name: "Tagalog", code: "tl" },
	tn: { name: "Tswana", code: "tn" },
	to: { name: "Tonga", code: "to" },
	tr: { name: "Turkish", code: "tr" },
	ts: { name: "Tsonga", code: "ts" },
	tt: { name: "Tatar", code: "tt" },
	ug: { name: "Uyghur", code: "ug" },
	uk: { name: "Ukrainian", code: "uk" },
	ur: { name: "Urdu", code: "ur" },
	uz: { name: "Uzbek", code: "uz" },
	ve: { name: "Venda", code: "ve" },
	vi: { name: "Vietnamese", code: "vi" },
	vo: { name: "Volapük", code: "vo" },
	wa: { name: "Walloon", code: "wa" },
	wo: { name: "Wolof", code: "wo" },
	xh: { name: "Xhosa", code: "xh" },
	yi: { name: "Yiddish", code: "yi" },
	yo: { name: "Yoruba", code: "yo" },
	za: { name: "Zhuang", code: "za" },
	zh: { name: "Chinese", code: "zh" },
	zu: { name: "Zulu", code: "zu" },
};

/**
 * ISO-639-2/3 aliases for MKV language tags. Alpha-2 tags are resolved
 * directly through `TRANSLATE_LANGS`; this table covers terminology and
 * bibliographic three-letter forms plus a few common legacy aliases.
 */
const ISO639_ALIAS_TO_GGM: Record<string, string> = {
	aar: "aa",
	abk: "ab",
	afr: "af",
	aka: "ak",
	amh: "am",
	arg: "an",
	ara: "ar",
	asm: "as",
	aze: "az",
	bak: "ba",
	bel: "be",
	bul: "bg",
	bam: "bm",
	ben: "bn",
	bod: "bo",
	tib: "bo",
	bre: "br",
	bos: "bs",
	cat: "ca",
	che: "ce",
	cos: "co",
	ces: "cs",
	cze: "cs",
	chv: "cv",
	cym: "cy",
	wel: "cy",
	dan: "da",
	deu: "de",
	ger: "de",
	div: "dv",
	dzo: "dz",
	ewe: "ee",
	ell: "el",
	gre: "el",
	eng: "en",
	epo: "eo",
	spa: "es",
	est: "et",
	eus: "eu",
	baq: "eu",
	fas: "fa",
	per: "fa",
	ful: "ff",
	fin: "fi",
	fil: "fil",
	fao: "fo",
	fra: "fr",
	fre: "fr",
	fry: "fy",
	gle: "ga",
	gla: "gd",
	glg: "gl",
	grn: "gn",
	guj: "gu",
	glv: "gv",
	hau: "ha",
	heb: "he",
	hin: "hi",
	hrv: "hr",
	hat: "ht",
	hun: "hu",
	hye: "hy",
	arm: "hy",
	ina: "ia",
	ind: "id",
	ile: "ie",
	ibo: "ig",
	iii: "ii",
	ipk: "ik",
	ido: "io",
	isl: "is",
	ice: "is",
	ita: "it",
	iku: "iu",
	jpn: "ja",
	jav: "jv",
	kat: "ka",
	geo: "ka",
	kik: "ki",
	kaz: "kk",
	kal: "kl",
	khm: "km",
	kan: "kn",
	kor: "ko",
	kas: "ks",
	kur: "ku",
	cor: "kw",
	kir: "ky",
	lat: "la",
	ltz: "lb",
	lug: "lg",
	lin: "ln",
	lao: "lo",
	lit: "lt",
	lub: "lu",
	lav: "lv",
	mlg: "mg",
	mri: "mi",
	mao: "mi",
	mkd: "mk",
	mac: "mk",
	mal: "ml",
	mon: "mn",
	mar: "mr",
	msa: "ms",
	may: "ms",
	mlt: "mt",
	mya: "my",
	bur: "my",
	nob: "nb",
	nde: "nd",
	nep: "ne",
	nld: "nl",
	dut: "nl",
	nno: "nn",
	nor: "no",
	nbl: "nr",
	nav: "nv",
	nya: "ny",
	oci: "oc",
	orm: "om",
	ori: "or",
	oss: "os",
	pan: "pa",
	pol: "pl",
	pus: "ps",
	por: "pt",
	que: "qu",
	roh: "rm",
	run: "rn",
	ron: "ro",
	rum: "ro",
	rus: "ru",
	kin: "rw",
	san: "sa",
	srd: "sc",
	snd: "sd",
	sme: "se",
	sag: "sg",
	sin: "si",
	slk: "sk",
	slo: "sk",
	slv: "sl",
	sna: "sn",
	som: "so",
	sqi: "sq",
	alb: "sq",
	srp: "sr",
	ssw: "ss",
	sot: "st",
	sun: "su",
	swe: "sv",
	swa: "sw",
	tam: "ta",
	tel: "te",
	tgk: "tg",
	tha: "th",
	tir: "ti",
	tuk: "tk",
	tgl: "tl",
	tsn: "tn",
	ton: "to",
	tur: "tr",
	tso: "ts",
	tat: "tt",
	uig: "ug",
	ukr: "uk",
	urd: "ur",
	uzb: "uz",
	ven: "ve",
	vie: "vi",
	vol: "vo",
	wln: "wa",
	wol: "wo",
	xho: "xh",
	yid: "yi",
	yor: "yo",
	zha: "za",
	zho: "zh",
	chi: "zh",
	zul: "zu",
	iw: "he",
	in: "id",
	ji: "yi",
};

/** Normalise a language tag the same way the rest of the pipeline does. */
export function normalizeTag(input: string | undefined): string {
	if (!input) return "und";
	const s = input.toLowerCase().trim();
	return LANG_ALIASES[s] || s;
}

/** Convert a loose locale tag into conventional BCP-47 casing. */
function canonicalizeLocale(code: string): string {
	const parts = code.replace(/_/g, "-").split("-").filter(Boolean);
	if (parts.length === 0) return "und";

	return parts
		.map((part, index) => {
			if (index === 0) return part.toLowerCase();
			if (/^[a-z]{4}$/i.test(part)) return `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`;
			if (/^[a-z]{2}$/i.test(part)) return part.toUpperCase();
			return part.toLowerCase();
		})
		.join("-");
}

/** Resolve Chinese aliases and script/region variants deliberately. */
function resolveChinese(lower: string): TranslateLang {
	if (/latn/.test(lower)) return { name: "Chinese", code: "zh-Latn" };

	if (/hant|traditional/.test(lower)) {
		if (/(?:^|[-_])hk(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hant-HK" };
		if (/(?:^|[-_])mo(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hant-MO" };
		if (/(?:^|[-_])my(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hant-MY" };
		return { name: "Chinese (Traditional)", code: "zh-Hant" };
	}

	if (/(?:^|[-_])tw(?:$|[-_])/.test(lower)) return { name: "Chinese (Traditional)", code: "zh-TW" };
	if (/(?:^|[-_])(hk|mo)(?:$|[-_])/.test(lower)) return { name: "Chinese (Traditional)", code: "zh-Hant" };

	if (/hans|simplified/.test(lower)) {
		if (/(?:^|[-_])hk(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hans-HK" };
		if (/(?:^|[-_])mo(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hans-MO" };
		if (/(?:^|[-_])my(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hans-MY" };
		if (/(?:^|[-_])sg(?:$|[-_])/.test(lower)) return { name: "Chinese", code: "zh-Hans-SG" };
	}

	return { name: "Chinese (Simplified)", code: "zh-Hans" };
}

/**
 * Resolve an MKV/user language tag to the descriptor used in the
 * TranslateGemma prompt, or `null` when its base language is unsupported.
 *
 * Examples:
 *  - "deu" / "ger" -> German (de)
 *  - "pt-BR" -> Portuguese (pt-BR)
 *  - "sr-Latn" -> Serbian (sr-Latn)
 *  - "zh-TW" -> Chinese (Traditional) (zh-TW)
 *  - honorifics pseudo-tag "en-JP" -> English (en)
 */
export function resolveTranslateLang(tag: string | undefined): TranslateLang | null {
	if (!tag) return null;

	const norm = normalizeTag(tag);
	const lower = norm.replace(/_/g, "-").toLowerCase();

	// Internal honorifics pseudo-tag: the subtitle text is still English.
	if (lower === "en-jp") return TRANSLATE_LANGS.en!;

	const rawParts = lower.split("-").filter(Boolean);
	const rawBase = rawParts[0];
	if (!rawBase) return null;

	// Chinese needs explicit script handling before generic alias resolution.
	if (rawBase === "zh" || rawBase === "zho" || rawBase === "chi") {
		return resolveChinese(lower);
	}

	const baseCode = TRANSLATE_LANGS[rawBase] ? rawBase : ISO639_ALIAS_TO_GGM[rawBase];
	if (!baseCode) return null;

	const base = TRANSLATE_LANGS[baseCode];
	if (!base) return null;

	// No variant was requested. Filipino is emitted as fil-PH because that is
	// the code exposed by Ollama's supported-language table.
	if (rawParts.length === 1) return base;

	const requestedVariant = rawParts.slice(1).join("-");
	return {
		name: base.name,
		code: canonicalizeLocale(`${baseCode}-${requestedVariant}`),
	};
}

/** True when TranslateGemma accepts this language's base code. */
export function isTranslatable(tag: string | undefined): boolean {
	return resolveTranslateLang(tag) !== null;
}
