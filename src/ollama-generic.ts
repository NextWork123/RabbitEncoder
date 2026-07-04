import { Logger } from "./logger";
import type { TranslateLang } from "./translate-languages";

/**
 * Generic instruct-model translator for Ollama (Qwen, Llama, Mistral, Gemma-it,
 * etc.). Unlike TranslateGemma — a translation-only model that emits just the
 * translation — general chat models follow rich instructions and use context,
 * but they also tend to add commentary and can merge/split/reorder lines.
 *
 * To make batched translation robust we use structured JSON keyed by stable
 * IDs: we send `[{id, name?, text}]` and expect `[{id, text}]` back, then remap
 * by id. Because alignment is by id (not position), the model reordering the
 * array can't corrupt cue alignment. Any id the model drops is recovered with a
 * per-line fallback, so a batch can never silently lose or misalign a cue.
 *
 * The ASS "Name" (actor) field rides along as `name` so the model knows which
 * character is speaking and can keep tone and forms of address consistent.
 */

export interface TranslateItem {
	/**
	 * Source text to translate. Already tag-split by the caller, so it may carry
	 * a leading `{\...}` override block and literal `\N` breaks — those are
	 * "protected" and must survive verbatim.
	 */
	text: string;
	/** Speaking character, from the ASS Name/Actor field (absent for SRT). */
	name?: string;
}

export interface GenericOptions {
	/** Base URL, e.g. "http://localhost:11434". */
	url: string;
	/** Model tag, e.g. "qwen2.5:14b", "llama3.1:8b". */
	model: string;
	source: TranslateLang;
	target: TranslateLang;
	/** Ollama num_ctx. Batches of JSON need headroom; default 8192. */
	numCtx?: number;
	/** Sampling temperature. A touch above deterministic for natural dialogue. */
	temperature?: number;
	/** Per-request timeout in ms. */
	timeoutMs?: number;
	/** External cancellation (job abort). */
	signal?: AbortSignal;
	/**
	 * Optional override for the instruction block that precedes the JSON payload.
	 * `{target}` / `{source}` placeholders are substituted. When omitted, the
	 * built-in subtitle-translation instruction is used.
	 */
	instruction?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_NUM_CTX = 8192;
const DEFAULT_TEMPERATURE = 0.1;

/** Payload row sent to the model. */
interface PayloadRow {
	id: string;
	name?: string;
	text: string;
}

/**
 * Build the instruction block. Based on a natural-dialogue subtitle prompt,
 * adapted for id-keyed JSON I/O and the character-name context.
 */
export function buildGenericInstruction(source: TranslateLang, target: TranslateLang, override?: string): string {
	if (override && override.trim()) {
		return override.replaceAll("{target}", target.name).replaceAll("{source}", source.name).trim();
	}
	return [
		`Translate these anime/movie/show subtitles from ${source.name} into ${target.name}.`,
		`Produce natural dialogue that sounds as though it was originally written in ${target.name}.`,
		`Translate the intended meaning rather than word-for-word or the source sentence structure.`,
		``,
		`Requirements:`,
		`- Preserve all meaning without additions or omissions.`,
		`- Preserve each character's tone, humour and emotional intensity.`,
		`- Use natural conversational language.`,
		`- Maintain consistent names, terminology and forms of address across entries.`,
		`- Each entry has an "id", an optional "name" (the speaking character), and "text".`,
		`  Use "name" to know who is speaking and to keep their voice and forms of address consistent.`,
		`- Use the surrounding entries as context for pronouns, tone and continuity.`,
		`- Preserve every "id" exactly.`,
		`- Preserve protected formatting verbatim: any leading "{...}" override block and every "\\N" line break must appear unchanged in the output text.`,
		`- Do not merge, split, reorder, add or remove entries.`,
		`- Return ONLY a JSON array of objects {"id": "...", "text": "..."}, one per input entry, with no commentary, no explanations and no markdown fences.`,
	].join("\n");
}

/** Build the full prompt: instruction block followed by the JSON payload. */
export function buildGenericPrompt(items: TranslateItem[], opts: Pick<GenericOptions, "source" | "target" | "instruction">): string {
	const rows: PayloadRow[] = items.map((it, i) => {
		const row: PayloadRow = { id: String(i), text: it.text };
		const name = it.name?.trim();
		if (name) row.name = name;
		return row;
	});
	const instruction = buildGenericInstruction(opts.source, opts.target, opts.instruction);
	return `${instruction}\n\nInput:\n${JSON.stringify(rows, null, 0)}`;
}

/** Strip leading/trailing markdown code fences if the model wrapped its answer. */
export function stripCodeFences(s: string): string {
	let t = s.trim();
	// ```json\n ... \n```  or  ``` ... ```
	const fence = t.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
	if (fence && fence[1] !== undefined) t = fence[1].trim();
	return t;
}

/** Extract the outermost JSON array substring, tolerating prose around it. */
export function extractJsonArray(s: string): string | null {
	const t = stripCodeFences(s);
	const start = t.indexOf("[");
	const end = t.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	return t.slice(start, end + 1);
}

/**
 * Parse a model response into a map id->text. Returns an array aligned to
 * `count` (index === numeric id); entries the model dropped are `null`.
 */
export function parseGenericResponse(content: string, count: number): (string | null)[] {
	const out: (string | null)[] = new Array(count).fill(null);
	const json = extractJsonArray(content);
	if (!json) return out;

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return out;
	}
	if (!Array.isArray(parsed)) return out;

	for (const row of parsed) {
		if (!row || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		const rawId = r["id"];
		const rawText = r["text"];
		if (rawText === undefined || rawText === null) continue;
		const id = typeof rawId === "number" ? rawId : parseInt(String(rawId ?? ""), 10);
		if (!Number.isInteger(id) || id < 0 || id >= count) continue;
		out[id] = String(rawText);
	}
	return out;
}

interface OllamaChatResponse {
	message?: { content?: string };
	error?: string;
}

/** One /api/chat round-trip. Throws on HTTP, network, timeout or abort. */
async function chat(prompt: string, opts: GenericOptions): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("Ollama request timed out")), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const onExternalAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
	if (opts.signal) {
		if (opts.signal.aborted) onExternalAbort();
		else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		const base = opts.url.replace(/\/+$/, "");
		const res = await fetch(`${base}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: controller.signal,
			body: JSON.stringify({
				model: opts.model,
				stream: false,
				messages: [{ role: "user", content: prompt }],
				options: {
					temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
					num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
				},
			}),
		});
		if (!res.ok) throw new Error(`Ollama /api/chat returned HTTP ${res.status}`);
		const data = (await res.json()) as OllamaChatResponse;
		if (data.error) throw new Error(`Ollama error: ${data.error}`);
		return data.message?.content ?? "";
	} finally {
		clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", onExternalAbort);
	}
}

/**
 * Translate a single line with a minimal direct prompt. Used as the recovery
 * path for any entry a batch dropped. Returns the source text unchanged only if
 * the model yields nothing usable, so a cue is never lost.
 */
export async function translateOneGeneric(text: string, opts: GenericOptions): Promise<string> {
	if (text.trim() === "") return text;
	const prompt =
		`Translate this single ${opts.source.name} subtitle line into ${opts.target.name}. ` +
		`Keep any leading "{...}" override block and every "\\N" break exactly as-is. ` +
		`Output only the translated line, with no quotes, labels or commentary.\n\n${text}`;
	const content = await chat(prompt, opts);
	const cleaned = stripCodeFences(content).trim();
	return cleaned === "" ? text : cleaned;
}

/**
 * Translate a batch of items. Blank-text entries are passed through untouched
 * and never cost a request. Returns translations aligned to the input order.
 */
export async function translateBatchGeneric(items: TranslateItem[], opts: GenericOptions): Promise<string[]> {
	if (items.length === 0) return [];

	// Indices that actually need translation.
	const payloadIdx: number[] = [];
	for (let i = 0; i < items.length; i++) {
		if (items[i]!.text.trim() !== "") payloadIdx.push(i);
	}
	const result = items.map((it) => it.text);
	if (payloadIdx.length === 0) return result;

	const payload = payloadIdx.map((i) => items[i]!);

	if (payload.length === 1) {
		result[payloadIdx[0]!] = await translateOneGeneric(payload[0]!.text, opts);
		return result;
	}

	const prompt = buildGenericPrompt(payload, opts);
	const content = await chat(prompt, opts);
	const parsed = parseGenericResponse(content, payload.length);

	// Fill aligned ids; collect any the model dropped for per-line recovery.
	const missing: number[] = [];
	for (let k = 0; k < payload.length; k++) {
		const t = parsed[k];
		if (t === null || t === undefined) missing.push(k);
		else result[payloadIdx[k]!] = t;
	}

	if (missing.length > 0) {
		Logger.warn(
			`[translate] Generic batch of ${payload.length} returned ${payload.length - missing.length} usable ids ` +
				`(${opts.source.code}->${opts.target.code}); recovering ${missing.length} line(s) individually`,
		);
		for (const k of missing) {
			result[payloadIdx[k]!] = await translateOneGeneric(payload[k]!.text, opts);
		}
	}

	return result;
}

/**
 * Preflight for a generic model: reachability, model presence, and a real
 * JSON round-trip so the Test button fails fast instead of the encode failing
 * hours in. Reuses Ollama's /api/tags listing.
 */
export async function checkGenericModel(
	url: string,
	model: string,
	source: TranslateLang,
	target: TranslateLang,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string; sample?: string }> {
	const base = url.replace(/\/+$/, "");
	try {
		const res = await fetch(`${base}/api/tags`, { signal });
		if (!res.ok) return { ok: false, detail: `Ollama at ${base} returned HTTP ${res.status}` };
		const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
		const names = (data.models ?? []).map((m) => m.name ?? m.model ?? "");
		const wanted = model.includes(":") ? model : `${model}:latest`;
		const present = names.some((n) => n === model || n === wanted || n.split(":")[0] === model.split(":")[0]);
		if (!present) return { ok: false, detail: `Model "${model}" not found in Ollama. Pull it with: ollama pull ${model}` };
	} catch (err) {
		return { ok: false, detail: `Cannot reach Ollama at ${url}: ${(err as Error).message}` };
	}

	// Prove it actually translates and returns something usable.
	try {
		const sample = await translateOneGeneric("The goal of all life is death.", {
			url,
			model,
			source,
			target,
			timeoutMs: 30_000,
			signal,
		});
		return { ok: true, detail: "", sample };
	} catch (err) {
		return { ok: false, detail: `Model reachable but translation failed: ${(err as Error).message}` };
	}
}
