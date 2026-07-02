import { Logger } from "./logger";
import type { TranslateLang } from "./translate-languages";

/**
 * Thin Ollama client specialised for TranslateGemma. TranslateGemma is a
 * translation-only, single-direction model: one source->target pair per call,
 * and it emits only the translation with no commentary. That makes multi-line
 * batches fragile (the model can merge/drop/reorder lines), so `translateBatch`
 * verifies the returned line count and falls back to per-line translation for
 * any batch that doesn't align exactly. Correctness over speed.
 */

export interface OllamaOptions {
	/** Base URL "http://localhost:11434". */
	url: string;
	/** Model tag "translategemma:12b". */
	model: string;
	source: TranslateLang;
	target: TranslateLang;
	/** Ollama num_ctx. TranslateGemma supports up to 128K. */
	numCtx?: number;
	/** Sampling temperature (low is best for deterministic translation) */
	temperature?: number;
	/** Per-request timeout in ms. */
	timeoutMs?: number;
	/** External cancellation (job abort). */
	signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_NUM_CTX = 8192;
const DEFAULT_TEMPERATURE = 0.1;

/** Build the TranslateGemma prompt for a block of one or more lines. */
export function buildTranslatePrompt(source: TranslateLang, target: TranslateLang, block: string): string {
	return (
		`You are a professional ${source.name} (${source.code}) to ${target.name} (${target.code}) translator. ` +
		`Your goal is to accurately convey the meaning and nuances of the original ${source.name} text ` +
		`while adhering to ${target.name} grammar, vocabulary, and cultural sensitivities.\n` +
		`Produce only the ${target.name} translation, without any additional explanations or commentary. ` +
		`Please translate the following ${source.name} text into ${target.name}:\n\n\n${block}`
	);
}

interface OllamaChatResponse {
	message?: { content?: string };
	error?: string;
}

/** One /api/chat round-trip. Throws on HTTP or network error. */
async function chat(prompt: string, opts: OllamaOptions): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("Ollama request timed out")), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	const onExternalAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort(opts.signal.reason);
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
					num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
					temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
				},
			}),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
		}

		const data = (await res.json()) as OllamaChatResponse;
		if (data.error) throw new Error(`Ollama error: ${data.error}`);
		return (data.message?.content ?? "").trim();
	} finally {
		clearTimeout(timeout);
		if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
	}
}

/** Translate a single line/string. */
export async function translateOne(text: string, opts: OllamaOptions): Promise<string> {
	if (text.trim() === "") return text;
	const prompt = buildTranslatePrompt(opts.source, opts.target, text);
	return chat(prompt, opts);
}

/** Split a model response into lines, tolerating a single trailing blank. */
function splitResponseLines(content: string): string[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

/**
 * Translate a batch of lines in one request, returning exactly `lines.length`
 * results. If the response doesn't line up 1:1, fall back to translating each
 * line on its own so cue alignment is never lost.
 *
 * Empty input lines are passed through untouched and don't cost a request.
 */
export async function translateBatch(lines: string[], opts: OllamaOptions): Promise<string[]> {
	if (lines.length === 0) return [];

	// Indices that actually need translation.
	const payloadIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() !== "") payloadIdx.push(i);
	}
	if (payloadIdx.length === 0) return [...lines];

	const payload = payloadIdx.map((i) => lines[i]!);
	const result = [...lines];

	if (payload.length === 1) {
		result[payloadIdx[0]!] = await translateOne(payload[0]!, opts);
		return result;
	}

	const block = payload.join("\n");
	const prompt = buildTranslatePrompt(opts.source, opts.target, block);
	const content = await chat(prompt, opts);
	const outLines = splitResponseLines(content);

	if (outLines.length === payload.length) {
		payloadIdx.forEach((origIdx, k) => (result[origIdx] = outLines[k]!));
		return result;
	}

	// Misaligned - the model merged/split lines. Redo this batch line-by-line.
	Logger.warn(
		`[translate] Batch of ${payload.length} lines returned ${outLines.length} lines (${opts.source.code}->${opts.target.code}); ` +
			`falling back to per-line translation for this chunk`,
	);
	for (let k = 0; k < payload.length; k++) {
		result[payloadIdx[k]!] = await translateOne(payload[k]!, opts);
	}
	return result;
}

/** Probe Ollama for reachability and whether the model is available. */
export async function checkOllama(url: string, model: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
	try {
		const base = url.replace(/\/+$/, "");
		const res = await fetch(`${base}/api/tags`, { signal });
		if (!res.ok) return { ok: false, detail: `Ollama at ${base} returned HTTP ${res.status}` };
		const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
		const names = (data.models ?? []).map((m) => m.name ?? m.model ?? "");
		// Match with or without an explicit tag (":latest").
		const wanted = model.includes(":") ? model : `${model}:latest`;
		const present = names.some((n) => n === model || n === wanted || n.split(":")[0] === model.split(":")[0]);
		if (!present) {
			return { ok: false, detail: `Model "${model}" not found in Ollama. Pull it with: ollama pull ${model}` };
		}
		return { ok: true, detail: "" };
	} catch (err) {
		return { ok: false, detail: `Cannot reach Ollama at ${url}: ${(err as Error).message}` };
	}
}
