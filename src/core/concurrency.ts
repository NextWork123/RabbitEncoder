export interface Semaphore {
	/** Run `task` once a slot is free; never more than `limit` run at once. */
	run<T>(task: () => Promise<T>): Promise<T>;
}

/** A minimal counting semaphore (single-process, single-threaded). */
export function createSemaphore(limit: number): Semaphore {
	const max = Math.max(1, Math.floor(limit));
	let active = 0;
	const waiters: Array<() => void> = [];

	const pump = () => {
		if (active >= max) return;
		const wake = waiters.shift();
		if (wake) {
			active++;
			wake();
		}
	};

	return {
		run<T>(task: () => Promise<T>): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				waiters.push(() => {
					task()
						.then(resolve, reject)
						.finally(() => {
							active--;
							pump();
						});
				});
				pump();
			});
		},
	};
}

/** map with bounded concurrency; preserves input order in the result. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const sem = createSemaphore(limit);
	return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))));
}
