/** Where translation requests are sent. */
export type TranslateProvider = "ollama" | "deepseek";

/**
 * Derive the prompt/parse strategy from provider + model name.
 * TranslateGemma is a translation-only model with its own prompt format;
 * everything else (including all cloud models) uses the generic
 * id-keyed JSON strategy.
 */
export function resolveTranslateStrategy(provider: TranslateProvider, model: string): "translategemma" | "generic" {
	if (provider !== "ollama") return "generic";
	return model.trim().toLowerCase().includes("translategemma") ? "translategemma" : "generic";
}
