import { Logger } from "../core/logger";
import { chatComplete, type LlmChatOptions } from "./llm-client";
import type { TranslateLang } from "./translate-languages";

/**
 * TranslateGemma prompt strategy (replaces the old Ollama-specific client).
 *
 * TranslateGemma is a translation-only, single-direction model: one
 * source->target pair per call, and it emits only the translation with no
 * commentary. That makes multi-line batches fragile (the model can
 * merge/drop/reorder lines), so `translateBatch` verifies the returned line
 * count and bisects any block that doesn't align exactly. Correctness over
 * speed.
 *
 * Transport-agnostic: runs over any OpenAI-compatible endpoint (e.g. Ollama's
 * "http://localhost:11434/v1") or the Anthropic Messages API.
 */

export interface TranslateGemmaOptions extends LlmChatOptions {
	source: TranslateLang;
	target: TranslateLang;
}

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

async function chat(prompt: string, opts: TranslateGemmaOptions): Promise<string> {
	return (await chatComplete(prompt, opts)).trim();
}

/** One block attempt: returns aligned translations, or null on line-count mismatch. */
async function attemptBlock(payload: string[], opts: TranslateGemmaOptions): Promise<string[] | null> {
	const block = payload.join("\n");
	const content = await chat(buildTranslatePrompt(opts.source, opts.target, block), opts);
	const outLines = splitResponseLines(content);
	return outLines.length === payload.length ? outLines : null;
}

/** Translate a single line/string. */
export async function translateOne(text: string, opts: TranslateGemmaOptions): Promise<string> {
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
 * Translate non-blank lines, bisecting on misalignment. TranslateGemma
 * occasionally merges/splits lines within a block; rather than redoing the
 * whole chunk line-by-line (n requests, ~full prompt each), split the block
 * in half and recurse — clean halves are kept, and the offending line is
 * isolated in log(n) retries.
 */
async function translateBlockResilient(payload: string[], opts: TranslateGemmaOptions): Promise<string[]> {
	if (payload.length === 0) return [];
	if (payload.length === 1) return [await translateOne(payload[0]!, opts)];

	const aligned = await attemptBlock(payload, opts);
	if (aligned) return aligned;

	Logger.warn(`[translate] Block of ${payload.length} lines misaligned (${opts.source.code}->${opts.target.code}); bisecting`);
	const mid = Math.ceil(payload.length / 2);
	const left = await translateBlockResilient(payload.slice(0, mid), opts);
	const right = await translateBlockResilient(payload.slice(mid), opts);
	return [...left, ...right];
}

/**
 * Translate a batch of lines in one request, returning exactly `lines.length`
 * results. If the response doesn't line up 1:1, the block is bisected until
 * aligned halves are found, so cue alignment is never lost.
 *
 * Empty input lines are passed through untouched and don't cost a request.
 */
export async function translateBatch(lines: string[], opts: TranslateGemmaOptions): Promise<string[]> {
	if (lines.length === 0) return [];

	// Indices that actually need translation.
	const payloadIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() !== "") payloadIdx.push(i);
	}
	if (payloadIdx.length === 0) return [...lines];

	const payload = payloadIdx.map((i) => lines[i]!);
	const result = [...lines];

	const translated = await translateBlockResilient(payload, opts);
	payloadIdx.forEach((origIdx, k) => (result[origIdx] = translated[k]!));
	return result;
}
