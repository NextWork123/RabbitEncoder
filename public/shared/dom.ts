export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
	return document.getElementById(id)! as T;
}

export function inputById(id: string): HTMLInputElement {
	return byId<HTMLInputElement>(id);
}

export function buttonById(id: string): HTMLButtonElement {
	return byId<HTMLButtonElement>(id);
}

export function asElementTarget(target: EventTarget | null): Element | null {
	return target instanceof Element ? target : null;
}

export function isDefined<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}
