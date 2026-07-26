import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";

export interface GlideOutlineViewHandlers {
	onJump(item: HeadingItem): void;
}

const HOST_CLASS = "glide-outline-host";
const RAIL_WIDTH = 28;
const LABEL_GAP = 6;
const SAFE_SLACK = 20;

/**
 * Owns the Glide Outline DOM inside a MarkdownView's contentEl.
 *
 * Structure (transform responsibilities are split on purpose):
 *   root      – positioning, CSS variables, pointer-events: none
 *   hit-zone  – transparent rail strip, pointer-events: auto
 *   viewport  – vertical scrolling, pointer-events only while expanded
 *   list      – item layout
 *   item      – stable layout + click target (button)
 *     marker  – collapsed heading marker
 *     motion  – vertical displacement (--glide-shift-y)
 *     reveal  – horizontal slide-in + opacity
 *     label   – dock scale (--glide-scale)
 */
export class GlideOutlineView {
	readonly rootEl: HTMLElement;
	readonly hitZoneEl: HTMLElement;
	readonly viewportEl: HTMLElement;
	readonly listEl: HTMLElement;

	private readonly doc: Document;
	private itemEls = new Map<string, HTMLButtonElement>();
	private items: readonly HeadingItem[] = [];
	private activeKey: string | null = null;
	private disposed = false;

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly getSettings: () => GlideOutlineSettings,
		private readonly handlers: GlideOutlineViewHandlers,
	) {
		this.doc = hostEl.ownerDocument;
		hostEl.classList.add(HOST_CLASS);

		this.rootEl = this.doc.createElement("div");
		this.rootEl.className = "glide-outline-root";

		this.hitZoneEl = this.doc.createElement("div");
		this.hitZoneEl.className = "glide-outline-hit-zone";

		this.viewportEl = this.doc.createElement("div");
		this.viewportEl.className = "glide-outline-viewport";

		this.listEl = this.doc.createElement("nav");
		this.listEl.className = "glide-outline-list";
		this.listEl.setAttribute("aria-label", "Document outline");

		this.viewportEl.appendChild(this.listEl);
		this.rootEl.appendChild(this.hitZoneEl);
		this.rootEl.appendChild(this.viewportEl);
		hostEl.appendChild(this.rootEl);

		this.applySettings();
	}

	/** Keyed reconciliation — DOM nodes survive as long as heading identity does. */
	setItems(items: readonly HeadingItem[]): void {
		if (this.disposed) return;
		const settings = this.getSettings();
		const visible = items.filter((item) => settings.showLevels[item.level - 1]);
		this.items = visible;

		const nextKeys = new Set(visible.map((item) => item.key));
		for (const [key, el] of this.itemEls) {
			if (!nextKeys.has(key)) {
				el.remove();
				this.itemEls.delete(key);
			}
		}

		let previousEl: HTMLElement | null = null;
		for (const item of visible) {
			let el = this.itemEls.get(item.key);
			if (!el) {
				el = this.createItemEl(item);
				this.itemEls.set(item.key, el);
			}
			this.updateItemEl(el, item);
			// Keep DOM order aligned with model order with minimal moves.
			const expectedPrev = previousEl;
			if (
				el.parentElement !== this.listEl ||
				el.previousElementSibling !== expectedPrev
			) {
				if (expectedPrev) {
					expectedPrev.insertAdjacentElement("afterend", el);
				} else {
					this.listEl.insertAdjacentElement("afterbegin", el);
				}
			}
			previousEl = el;
		}

		if (this.activeKey && !nextKeys.has(this.activeKey)) {
			this.activeKey = null;
		}
	}

	getItems(): readonly HeadingItem[] {
		return this.items;
	}

	setActiveKey(key: string | null): void {
		if (this.disposed || key === this.activeKey) return;
		if (this.activeKey) {
			this.itemEls.get(this.activeKey)?.classList.remove("is-active");
			this.itemEls.get(this.activeKey)?.removeAttribute("aria-current");
		}
		this.activeKey = key;
		if (key) {
			const el = this.itemEls.get(key);
			el?.classList.add("is-active");
			el?.setAttribute("aria-current", "true");
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.disposed) return;
		this.rootEl.classList.toggle("is-expanded", expanded);
	}

	isExpanded(): boolean {
		return this.rootEl.classList.contains("is-expanded");
	}

	/** Re-apply CSS variables and position classes after a settings change. */
	applySettings(): void {
		const s = this.getSettings();
		const root = this.rootEl;

		root.classList.toggle("glide-outline-root--right", s.position === "right");
		root.classList.toggle("glide-outline-root--left", s.position === "left");
		root.classList.toggle("glide-outline-root--marker-dot", s.markerStyle === "dot");
		root.classList.toggle("glide-outline-root--no-anim", !s.animationEnabled);

		// Safe gutter: the widest possible magnified label must fit inside the
		// root, so the plugin never clips its own content and never needs a
		// horizontal scrollbar. Root stays pointer-transparent, so width is free.
		const gutter = Math.ceil(s.maxLabelWidth * s.maxScale) + LABEL_GAP + SAFE_SLACK;
		root.style.setProperty("--glide-root-width", `${RAIL_WIDTH + gutter}px`);
		root.style.setProperty("--glide-rail-width", `${RAIL_WIDTH}px`);
		root.style.setProperty("--glide-label-max-width", `${s.maxLabelWidth}px`);
		root.style.setProperty("--glide-font-size", `${s.baseFontSize}px`);
		root.style.setProperty("--glide-vertical-offset", `${s.verticalOffset}px`);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.itemEls.clear();
		this.rootEl.remove();
		this.hostEl.classList.remove(HOST_CLASS);
	}

	private createItemEl(item: HeadingItem): HTMLButtonElement {
		const button = this.doc.createElement("button");
		button.type = "button";
		button.className = "glide-outline-item";

		const marker = this.doc.createElement("span");
		marker.className = "glide-outline-marker";
		marker.setAttribute("aria-hidden", "true");

		const motion = this.doc.createElement("span");
		motion.className = "glide-outline-motion";

		const reveal = this.doc.createElement("span");
		reveal.className = "glide-outline-reveal";

		const label = this.doc.createElement("span");
		label.className = "glide-outline-label";

		reveal.appendChild(label);
		motion.appendChild(reveal);
		button.appendChild(marker);
		button.appendChild(motion);

		button.addEventListener("click", () => {
			const current = this.items.find((candidate) => candidate.key === item.key);
			if (current) this.handlers.onJump(current);
		});

		return button;
	}

	private updateItemEl(el: HTMLButtonElement, item: HeadingItem): void {
		el.dataset.level = String(item.level);
		el.dataset.key = item.key;
		el.setAttribute("aria-label", `H${item.level}: ${item.text}`);
		const label = el.querySelector<HTMLElement>(".glide-outline-label");
		if (label && label.textContent !== item.text) {
			label.textContent = item.text;
		}
	}
}
