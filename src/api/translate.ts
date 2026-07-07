import type { Web } from "@rabbit-company/web";
import { checkOllama, translateOne } from "../translate/ollama";
import { resolveTranslateLang } from "../translate/translate-languages";
import { checkGenericChat, checkGenericModel } from "../translate/generic";
import { resolveTranslateStrategy, type TranslateProvider } from "../translate/translate-provider";
import { checkDeepseek } from "../translate/deepseek";

export function registerTranslateRoutes(app: Web): void {
	app.post("/api/translate/test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			provider?: string;
			url?: string;
			model?: string;
			apiKey?: string;
			target?: string;
		};
		const provider: TranslateProvider = body.provider === "deepseek" ? "deepseek" : "ollama";
		const model = (body.model || "").trim();
		const source = { name: "English", code: "en" };
		const target = resolveTranslateLang(body.target || "slv") ?? { name: "Slovenian", code: "sl" };

		if (provider === "deepseek") {
			const apiKey = (body.apiKey || "").trim();
			if (!apiKey || !model) return c.json({ ok: false, error: "Missing DeepSeek API key or model" }, 400);

			const health = await checkDeepseek(apiKey, model);
			if (!health.ok) return c.json({ ok: false, error: health.detail });

			const r = await checkGenericChat({ provider: "deepseek", url: "", apiKey, model, source, target });
			return c.json(r.ok ? { ok: true, sample: r.sample, model, target: target.name } : { ok: false, error: r.detail });
		}

		const url = (body.url || "").trim();
		if (!url || !model) return c.json({ ok: false, error: "Missing Ollama URL or model" }, 400);

		const health = await checkOllama(url, model);
		if (!health.ok) return c.json({ ok: false, error: health.detail });

		const strategy = resolveTranslateStrategy(provider, model);

		if (strategy === "generic") {
			const r = await checkGenericModel(url, model, source, target);
			return c.json(r.ok ? { ok: true, sample: r.sample, model, target: target.name } : { ok: false, error: r.detail });
		}

		try {
			const sample = await translateOne("The goal of all life is death.", {
				url,
				model,
				source,
				target,
				timeoutMs: 30000,
			});
			return c.json({ ok: true, sample, model, target: target.name });
		} catch (err: any) {
			return c.json({ ok: false, error: `Model reachable but translation failed: ${err?.message || err}` });
		}
	});
}
