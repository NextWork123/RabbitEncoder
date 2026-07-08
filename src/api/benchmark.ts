import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { cancelBenchmark, getBenchmarkState, startBenchmark } from "../video/benchmark";

export function registerBenchmarkRoutes(app: Web, config: AppConfig): void {
	app.get("/api/benchmark", async (c) => {
		return c.json(await getBenchmarkState(config.defaults.gpuDevice, config.defaults.denoiseBackend));
	});

	app.post("/api/benchmark", async (c) => {
		const result = await startBenchmark({
			gpuDevice: config.defaults.gpuDevice,
			denoiseBackend: config.defaults.denoiseBackend,
		});
		if (!result.ok) return c.json({ error: result.error || "Failed to start benchmark" }, 409);
		return c.json(await getBenchmarkState(config.defaults.gpuDevice, config.defaults.denoiseBackend));
	});

	app.delete("/api/benchmark", (c) => {
		const ok = cancelBenchmark();
		if (!ok) return c.json({ error: "No benchmark currently running" }, 400);
		return c.json({ ok: true });
	});
}
