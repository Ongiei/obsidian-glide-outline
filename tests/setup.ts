/**
 * Obsidian adds these helpers to HTMLElement at runtime. jsdom does not, so
 * provide the smallest faithful test shim used by the mount lifecycle.
 */
if (typeof window !== "undefined") {
	Object.defineProperty(Document.prototype, "win", { configurable: true, get(this: Document) { return this.defaultView; } });
	Object.defineProperty(window, "createEl", { configurable: true, value: (tag: string) => document.createElement(tag) });
	Object.defineProperty(window, "createDiv", { configurable: true, value: () => document.createElement("div") });
	Object.defineProperty(window, "createSpan", { configurable: true, value: () => document.createElement("span") });
}
if (
	typeof HTMLElement !== "undefined" &&
	typeof HTMLElement.prototype.setCssProps !== "function"
) {
	Object.defineProperty(HTMLElement.prototype, "setCssProps", {
		configurable: true,
		value(this: HTMLElement, props: Record<string, string>): void {
			for (const [name, value] of Object.entries(props)) {
				this.style.setProperty(name, value);
			}
		},
		writable: true,
	});
}
