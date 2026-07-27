import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";
import { computeResponsiveWidth } from "../utils/layout";

export interface GlideOutlineViewHandlers {
	onJump(item: HeadingItem): void;
	/**
	 * Optional rich-label renderer (Markdown). Called with an empty label
	 * element; when absent, plain text is used.
	 */
	renderLabel?(labelEl: HTMLElement, item: HeadingItem): void;
}

const HOST_CLASS = "glide-outline-host";
export const RAIL_WIDTH = 28;
export const LABEL_GAP = 6;
export const SAFE_SLACK = 20;
export const COMPACT_THRESHOLD = 60;

interface ItemRecord {
	rowEl: HTMLElement;
	buttonEl: HTMLButtonElement;
	labelEl: HTMLElement;
	/** What the label currently displays (text or rendered source). */
	renderedContent: string;
	renderedRich: boolean;
}

/**
 * Owns the Glide Outline DOM inside a MarkdownView's contentEl.
 *
 * Structure (transform responsibilities are split on purpose):
 *   root      – positioning, CSS variables      → pointer-events: none
 *   hit-zone  – transparent rail strip           → pointer-events: auto
 *   viewport  – vertical scrolling               → pointer-events: none
 *   list      – item layout                      → pointer-events: none
 *   row       – one heading row                  → pointer-events: none
 *   item      – button, a11y target              → pointer-events: none
 *     marker  – collapsed heading marker         → pointer-events: auto
 *     motion  – vertical displacement (--glide-shift-y)
 *     reveal  – horizontal slide-in + opacity
 *     card    – visual chrome + dock scale       → pointer-events: auto (expanded)
 *       label – text / rendered markdown
 *
 * The editor underneath stays fully interactive everywhere except the thin
 * marker rail and the actually visible label cards.
 */
export class GlideOutlineView {
	readonly rootEl: HTMLElement;
	readonly hitZoneEl: HTMLElement;
	readonly viewportEl: HTMLElement;
	readonly listEl: HTMLElement;

	private readonly doc: Document;
	private readonly resizeObserver: ResizeObserver | null = null;
	private itemRecords = new Map<string, ItemRecord>();
	private items: readonly HeadingItem[] = [];
	private activeKey: string | null = null;
	private followEnabled = true;
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

		// Narrow-pane adaptation: recompute widths whenever the host resizes.
		const win = this.doc.defaultView;
		if (win) {
			this.resizeObserver = new win.ResizeObserver(() => {
				this.applyResponsiveWidth();
			});
			this.resizeObserver.observe(hostEl);
		}

		this.applySettings();
	}

	/** Keyed reconciliation — DOM nodes survive as long as heading identity does. */
	setItems(items: readonly HeadingItem[]): void {
		if (this.disposed) return;
		const settings = this.getSettings();
		const visible = items.filter((item) => settings.showLevels[item.level - 1]);
		this.items = visible;

		const nextKeys = new Set(visible.map((item) => item.key));
		for (const [key, record] of this.itemRecords) {
			if (!nextKeys.has(key)) {
				record.rowEl.remove();
				this.itemRecords.delete(key);
			}
		}

		let previousEl: HTMLElement | null = null;
		for (const item of visible) {
			let record = this.itemRecords.get(item.key);
			if (!record) {
				record = this.createItemRecord(item);
				this.itemRecords.set(item.key, record);
			}
			this.updateItemRecord(record, item);
			// Keep DOM order aligned with model order with minimal moves.
			const el = record.rowEl;
			if (
				el.parentElement !== this.listEl ||
				el.previousElementSibling !== previousEl
			) {
				if (previousEl) {
					previousEl.insertAdjacentElement("afterend", el);
				} else {
					this.listEl.insertAdjacentElement("afterbegin", el);
				}
			}
			previousEl = el;
		}

		if (this.activeKey && !nextKeys.has(this.activeKey)) {
			this.activeKey = null;
		}

		// Empty state: hide the rail entirely when nothing is visible.
		this.rootEl.classList.toggle("is-empty", visible.length === 0);
	}

	getItems(): readonly HeadingItem[] {
		return this.items;
	}

	setActiveKey(key: string | null): void {
		if (this.disposed || key === this.activeKey) return;
		if (this.activeKey) {
			const prev = this.itemRecords.get(this.activeKey);
			prev?.buttonEl.classList.remove("is-active");
			prev?.buttonEl.removeAttribute("aria-current");
		}
		this.activeKey = key;
		if (key) {
			const record = this.itemRecords.get(key);
			if (record) {
				record.buttonEl.classList.add("is-active");
				record.buttonEl.setAttribute("aria-current", "true");
				// Keep the active heading visible inside the outline's own
				// scroll viewport — but never fight the user's pointer.
				if (this.followEnabled) {
					this.scrollRowIntoView(record.rowEl);
				}
			}
		}
	}

	/**
	 * While the pointer is inside the outline (or the user scrolls it),
	 * automatic follow of the active heading is paused.
	 */
	setFollowEnabled(enabled: boolean): void {
		this.followEnabled = enabled;
		if (enabled && this.activeKey) {
			const record = this.itemRecords.get(this.activeKey);
			if (record) this.scrollRowIntoView(record.rowEl);
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

		root.style.setProperty("--glide-rail-width", `${RAIL_WIDTH}px`);
		root.style.setProperty("--glide-font-size", `${s.baseFontSize}px`);
		root.style.setProperty("--glide-vertical-offset", `${s.verticalOffset}px`);

		// Label card appearance.
		const card = s.card;
		root.style.setProperty("--glide-card-opacity", `${card.opacity}%`);
		root.style.setProperty("--glide-card-radius", `${card.radius}px`);
		root.style.setProperty("--glide-card-padding-x", `${card.paddingX}px`);
		root.style.setProperty("--glide-card-padding-y", `${card.paddingY}px`);
		root.classList.toggle("glide-outline-root--card-border", card.border);
		root.classList.toggle("glide-outline-root--card-shadow", card.shadow);
		root.classList.toggle("glide-outline-root--text-shadow", card.textShadow);
		root.classList.toggle(
			"glide-outline-root--pure-text",
			card.opacity === 0 && !card.border && !card.shadow,
		);

		this.applyResponsiveWidth();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.resizeObserver?.disconnect();
		this.itemRecords.clear();
		this.rootEl.remove();
		this.hostEl.classList.remove(HOST_CLASS);
	}

	/**
	 * Narrow-pane adaptation (P0-2): the root and label widths follow the
	 * host width so magnified labels never clip and never overflow the pane.
	 */
	private applyResponsiveWidth(): void {
		if (this.disposed) return;
		const s = this.getSettings();
		const { rootWidth, labelWidth, compact } = computeResponsiveWidth({
			hostWidth: this.hostEl.clientWidth || 0,
			maxLabelWidth: s.maxLabelWidth,
			maxScale: s.maxScale,
			railWidth: RAIL_WIDTH,
			labelGap: LABEL_GAP,
			safeSlack: SAFE_SLACK,
			compactThreshold: COMPACT_THRESHOLD,
		});
		this.rootEl.style.setProperty("--glide-root-width", `${rootWidth}px`);
		this.rootEl.style.setProperty("--glide-label-max-width", `${labelWidth}px`);
		this.rootEl.classList.toggle("glide-outline-root--compact", compact);
	}

	private scrollRowIntoView(rowEl: HTMLElement): void {
		// block: "nearest" keeps outline-internal scrolling minimal and never
		// scrolls ancestor containers unexpectedly.
		rowEl.scrollIntoView({ block: "nearest" });
	}

	private createItemRecord(item: HeadingItem): ItemRecord {
		const row = this.doc.createElement("div");
		row.className = "glide-outline-row";

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

		const card = this.doc.createElement("span");
		card.className = "glide-outline-card";

		const label = this.doc.createElement("span");
		label.className = "glide-outline-label";

		card.appendChild(label);
		reveal.appendChild(card);
		motion.appendChild(reveal);
		button.appendChild(marker);
		button.appendChild(motion);
		row.appendChild(button);

		button.addEventListener("click", (event) => {
			// Links rendered inside labels handle their own navigation.
			// Duck-typed instead of instanceof — safe in pop-out windows.
			const target = event.target as Partial<Element> | null;
			if (target?.closest?.("a")) return;
			const current = this.items.find((candidate) => candidate.key === item.key);
			if (current) this.handlers.onJump(current);
		});

		return {
			rowEl: row,
			buttonEl: button,
			labelEl: label,
			renderedContent: "",
			renderedRich: false,
		};
	}

	private updateItemRecord(record: ItemRecord, item: HeadingItem): void {
		const { buttonEl, labelEl } = record;
		buttonEl.dataset.level = String(item.level);
		buttonEl.dataset.key = item.key;
		record.rowEl.dataset.level = String(item.level);
		buttonEl.setAttribute("aria-label", `H${item.level}: ${item.text}`);

		const settings = this.getSettings();
		const rich = settings.renderMarkdown && !!this.handlers.renderLabel;
		const content = rich ? item.displaySource : item.text;
		if (record.renderedContent === content && record.renderedRich === rich) {
			return;
		}
		record.renderedContent = content;
		record.renderedRich = rich;
		if (rich && this.handlers.renderLabel) {
			labelEl.textContent = "";
			this.handlers.renderLabel(labelEl, item);
		} else {
			labelEl.textContent = item.text;
		}
	}
}
