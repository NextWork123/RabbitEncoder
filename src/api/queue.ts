import type { Web } from "@rabbit-company/web";
import { isQueuePaused, pauseQueue, resumeQueue } from "../queue/store";

export function registerQueueRoutes(app: Web): void {
	app.get("/api/queue", (c) => {
		return c.json({ paused: isQueuePaused() });
	});

	app.post("/api/queue/pause", (c) => {
		const ok = pauseQueue();
		if (!ok) return c.json({ error: "Queue is already paused", paused: true }, 400);
		return c.json({ ok: true, paused: true });
	});

	app.post("/api/queue/resume", (c) => {
		const ok = resumeQueue();
		if (!ok) return c.json({ error: "Queue is not paused", paused: false }, 400);
		return c.json({ ok: true, paused: false });
	});
}
