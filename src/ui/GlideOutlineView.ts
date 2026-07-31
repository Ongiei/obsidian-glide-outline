import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";
import {
	computeResponsiveWidth,
	computeVerticalSafeSpace,
} from "../utils/layout";
import { computeOverflowState } from "../utils/overflow";
import type { OverflowState } from "../utils/overflow";
import { bridgeRectFor } from "../utils/envelope";
import type { PointerEnvelope, Rect } from "../utils/envelope";
import type { PerfCapture } from "../core/PerfCapture";
import { createOutlineMount } from "./mount";
import type { MountHostMutationDiagnostics, OutlineMount } from "./mount";

/** Copy the four edges out of a DOMRect-like object into our Rect shape. */
function rectFrom(r: { left: number; top: number; right: number; bottom: number }): Rect {
	return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function zeroRect(): Rect {
	return { left: 0, top: 0, right: 0, bottom: 0 };
}

/** Monotonic id source for sr-only label elements (unique per window). */
let a11yLabelSeq = 0;

export interface GlideOutlineViewHandlers {
	onJump(item: HeadingItem): void;
	/**
	 * Optional rich-label renderer (Markdown). Called with an empty label
	 * element; when absent, plain text is used.
	 */
	renderLabel?(labelEl: HTMLElement, item: HeadingItem): void;
	/** Fired after row geometry was re-measured (magnification cache is stale). */
	onMetricsChanged?(): void;
}

export const RAIL_WIDTH = 28;
export const LABEL_GAP = 6;
export const SAFE_SLACK = 20;
export const COMPACT_THRESHOLD = 60;
/** Rows never get thinner than this so markers stay easy to hit. */
export const MARKER_MIN_HIT_HEIGHT = 18;
/** Painting room reserved for the card shadow when it is enabled. */
export const SHADOW_ALLOWANCE = 12;
/** Card border width per side when the border is enabled. */
export const CARD_BORDER_WIDTH = 1;
/** Width the H1–H6 badge (incl. its gap) adds to the card, px. */
export const LEVEL_BADGE_ALLOWANCE = 26;

export interface ItemRecord {
	rowEl: HTMLElement;
	buttonEl: HTMLButtonElement;
	/** Cached at creation — envelope rebuilds never querySelector for it. */
	markerEl: HTMLElement;
	cardEl: HTMLElement;
	badgeEl: HTMLElement;
	labelEl: HTMLElement;
	/**
	 * Screen-reader-only accessible name ("H2: Section title"). The
	 * button points at it via `aria-labelledby` instead of `aria-label`
	 * — Obsidian renders `aria-label` as a hover tooltip, which fought
	 * the magnified card visually (§ tooltip removal).
	 */
	a11yLabelEl: HTMLElement;
	/** Unscaled card height from the last measurement pass. */
	baseCardHeight: number;
	/**
	 * §八: the row height actually written to `--glide-row-height` last
	 * time (px). Unchanged heights skip the style write entirely — style
	 * writes on ~50 rows per measure pass were pure Recalculate Style
	 * fuel on Windows even when nothing moved.
	 */
	lastWrittenRowHeight: number;
	/** What the label currently displays (text or rendered source). */
	renderedContent: string;
	renderedRich: boolean;
}

/**
 * Owns the Glide Outline DOM inside a MarkdownView's contentEl.
 *
 * Structure (single visual card per heading — see styles.css):
 *   root      – positioning, CSS variables       → pointer-events: none
 *   hit-zone  – transparent rail strip           → pointer-events: auto
 *   viewport  – vertical scrolling               → pointer-events: none
 *   list      – item layout                      → pointer-events: none
 *   row       – measured row height              → pointer-events: none
 *   item      – fully reset button, a11y target  → pointer-events: none
 *     motion  – marker + card, moves together (--glide-shift-y)
 *       marker – rail-width hit slot, line/dot   → pointer-events: auto
 *       reveal – horizontal slide-in + opacity
 *         card – THE ONLY visual chrome + scale  → pointer-events: auto (expanded)
 *           label – text / rendered markdown
 *
 * The button is anchored to the editor edge with `width: max-content`; it
 * never spans the root, so leaked theme chrome cannot form a full-width bar
 * and the transparent area over the editor stays clickable.
 */
export class GlideOutlineView {
	readonly rootEl: HTMLElement;
	readonly hitZoneEl: HTMLElement;
	readonly viewportEl: HTMLElement;
	readonly listEl: HTMLElement;

	private readonly doc: Document;
	/** Owns every node this view creates; the only thing added to the host. */
	private readonly mount: OutlineMount;
	private readonly hostResizeObserver: ResizeObserver | null = null;
	/** One shared observer for every card (never one per item). */
	private readonly cardResizeObserver: ResizeObserver | null = null;
	private itemRecords = new Map<string, ItemRecord>();
	private items: readonly HeadingItem[] = [];
	private activeKey: string | null = null;
	private followEnabled = true;
	private metricsScheduled = false;
	/** rAF handle for the queued measure pass; 0 = none in flight. */
	private pendingMeasureFrame = 0;
	private disposed = false;
	private overflowState: OverflowState = {
		hasOverflow: false,
		canScrollUp: false,
		canScrollDown: false,
	};
	/**
	 * §五.1: cached scroll-box geometry. `clientHeight`/`scrollHeight` are
	 * layout reads; `scrollTop` is not. Scrolling cannot resize the scroll
	 * box, so the scroll path reads only `scrollTop` and reuses these.
	 * NaN = never measured (the cache is cold).
	 */
	private cachedClientHeight = Number.NaN;
	private cachedScrollHeight = Number.NaN;
	/**
	 * §五.2: fade classes as last written. Seeded `false` because that is
	 * exactly the freshly built root's state — a memo that starts as a
	 * guess would be a bug, not an optimisation.
	 */
	private lastFadeTop = false;
	private lastFadeBottom = false;
	private readonly onViewportScroll = (): void => {
		const perf = this.perf;
		// §3.2: same hot path as the controller's scroll listener, so the
		// same rotation group arms it.
		const measureDeep = perf?.deepScrollEventActive === true;
		const start = measureDeep ? this.now() : 0;
		perf?.count("overflowScrollEventCount");
		// A scroll cannot change the scroll box's size — trust the cache.
		this.evaluateOverflowState(false);
		if (measureDeep && perf) {
			perf.addPhaseSample("viewOverflowHandler", this.now() - start);
		}
	};

	/** §八: last written `--glide-viewport-pad` value (px); NaN = never. */
	private lastWrittenViewportPad = Number.NaN;
	/** §十: set right before a programmatic reveal scroll, consumed by the
	 * magnification controller's scroll handler for source attribution. */
	private programmaticScrollNote: "jump" | null = null;

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly getSettings: () => GlideOutlineSettings,
		private readonly handlers: GlideOutlineViewHandlers,
		/** On-demand perf capture (§八 measureRows counters). */
		private readonly perf: PerfCapture | null = null,
	) {
		this.doc = hostEl.ownerDocument;
		// Every node below hangs off the owned wrapper; the host itself is
		// left alone (see src/ui/mount.ts).
		this.mount = createOutlineMount(hostEl);

		this.rootEl = this.doc.createElement("div");
		this.rootEl.className = "glide-outline-root";

		this.hitZoneEl = this.doc.createElement("div");
		this.hitZoneEl.className = "glide-outline-hit-zone";

		this.viewportEl = this.doc.createElement("div");
		this.viewportEl.className = "glide-outline-viewport";

		this.listEl = this.doc.createElement("nav");
		this.listEl.className = "glide-outline-list";
		// Accessible name via a hidden span, NOT `aria-label`: Obsidian
		// renders aria-label as a hover tooltip, and a tooltip over the rail
		// is exactly what this plugin exists to replace.
		const listLabel = this.doc.createElement("span");
		listLabel.className = "glide-outline-a11y-label";
		listLabel.id = `glide-outline-a11y-${a11yLabelSeq++}`;
		listLabel.textContent = "Document outline";
		this.listEl.setAttribute("aria-labelledby", listLabel.id);

		this.viewportEl.appendChild(this.listEl);
		this.rootEl.appendChild(listLabel);
		this.rootEl.appendChild(this.hitZoneEl);
		this.rootEl.appendChild(this.viewportEl);
		this.mount.mountEl.appendChild(this.rootEl);

		// Edge fades track the scroll position (passive — no work per frame
		// beyond three cheap reads and two class toggles).
		this.viewportEl.addEventListener("scroll", this.onViewportScroll, {
			passive: true,
		});

		const win = this.doc.defaultView;
		if (win && typeof win.ResizeObserver === "function") {
			// Narrow-pane adaptation: recompute widths when the host resizes.
			this.hostResizeObserver = new win.ResizeObserver(() => {
				this.applyResponsiveWidth();
			});
			this.hostResizeObserver.observe(hostEl);
			// Card content boxes drive row heights. Card size changes do NOT
			// change the observed list/root size (cards are measured, rows are
			// written), so this cannot loop.
			this.cardResizeObserver = new win.ResizeObserver(() => {
				this.scheduleMeasure();
			});
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
				this.cardResizeObserver?.unobserve(record.cardEl);
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
				this.cardResizeObserver?.observe(record.cardEl);
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
		// §五.1: rows came and went — the cached scroll height is a lie now.
		this.invalidateOverflowMetrics();
		this.scheduleMeasure();
	}

	getItems(): readonly HeadingItem[] {
		return this.items;
	}

	/** Unscaled card height for the collision solver; 0 when unknown. */
	getBaseCardHeight(key: string): number {
		return this.itemRecords.get(key)?.baseCardHeight ?? 0;
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

		// Motion behaviour: always full. The --motion-full root class keeps
		// CSS transitions alive even under an OS prefers-reduced-motion
		// report (the media-query block in styles.css only bites while the
		// root is NOT --motion-full), and --motion-reduced is never applied.
		root.classList.add("glide-outline-root--motion-full");
		root.classList.remove("glide-outline-root--motion-reduced");

		root.style.setProperty("--glide-rail-width", `${RAIL_WIDTH}px`);
		root.style.setProperty("--glide-label-gap", `${LABEL_GAP}px`);
		root.style.setProperty("--glide-font-size", `${s.baseFontSize}px`);
		root.style.setProperty("--glide-vertical-offset", `${s.verticalOffset}px`);
		root.style.setProperty(
			"--glide-horizontal-offset",
			`${s.horizontalOffset}px`,
		);
		root.style.setProperty("--glide-edge-fade-size", `${s.edgeFadeSize}px`);
		root.classList.toggle("glide-outline-root--edge-fade", s.edgeFadeEnabled);

		// Label card appearance.
		const card = s.card;
		root.style.setProperty("--glide-card-opacity", `${card.opacity}%`);
		root.style.setProperty("--glide-card-radius", `${card.radius}px`);
		root.style.setProperty("--glide-card-padding-x", `${card.paddingX}px`);
		root.style.setProperty("--glide-card-padding-y", `${card.paddingY}px`);
		root.classList.toggle("glide-outline-root--card-border", card.border);
		root.classList.toggle("glide-outline-root--card-shadow", card.shadow);
		root.classList.toggle(
			"glide-outline-root--pure-text",
			card.opacity === 0 && !card.border && !card.shadow,
		);
		// Hierarchy badge (primary level cue).
		root.classList.toggle(
			"glide-outline-root--level-badge",
			s.levelIndicatorStyle === "badge",
		);

		// Hierarchy staircase: per-item indent is (level - 1) × this step.
		for (const record of this.itemRecords.values()) {
			const level = Number(record.rowEl.dataset.level ?? "1");
			record.buttonEl.style.setProperty(
				"--glide-level-indent",
				`${(Math.max(1, level) - 1) * s.levelIndent}px`,
			);
		}

		this.applyResponsiveWidth();
		// Font size / padding / border / markdown changes alter card boxes.
		this.invalidateOverflowMetrics();
		this.scheduleMeasure();
	}

	/** True when `node` belongs to this view's owned subtree. */
	owns(node: unknown): boolean {
		return this.mount.owns(node);
	}

	/** §十: the owning mount's instance id, for scroll-delta snapshots. */
	getMountInstanceId(): string {
		return this.mount.instanceId;
	}

	/** §十一: host-mutation observation (live object from the mount). */
	getMountDiagnostics(): MountHostMutationDiagnostics {
		return this.mount.diagnostics;
	}

	/**
	 * §十: consume the note left by the last programmatic outline scroll
	 * (active-heading reveal). Cleared on read so a later user scroll is
	 * never mis-attributed.
	 */
	takeProgrammaticScrollNote(): "jump" | null {
		const note = this.programmaticScrollNote;
		this.programmaticScrollNote = null;
		return note;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.viewportEl.removeEventListener("scroll", this.onViewportScroll);
		this.hostResizeObserver?.disconnect();
		this.cardResizeObserver?.disconnect();
		// A measure pass queued for the next frame would otherwise run once
		// against detached nodes. The `disposed` guard makes it harmless, but
		// cancelling means we never hold the callback (or this view) alive.
		if (this.pendingMeasureFrame !== 0) {
			this.doc.defaultView?.cancelAnimationFrame(this.pendingMeasureFrame);
			this.pendingMeasureFrame = 0;
		}
		this.metricsScheduled = false;
		this.itemRecords.clear();
		this.rootEl.remove();
		// Removes the owned wrapper and undoes the host anchor, if any.
		this.mount.dispose();
	}

	/** Current overflow / scrollability of the outline viewport. */
	getOverflowState(): OverflowState {
		return this.overflowState;
	}

	/** Viewport scroll metrics, for diagnostics. */
	getViewportMetrics(): { scrollTop: number; clientHeight: number; scrollHeight: number } {
		const vp = this.viewportEl;
		return {
			scrollTop: vp.scrollTop,
			clientHeight: vp.clientHeight,
			scrollHeight: vp.scrollHeight,
		};
	}

	/** Root class list (as strings), for diagnostics. */
	getRootClassList(): string[] {
		return Array.from(this.rootEl.classList);
	}

	/** Stable ItemRecord access for geometry consumers (section 6). */
	getItemRecord(key: string): ItemRecord | undefined {
		return this.itemRecords.get(key);
	}

	/**
	 * Build the geometric Pointer Envelope from the actual (post-transform)
	 * marker and card rectangles of the ACTIVE RANGE of visible headings,
	 * plus the rail hit zone. The bridge of each heading spans ONLY its own
	 * marker and card, so a long title can never widen a short neighbour's
	 * hover range.
	 *
	 * Intended to be called from a single RAF read phase (never per
	 * pointermove): it reads `getBoundingClientRect` only for the rows in
	 * [startIndex, endIndex] (inclusive; defaults to all visible items).
	 * Marker/card elements come from the ItemRecord cache — no
	 * querySelector per rebuild.
	 */
	collectEnvelope(
		hTolerance = 9,
		vTolerance = 5,
		startIndex = 0,
		endIndex = this.items.length - 1,
	): PointerEnvelope {
		const railRect = rectFrom(this.hitZoneEl.getBoundingClientRect());
		const items: PointerEnvelope["items"] = [];
		const first = Math.max(0, startIndex);
		const last = Math.min(this.items.length - 1, endIndex);
		for (let i = first; i <= last; i++) {
			const item = this.items[i];
			const record = this.itemRecords.get(item.key);
			const markerRect = rectFrom(
				record?.markerEl.getBoundingClientRect() ?? zeroRect(),
			);
			const cardRect = rectFrom(
				record?.cardEl.getBoundingClientRect() ?? zeroRect(),
			);
			const bridgeRect = bridgeRectFor(
				markerRect,
				cardRect,
				hTolerance,
				vTolerance,
			);
			items.push({ key: item.key, markerRect, cardRect, bridgeRect });
		}
		return { railRect, items };
	}

	/**
	 * Re-evaluate overflow and toggle the edge fade classes. Runs after
	 * measurement passes and after responsive width changes.
	 *
	 * Always re-measures: anything that is not a scroll may have resized
	 * the scroll box, and guessing which callers did is how stale fades
	 * happen. The scroll path uses the cached form instead (§五.1).
	 */
	updateOverflowState(): void {
		this.evaluateOverflowState(true);
	}

	/** §五.1: invalidate the cached scroll-box geometry. */
	private invalidateOverflowMetrics(): void {
		this.cachedClientHeight = Number.NaN;
		this.cachedScrollHeight = Number.NaN;
	}

	/**
	 * §五.1: the one place overflow is evaluated.
	 *
	 * `refresh` (or a cold cache) pays two layout reads; otherwise the
	 * cached box geometry is reused and only `scrollTop` is read, which is
	 * the whole point — a kinetic auto-scroll fires this on every frame.
	 */
	private evaluateOverflowState(refresh: boolean): void {
		if (this.disposed) return;
		const viewport = this.viewportEl;
		const cold =
			!Number.isFinite(this.cachedClientHeight) ||
			!Number.isFinite(this.cachedScrollHeight);
		if (refresh || cold) {
			this.cachedClientHeight = viewport.clientHeight;
			this.cachedScrollHeight = viewport.scrollHeight;
			this.perf?.count("overflowMetricRefreshCount");
		} else {
			this.perf?.count("overflowMetricReadCount");
		}
		const state = computeOverflowState({
			scrollTop: viewport.scrollTop,
			clientHeight: this.cachedClientHeight,
			scrollHeight: this.cachedScrollHeight,
		});
		this.overflowState = state;
		this.applyFadeClasses(state.canScrollUp, state.canScrollDown);
	}

	/**
	 * §五.2: write a fade class only when it actually changes.
	 *
	 * A `classList.toggle` to the value already present still runs the
	 * DOMTokenList update steps and still marks the element for style
	 * recalc on some engines. During an auto-scroll the pair is evaluated
	 * every frame while the answer changes maybe twice per gesture, so
	 * nearly all of those writes are pure waste.
	 */
	private applyFadeClasses(fadeTop: boolean, fadeBottom: boolean): void {
		if (fadeTop === this.lastFadeTop && fadeBottom === this.lastFadeBottom) {
			this.perf?.count("overflowClassSkippedCount");
			return;
		}
		let mutations = 0;
		if (fadeTop !== this.lastFadeTop) {
			this.rootEl.classList.toggle("glide-outline-root--fade-top", fadeTop);
			this.lastFadeTop = fadeTop;
			mutations++;
		}
		if (fadeBottom !== this.lastFadeBottom) {
			this.rootEl.classList.toggle(
				"glide-outline-root--fade-bottom",
				fadeBottom,
			);
			this.lastFadeBottom = fadeBottom;
			mutations++;
		}
		if (mutations > 0) {
			this.perf?.count("overflowClassMutationCount", mutations);
		}
	}

	/** Clock helper — the view has no `win` field of its own. */
	private now(): number {
		return this.doc.defaultView?.performance.now() ?? 0;
	}

	/** Horizontal room reserved for the shadow in the current settings. */
	private shadowAllowance(): number {
		return this.getSettings().card.shadow ? SHADOW_ALLOWANCE : 0;
	}

	/**
	 * Narrow-pane adaptation: the root width budgets the COMPLETE magnified
	 * card (text + padding + border + shadow), never just the text.
	 */
	private applyResponsiveWidth(): void {
		if (this.disposed) return;
		const s = this.getSettings();
		// Deepest VISIBLE heading level drives the worst-case indent.
		let deepestLevel = 1;
		for (const item of this.items) {
			if (item.level > deepestLevel) deepestLevel = item.level;
		}
		// NOTE: the solver still reports `interactionWidth`, but nothing
		// consumes it as a CSS var anymore — the transparent interaction
		// surface is gone; hover is maintained by the geometric Pointer
		// Envelope (collectEnvelope + MagnificationController).
		const { rootWidth, labelContentWidth, compact } =
			computeResponsiveWidth({
			hostWidth: this.hostEl.clientWidth || 0,
			maxLabelWidth: s.maxLabelWidth,
			maxScale: s.maxScale,
			railWidth: RAIL_WIDTH,
			labelGap: LABEL_GAP,
			cardPaddingX: s.card.paddingX,
			cardBorderWidth: s.card.border ? CARD_BORDER_WIDTH : 0,
			shadowAllowance: this.shadowAllowance(),
			safeSlack: SAFE_SLACK,
			compactThreshold: COMPACT_THRESHOLD,
			horizontalOffset: s.horizontalOffset,
			maxLevelIndent: (deepestLevel - 1) * s.levelIndent,
			badgeAllowance:
				s.levelIndicatorStyle === "badge" ? LEVEL_BADGE_ALLOWANCE : 0,
		});
		this.rootEl.style.setProperty("--glide-root-width", `${rootWidth}px`);
		this.rootEl.style.setProperty(
			"--glide-label-content-width",
			`${labelContentWidth}px`,
		);
		this.rootEl.classList.toggle("glide-outline-root--compact", compact);
		// §五.1: a width change rewraps labels, so row heights (and with
		// them the scroll height) can move.
		this.invalidateOverflowMetrics();
	}

	/** Coalesce measurement work into one pass per frame. */
	private scheduleMeasure(): void {
		if (this.disposed || this.metricsScheduled) return;
		this.metricsScheduled = true;
		const win = this.doc.defaultView;
		const run = () => {
			this.pendingMeasureFrame = 0;
			this.metricsScheduled = false;
			this.measureRows();
		};
		if (win && typeof win.requestAnimationFrame === "function") {
			this.pendingMeasureFrame = win.requestAnimationFrame(run);
		} else {
			run();
		}
	}

	/**
	 * Adaptive row heights (read phase then write phase, no interleaving):
	 * `offsetHeight` reads the UNscaled card box — layout size ignores CSS
	 * transforms, so magnification never pollutes the base measurement.
	 *
	 *   rowHeight = max(markerMinimumHitHeight, baseCardHeight) + cardGap
	 */
	private measureRows(): void {
		if (this.disposed) return;
		const s = this.getSettings();
		const records = [...this.itemRecords.values()];
		this.perf?.count("measureRowsRunCount");

		// Read phase — a single batched offsetHeight sweep (§八.1). No
		// writes may interleave here or every read forces a re-layout.
		const heights = records.map((record) => record.cardEl.offsetHeight);
		this.perf?.count("measureRowsReadCount", records.length);

		// Write phase — §八.2: only rows whose effective row height
		// actually changed get a style write. On a steady list this loop
		// writes NOTHING, so a redundant measure pass costs one layout
		// read sweep and zero invalidation.
		let maxCardHeight = 0;
		let changed = false;
		let writes = 0;
		let skipped = 0;
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			const cardHeight = heights[i];
			if (record.baseCardHeight !== cardHeight) {
				record.baseCardHeight = cardHeight;
				changed = true;
			}
			maxCardHeight = Math.max(maxCardHeight, cardHeight);
			const rowHeight =
				Math.max(MARKER_MIN_HIT_HEIGHT, cardHeight) + s.cardGap;
			if (record.lastWrittenRowHeight !== rowHeight) {
				record.rowEl.style.setProperty(
					"--glide-row-height",
					`${rowHeight}px`,
				);
				record.lastWrittenRowHeight = rowHeight;
				writes++;
			} else {
				skipped++;
			}
		}
		if (writes > 0) this.perf?.count("measureRowsWriteCount", writes);
		if (skipped > 0) {
			this.perf?.count("measureRowsSkippedWriteCount", skipped);
		}

		// Vertical painting space so edge cards can magnify without
		// clipping — same skip-if-unchanged rule (§八.2).
		const pad = computeVerticalSafeSpace({
			maxBaseCardHeight: maxCardHeight,
			maxScale: s.maxScale,
			radius: s.radius,
			cardGap: s.cardGap,
			shadowAllowance: this.shadowAllowance(),
		});
		if (pad !== this.lastWrittenViewportPad) {
			this.rootEl.style.setProperty("--glide-viewport-pad", `${pad}px`);
			this.lastWrittenViewportPad = pad;
			// Row heights / pad define scrollHeight — refresh the fades
			// only when the geometry could actually have moved (§八.2:
			// class toggles are cheap but not free on Windows).
			this.updateOverflowState();
		} else if (writes > 0) {
			this.updateOverflowState();
		}

		if (changed) this.handlers.onMetricsChanged?.();
	}

	private scrollRowIntoView(rowEl: HTMLElement): void {
		// §十: leave an attribution note BEFORE the scroll — scrollIntoView
		// may dispatch the scroll event synchronously in some runtimes.
		this.programmaticScrollNote = "jump";
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

		const motion = this.doc.createElement("span");
		motion.className = "glide-outline-motion";

		const marker = this.doc.createElement("span");
		marker.className = "glide-outline-marker";
		marker.setAttribute("aria-hidden", "true");

		const reveal = this.doc.createElement("span");
		reveal.className = "glide-outline-reveal";

		const card = this.doc.createElement("span");
		card.className = "glide-outline-card";

		// Edge level badge (H1…H6). DOM order is badge → label; CSS flips
		// the card's flex direction so the badge always sits on the
		// rail-facing side (right edge on the right outline, left on left).
		const badge = this.doc.createElement("span");
		badge.className = "glide-outline-level-badge";
		badge.setAttribute("aria-hidden", "true");

		const label = this.doc.createElement("span");
		label.className = "glide-outline-label";

		// Visually hidden accessible name. Keeping it OUTSIDE the visual
		// card (direct child of the button) means clip/transform on the
		// card never affects it, and `aria-labelledby` gives keyboard and
		// screen-reader users the same "H2: Title" announcement the old
		// `aria-label` did — without Obsidian's hover tooltip.
		const a11yLabel = this.doc.createElement("span");
		a11yLabel.className = "glide-outline-a11y-label";
		a11yLabel.id = `glide-outline-a11y-${a11yLabelSeq++}`;
		button.setAttribute("aria-labelledby", a11yLabel.id);

		card.appendChild(badge);
		card.appendChild(label);
		reveal.appendChild(card);
		motion.appendChild(marker);
		motion.appendChild(reveal);
		button.appendChild(motion);
		button.appendChild(a11yLabel);
		row.appendChild(button);

		button.addEventListener("click", (event) => {
			// Mouse/touch activation is handled by the pointerup lock in the
			// magnification controller, which also suppresses this synthetic
			// click (a real pointer click has event.detail > 0). Only a
			// keyboard activation — Enter / Space — arrives here with
			// event.detail === 0, so the two paths can never double-fire.
			if (event.detail !== 0) return;
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
			markerEl: marker,
			cardEl: card,
			badgeEl: badge,
			labelEl: label,
			a11yLabelEl: a11yLabel,
			baseCardHeight: 0,
			lastWrittenRowHeight: Number.NaN,
			renderedContent: "",
			renderedRich: false,
		};
	}

	private updateItemRecord(record: ItemRecord, item: HeadingItem): void {
		const { buttonEl, labelEl } = record;
		if (record.badgeEl.textContent !== `H${item.level}`) {
			record.badgeEl.textContent = `H${item.level}`;
		}
		buttonEl.dataset.level = String(item.level);
		buttonEl.dataset.key = item.key;
		record.rowEl.dataset.level = String(item.level);
		record.rowEl.dataset.key = item.key;
		// Accessible name lives in a sr-only span (aria-labelledby), NOT
		// in `aria-label`: Obsidian shows aria-label as a hover tooltip,
		// which duplicated the already-magnified card text.
		const a11yText = `H${item.level}: ${item.text}`;
		if (record.a11yLabelEl.textContent !== a11yText) {
			record.a11yLabelEl.textContent = a11yText;
		}
		// Hierarchy staircase indent — static per level, so it lives on the
		// button (not inside the reveal transform, which animates).
		buttonEl.style.setProperty(
			"--glide-level-indent",
			`${(item.level - 1) * this.getSettings().levelIndent}px`,
		);

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
