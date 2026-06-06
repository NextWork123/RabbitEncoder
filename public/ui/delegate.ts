export type DelegatedHandler<T extends Element = Element> = (event: MouseEvent, target: T) => void | Promise<void>;

export function delegateClick<T extends Element>(root: Element | Document, selector: string, handler: DelegatedHandler<T>): void {
	root.addEventListener("click", (event) => {
		const rawTarget = event.target;
		if (!(rawTarget instanceof Element)) return;

		const target = rawTarget.closest<T>(selector);
		if (!target) return;

		if (root instanceof Element && !root.contains(target)) return;
		void handler(event as MouseEvent, target);
	});
}
