import { Logger } from "../core/logger";

const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_TEMPERATURE = 0.1;
/** Batched JSON answers can be large; give the model output headroom. */
const DEFAULT_MAX_TOKENS = 8192;
/** Retries on transient failures (429 / 5xx / network). */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];

export interface DeepseekOptions {
	apiKey: string;
	/** e.g. "deepseek-v4-flash" */
	model: string;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string } }>;
	error?: { message?: string; type?: string };
}

function friendlyHttpError(status: number, bodyMsg?: string): string {
	if (status === 401) return "DeepSeek rejected the API key (HTTP 401). Check the key in settings.";
	if (status === 402) return "DeepSeek account has insufficient balance (HTTP 402).";
	if (status === 429) return "DeepSeek rate limit hit (HTTP 429).";
	return `DeepSeek API returned HTTP ${status}${bodyMsg ? `: ${bodyMsg}` : ""}`;
}

function isRetryable(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 504);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** One chat-completions round trip with timeout, abort, and transient-error retry. */
export async function deepseekChat(prompt: string, opts: DeepseekOptions): Promise<string> {
	let lastError: Error = new Error("DeepSeek request failed");

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error("DeepSeek request timed out")), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		const onExternalAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
		if (opts.signal) {
			if (opts.signal.aborted) controller.abort(opts.signal.reason);
			else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
		}

		try {
			const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${opts.apiKey}`,
				},
				signal: controller.signal,
				body: JSON.stringify({
					model: opts.model,
					stream: false,
					messages: [{ role: "user", content: prompt }],
					temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
					max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
				}),
			});

			if (!res.ok) {
				const bodyMsg = await res
					.json()
					.then((j: ChatCompletionResponse) => j?.error?.message)
					.catch(() => undefined);
				const err = new Error(friendlyHttpError(res.status, bodyMsg));
				if (isRetryable(res.status) && attempt < MAX_ATTEMPTS - 1) {
					lastError = err;
					Logger.warn(`[translate] ${err.message} — retrying (${attempt + 1}/${MAX_ATTEMPTS - 1})`);
					await sleep(RETRY_DELAYS_MS[attempt] ?? 3_000, opts.signal);
					continue;
				}
				throw err;
			}

			const data = (await res.json()) as ChatCompletionResponse;
			if (data.error) throw new Error(`DeepSeek error: ${data.error.message ?? data.error.type ?? "unknown"}`);
			return data.choices?.[0]?.message?.content ?? "";
		} catch (err) {
			// Abort (job cancel / timeout) is never retried.
			if (opts.signal?.aborted || controller.signal.aborted) throw err;
			lastError = err as Error;
			if (attempt < MAX_ATTEMPTS - 1) {
				Logger.warn(`[translate] DeepSeek request failed (${lastError.message}) — retrying`);
				await sleep(RETRY_DELAYS_MS[attempt] ?? 3_000, opts.signal);
				continue;
			}
			throw lastError;
		} finally {
			clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onExternalAbort);
		}
	}
	throw lastError;
}

/** Probe DeepSeek: key validity and model availability, via GET /models. */
export async function checkDeepseek(apiKey: string, model: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
	if (!apiKey.trim()) return { ok: false, detail: "no DeepSeek API key is configured" };
	try {
		const res = await fetch(`${DEEPSEEK_BASE}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (res.status === 401) return { ok: false, detail: "DeepSeek rejected the API key (HTTP 401)" };
		if (!res.ok) return { ok: false, detail: `DeepSeek /models returned HTTP ${res.status}` };
		const data = (await res.json()) as { data?: Array<{ id?: string }> };
		const ids = (data.data ?? []).map((m) => m.id ?? "");
		if (ids.length > 0 && !ids.includes(model)) {
			return { ok: false, detail: `Model "${model}" not available on this DeepSeek account (available: ${ids.join(", ")})` };
		}
		return { ok: true, detail: "" };
	} catch (err) {
		return { ok: false, detail: `Cannot reach DeepSeek API: ${(err as Error).message}` };
	}
}
