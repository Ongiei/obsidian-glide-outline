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
import { markColdStart } from "../core/ColdStartTrace";
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

/**
 * §四: how the user is currently interacting with the outline.
 *
 * Only `collapsed` pre-positions the active heading; the three expanded
 * variants mean the user (pointer hover, keyboard focus, or an in-flight
 * press) is driving the outline, so automatic follow stands down and
 * never fights them.
 */
export type OutlineInteractionState =
	| "collapsed"
	| "expanded-pointer"
	| "expanded-keyboard"
	| "pressed";

/** §四: why an active-follow re-position was requested (for diagnostics). */
export type ActiveFollowReason =
	| "active-change"
	| "items-change"
	| "metrics-change"
	| "resize"
	| "collapse"
	| "mode-change"
	| "file-change";

/**
 * §四: a follow queued before the active row has been measured retries a
 * bounded number of frames instead of dropping silently. A single measure
 * pass takes one RAF, so a few frames is ample for geometry to settle.
 */
const ACTIVE_FOLLOW_RETRY_BUDGET = 3;

/**
 * §四: center alignment tolerance. Sub-pixel layouts and device-pixel-ratio
 * scaling make an exact-zero requirement unreachable, so the session
 * declares success when the active row's center is within this many pixels
 * of the playhead's center.
 */
const CENTER_ALIGNMENT_TOLERANCE_PX = 0.75;

/**
 * §八: time constant for the exponential approach. Lower = snappier,
 * higher = smoother. 110ms feels responsive without overshooting.
 */
const CENTER_FOLLOW_TAU_MS = 110;

/** §八: hard ceiling on follow duration before a forced snap. */
const CENTER_FOLLOW_MAX_DURATION_MS = 700;

/** §五: a sane ceiling on the offsetParent walk (cycle / detach guard). */
const OFFSET_CHAIN_MAX_DEPTH = 32;

/**
 * §七: the lifecycle of a single center-follow animation. Only one session
 * exists at a time — a new active key retargets the current session rather
 * than starting a second animation.
 */
export type ActiveFollowSessionState =
	| "idle"
	| "following"
	| "retargeting"
	| "snapping"
	| "verifying"
	| "aligned"
	| "cancelled";

/** §七: a single center-follow animation. */
export interface ActiveFollowSession {
	generation: number;
	targetKey: string;
	targetScrollTop: number;
	state: ActiveFollowSessionState;
	startedAt: number;
	lastFrameAt: number;
	lastErrorPx: number;
	source: ActiveFollowReason;
}

/**
 * §三: the latest follow target, retained across expanded / pressed /
 * paused states. Flushed the moment the gate reopens.
 */
export interface PendingActiveFollow {
	key: string;
	reason: ActiveFollowReason;
	generation: number;
	requestedAt: number;
}

/**
 * §五: layout offset of `element` inside the scrolling content of
 * `scrollViewport`. Accumulates along the offsetParent chain instead of
 * trusting a bare `offsetTop` (which is only correct when the viewport
 * is the direct offsetParent).
 */
export function getOffsetWithinScrollContent(
	element: HTMLElement,
	scrollViewport: HTMLElement,
): { top: number; left: number; depth: number; resolved: boolean } {
	let top = 0;
	let left = 0;
	let depth = 0;
	let node: HTMLElement | null = element;
	while (node !== null && node !== scrollViewport) {
		if (depth >= OFFSET_CHAIN_MAX_DEPTH) {
			return { top, left, depth, resolved: false };
		}
		top += node.offsetTop || 0;
		left += node.offsetLeft || 0;
		depth++;
		node = (node.offsetParent as HTMLElement | null) ?? null;
	}
	return { top, left, depth, resolved: node === scrollViewport };
}

/** §十三: center-alignment diagnostics payload. */
export interface ActiveFollowDiagnostics {
	interactionState: OutlineInteractionState;
	followEnabled: boolean;
	activeKey: string | null;
	pendingKey: string | null;
	pendingGeneration: number;
	sessionGeneration: number;
	sessionState: ActiveFollowSessionState;
	sessionTargetKey: string | null;
	requestCount: number;
	retargetCount: number;
	alignedCount: number;
	snapCount: number;
	timeoutCount: number;
	cancelledCount: number;
	userInterruptedCount: number;
	suppressedCount: number;
	flushCount: number;
	frameCount: number;
	scrollMutationCount: number;
	noMutationCount: number;
	lastCoordinateSource: "offset-chain" | "rect" | "";
	lastRowContentCenter: number;
	lastPlayheadY: number;
	lastTargetScrollTop: number;
	lastScrollTopBefore: number;
	lastScrollTopAfter: number;
	lastAlignmentErrorPx: number;
	maxAlignmentErrorPx: number;
	lastDurationMs: number;
	topCenterSpacerPx: number;
	bottomCenterSpacerPx: number;
	/** §六: the row heights the spacers were sized from. */
	firstRowHeight: number;
	lastRowHeight: number;
	/** §六: the playhead's y in viewport client space (clientHeight / 2). */
	playheadClientY: number;
	/** §六: how many times the spacers have been re-measured. */
	centerSpacerRefreshCount: number;
	playheadVisible: boolean;
}

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
	 * magnification controller's scroll handler for source attribution.
	 * §四: widened to distinguish an active-follow reveal from a jump. */
	private programmaticScrollNote: "jump" | "active-follow" | null = null;

	/** §四: current interaction state; only `collapsed` pre-positions. */
	private interactionState: OutlineInteractionState = "collapsed";
	/** §四: a follow request arrived while a frame was already in flight. */
	private activeFollowPending = false;
	/** §四: retry frames left while the active row is still unmeasured. */
	private activeFollowRetryBudget = ACTIVE_FOLLOW_RETRY_BUDGET;
	/**
	 * §三: the newest follow target, retained until it is consumed. A
	 * request that arrives while the outline is expanded/pressed or while
	 * follow is paused is NOT discarded — it lands here and is flushed the
	 * moment the gate reopens.
	 */
	private pendingActiveFollow: PendingActiveFollow | null = null;
	/** §三: monotonic id of the newest request. */
	private activeFollowGeneration = 0;
	/** §七: the single active center-follow session (null = idle). */
	private activeFollowSession: ActiveFollowSession | null = null;
	/** §七: rAF handle driving the session; 0 = none. */
	private activeFollowFrame = 0;
	/** §七: last timestamp from the rAF callback (for dt computation). */
	private activeFollowLastTimestamp = 0;
	/** §五: the fixed center playhead element. */
	private playheadEl: HTMLElement | null = null;
	/** §六: top spacer element inside the scroll content. */
	private topSpacerEl: HTMLElement | null = null;
	/** §六: bottom spacer element inside the scroll content. */
	private bottomSpacerEl: HTMLElement | null = null;
	/** §六: last measured spacer heights (diagnostics). */
	private topCenterSpacerPx = 0;
	private bottomCenterSpacerPx = 0;
	private firstRowHeightPx = 0;
	private lastRowHeightPx = 0;
	private centerSpacerRefreshCount = 0;
	/** §四/§十三: counters for tests and diagnostics. */
	private readonly activeFollowDiag = {
		requestCount: 0,
		retargetCount: 0,
		alignedCount: 0,
		snapCount: 0,
		timeoutCount: 0,
		cancelledCount: 0,
		userInterruptedCount: 0,
		suppressedCount: 0,
		flushCount: 0,
		frameCount: 0,
		scrollMutationCount: 0,
		noMutationCount: 0,
		rectFallbackCount: 0,
		maxOffsetChainDepth: 0,
		lastCoordinateSource: "" as "offset-chain" | "rect" | "",
		lastRowContentCenter: Number.NaN,
		lastPlayheadY: Number.NaN,
		lastTargetScrollTop: Number.NaN,
		lastScrollTopBefore: Number.NaN,
		lastScrollTopAfter: Number.NaN,
		lastAlignmentErrorPx: Number.NaN,
		maxAlignmentErrorPx: 0,
		lastDurationMs: Number.NaN,
	};

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

		// §六: center spacers inside the scroll content so the first and
		// last rows can reach the playhead at the vertical center.
		this.topSpacerEl = this.doc.createElement("div");
		this.topSpacerEl.className = "glide-outline-center-spacer glide-outline-center-spacer--top";
		this.topSpacerEl.setAttribute("aria-hidden", "true");
		this.viewportEl.insertBefore(this.topSpacerEl, this.listEl);

		this.bottomSpacerEl = this.doc.createElement("div");
		this.bottomSpacerEl.className = "glide-outline-center-spacer glide-outline-center-spacer--bottom";
		this.bottomSpacerEl.setAttribute("aria-hidden", "true");
		this.viewportEl.appendChild(this.bottomSpacerEl);

		// §五: fixed center playhead. Lives in the root (not the scroll
		// viewport) so it never moves with the content. pointer-events:
		// none, no tooltip, no hit area.
		this.playheadEl = this.doc.createElement("div");
		this.playheadEl.className = "glide-outline-playhead";
		this.playheadEl.setAttribute("aria-hidden", "true");
		const playheadMarker = this.doc.createElement("span");
		playheadMarker.className = "glide-outline-playhead-marker";
		this.playheadEl.appendChild(playheadMarker);
		this.rootEl.appendChild(this.playheadEl);
		markColdStart("firstPlayheadMounted");

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
		markColdStart("firstItemsSet"); // §十三

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

		// §十三: the row list is now in the document — the first commit is
		// the earliest instant anything of the outline is on screen.
		if (visible.length > 0) markColdStart("firstOutlineDomCommit");

		// Empty state: hide the rail entirely when nothing is visible.
		this.rootEl.classList.toggle("is-empty", visible.length === 0);
		// §五.1: rows came and went — the cached scroll height is a lie now.
		this.invalidateOverflowMetrics();
		this.scheduleMeasure();
		// §六: row count / order changed — spacers depend on first/last row.
		this.refreshCenterSpacers();
		// §四: the list changed, so the active row's offset moved. Re-center
		// it (retries until the queued measure pass gives it a real height).
		this.requestActiveFollow("items-change");
	}

	getItems(): readonly HeadingItem[] {
		return this.items;
	}

	/** Unscaled card height for the collision solver; 0 when unknown. */
	getBaseCardHeight(key: string): number {
		return this.itemRecords.get(key)?.baseCardHeight ?? 0;
	}

	setActiveKey(key: string | null): void {
		if (this.disposed) return;
		// §四: the same-key case is NOT a no-op. The active heading can be
		// unchanged while its row offset moved (file/mode swap, resize,
		// re-measure). The class/aria toggles below are skipped — nothing
		// changed there — but a re-position is still requested so a
		// collapsed outline stays centred on the active row.
		if (key === this.activeKey) {
			this.requestActiveFollow("active-change");
			return;
		}
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
		}
	}
	// §四: keep the active heading positioned inside the outline's own
	// scroll viewport — but only while collapsed, so the pointer/keyboard
	// user is never fought (requestActiveFollow enforces that gate).
	this.requestActiveFollow("active-change");
	}

	/**
	 * While the pointer is inside the outline (or the user scrolls it),
	 * automatic follow of the active heading is paused.
	 *
	 * §四: re-enabling is a *resume*, not just a flag flip. Anything the
	 * active heading did while follow was paused is still sitting in
	 * `pendingActiveFollow`, and it is consumed here — otherwise the
	 * outline would stay parked wherever the user left it until some
	 * unrelated event happened to request a follow again.
	 */
	setFollowEnabled(enabled: boolean): void {
		if (this.disposed) return;
		const previous = this.followEnabled;
		this.followEnabled = enabled;
		if (!previous && enabled) this.flushPendingActiveFollow();
	}

	/**
	 * §十二: record how the user is interacting with the outline.
	 *
	 * Returning to `collapsed` hands control back to automatic follow:
	 * show the playhead, flush the pending target, start a new session.
	 * Leaving `collapsed` (expand/press) cancels the session and hides
	 * the playhead so the row's own active marker takes over.
	 */
	setInteractionState(state: OutlineInteractionState): void {
		if (this.disposed) return;
		const previous = this.interactionState;
		this.interactionState = state;
		if (previous === "collapsed" && state !== "collapsed") {
			// §十一: an EXPANSION must show the current heading straight
			// away, so the in-flight follow is finished instantly rather
			// than left to slide under the pointer.
			//
			// §十二: `pressed` is different — it freezes. The list stays
			// exactly where the user grabbed it; snapping under a held
			// pointer would yank the row out from under them. The session
			// is only cancelled, and the pending target survives for the
			// next collapse.
			if (state !== "pressed") this.finishActiveFollowImmediately();
			this.cancelActiveFollowSession();
		}
		if (previous !== "collapsed" && state === "collapsed") {
			this.refreshCenterSpacers();
			this.flushPendingActiveFollow();
		}
		this.updatePlayheadVisibility();
	}

	/** §四: current interaction state (diagnostics / tests). */
	getInteractionState(): OutlineInteractionState {
		return this.interactionState;
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
	takeProgrammaticScrollNote(): "jump" | "active-follow" | null {
		// §十: while a center-follow session is active, every scroll event
		// is attributed to "active-follow" — the session owns the scroll
		// until it aligns or is cancelled.
		if (this.activeFollowSession !== null) return "active-follow";
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
		// §四: drop any queued active-follow pass too.
		if (this.activeFollowFrame !== 0) {
			this.doc.defaultView?.cancelAnimationFrame(this.activeFollowFrame);
			this.activeFollowFrame = 0;
		}
		this.activeFollowSession = null;
		this.activeFollowPending = false;
		this.pendingActiveFollow = null;
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
		// §六: viewport height changed — spacers depend on clientHeight.
		this.refreshCenterSpacers();
		// §四: a viewport-size change shifts the active row's centred
		// position — re-request a follow (no-op unless collapsed).
		this.requestActiveFollow("resize");
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
		markColdStart("firstMeasureRowsStart"); // §十三
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

		if (changed) {
			this.handlers.onMetricsChanged?.();
			// §四: row heights moved, so the active row's centred position
			// moved too. This is also the pass that satisfies a follow
			// deferred by setItems (rows finally have a real height).
			this.requestActiveFollow("metrics-change");
		}
		// §六: row heights changed — spacers depend on first/last row height.
		this.refreshCenterSpacers();
		markColdStart("firstMeasureRowsEnd"); // §十三
	}

	/**
	 * §四: request that the active heading be re-centred inside the outline
	 * viewport. Coalesced into a single RAF; multiple reasons in one frame
	 * collapse to one pass. A follow queued before the active row has a
	 * measured height retries for a bounded number of frames.
	 *
	 * Only the collapsed interaction state pre-positions — while the user
	 * hovers, focuses, or presses the outline, the request is refused so we
	 * never yank the content out from under them.
	 */
	requestActiveFollow(reason: ActiveFollowReason): void {
		if (this.disposed) return;
		const diag = this.activeFollowDiag;
		diag.requestCount++;
		const key = this.activeKey;
		if (key === null) return;
		markColdStart("firstActiveFollowRequest");

		// §三: record the target unconditionally — even when the gate is
		// shut, the newest target is retained for the next collapse.
		this.activeFollowGeneration++;
		this.pendingActiveFollow = {
			key,
			reason,
			generation: this.activeFollowGeneration,
			requestedAt: this.now(),
		};

		if (!this.canRunActiveFollow()) {
			diag.suppressedCount++;
			return;
		}
		this.startOrRetargetActiveFollowSession(key, reason);
	}

	/** §三: is automatic positioning allowed to run right now? */
	private canRunActiveFollow(): boolean {
		return this.followEnabled && this.interactionState === "collapsed";
	}

	/**
	 * §四: consume the newest retained follow target now that the gate has
	 * reopened (collapse, or follow re-enabled). Re-targets at the live
	 * active key if the pending entry was for a different heading.
	 */
	private flushPendingActiveFollow(): void {
		if (this.disposed) return;
		const pending = this.pendingActiveFollow;
		if (pending === null) return;
		if (!this.canRunActiveFollow()) return;
		const key = this.activeKey;
		if (key === null) {
			this.pendingActiveFollow = null;
			return;
		}
		if (pending.key !== key) {
			this.activeFollowGeneration++;
			this.pendingActiveFollow = {
				key,
				reason: pending.reason,
				generation: this.activeFollowGeneration,
				requestedAt: pending.requestedAt,
			};
		}
		this.activeFollowDiag.flushCount++;
		this.activeFollowRetryBudget = ACTIVE_FOLLOW_RETRY_BUDGET;
		this.startOrRetargetActiveFollowSession(key, pending.reason);
	}

	/** §十三: center-alignment diagnostics for tests and the report. */
	getActiveFollowDiagnostics(): ActiveFollowDiagnostics {
		const d = this.activeFollowDiag;
		const s = this.activeFollowSession;
		const p = this.pendingActiveFollow;
		return {
			interactionState: this.interactionState,
			followEnabled: this.followEnabled,
			activeKey: this.activeKey,
			pendingKey: p?.key ?? null,
			pendingGeneration: this.activeFollowGeneration,
			sessionGeneration: s?.generation ?? 0,
			sessionState: s?.state ?? "idle",
			sessionTargetKey: s?.targetKey ?? null,
			requestCount: d.requestCount,
			retargetCount: d.retargetCount,
			alignedCount: d.alignedCount,
			snapCount: d.snapCount,
			timeoutCount: d.timeoutCount,
			cancelledCount: d.cancelledCount,
			userInterruptedCount: d.userInterruptedCount,
			suppressedCount: d.suppressedCount,
			flushCount: d.flushCount,
			frameCount: d.frameCount,
			scrollMutationCount: d.scrollMutationCount,
			noMutationCount: d.noMutationCount,
			lastCoordinateSource: d.lastCoordinateSource,
			lastRowContentCenter: d.lastRowContentCenter,
			lastPlayheadY: d.lastPlayheadY,
			lastTargetScrollTop: d.lastTargetScrollTop,
			lastScrollTopBefore: d.lastScrollTopBefore,
			lastScrollTopAfter: d.lastScrollTopAfter,
			lastAlignmentErrorPx: d.lastAlignmentErrorPx,
			maxAlignmentErrorPx: d.maxAlignmentErrorPx,
			lastDurationMs: d.lastDurationMs,
			topCenterSpacerPx: this.topCenterSpacerPx,
			bottomCenterSpacerPx: this.bottomCenterSpacerPx,
			firstRowHeight: this.firstRowHeightPx,
			lastRowHeight: this.lastRowHeightPx,
			playheadClientY: this.viewportEl.clientHeight / 2,
			centerSpacerRefreshCount: this.centerSpacerRefreshCount,
			playheadVisible: this.playheadEl !== null && this.playheadEl.style.display !== "none",
		};
	}

	/** §三: the retained follow target, if any (tests / diagnostics). */
	getPendingActiveFollow(): PendingActiveFollow | null {
		return this.pendingActiveFollow;
	}

	// ── §七: single Active Follow Session ───────────────────────────

	/**
	 * §七: start a new session or retarget the existing one. A retarget
	 * does NOT create a second animation — it updates the target and lets
	 * the current RAF naturally steer toward the new position.
	 */
	private startOrRetargetActiveFollowSession(
		key: string,
		reason: ActiveFollowReason,
	): void {
		if (this.disposed) return;
		markColdStart("firstCenterFollowRequested");
		const target = this.computeCenterTargetScrollTop(key);
		if (!Number.isFinite(target)) {
			// Geometry not ready — retry on the next frame.
			if (this.activeFollowFrame === 0 && this.activeFollowRetryBudget > 0) {
				this.activeFollowRetryBudget--;
				this.scheduleActiveFollowFrame();
			}
			return;
		}
		this.activeFollowRetryBudget = ACTIVE_FOLLOW_RETRY_BUDGET;
		const now = this.now();
		const existing = this.activeFollowSession;
		if (existing !== null && existing.state !== "aligned" && existing.state !== "cancelled") {
			// §七: retarget — update the existing session.
			existing.targetKey = key;
			existing.targetScrollTop = target;
			existing.state = "retargeting";
			existing.source = reason;
			this.activeFollowDiag.retargetCount++;
			this.perf?.count("centerFollowRetargetCount");
			return;
		}
		this.activeFollowSession = {
			generation: this.activeFollowGeneration,
			targetKey: key,
			targetScrollTop: target,
			state: "following",
			startedAt: now,
			lastFrameAt: now,
			lastErrorPx: Number.NaN,
			source: reason,
		};
		if (this.activeFollowFrame === 0) {
			this.scheduleActiveFollowFrame();
		}
	}

	/** §七: cancel the current session (expanded / pressed / dispose / file / mode). */
	private cancelActiveFollowSession(): void {
		if (this.activeFollowSession !== null) {
			this.activeFollowSession.state = "cancelled";
			this.activeFollowDiag.cancelledCount++;
		}
		this.activeFollowSession = null;
		this.cancelActiveFollowFrame();
	}

	/**
	 * §十一: snap the latest active heading to the center immediately,
	 * bypassing the smooth animation. Called on pointer-enter so the user
	 * sees the correct heading before expansion begins.
	 */
	finishActiveFollowImmediately(): void {
		if (this.disposed) return;
		const key = this.activeKey;
		if (key === null) {
			this.cancelActiveFollowFrame();
			return;
		}
		this.cancelActiveFollowFrame();
		const target = this.computeCenterTargetScrollTop(key);
		if (!Number.isFinite(target)) return;
		const viewport = this.viewportEl;
		const diag = this.activeFollowDiag;
		const before = viewport.scrollTop;
		if (before !== target) {
			this.programmaticScrollNote = "active-follow";
			viewport.scrollTop = target;
			diag.scrollMutationCount++;
			diag.snapCount++;
			this.perf?.count("centerFollowScrollMutationCount");
			this.perf?.count("centerFollowSnapCount");
		}
		diag.lastScrollTopBefore = before;
		diag.lastScrollTopAfter = viewport.scrollTop;
		diag.lastTargetScrollTop = target;
		diag.lastAlignmentErrorPx = Math.abs(viewport.scrollTop - target);
		if (diag.lastAlignmentErrorPx > diag.maxAlignmentErrorPx) {
			diag.maxAlignmentErrorPx = diag.lastAlignmentErrorPx;
		}
		// Mark aligned and clear pending.
		if (this.activeFollowSession !== null) {
			this.activeFollowSession.state = "aligned";
		}
		this.activeFollowSession = null;
		if (this.pendingActiveFollow !== null) {
			this.pendingActiveFollow = null;
		}
		diag.alignedCount++;
		markColdStart("firstCenterFollowAligned");
	}

	// ── §八: custom RAF smooth scroll ───────────────────────────────

	private scheduleActiveFollowFrame(): void {
		if (this.disposed || this.activeFollowFrame !== 0) return;
		const win = this.doc.defaultView;
		const step = (timestamp: number): void => {
			this.activeFollowFrame = 0;
			this.centerFollowFrameStep(timestamp);
		};
		if (win && typeof win.requestAnimationFrame === "function") {
			this.activeFollowFrame = win.requestAnimationFrame(step);
		}
	}

	private cancelActiveFollowFrame(): void {
		if (this.activeFollowFrame !== 0) {
			this.doc.defaultView?.cancelAnimationFrame(this.activeFollowFrame);
			this.activeFollowFrame = 0;
		}
		this.activeFollowPending = false;
	}

	/**
	 * §八: per-frame exponential approach. Frame-rate independent:
	 * alpha = 1 - exp(-dt / tau). No overshoot, no oscillation. Snaps
	 * when the error falls below tolerance or the max duration elapses.
	 */
	private centerFollowFrameStep(timestamp: number): void {
		if (this.disposed) return;
		const session = this.activeFollowSession;
		if (session === null || session.state === "aligned" || session.state === "cancelled") {
			return;
		}
		if (!this.canRunActiveFollow()) {
			this.cancelActiveFollowSession();
			return;
		}
		const diag = this.activeFollowDiag;
		const viewport = this.viewportEl;
		const current = viewport.scrollTop;
		const target = session.targetScrollTop;

		// Recompute target in case the layout shifted (spacer resize, etc.)
		const recomputed = this.computeCenterTargetScrollTop(session.targetKey);
		if (Number.isFinite(recomputed) && Math.abs(recomputed - target) > 1) {
			session.targetScrollTop = recomputed;
		}

		const dt = Math.max(1, timestamp - session.lastFrameAt);
		const elapsed = timestamp - session.startedAt;
		session.lastFrameAt = timestamp;
		diag.frameCount++;
		this.perf?.count("centerFollowFrameCount");
		markColdStart("firstCenterFollowFrame");

		const error = session.targetScrollTop - current;
		session.lastErrorPx = Math.abs(error);
		diag.lastAlignmentErrorPx = session.lastErrorPx;
		if (session.lastErrorPx > diag.maxAlignmentErrorPx) {
			diag.maxAlignmentErrorPx = session.lastErrorPx;
		}
		diag.lastScrollTopBefore = current;
		diag.lastTargetScrollTop = session.targetScrollTop;

		// §四: tolerance check — aligned.
		if (session.lastErrorPx <= CENTER_ALIGNMENT_TOLERANCE_PX) {
			this.alignSession(current, session);
			return;
		}

		// §八: hard timeout — snap.
		if (elapsed >= CENTER_FOLLOW_MAX_DURATION_MS) {
			this.programmaticScrollNote = "active-follow";
			viewport.scrollTop = session.targetScrollTop;
			diag.scrollMutationCount++;
			diag.timeoutCount++;
			this.perf?.count("centerFollowScrollMutationCount");
			this.perf?.count("centerFollowTimeoutCount");
			diag.lastScrollTopAfter = viewport.scrollTop;
			this.alignSession(viewport.scrollTop, session);
			return;
		}

		// §八: exponential approach. alpha = 1 - exp(-dt / tau).
		const alpha = 1 - Math.exp(-dt / CENTER_FOLLOW_TAU_MS);
		const next = current + error * alpha;

		this.programmaticScrollNote = "active-follow";
		viewport.scrollTop = next;
		diag.scrollMutationCount++;
		this.perf?.count("centerFollowScrollMutationCount");
		diag.lastScrollTopAfter = viewport.scrollTop;
		session.state = "following";

		this.perf?.count("activeFollowScrollMutationCount");
		this.scheduleActiveFollowFrame();
	}

	/** §八: mark the session aligned, clear pending, stop the RAF. */
	private alignSession(finalScrollTop: number, session: ActiveFollowSession): void {
		const diag = this.activeFollowDiag;
		session.state = "aligned";
		diag.lastScrollTopAfter = finalScrollTop;
		diag.lastAlignmentErrorPx = Math.abs(finalScrollTop - session.targetScrollTop);
		diag.lastDurationMs = this.now() - session.startedAt;
		diag.alignedCount++;
		markColdStart("firstCenterFollowAligned");
		// §七: pending is cleared ONLY on alignment, not on scroll request.
		if (this.pendingActiveFollow?.generation === session.generation) {
			this.pendingActiveFollow = null;
		}
		this.activeFollowSession = null;
		this.cancelActiveFollowFrame();
	}

	// ── §九: target position calculation ────────────────────────────

	/**
	 * §九: compute the scrollTop that puts the active row's content center
	 * at the playhead (viewport.clientHeight / 2). Returns NaN when the
	 * row or viewport has no layout yet.
	 */
	private computeCenterTargetScrollTop(key: string): number {
		const record = this.itemRecords.get(key);
		if (!record) return Number.NaN;
		const measured = this.measureActiveRow(record.rowEl);
		if (measured === null) return Number.NaN;
		const viewport = this.viewportEl;
		const playheadY = viewport.clientHeight / 2;
		const activeCenter = measured.rowTop + measured.rowHeight / 2;
		const maxScrollTop = Math.max(0, measured.scrollHeight - measured.clientHeight);
		const target = Math.max(0, Math.min(maxScrollTop, activeCenter - playheadY));
		const diag = this.activeFollowDiag;
		diag.lastRowContentCenter = activeCenter;
		diag.lastPlayheadY = playheadY;
		diag.lastTargetScrollTop = target;
		diag.lastCoordinateSource = measured.source;
		return target;
	}

	/**
	 * §五: measure the active row's content-coordinate position. Uses the
	 * offsetParent chain (correct for every nesting); falls back to
	 * getBoundingClientRect for the single active row only when the chain
	 * cannot reach the viewport.
	 */
	private measureActiveRow(rowEl: HTMLElement): {
		rowTop: number;
		rowHeight: number;
		clientHeight: number;
		scrollHeight: number;
		source: "offset-chain" | "rect";
	} | null {
		const viewport = this.viewportEl;
		const clientHeight = viewport.clientHeight;
		const rowHeight = rowEl.offsetHeight;
		if (!(clientHeight > 0) || !(rowHeight > 0)) return null;
		const scrollHeight = viewport.scrollHeight;
		const diag = this.activeFollowDiag;
		const chain = getOffsetWithinScrollContent(rowEl, viewport);
		if (chain.depth > diag.maxOffsetChainDepth) {
			diag.maxOffsetChainDepth = chain.depth;
		}
		if (chain.resolved) {
			return { rowTop: chain.top, rowHeight, clientHeight, scrollHeight, source: "offset-chain" };
		}
		// §五: rect fallback — single active row only, never a sweep.
		const rowRect = rowEl.getBoundingClientRect();
		const viewportRect = viewport.getBoundingClientRect();
		const rowTop = rowRect.top - viewportRect.top - viewport.clientTop + viewport.scrollTop;
		if (!Number.isFinite(rowTop)) return null;
		diag.rectFallbackCount++;
		this.perf?.count("centerFollowRectFallbackCount");
		return { rowTop, rowHeight, clientHeight, scrollHeight, source: "rect" };
	}

	/**
	 * §九: snap the active row to the center. Used by jump corrections and
	 * other callers that need instant positioning (not the smooth session).
	 * The smooth session writes scrollTop directly via centerFollowFrameStep.
	 */
	scrollActiveRowIntoPosition(options: {
		alignment: "center";
		behavior: "auto";
		source: "active-follow" | "jump";
	}): boolean {
		if (this.disposed || this.activeKey === null) return false;
		const record = this.itemRecords.get(this.activeKey);
		if (!record) return false;
		const target = this.computeCenterTargetScrollTop(this.activeKey);
		if (!Number.isFinite(target)) return false;
		const viewport = this.viewportEl;
		const diag = this.activeFollowDiag;
		const before = viewport.scrollTop;
		diag.lastScrollTopBefore = before;
		if (Math.abs(before - target) <= CENTER_ALIGNMENT_TOLERANCE_PX) {
			diag.noMutationCount++;
			diag.lastScrollTopAfter = before;
			return true;
		}
		this.programmaticScrollNote =
			options.source === "active-follow" ? "active-follow" : "jump";
		viewport.scrollTop = target;
		diag.scrollMutationCount++;
		diag.lastScrollTopAfter = viewport.scrollTop;
		return true;
	}

	// ── §五/§六: playhead visibility ─────────────────────────────────

	/** §五: show or hide the fixed center playhead based on interaction state. */
	private updatePlayheadVisibility(): void {
		if (!this.playheadEl) return;
		const visible = this.interactionState === "collapsed";
		this.playheadEl.style.display = visible ? "" : "none";
	}

	// ── §六: center spacers ──────────────────────────────────────────

	/**
	 * §六: recompute top/bottom spacer heights so the first and last rows
	 * can reach the center. Called on resize, setItems, level filter,
	 * file/mode change.
	 */
	private refreshCenterSpacers(): void {
		if (this.disposed) return;
		const viewport = this.viewportEl;
		const clientHeight = viewport.clientHeight;
		if (!(clientHeight > 0)) return;
		const rows = this.itemRecords;
		if (rows.size === 0) return;
		const firstRecord = rows.values().next().value;
		const lastRecord = [...rows.values()].pop();
		if (!firstRecord || !lastRecord) return;
		const firstRowHeight = firstRecord.rowEl.offsetHeight || 0;
		const lastRowHeight = lastRecord.rowEl.offsetHeight || 0;
		const topSpacer = Math.max(0, clientHeight / 2 - firstRowHeight / 2);
		const bottomSpacer = Math.max(0, clientHeight / 2 - lastRowHeight / 2);
		this.topCenterSpacerPx = topSpacer;
		this.bottomCenterSpacerPx = bottomSpacer;
		this.firstRowHeightPx = firstRowHeight;
		this.lastRowHeightPx = lastRowHeight;
		this.centerSpacerRefreshCount++;
		markColdStart("firstCenterSpacerMeasured");
		if (this.topSpacerEl) {
			this.topSpacerEl.style.height = `${topSpacer}px`;
		}
		if (this.bottomSpacerEl) {
			this.bottomSpacerEl.style.height = `${bottomSpacer}px`;
		}
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
