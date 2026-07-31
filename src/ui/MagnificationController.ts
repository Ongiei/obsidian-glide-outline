import { computeCollisionFreeMagnification } from "../utils/geometry";
import { type AutoScrollStopReason } from "../utils/overflow";
import {
	computeEdgeScrollIntent,
	computeKineticIntentVelocity,
	predictedPointerY,
	resolveEdgeZones,
	PointerSampleRing,
	POINTER_FOLLOW_DECAY_TAU_MS,
	POINTER_FOLLOW_MAX_SHARE,
	type EdgeIntentState,
	type PointerKinematicsState,
	type ScrollIntegratorState,
} from "../utils/scrollIntent";
import {
	MANUAL_WHEEL_COOLDOWN_MS,
	resolveWheelRoute,
} from "../utils/wheelRouting";
import { DisposableStore } from "../utils/disposable";
import {
	bridgeRectFor,
	emptyRect,
	pointInEnvelope,
	translateEnvelopeItemsY,
} from "../utils/envelope";
import type { PointerEnvelope, Rect } from "../utils/envelope";
import {
	clientYToContentY,
	contentRangeForViewport,
} from "../utils/contentCoords";
import type { ContentRange, ScrollViewportFrame } from "../utils/contentCoords";
import {
	computeActiveMotionRange,
	computeScaleRange,
	computeVisibleRange,
	emptyActiveRange,
	isEmptyActiveRange,
} from "../utils/activeRange";
import type { ActiveMotionRange } from "../utils/activeRange";
import {
	identityMotionState,
	motionAlpha,
	motionStateConverged,
	stepMotionState,
	stepToward,
	SCALE_EPSILON,
	SHIFT_EPSILON,
} from "../utils/motionInterp";
import type { MotionItemState } from "../utils/motionInterp";
import { resolveClickTarget } from "../utils/activation";
import { closestOwned } from "./mount";
import type { Diagnostics, ScrollDeltaSource } from "../core/Diagnostics";
import type { PerfCapture, PerfCounters } from "../core/PerfCapture";
import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";
import type { GlideOutlineView } from "./GlideOutlineView";

interface CachedItem {
	el: HTMLElement;
	/** Heading key (`data-key`) — links the row to its envelope item so
	 * motion updates can re-derive envelope rects mathematically (§十四). */
	key: string;
	/**
	 * §六 Base vertical center in CONTENT coordinates — measured from the
	 * top of the scrollable content, NOT from the viewport. Rows themselves
	 * never transform (`--glide-shift-y` moves the motion element inside),
	 * so the row rect is transform-free and this is the pure layout center.
	 *
	 * Content coordinates are scroll-INDEPENDENT: an outline scroll changes
	 * only `currentScrollTop` (O(1)) and every cached center stays valid.
	 * The client-space value, when one is actually needed, is derived on
	 * demand with `contentYToClientY`.
	 */
	contentCenter: number;
	/** contentCenter + displayed shift — where the card/marker visually is
	 * (still content space). */
	contentVisualCenter: number;
	/** Unscaled card height (measured by the view, cached here). */
	height: number;
	/** Continuous target/displayed interpolation state (section 11). */
	motion: MotionItemState;
	/** Last CSS var values actually written; NaN = property absent. */
	lastWrittenScale: number;
	lastWrittenShift: number;
	/** §九: split will-change classes currently applied per axis. */
	shifting: boolean;
	scaling: boolean;
	/** §六: true when this row was a snapped taper-chain row last frame.
	 * On the frame it transitions into the solver core, its displayed
	 * state still carries the relaxed-gap buffer position; the write
	 * phase snaps it once to the strict target (off-screen, invisible)
	 * so the gap does not surface as a visible overlap while it
	 * interpolates home. */
	wasSnapped: boolean;
}

/** Grace period before collapsing, so crossing a transparent gap between
 * two magnification-displaced neighbours does not flicker the outline shut.
 * 100 ms: snappier exit than the original 120 ms while still bridging the
 * marker↔card gap crossing (re-entry within the grace cancels collapse). */
const COLLAPSE_GRACE_MS = 100;

/** Pointer auto-scroll: peak speed in px/s at the very edge (speed 1).
 * `pointerAutoScrollSpeed` (P1-3) scales this AND the acceleration cap
 * linearly, so the motion character (ramp shape, damping feel) is
 * preserved at every speed setting — only the tempo changes. */
export const AUTO_SCROLL_MAX_SPEED = 320;
/** §十一 hysteresis: once auto-scroll is latched, the pointer must retreat
 * this many px past the trigger zone's inner boundary before the session
 * ends with "zone-exit" — small jitter never re-arms the dwell gate. */
export const AUTO_SCROLL_EXIT_HYSTERESIS_PX = 12;
/** Dwell before the list starts moving, so brushing an edge does not
 * immediately yank the heading the user was about to click. EDGE only —
 * the kinetic (pointer-follow) intent has NO dwell (§九). */
export const AUTO_SCROLL_DWELL_MS = 140;
/** Max change of the APPLIED scroll speed, px/s per second — the
 * acceleration cap that turns raw target speeds into damped motion. */
export const AUTO_SCROLL_ACCEL = 1400;
/** §四: guard rows added on each side of the collision seed range. A
 * buffer row absorbed into the core passes through the guard (off-screen)
 * where its relaxed-gap displayed state is snapped once to the strict
 * solver target (see wasSnapped), so it never surfaces as a visible
 * overlap. */
export const COLLISION_GUARD_ROWS = 2;
/** §三/§十四: allowed adjacent overlap slack, px (rounding tolerance). */
export const OVERLAP_TOLERANCE_PX = 1;
/** §四/§六 handoff apron: when a layout has NO offscreen gap to relax
 * (cardGap=0 → baseGap=0), the buffer collapses to the 1px tolerance
 * taper. The first rows then use a HALF-pixel step so that when the
 * collision slice later absorbs them, the inherited pair closure (plus
 * DPR rounding noise) stays within tolerance (§三: 1.113px overshoot on
 * the after-scroll handoff with a full-pixel step). Only the near rows
 * need this; far rows never hand off while far. */
export const COLLISION_TAPER_APRON_ROWS = 8;
export const COLLISION_TAPER_APRON_STEP_PX = 0.5;
/** §四/§六: hard cap on taper rows per side (write-budget guard). The
 * buffer normally stops on its own once the boundary shift is absorbed
 * by offscreen gap relaxation; the cap bounds pathological shifts so
 * rows far outside the viewport stay at identity (never written). */
export const COLLISION_TAPER_MAX_ROWS = 160;

/** §八 Pointer-anchor resolve: rows probed around the previous anchor
 * before falling back to the binary search. A stationary pointer over a
 * scrolling list moves at most a row or two per frame, so the local probe
 * answers almost every resolve in O(1). */
export const ANCHOR_LOCAL_PROBE_RADIUS = 3;

/** Horizontal / vertical slack (px) added to each heading's bridge rect so
 * the hover envelope stays comfortable without growing to the longest title. */
const ENVELOPE_H_TOLERANCE = 9;
const ENVELOPE_V_TOLERANCE = 5;
/** Release-point tolerance (px) around the locked target on pointerup. */
const ACTIVATION_RELEASE_TOLERANCE = 8;
/** §九: split layer-hint classes. `is-shifting` promotes ONLY the motion
 * element (translateY), `is-scaling` promotes ONLY the card (scale). A row
 * whose shift is moving but whose scale rests at 1 (or vice versa) never
 * holds a layer on the other axis — resting text re-rasterizes crisply
 * on the non-composited path (Windows 1080p clarity, §三/§九). */
export const MOTION_SHIFT_CLASS = "glide-outline-row--is-shifting";
export const MOTION_SCALE_CLASS = "glide-outline-row--is-scaling";
/** Clamp for the interpolation time step: a frozen tab or a pointer-hold
 * must not turn into a giant catch-up jump on the next frame. */
const MAX_MOTION_DT_MS = 100;
/** Fallback time step for the first frame after the loop was idle. */
const DEFAULT_MOTION_DT_MS = 16.7;

/** Reason a full geometry rebuild ran (PerfCapture histogram, §十五).
 * §七: "expand" is GONE — expansion does not change row layout (rows are
 * laid out even while collapsed; the reveal animates opacity/translateX
 * only), so expanding must never trigger a full geometry rebuild. */
type GeometryRebuildReason = "initial" | "invalidate" | "resize";

/**
 * §八: the old single `pointerInside` boolean conflated four independent
 * facts, which made auto-scroll stop/start decisions ambiguous (a gap
 * crossing looked identical to a real exit). Split into explicit fields:
 */
interface PointerInteractionState {
	/** Pointer physically over a real element (rail / marker / card). */
	overElement: boolean;
	/** Pointer inside the geometric envelope (incl. transparent gaps). */
	insideEnvelope: boolean;
	/** §九 latch: an auto-scroll session is engaged. Held through gaps and
	 * hysteresis-sized jitter; released only by an explicit stop reason. */
	autoScrollLatched: boolean;
	/** Why the last auto-scroll session ended (diagnostics / perf). */
	lastStopReason: AutoScrollStopReason | null;
}

function idlePointerState(): PointerInteractionState {
	return {
		overElement: false,
		insideEnvelope: false,
		autoScrollLatched: false,
		lastStopReason: null,
	};
}

/** §十: a window-level pointer move parked for the deferred containment
 * test. Only the fields the velocity ring needs — no event reference, so
 * nothing keeps a DOM object alive past the frame. */
interface PendingPointerSample {
	pointerId: number;
	clientY: number;
	timeStamp: number;
}

/**
 * §十四: move a cached rect with its row's motion — vertical shift plus
 * vertical scale growth around the rect's own center (`transform-origin`
 * is `left/right center`, so vertical growth IS center-symmetric).
 */
function applyMotionDeltaToRect(r: Rect, dy: number, ratio: number): void {
	const cy = (r.top + r.bottom) / 2 + dy;
	const hh = ((r.bottom - r.top) / 2) * ratio;
	r.top = cy - hh;
	r.bottom = cy + hh;
}

/** §九: numeric sort comparator (Array#sort is lexicographic by default,
 * which would order row 10 before row 9). */
function ascending(a: number, b: number): number {
	return a - b;
}

/** §十七: quantize CSS var payloads — scale to 4 decimals, shift to
 * device pixels. Sub-quantum churn produces byte-identical strings and is
 * dropped by the equality/epsilon guards before touching the DOM. */
function quantizeScale(value: number): number {
	return Math.round(value * 10000) / 10000;
}
/** §九.3 pixel alignment: `Math.round(shift × dpr) / dpr` — a fractional
 * device-pixel translateY lands glyphs between physical pixels and blurs
 * text (the Windows 1080p clarity complaint). Falls back to 0.1 px
 * quantization when the ratio is unavailable (headless tests). */
function quantizeShift(value: number, dpr: number): number {
	if (Number.isFinite(dpr) && dpr > 0) {
		return Math.round(value * dpr) / dpr;
	}
	return Math.round(value * 10) / 10;
}

interface PressedHeadingState {
	pointerId: number;
	headingKey: string;
	targetType: "marker" | "card";
	downX: number;
	downY: number;
	/** Actual (post-transform) rect of the locked target at pointerdown. */
	targetRect: Rect;
	/** Element the pointer was captured on (for releasePointerCapture). */
	captured: HTMLElement | null;
}

/**
 * Pointer-proximity expand/collapse + dock magnification.
 *
 * FRAME BUDGET DESIGN (perf/motion-frame-budget):
 *
 *   - Pointer handlers are INPUT-ONLY (section 4): they store clientX/Y,
 *     mark pending work and schedule a RAF. All DOM reads, solver math and
 *     style writes happen inside `frame`, strictly phased as
 *     READ → PURE CALC → WRITE (section 13).
 *   - The envelope is rebuilt at most once per frame, only when dirty
 *     (section 5), and only over the ACTIVE row range (sections 6/10).
 *   - Outline scrolling updates cached geometry by DELTA (section 8) —
 *     no rect reads, no full rebuild; full rebuilds are reserved for
 *     discrete events (items/size/settings/resize).
 *   - Cache rebuilds are O(n) via element→entry maps (section 9).
 *   - Continuous motion is RAF-interpolated (target/displayed pairs with
 *     a time-based exponential step, section 11); CSS transitions no
 *     longer drive the continuous transforms. CSS vars are written only
 *     past epsilon thresholds and only for rows that changed (section 14).
 *   - `will-change: transform` exists only on active-range rows and is
 *     removed on exit/convergence/collapse/dispose (section 15).
 *
 * Coordinate system: viewport client coordinates for BOTH the pointer
 * (`event.clientY`) and cached item centers (`getBoundingClientRect()`).
 *
 * Pop-out safe (P1-1): all `instanceof` checks and observers use the
 * owner window's constructors, never the main-window globals.
 *
 * Expansion has two independent sources (P1-2):
 *   - pointerExpanded: pointer near the rail / over a card
 *   - focusExpanded:   keyboard focus inside the outline
 * The outline stays expanded while either is true.
 *
 * Hover is maintained by a GEOMETRIC Pointer Envelope (not a large
 * transparent DOM plane): the union of the rail hit zone and each active
 * heading's actual marker / card / bridge rectangles.
 */
export class MagnificationController {
	private readonly disposables = new DisposableStore();
	private readonly win: Window & typeof globalThis;
	private cache: CachedItem[] = [];
	/** O(1) element → cache index (anchor resolution, rebuild carry). */
	private cacheIndexByEl = new Map<HTMLElement, number>();
	/** O(1) heading key → cache index (envelope motion derivation, §十四). */
	private cacheIndexByKey = new Map<string, number>();
	/** Per-key displayed shift/scale at envelope collect time — the basis
	 * for deriving envelope rects mathematically instead of re-reading
	 * getBoundingClientRect after every motion write (§十四). */
	private envelopeMotionShift = new Map<string, number>();
	private envelopeMotionScale = new Map<string, number>();
	/** Why the next full geometry rebuild runs (PerfCapture, §十五). */
	private cacheDirtyReason: GeometryRebuildReason = "initial";
	/** §六 Solver input view over `cache`, in CONTENT coordinates. */
	private layout: { center: number; height: number }[] = [];
	/** §六 Cached CONTENT centers / heights for the range binary searches. */
	private centers: number[] = [];
	private heights: number[] = [];
	/** Per-item DISPLAYED shifts fed back into the solver (visual→base). */
	private shifts: number[] = [];
	/**
	 * Row element the pointer is physically over. Resolved lazily inside
	 * the frame from the last pointer event target (input-only handlers).
	 */
	private pointerAnchorEl: HTMLElement | null = null;
	private pendingAnchorTarget: EventTarget | null = null;
	private anchorDirty = false;
	/** §八 Last resolved anchor row — the seed for the local probe. */
	private lastAnchorIndex = -1;
	/** §六 An outline scroll moved the rows under a (possibly stationary)
	 * pointer; the cached anchor must be re-resolved. Set by the scroll
	 * handler (O(1)) and consumed once per frame, so a burst of scroll
	 * events costs one resolve, not one per event. */
	private anchorScrollStale = false;
	private cacheDirty = true;
	private pointerExpanded = false;
	private focusExpanded = false;
	private rafId = 0;
	private collapseTimer = 0;
	private lastPointerX = Number.NaN;
	private lastPointerY = Number.NaN;
	// --- Pointer Envelope (geometric hover maintenance) ----------------
	/** Union of rail hit zone + active headings' marker/card/bridge rects. */
	private envelope: PointerEnvelope = { railRect: emptyRect(), items: [] };
	/** §六: row index span the cached envelope was collected for; -1 = none. */
	private envelopeRangeStart = -1;
	private envelopeRangeEnd = -1;
	/** Rebuild the envelope during the next frame's READ phase. Only set
	 * on real geometry changes (section 5) — never unconditionally. */
	private envelopeDirty = true;
	/** Window-level containment test deferred to the frame (section 4). */
	private windowCheckPending = false;
	/**
	 * §十: the newest window-level pointer sample, waiting for the deferred
	 * containment test.
	 *
	 * A move across a TRANSPARENT GAP (the space between two magnified
	 * cards, or the marker↔card corridor) hits no outline element, so only
	 * the window listener sees it. Feeding it into the velocity ring right
	 * there would be wrong — the same listener also sees moves over the
	 * editor, and those must not drive the outline's follow gesture. So the
	 * sample is parked here and committed by `processWindowCheck()` only
	 * once the (frame-fresh) envelope confirms the pointer is still inside.
	 * That closes the hole where a gesture visibly stalled every time the
	 * pointer glided over a gap.
	 */
	private pendingPointerSample: PendingPointerSample | null = null;
	/** Active row window (sections 6/10); recomputed each frame. */
	private activeRange: ActiveMotionRange = emptyActiveRange();
	// --- §六 Content-coordinate geometry --------------------------------
	/** The outline viewport's scrollTop as of the last scroll event. This
	 * is the ONLY value an outline scroll has to update: every cached row
	 * center and envelope item rect lives in content space. */
	private currentScrollTop = 0;
	/** §四.2: >0 while we are inside our own scrollTop write, so the
	 * scroll listener can classify a synchronous (reentrant) dispatch. */
	private scrollTopWriteDepth = 0;
	/** §十: the source of the write currently in flight (reentrant path). */
	private activeWriteSource: ScrollDeltaSource | null = null;
	/** §十: short-lived attribution for the NEXT async scroll event(s).
	 * Frame-counted TTL — no clock reads on the capture-off hot path. */
	private scrollAttribution: {
		source: ScrollDeltaSource;
		ttl: number;
	} | null = null;
	/** §十: frames remaining during which a file/mode switch is "recent". */
	private fileChangeTtl = 0;
	private modeChangeTtl = 0;
	// --- Pointer edge auto-scroll state (coordinated in the same RAF as
	// magnification, so the two never fight over frames).
	/** Viewport bounds cached alongside the item cache — no per-frame rect. */
	private viewportTop = 0;
	private viewportBottom = 0;
	/** §八 four-field pointer interaction state (replaces `pointerInside`). */
	private pointer: PointerInteractionState = idlePointerState();
	/** Timestamp base for the motion interpolation step (section 11). */
	private lastMotionTime = Number.NaN;
	// --- §四 three independent row windows (recomputed each frame) -----
	/** Rows that may have scale > 1 (pointerY ± radius + 1). */
	private scaleRange: ActiveMotionRange = emptyActiveRange();
	/** Rows the collision solver must cover (visible ∪ scale ∪ settling ∪
	 * guard, then dynamically expanded until both boundaries are safe). */
	private collisionRange: ActiveMotionRange = emptyActiveRange();
	// --- §七 Scroll-intent coordinator state -------------------------
	/** Edge (positional) intent state, fully independent from kinetic. */
	private edgeIntent: EdgeIntentState = {
		dwellTimer: 0,
		dwellPassed: false,
		latched: false,
		direction: 0,
		lastStopReason: null,
	};
	/** Kinetic (pointer-follow) state: the velocity sample ring. */
	private kinematics: PointerKinematicsState = {
		samples: new PointerSampleRing(6, 90),
		velocityY: 0,
		predictedY: Number.NaN,
		lastSampleTime: Number.NaN,
		active: false,
	};
	/** §十 event dedup key (pointerId:timeStamp) so an element+window
	 * double-dispatch of the same move is sampled only once. */
	private lastSampleEventId = "";
	/** §十四: a kinetic session is live (nonzero target last frame). */
	private kineticActive = false;
	/** Shared integrator that combines the two intents. */
	private integrator: ScrollIntegratorState = {
		edgeIntentVelocity: 0,
		kineticIntentVelocity: 0,
		combinedTargetVelocity: 0,
		appliedVelocity: 0,
		lastFrameTime: Number.NaN,
		manualWheelCooldownUntil: 0,
	};
	// --- Sparse dirty rows (§五/§六/§九) --------------------------------
	/** §九: the EXACT set of row indices that may still be off identity
	 * (mid-interpolation, or carrying written vars / layer classes).
	 *
	 * This replaces the old inclusive `[settleStart, settleEnd]` span.
	 * The span was a lie whenever the dirty rows were not contiguous —
	 * and after a taper they never are: a handful of chain rows above
	 * the collision block plus the block itself made the span cover
	 * every clean row in between, and the write loop walked all of them
	 * once per frame just to hit the identity fast-skip. With a set the
	 * loop visits `collision ∪ dirty` and nothing else. */
	private readonly dirtyRows = new Set<number>();
	/** Reused per-frame write order (ascending). Held as a field so the
	 * frame loop allocates nothing on the hot path. */
	private readonly writeOrder: number[] = [];
	/** Reused scratch for dirty rows sitting outside the collision block. */
	private readonly outsideDirty: number[] = [];
	// --- Pointer activation lock (section 9) --------------------------
	/** Set on pointerdown over a real marker/card; cleared on pointerup /
	 * pointercancel / window blur / dispose. While set, the frame loop is
	 * suspended entirely, so target AND displayed motion values are frozen
	 * and the locked target cannot slide away (section 12). */
	private pressed: PressedHeadingState | null = null;

	/**
	 * Ownership predicate handed to every `closest()` on this hot path.
	 * Event targets can come from anywhere in the document (window-level
	 * listeners, foreign plugins reusing our class names), so a class match
	 * alone is never treated as proof that a node is ours.
	 */
	private readonly ownsNode = (node: unknown): boolean => this.view.owns(node);

	constructor(
		private readonly view: GlideOutlineView,
		private readonly getSettings: () => GlideOutlineSettings,
		private readonly diagnostics: Diagnostics | null = null,
		/** Pointer activation path (pointerup lock). Keyboard activation
		 * goes through the view's click handler instead — never both. */
		private readonly onJump: ((item: HeadingItem) => void) | null = null,
		/** On-demand performance capture (section 3); null = zero cost. */
		private readonly perf: PerfCapture | null = null,
	) {
		const doc = view.rootEl.ownerDocument;
		const win = doc.defaultView as (Window & typeof globalThis) | null;
		if (!win) throw new Error("glide-outline: detached document");
		this.win = win;

		const { hitZoneEl, listEl, rootEl, viewportEl } = view;

		// Rail strip + real cards/markers: enter/move/leave. The motion
		// corridor and the removed interaction surface are NOT interactive,
		// so the only elements that bubble here are the rail, markers and
		// cards — exactly what may keep the outline open or trigger a jump.
		this.disposables.listen(hitZoneEl, "pointerenter", this.onPointerEnter);
		this.disposables.listen(hitZoneEl, "pointermove", this.onPointerMove);
		this.disposables.listen(hitZoneEl, "pointerleave", this.onPointerLeave);
		this.disposables.listen(listEl, "pointerenter", this.onPointerEnter);
		this.disposables.listen(listEl, "pointermove", this.onPointerMove);
		this.disposables.listen(listEl, "pointerleave", this.onPointerLeave);

		// Window-level pointer tracking keeps the envelope honest when the
		// pointer crosses a transparent gap (e.g. the intra-row marker↔card
		// gap) straight into the editor — no real element fires a leave
		// there. INPUT-ONLY (section 4): stores coordinates, marks the
		// containment test pending, and schedules a frame. The test itself
		// runs in the frame against the cached envelope — never a rebuild.
		this.disposables.listen(win, "pointermove", this.onWindowPointerMove, {
			passive: true,
		});

		// §十: wheel routing through the pointer envelope. One WINDOW-level
		// capture-phase listener decides ownership from cached state (pure
		// math, no layout reads). While collapsed the handler is a single
		// boolean check — effectively free for editor scrolling.
		this.disposables.listen(win, "wheel", this.onWindowWheel, {
			capture: true,
			passive: false,
		});

		// §六 Outline scroll: O(1). Cached geometry lives in CONTENT
		// coordinates, so a scroll only moves the viewport window over it —
		// no per-row rewrite, no rect reads, no full rebuild. The stale
		// pointer anchor is re-resolved once in the next frame (§八), not
		// once per scroll event.
		this.disposables.listen(
			viewportEl,
			"scroll",
			() => {
				const perf = this.perf;
				const measure = perf?.active === true;
				// §三: the scroll-pipeline breakdown is DEEP-only — a LIGHT
				// capture keeps the counters (they are cheap adds) but never
				// reads the clock inside a scroll event.
				// §3.2: and even in DEEP, only while the "scrollEvent" group
				// holds the rotation slot.
				const measureDeep = perf?.deepScrollEventActive === true;
				// §四.2: a scroll event observed while we are still inside
				// our own scrollTop write was dispatched SYNCHRONOUSLY by
				// that write — its cost belongs to the write, not to the
				// ordinary async handler phase.
				const reentrant = this.scrollTopWriteDepth > 0;
				const handlerStart = measureDeep
					? this.win.performance.now()
					: 0;
				const scrollTop = viewportEl.scrollTop;
				const previousScrollTop = this.currentScrollTop;
				const delta = scrollTop - previousScrollTop;
				this.currentScrollTop = scrollTop;
				// §十: attribute the delta to whoever moved the scroller.
				const source = this.classifyScrollSource();
				if (measure && perf) {
					perf.count("scrollEventCount");
					if (reentrant) perf.count("scrollEventReentrantCount");
					if (delta === 0) perf.count("zeroDeltaScrollEventCount");
					perf.addScrollDeltaSample(delta, source);
				}
				if (measureDeep && perf) {
					// §四.2 scrollOffsetUpdate: applying the delta to the
					// cached content offset (the reads/writes above).
					perf.addPhaseSample(
						"scrollOffsetUpdate",
						this.win.performance.now() - handlerStart,
					);
				}
				// §十: |delta| beyond the viewport height is the "outline
				// teleported" anomaly — snapshot it ALWAYS (capture on or
				// off), never clamp it, never swallow the scroll. The
				// comparison uses the cached viewport height so the hot
				// path stays free of layout reads.
				const cachedViewportHeight =
					this.viewportBottom - this.viewportTop;
				if (
					this.diagnostics &&
					Number.isFinite(delta) &&
					cachedViewportHeight > 0 &&
					Math.abs(delta) > cachedViewportHeight
				) {
					this.diagnostics.recordLargeScrollDelta({
						previousScrollTop,
						currentScrollTop: scrollTop,
						delta,
						clientHeight: viewportEl.clientHeight,
						scrollHeight: viewportEl.scrollHeight,
						source,
						fileChangePending: this.fileChangeTtl > 0,
						modeChangePending: this.modeChangeTtl > 0,
						instanceId: this.view.getMountInstanceId(),
					});
				}
				if (
					!this.cacheDirty &&
					Number.isFinite(delta) &&
					delta !== 0 &&
					this.cache.length > 0
				) {
					this.anchorScrollStale = true;
				}
				// User is scrolling the outline — pause active-heading follow.
				this.view.setFollowEnabled(false);
				const scheduleStart = measureDeep
					? this.win.performance.now()
					: 0;
				this.schedule();
				if (measureDeep && perf) {
					const handlerEnd = this.win.performance.now();
					perf.addPhaseSample(
						"scrollFrameReschedule",
						handlerEnd - scheduleStart,
					);
					perf.addPhaseSample(
						reentrant
							? "synchronousScrollDispatch"
							: "scrollEventHandler",
						handlerEnd - handlerStart,
					);
				}
			},
			{ passive: true },
		);

		// Pointer activation lock (section 9): pointerdown over a real
		// marker/card captures the target; pointerup verifies and jumps.
		this.disposables.listen(rootEl, "pointerdown", this.onRootPointerDown);
		this.disposables.listen(rootEl, "pointerup", this.onRootPointerUp);
		this.disposables.listen(rootEl, "pointercancel", this.onRootPointerCancel);

		// Keyboard focus keeps the outline open (P1-2).
		this.disposables.listen(rootEl, "focusin", () => {
			this.focusExpanded = true;
			this.syncExpanded();
		});
		this.disposables.listen(rootEl, "focusout", (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (this.isNodeInRoot(next)) return;
			this.focusExpanded = false;
			this.syncExpanded();
		});

		// Window blur must release any held pointer and stop auto-scroll.
		this.disposables.listen(win, "blur", this.onWindowBlur);

		// §十五: coalesced + thresholded resize handling. Both observed
		// elements report through ONE callback, and sub-pixel size churn
		// (fractional layout rounding during magnification) is ignored —
		// only a ≥1 px change in either dimension is a real resize.
		const lastSizes = new Map<Element, { w: number; h: number }>();
		const resizeObserver = new win.ResizeObserver((entries) => {
			let significant = false;
			for (const entry of entries) {
				const w = entry.contentRect.width;
				const h = entry.contentRect.height;
				const prev = lastSizes.get(entry.target);
				if (
					!prev ||
					Math.abs(prev.w - w) >= 1 ||
					Math.abs(prev.h - h) >= 1
				) {
					significant = true;
				}
				lastSizes.set(entry.target, { w, h });
			}
			if (!significant) return;
			this.markCacheDirty("resize");
			this.envelopeDirty = true;
			this.schedule();
		});
		resizeObserver.observe(view.listEl);
		resizeObserver.observe(view.rootEl);
		this.disposables.add(() => resizeObserver.disconnect());

		// §十: a scroll event arriving right after construction (initial
		// layout settling, scrollTop restoration) is the mount's doing.
		this.scrollAttribution = { source: "mount", ttl: 3 };
	}

	/** Called when the heading list or settings changed (centers are stale). */
	invalidate(): void {
		this.markCacheDirty("invalidate");
		this.envelopeDirty = true;
		this.perf?.count("cacheInvalidationCount");
		if (this.isExpanded()) this.schedule();
	}

	/**
	 * §十: a file switch or view-mode switch just happened — a following
	 * outline scroll (content swap, scrollTop clamp/reset) belongs to it.
	 * TTLs are frame-counted; while collapsed they simply persist, which
	 * is the honest reading of "nothing else touched the outline since".
	 */
	noteContextChange(reason: "file-change" | "mode-change"): void {
		this.scrollAttribution = { source: reason, ttl: 3 };
		if (reason === "file-change") this.fileChangeTtl = 3;
		else this.modeChangeTtl = 3;
	}

	dispose(): void {
		this.cancelFrame();
		this.cancelCollapse();
		this.clearPressed();
		this.resetAllScrollIntent("dispose");
		this.clearMagnification();
		this.disposables.dispose();
	}

	/** Mark the geometry cache stale and remember why (§十五). */
	private markCacheDirty(reason: GeometryRebuildReason): void {
		this.cacheDirty = true;
		this.cacheDirtyReason = reason;
	}

	private isExpanded(): boolean {
		return this.pointerExpanded || this.focusExpanded;
	}

	/** Pop-out safe instanceof (P1-1). */
	private isNodeInRoot(value: unknown): boolean {
		return (
			value instanceof this.win.Node && this.view.rootEl.contains(value)
		);
	}

	private onPointerEnter = (event: PointerEvent): void => {
		// §十: is this a FRESH gesture, or a re-entry from a transparent
		// gap? `pointerenter` fires on the rail AND on the list, so gliding
		// off a card into the gap and onto the next one re-fires it several
		// times per second mid-flick. Only a genuinely fresh visit (the
		// outline was collapsed, or the pointer was outside the envelope)
		// may wipe the velocity ring; clearing it on gap re-entry killed
		// the very gesture the follow is supposed to continue.
		const wasExpanded = this.pointerExpanded;
		const freshGesture =
			!wasExpanded ||
			(!this.pointer.overElement && !this.pointer.insideEnvelope);
		this.cancelCollapse();
		this.pointerExpanded = true;
		this.pointer.overElement = true;
		this.pointer.insideEnvelope = true;
		// §七: expansion does NOT dirty the geometry cache — row layout is
		// identical collapsed/expanded (the reveal animates opacity and a
		// horizontal translate only). Card rects DO move horizontally, so
		// the envelope is refreshed on demand; the row cache is not.
		//
		// §六: and ONLY the expansion moves them. Re-entering from a gap
		// while already expanded changes no geometry, yet this fired
		// several times a second mid-flick and each one queued a forced
		// layout for the next pointerleave to pay.
		if (!wasExpanded) {
			this.envelopeDirty = true;
			this.perf?.count("envelopeEnterDirtyCount");
		} else {
			this.perf?.count("envelopeEnterReusedCount");
		}
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.pendingAnchorTarget = event.target;
		this.anchorDirty = true;
		if (freshGesture) {
			// No carried-over velocity from a previous visit.
			this.kinematics.samples.clear();
			this.kinematics.velocityY = 0;
			this.kinematics.predictedY = Number.NaN;
			this.kinematics.active = false;
			this.lastSampleEventId = "";
		}
		this.syncExpanded();
		this.schedule();
	};

	/**
	 * INPUT-ONLY hot path (section 4): store the sample, mark pending
	 * work, schedule one RAF. No DOM reads, no envelope rebuild, no
	 * solver, no style writes — multiple pointermoves per frame coalesce
	 * into a single frame() run.
	 */
	private onPointerMove = (event: PointerEvent): void => {
		this.perf?.count("pointermoveCount");
		this.cancelCollapse();
		if (!this.pointerExpanded) {
			this.pointerExpanded = true;
			this.envelopeDirty = true; // §七: envelope only, never the cache
			this.syncExpanded();
		}
		this.pointer.overElement = true;
		this.pointer.insideEnvelope = true;
		this.trackPointerVelocity(event);
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.pendingAnchorTarget = event.target;
		this.anchorDirty = true;
		this.schedule();
	};

	/**
	 * Leaving a real element (rail / marker / card): if the pointer moved to
	 * another outline element (relatedTarget still in root) do nothing. If
	 * it is still inside the geometric envelope (a transparent gap between
	 * magnified neighbours, or the intra-row marker↔card gap) keep the
	 * outline open but stop auto-scroll. Otherwise start the collapse grace.
	 *
	 * §六: the decision must be authoritative at the moment of exit, but
	 * "authoritative" does not mean "re-read layout". Motion is the only
	 * thing that moves these rects between frames, and motion is pure
	 * math on the row cache — so the warm path derives and reads nothing.
	 * A synchronous rebuild is left ONLY for a structurally stale
	 * envelope (rows or expansion changed), where the cached rects
	 * describe a layout that no longer exists.
	 */
	private onPointerLeave = (event: PointerEvent): void => {
		const related = event.relatedTarget;
		if (this.isNodeInRoot(related)) return;
		if (this.envelopeDirty) {
			this.activeRange = this.computeRange();
			this.rebuildEnvelope();
			this.perf?.count("envelopeSyncRebuildCount");
		} else {
			this.updateEnvelopeFromMotion();
			this.perf?.count("envelopeDerivedLeaveCount");
		}
		if (
			pointInEnvelope(
				this.envelope,
				event.clientX,
				event.clientY,
				this.clientYToContentY(event.clientY),
			)
		) {
			// Inside a transparent gap — keep expanded and, when a latched
			// auto-scroll session is running, keep it running too (§十二:
			// the horizontal band between marker and card is stable ground;
			// lateral wandering must not stutter an active scroll).
			this.pointer.overElement = false;
			this.pointer.insideEnvelope = true;
			this.pointerAnchorEl = null;
			this.anchorDirty = false;
			// §十/§十二: a gap crossing keeps the KINETIC intent alive (the
			// gesture continues); only an unlatched EDGE session stops.
			if (!this.edgeIntent.latched) {
				this.stopEdgeIntent("pointer-left");
			}
			this.cancelCollapse();
			return;
		}
		this.pointer.overElement = false;
		this.pointer.insideEnvelope = false;
		this.pointerAnchorEl = null;
		this.anchorDirty = false;
		this.resetAllScrollIntent("pointer-left");
		this.armCollapse();
	};

	/**
	 * Window-level move (section 4): catches exits from transparent gaps
	 * (no real element fires a leave there). INPUT-ONLY — saves the
	 * coordinates and defers the containment test to the frame, where the
	 * envelope is guaranteed fresh. Runs on every window move, so it must
	 * never touch the DOM.
	 */
	private onWindowPointerMove = (event: PointerEvent): void => {
		if (!this.isExpanded() || this.pressed) return;
		// §十三 dedup: moves over the outline's own elements already reached
		// onPointerMove via bubbling — running the window containment test
		// for them too would double the per-move work for zero information
		// (the pointer is trivially inside). Only moves OUTSIDE the root
		// (editor surface, transparent gaps) need the geometric test.
		const target = event.target;
		if (
			target instanceof this.win.Node &&
			this.view.rootEl.contains(target)
		) {
			return;
		}
		this.perf?.count("pointermoveCount");
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		// §十: park the sample; the frame decides whether this was a gap
		// crossing (→ feed the ring) or a genuine exit (→ discard).
		this.pendingPointerSample = {
			pointerId: event.pointerId,
			clientY: event.clientY,
			timeStamp: event.timeStamp,
		};
		this.windowCheckPending = true;
		this.schedule();
	};

	/**
	 * §十: window capture-phase wheel routing. Decides ownership with
	 * `resolveWheelRoute` on cached booleans/numbers only — no layout
	 * reads on the wheel hot path. Outline-owned wheels scroll the
	 * outline viewport (delta-normalized) and start the manual-wheel
	 * cooldown; editor handoffs and ignores fall through untouched so
	 * the editor keeps its native scrolling.
	 */
	private onWindowWheel = (event: WheelEvent): void => {
		// Collapsed → never ours (§十.1). Single boolean read; the editor
		// pays nothing for this listener while the outline is closed.
		if (!this.isExpanded()) return;
		const target = event.target;
		const targetInOutline =
			target instanceof this.win.Node &&
			this.view.rootEl.contains(target);
		const overflow = this.view.getOverflowState();
		const decision = resolveWheelRoute({
			expanded: true,
			pressed: this.pressed !== null,
			hasOverflow: overflow.hasOverflow,
			canScrollUp: overflow.canScrollUp,
			canScrollDown: overflow.canScrollDown,
			deltaY: event.deltaY,
			deltaX: event.deltaX,
			deltaMode: event.deltaMode,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			targetInOutline,
			insideEnvelope: this.pointer.insideEnvelope,
			viewportHeight: this.viewportBottom - this.viewportTop,
		});
		const perf = this.perf;
		if (perf?.active === true) {
			perf.count("wheelEventCount");
			if (decision.action === "outline") {
				perf.count("wheelOutlineCount");
			} else if (decision.action === "editor") {
				perf.count("wheelEditorHandoffCount");
			} else {
				perf.count("wheelIgnoredCount");
			}
		}
		if (decision.action !== "outline") return; // native path untouched
		event.preventDefault();
		event.stopPropagation();
		// §四.2: counted as a scrollTop mutation / boundary clamp, but NOT
		// as a scrollTopWrite phase sample — the sub-phases stay a strict
		// decomposition of the RAF autoScroll total.
		this.writeScrollTop(
			decision.deltaPx,
			perf?.active === true ? perf : undefined,
			false,
			"manual-wheel",
		);
		this.startManualWheelCooldown();
	};

	/** §十.5/§十一: (re)start the 160 ms cooldown that pauses edge
	 * auto-scroll AND pointer-follow. Counted once per cooldown WINDOW
	 * (consecutive wheel ticks extend the window, they do not re-count).
	 * NOT a pointer exit: intents stop with "manual-wheel", the applied
	 * velocity is smoothly zeroed by the integrator, and the outline
	 * never collapses on wheel. */
	private startManualWheelCooldown(): void {
		const now = this.win.performance.now();
		if (now >= this.integrator.manualWheelCooldownUntil) {
			this.perf?.count("wheelCooldownStartCount");
			this.perf?.count("manualWheelCooldownCount");
		}
		this.integrator.manualWheelCooldownUntil =
			now + MANUAL_WHEEL_COOLDOWN_MS;
		this.stopEdgeIntent("manual-wheel");
		this.stopKineticIntent("manual-wheel");
		this.schedule();
	}

	/**
	 * Deferred window containment test (sections 4 + 7). Runs inside the
	 * frame AFTER the envelope was refreshed. Inside the envelope →
	 * cancel any armed collapse (the pointer never really left — this is
	 * the section 7 fix; previously the inside case did nothing and a
	 * stale grace timer could still fire). Outside → arm the collapse.
	 */
	private processWindowCheck(): void {
		if (!this.windowCheckPending) return;
		this.windowCheckPending = false;
		const sample = this.pendingPointerSample;
		this.pendingPointerSample = null;
		// Degenerate envelope (no measurable geometry — e.g. jsdom, or a
		// detached/zero-size outline): never base a collapse decision on a
		// zero rect. Trust element-level enter/move/leave state instead.
		if (!this.envelopeIsMeasurable()) {
			// §十: with no geometry to test against we cannot claim the
			// pointer left, and the element-level state still says it is
			// interacting — so the sample is as trustworthy as any other.
			if (sample && this.pointer.insideEnvelope) {
				this.sampleKinematics(
					sample.pointerId,
					sample.clientY,
					sample.timeStamp,
				);
			}
			return;
		}
		if (
			pointInEnvelope(
				this.envelope,
				this.lastPointerX,
				this.lastPointerY,
				this.clientYToContentY(this.lastPointerY),
			)
		) {
			// §十二: a window-level move that lands inside the envelope is a
			// gap crossing, not an exit — the latch (if any) survives.
			this.pointer.insideEnvelope = true;
			this.pointer.overElement = false;
			// §十 GAP SAMPLING: the gesture did not pause just because the
			// pointer crossed a transparent stripe. Commit the parked
			// sample so the velocity ring stays continuous; without this
			// the ring starves over every gap, `velocityY` decays to 0 and
			// the follow visibly stutters mid-flick.
			if (sample) {
				this.sampleKinematics(
					sample.pointerId,
					sample.clientY,
					sample.timeStamp,
				);
			}
			this.cancelCollapse();
			return;
		}
		this.pointer.overElement = false;
		this.pointer.insideEnvelope = false;
		this.pointerAnchorEl = null;
		this.anchorDirty = false;
		this.resetAllScrollIntent("pointer-left");
		this.armCollapse();
	}

	/**
	 * Whether the geometric envelope carries real geometry. When it is empty
	 * or has zero area (common in headless tests and right after mount before
	 * layout settles) it cannot authoritatively say the pointer left — so a
	 * window-level move must not collapse the outline on that basis.
	 */
	private envelopeIsMeasurable(): boolean {
		const e = this.envelope;
		if (!e.items.length) return false;
		let area = 0;
		if (e.railRect.right > e.railRect.left && e.railRect.bottom > e.railRect.top) {
			area += (e.railRect.right - e.railRect.left) * (e.railRect.bottom - e.railRect.top);
		}
		for (const item of e.items) {
			// Use the RAW marker/card rects: the bridge carries a fixed
			// tolerance, so it has nonzero area even around zero-size rects.
			for (const r of [item.markerRect, item.cardRect]) {
				if (r.right > r.left && r.bottom > r.top) {
					area += (r.right - r.left) * (r.bottom - r.top);
				}
			}
		}
		return area > 0;
	}

	/** Collapse grace: only fires when the pointer truly left the envelope. */
	private armCollapse(): void {
		this.cancelCollapse();
		this.collapseTimer = this.win.setTimeout(() => {
			this.collapseTimer = 0;
			this.pointerExpanded = false;
			this.syncExpanded();
		}, COLLAPSE_GRACE_MS);
	}

	/**
	 * §九/§十 Feed the kinetic velocity ring from a pointer move. Element and
	 * window listeners both call this; the (pointerId:timeStamp) key dedups
	 * the same physical event so it is sampled only once. Pure math on event
	 * fields — allowed in the input-only handler. The ring computes a
	 * smoothed, direction-stable velocity that the frame loop decays between
	 * events (a stopped pointer stops assisting within a few frames).
	 */
	private trackPointerVelocity(event: PointerEvent): void {
		this.sampleKinematics(event.pointerId, event.clientY, event.timeStamp);
	}

	/**
	 * §十 Core of the velocity ring update, shared by the element path
	 * (immediate) and the transparent-gap path (deferred through
	 * `pendingPointerSample` → `processWindowCheck`).
	 */
	private sampleKinematics(
		pointerId: number,
		clientY: number,
		timeStamp: number,
	): void {
		const id = `${pointerId}:${timeStamp}`;
		if (id === this.lastSampleEventId) return; // dedup double dispatch
		this.lastSampleEventId = id;
		const kin = this.kinematics;
		kin.samples.push(clientY, timeStamp);
		kin.lastSampleTime = timeStamp;
		kin.velocityY = kin.samples.velocityY(timeStamp);
		kin.active = kin.samples.active;
		// §十: predict from THIS sample's position. The previous code read
		// `this.lastPointerY`, which the element handler had not updated
		// yet — the prediction was anchored one whole move behind the
		// pointer, which is exactly the lag the lookahead exists to remove.
		kin.predictedY = predictedPointerY(clientY, kin.velocityY);
	}

	private onRootPointerDown = (event: PointerEvent): void => {
		const activation = resolveClickTarget(event.target, this.ownsNode);
		if (!activation) return; // not on a real marker / card
		const item = this.view.getItems().find((c) => c.key === activation.key);
		if (!item) return;
		const targetEl = closestOwned(
			event.target,
			".glide-outline-marker, .glide-outline-card",
			this.ownsNode,
		) as HTMLElement | null;
		if (!targetEl) return;
		const rect = targetEl.getBoundingClientRect();
		const pressed: PressedHeadingState = {
			pointerId: event.pointerId,
			headingKey: activation.key,
			targetType: activation.targetType,
			downX: event.clientX,
			downY: event.clientY,
			targetRect: {
				left: rect.left,
				top: rect.top,
				right: rect.right,
				bottom: rect.bottom,
			},
			captured: null,
		};
		// Stop ALL scroll intents while the target is held (§十一).
		this.pressed = pressed;
		this.resetAllScrollIntent("pressed");
		// Section 12: freezing is structural — the frame loop is suspended
		// while pressed (schedule() refuses, frame() early-returns), and no
		// CSS transition remains on the continuous transforms, so BOTH the
		// target and displayed values hold perfectly still. The locked rect
		// stays valid until pointerup without any DOM re-reads.
		try {
			targetEl.setPointerCapture(event.pointerId);
			pressed.captured = targetEl;
		} catch {
			// Pointer capture unsupported here — fall back to coordinate test.
		}
	};

	private onRootPointerUp = (event: PointerEvent): void => {
		const pressed = this.pressed;
		if (!pressed || event.pointerId !== pressed.pointerId) return;
		this.pressed = null;
		if (pressed.captured) {
			try {
				pressed.captured.releasePointerCapture(event.pointerId);
			} catch {
				// Capture already released — ignore.
			}
		}
		const r = pressed.targetRect;
		const inside =
			event.clientX >= r.left - ACTIVATION_RELEASE_TOLERANCE &&
			event.clientX <= r.right + ACTIVATION_RELEASE_TOLERANCE &&
			event.clientY >= r.top - ACTIVATION_RELEASE_TOLERANCE &&
			event.clientY <= r.bottom + ACTIVATION_RELEASE_TOLERANCE;
		const item = this.view.getItems().find((c) => c.key === pressed.headingKey);
		if (inside && item) {
			this.diagnostics?.recordPointerActivation({
				headingKey: item.key,
				headingText: item.text,
				headingLine: item.line,
				targetType: pressed.targetType,
				downX: pressed.downX,
				downY: pressed.downY,
				upX: event.clientX,
				upY: event.clientY,
				accepted: true,
			});
			// Resume magnification / auto-scroll on the next frame.
			this.schedule();
			this.onJump?.(item);
		} else {
			this.diagnostics?.recordPointerActivation({
				headingKey: pressed.headingKey,
				headingText: item?.text ?? "",
				headingLine: item?.line ?? -1,
				targetType: pressed.targetType,
				downX: pressed.downX,
				downY: pressed.downY,
				upX: event.clientX,
				upY: event.clientY,
				accepted: false,
				rejectionReason: inside ? "heading-not-found" : "release-outside-target",
			});
			this.schedule();
		}
	};

	private onRootPointerCancel = (event: PointerEvent): void => {
		const pressed = this.pressed;
		if (!pressed || event.pointerId !== pressed.pointerId) return;
		this.clearPressed();
		this.schedule();
	};

	private onWindowBlur = (): void => {
		this.clearPressed();
		this.resetAllScrollIntent("window-blur");
		this.pointer.overElement = false;
		this.pointer.insideEnvelope = false;
		this.pointerAnchorEl = null;
		this.anchorDirty = false;
		this.armCollapse();
	};

	/** Release any held pointer target cleanly (pointercancel / blur / dispose). */
	private clearPressed(): void {
		if (!this.pressed) return;
		const pressed = this.pressed;
		if (pressed.captured) {
			try {
				pressed.captured.releasePointerCapture(pressed.pointerId);
			} catch {
				// Already released.
			}
		}
		this.pressed = null;
	}

	private cancelCollapse(): void {
		if (this.collapseTimer !== 0) {
			this.win.clearTimeout(this.collapseTimer);
			this.collapseTimer = 0;
		}
	}

	private syncExpanded(): void {
		const expanded = this.isExpanded();
		if (expanded === this.view.isExpanded()) {
			// Still update follow state: pointer inside ⇒ follow paused.
			this.view.setFollowEnabled(!expanded);
			return;
		}
		this.view.setExpanded(expanded);
		this.view.setFollowEnabled(!expanded);
		if (!expanded) {
			this.cancelFrame();
			this.resetAllScrollIntent("collapsed");
			this.clearMagnification();
			this.envelope = { railRect: emptyRect(), items: [] };
			this.envelopeMotionShift.clear();
			this.envelopeMotionScale.clear();
			this.envelopeRangeStart = -1;
			this.envelopeRangeEnd = -1;
			this.activeRange = emptyActiveRange();
			this.windowCheckPending = false;
			this.lastMotionTime = Number.NaN;
		} else {
			// §七: expanding refreshes the envelope on demand; the geometry
			// cache stays valid (row layout is expansion-invariant).
			this.envelopeDirty = true;
			this.schedule();
		}
	}

	private schedule(): void {
		if (this.rafId !== 0 || this.pressed) return;
		this.rafId = this.win.requestAnimationFrame(this.frame);
	}

	private cancelFrame(): void {
		if (this.rafId !== 0) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
	}

	/**
	 * The coordinated frame: READ phase → PURE CALC → WRITE phase
	 * (section 13). This is the ONLY place that reads rects or writes
	 * styles while the pointer interacts with the outline.
	 */
	private frame = (frameTs?: number): void => {
		this.rafId = 0;
		// While a heading is held (pointerdown) the loop is suspended so
		// the locked target cannot slide away; auto-scroll already stopped.
		if (this.pressed) return;
		if (!this.isExpanded()) return;
		const now =
			typeof frameTs === "number" && Number.isFinite(frameTs)
				? frameTs
				: this.win.performance.now();
		const perf = this.perf;
		const measure = perf?.active === true;
		// §四: one exclusive attribution cursor per frame. Each boundary is
		// a single clock read shared by the segment that closes and the one
		// that opens, so n phases cost n+1 reads instead of 2n.
		if (measure && perf) {
			perf.beginFrameAttribution(this.win.performance.now());
		}
		// §三: fine-grained sub-phase timing is a DEEP capture only. Every
		// site below that reads the clock for a sub-phase checks THIS, not
		// `measure` — the clock read is the cost being avoided.
		// §3.2: read AFTER the rotation advanced above, so the flag and the
		// capture's own gate agree for the whole frame.
		const measureDeep = perf?.deepFrameCalcActive === true;
		perf?.recordFrame(now);

		// ---------------- READ PHASE (DOM geometry) ----------------
		if (this.cacheDirty) this.rebuildCache();
		if (this.cache.length === 0) {
			if (measure && perf) {
				const readEnd = this.win.performance.now();
				perf.markPhase("read", readEnd);
				perf.endFrameAttribution(readEnd);
			}
			this.endFrame();
			return;
		}
		const settings = this.getSettings();
		// Envelope/compat window from cached numbers (pure, O(log n)).
		this.activeRange = this.computeRange();
		// §六: the range slides with the pointer. Cached rects stay valid
		// for the rows they were collected for, and only for those.
		if (!this.envelopeCoversActiveRange()) this.envelopeDirty = true;
		// §十四 gating: a stale envelope is only rebuilt when a containment
		// decision actually needs it (a deferred window check is pending).
		// Motion keeps the cached rects fresh mathematically (see the write
		// phase), so frames without a pending check skip the rect reads.
		if (this.envelopeDirty && this.windowCheckPending) {
			this.rebuildEnvelope();
		}

		// Deferred window containment test — pure math on cached rects.
		this.processWindowCheck();
		if (measure && perf) {
			perf.markPhase("read", this.win.performance.now());
		}

		if (Number.isNaN(this.lastPointerY)) {
			if (measure && perf) {
				const idleEnd = this.win.performance.now();
				perf.markPhase("pureCalc", idleEnd);
				perf.endFrameAttribution(idleEnd);
			}
			this.endFrame();
			return;
		}

		// ---------------- PURE CALC PHASE ----------------
		// §六/§八: an outline scroll since the last frame moved the rows
		// under the pointer. Re-resolve the anchor ONCE here from cached
		// content-space geometry (the scroll handler itself stays O(1)).
		const scrolledSinceLastFrame = this.anchorScrollStale;
		if (this.anchorScrollStale) {
			this.anchorScrollStale = false;
			// §四.2 scrollAnchorResolve: re-resolving the pointer anchor
			// after the content offset moved under it. Nested inside
			// pureCalc — DEEP only (§三).
			const anchorResolveStart = measureDeep
				? this.win.performance.now()
				: 0;
			this.refreshPointerAnchorAfterScroll();
			if (measureDeep && perf) {
				perf.addPhaseSample(
					"scrollAnchorResolve",
					this.win.performance.now() - anchorResolveStart,
				);
			}
		}
		// Resolve the magnification anchor from the last pointer target.
		// `closest` is an ancestor-tree walk (no layout access).
		if (this.anchorDirty) {
			this.anchorDirty = false;
			this.pointerAnchorEl = closestOwned(
				this.pendingAnchorTarget,
				".glide-outline-row",
				this.ownsNode,
			) as HTMLElement | null;
			this.pendingAnchorTarget = null;
			this.resolveAnchorIndex(); // refresh the §八 local-probe seed
		}

		// Motion policy is always FULL — the user-facing setting was
		// removed and prefers-reduced-motion is deliberately not honoured.

		// Time-based interpolation step (frame-rate independent).
		const dtMs = Number.isFinite(this.lastMotionTime)
			? Math.min(MAX_MOTION_DT_MS, Math.max(0, now - this.lastMotionTime))
			: DEFAULT_MOTION_DT_MS;
		this.lastMotionTime = now;
		const alpha = motionAlpha(dtMs);
		const dpr = this.win.devicePixelRatio || 1;

		// §六: the cache is content-space, so the two moving inputs (the
		// pointer and the visible window) are converted ONCE per frame —
		// two subtractions instead of a per-row rewrite on every scroll.
		// §四.2 scrollEnvelopeUpdate: when a scroll happened since the
		// last frame, this conversion IS the envelope/viewport geometry
		// update the scroll caused (the item rects themselves are content-
		// space and deliberately untouched by scrolling).
		const envUpdateStart =
			measureDeep && scrolledSinceLastFrame
				? this.win.performance.now()
				: 0;
		const pointerContentY = this.clientYToContentY(this.lastPointerY);
		const contentWindow = this.contentRangeForViewport();
		if (measureDeep && scrolledSinceLastFrame && perf) {
			perf.addPhaseSample(
				"scrollEnvelopeUpdate",
				this.win.performance.now() - envUpdateStart,
			);
		}

		// ---------------- §四 three independent ranges ----------------
		// 1) SCALE range: pointerY ± radius (+1 overscan). Answers "which
		//    rows may have scale > 1" and is NEVER enlarged by collision
		//    propagation (the solver's radius falloff enforces this).
		this.scaleRange = computeScaleRange({
			centers: this.centers,
			heights: this.heights,
			pointerY: pointerContentY,
			radius: settings.radius,
		});
		// 2) COLLISION range seed = Visible ∪ Scale + guard. §五 safe
		//    fallback: the visible window is ALWAYS included, so every
		//    on-screen adjacent pair is covered by the solver — the §三
		//    regression (boundary rows colliding with untouched outside
		//    rows) cannot re-enter through a too-small slice. Settling rows
		//    are deliberately NOT folded into the seed: they only need
		//    identity targets (handled by the iteration window below), and
		//    seeding them would let the range creep outward frame over
		//    frame as freshly written rows re-enter the seed.
		const visibleRange = computeVisibleRange({
			centers: this.centers,
			heights: this.heights,
			viewportTop: contentWindow.top,
			viewportBottom: contentWindow.bottom,
		});
		const rowCount = this.cache.length;
		let cStart = Number.MAX_SAFE_INTEGER;
		let cEnd = -1;
		// Seed = Visible ∪ Scale only. Settling rows are deliberately NOT
		// folded into the seed: taper rows written outside the slice carry
		// pairwise deltas of ≤ COLLISION_TAPER_STEP_PX and interpolate home
		// with a shared alpha, so their pairs stay feasible without being
		// re-solved. Seeding them would let the range creep outward frame
		// over frame as freshly written taper rows re-enter the seed
		// (§九/§十 write-budget violation).
		for (const range of [visibleRange, this.scaleRange]) {
			if (!isEmptyActiveRange(range)) {
				cStart = Math.min(cStart, range.start);
				cEnd = Math.max(cEnd, range.end);
			}
		}
		const collisionEmpty = cEnd < cStart;
		if (!collisionEmpty) {
			cStart = Math.max(0, cStart - COLLISION_GUARD_ROWS);
			cEnd = Math.min(rowCount - 1, cEnd + COLLISION_GUARD_ROWS);
		}

		// 3) Solve ONCE over the core slice (Visible ∪ Scale ∪ Settling +
		//    guard). The anchored solver keeps every pair inside the slice
		//    feasible; the boundary rows may carry a residual push that
		//    would collide with the identity rows just outside.
		let results: {
			scale: number;
			translateY: number;
			/** Taper row: displayed follows target directly (no interp). */
			snap?: boolean;
		}[] = [];
		if (!collisionEmpty) {
			const anchorIndex = this.resolveAnchorIndex();
			const activeLayout = this.layout.slice(cStart, cEnd + 1);
			const activeShifts = this.shifts.slice(cStart, cEnd + 1);
			const anchorInSlice =
				anchorIndex >= cStart && anchorIndex <= cEnd
					? anchorIndex - cStart
					: -1;
			// §四: the solver gets its own exclusive segment. Its duration
			// comes from the two cursor boundaries that already had to be
			// read — the solver sample costs ZERO extra clock reads.
			const solverStart = measure ? this.win.performance.now() : 0;
			if (measure && perf) perf.markPhase("pureCalc", solverStart);
			results = computeCollisionFreeMagnification(
				pointerContentY,
				activeLayout,
				settings.maxScale,
				settings.radius,
				settings.cardGap,
				false,
				{
					currentShifts: activeShifts,
					preferredAnchorIndex: anchorInSlice,
				},
			);
			if (measure && perf) {
				const solverEnd = this.win.performance.now();
				perf.markPhase("collisionSolve", solverEnd);
				perf.addSolverSample(solverEnd - solverStart, activeLayout.length);
			}
			// §四/§六 boundary buffer — LOCKSTEP SNAP with OFFSCREEN GAP
			// RELAXATION. The solved boundary row carries a residual push
			// that identity rows just outside would overlap. Instead of a
			// fixed 1px/row taper (which needs |shift| rows and inflated
			// the collision range to ~78 rows avg, §三 perf regression),
			// each offscreen buffer pair may COMPRESS its gap from the
			// base clearance down to 0 (and one tolerance unit into
			// overlap) to absorb the push locally. The per-row step is
			// therefore max(baseGap, tolerance) — for a real cardGap of
			// 6 the push absorbs in ~E/6 rows instead of E rows.
			//   • buffer rows SNAP (displayed = target) and are re-anchored
			//     every frame to the boundary row's predicted WRITTEN
			//     shift, so chain values stay grid-aligned with zero
			//     rounding noise;
			//   • the seam compensates the boundary row's scaled half-height
			//     growth h·(s−1)/2;
			//   • the chain BRIDGES toward legacy settling fields (compares
			//     the outer row's predicted written shift) instead of
			//     cliff-dropping to 0;
			//   • for cardGap=0 layouts (baseGap=0) the step collapses to
			//     the tolerance — the original 1px taper, still feasible.
			// Visible pairs keep strict cardGap (solver + headroom); only
			// OFFSCREEN active pairs may relax (§六.1 contract). Far rows
			// stay identity and are never written (§九/§十 budget).
			const taperBoundary = (up: boolean): void => {
				const edgeIdx0 = up ? cStart : cEnd;
				const edge = up ? results[0] : results[results.length - 1];
				if (!edge || edge.translateY === 0) return;
				const edgeMotion = this.cache[edgeIdx0]?.motion;
				// Predicted post-step written shift of the boundary row.
				const predictedShift = edgeMotion
					? stepToward(
							edgeMotion.displayedShift,
							edge.translateY,
							alpha,
							SHIFT_EPSILON,
						)
					: edge.translateY;
				// Predicted on-screen scale this frame (max of target and
				// post-step displayed — covers growth AND settling decay).
				const predictedScale = edgeMotion
					? stepToward(
							edgeMotion.displayedScale,
							edge.scale,
							alpha,
							SCALE_EPSILON,
						)
					: edge.scale;
				const edgeScale = Math.max(edge.scale, predictedScale);
				const growth = Math.max(
					0,
					((this.heights[edgeIdx0] ?? 0) * (edgeScale - 1)) / 2,
				);
				// Quantized UP + epsilon margin: keeps the seam within
				// tolerance even when the boundary write is epsilon-
				// skipped, and stays on the DPR grid so buffer values
				// snap to themselves.
				const growthQ =
					Math.ceil((growth + SHIFT_EPSILON) * dpr) / dpr;
				let shift = quantizeShift(predictedShift, dpr);
				shift =
					Math.round((shift + (up ? -growthQ : growthQ)) * 100) /
					100;
				let added = 0;
				while (added < COLLISION_TAPER_MAX_ROWS) {
					const next = up ? cStart - 1 : cEnd + 1;
					if (next < 0 || next > rowCount - 1) break;
					// §六: the per-row step. The buffer may compress each
					// offscreen pair's gap from its base clearance down to 0
					// to absorb the push locally — BUT only once the apron
					// (first rows, half-pixel) has put enough rows between
					// the relaxation and the visible boundary. The apron
					// rows close by only 0.5px (within tolerance even if
					// they scroll into view before converging); the full
					// gap relaxation beyond them is far enough off-screen to
					// converge first.
					// §六 CORRECTNESS GUARD: gap relaxation creates buffer
					// rows whose DISPLAYED gap is below cardGap. During fast
					// kinetic scroll (strong pointer-follow) those rows enter
					// the visible range before the displayed state converges
					// back to the strict solver target, surfacing as visible
					// overlap (3.27px = h·(s−1)/2, the scaled boundary
					// growth). Until sparse-write / scroll-offset work lets
					// us shrink the range WITHOUT relaxing gaps, the far
					// zone uses the 1px tolerance taper (same as v1, 0
					// overlaps) — the perf cost is accepted per §四 priority
					// #1 (visibleOverlapViolationCount = 0).
					const stepBudget =
						added < COLLISION_TAPER_APRON_ROWS
							? COLLISION_TAPER_APRON_STEP_PX
							: OVERLAP_TOLERANCE_PX;
					// Bridge: stop when the outer row's predicted settling
					// write is within one absorption of the chain — the
					// seam pair is feasible as written and the rows beyond
					// stay on their own course.
					const om = this.cache[next]?.motion;
					const outerWritten = om
						? quantizeShift(
								stepToward(
									om.displayedShift,
									0,
									alpha,
									SHIFT_EPSILON,
								),
								dpr,
							)
						: 0;
					const delta = outerWritten - shift;
					if (Math.abs(delta) <= stepBudget) break;
					// Step TOWARD the outer field by the budget, not toward
					// 0 — the legacy settling field may sit on the opposite
					// side of 0, and a walk-to-0 chain would cliff against
					// it (§三: 9px seam at the chain end).
					const stepPx = Math.min(Math.abs(delta), stepBudget);
					shift =
						Math.round(
							(shift + Math.sign(delta) * stepPx) * 100,
						) / 100;
					const r = {
						scale: 1,
						translateY: shift,
						snap: true,
					};
					if (up) {
						results.unshift(r);
						cStart = next;
					} else {
						results.push(r);
						cEnd = next;
					}
					added++;
				}
				if (measure && perf && added > 0) {
					perf.addCollisionExpansionSample(added);
					perf.count("boundarySafetyRetryCount");
				}
			};
			taperBoundary(true);
			taperBoundary(false);
		}
		this.collisionRange = collisionEmpty
			? emptyActiveRange()
			: { start: cStart, end: cEnd };

		// §九 per-frame write order = Collision ∪ Dirty, SPARSE.
		// Dirty rows OUTSIDE the collision range get identity targets and
		// interpolate home; rows in neither set are clean by invariant and
		// are never visited — not even to be skipped. Ascending order is
		// produced by a merge (the collision block is already sorted, the
		// outside rows are few), so no per-frame full sort is needed.
		const outside = this.outsideDirty;
		outside.length = 0;
		if (this.dirtyRows.size > 0) {
			for (const i of this.dirtyRows) {
				if (i < 0 || i >= rowCount) {
					// The row vanished with a rebuild — drop the stale index.
					this.dirtyRows.delete(i);
					continue;
				}
				if (!collisionEmpty && i >= cStart && i <= cEnd) continue;
				outside.push(i);
			}
			if (outside.length > 1) outside.sort(ascending);
		}
		const order = this.writeOrder;
		order.length = 0;
		let outsideCursor = 0;
		if (collisionEmpty) {
			for (const i of outside) order.push(i);
		} else {
			while (
				outsideCursor < outside.length &&
				outside[outsideCursor] < cStart
			) {
				order.push(outside[outsideCursor++]);
			}
			for (let i = cStart; i <= cEnd; i++) order.push(i);
			while (outsideCursor < outside.length) {
				order.push(outside[outsideCursor++]);
			}
		}

		// ---------------- WRITE PHASE (styles only) ----------------
		if (measure && perf) {
			perf.markPhase("pureCalc", this.win.performance.now());
		}
		let converging = false;
		let writes = 0;
		// §九 churn / skip diagnostics for this frame.
		let dirtyAdded = 0;
		let dirtyRemoved = 0;
		let identitySkipped = 0;
		for (const i of order) {
			const entry = this.cache[i];
			const state = entry.motion;
			const inMotion = !collisionEmpty && i >= cStart && i <= cEnd;
			if (inMotion) {
				const r = results[i - cStart];
				state.targetScale = r.scale;
				state.targetShift = r.translateY;
				// §四/§六 snap: taper chain rows jump straight to target
				// (the target already tracks the boundary's per-frame
				// interpolation, so interpolating on top would lag the
				// anchor and reopen the seam).
				if (r.snap) {
					state.displayedScale = r.scale;
					state.displayedShift = r.translateY;
				}
				entry.wasSnapped = false;
			} else {
				state.targetScale = 1;
				state.targetShift = 0;
				entry.wasSnapped = false;
				// Fast skip: fully idle row — no interpolation, no writes,
				// no repeated identity resets (section 10/14). It leaves
				// the dirty set here and is not visited again until it
				// moves.
				if (
					state.displayedScale === 1 &&
					state.displayedShift === 0 &&
					Number.isNaN(entry.lastWrittenScale) &&
					Number.isNaN(entry.lastWrittenShift)
				) {
					if (entry.shifting) {
						entry.el.classList.remove(MOTION_SHIFT_CLASS);
						entry.shifting = false;
					}
					if (entry.scaling) {
						entry.el.classList.remove(MOTION_SCALE_CLASS);
						entry.scaling = false;
					}
					entry.contentVisualCenter = entry.contentCenter;
					this.shifts[i] = 0;
					identitySkipped++;
					if (this.dirtyRows.delete(i)) dirtyRemoved++;
					continue;
				}
			}
			if (stepMotionState(state, alpha)) converging = true;
			writes += this.applyRowStyle(entry, dpr);
			// §九 split GPU layer hints (section 15): each axis holds its
			// hint exactly while THAT axis is in motion or displaced —
			// dropped on convergence back to identity, on range exit and
			// on collapse/dispose. A scaling-only anchor never promotes
			// its shift layer (and vice versa), so resting text stays on
			// the crisp non-composited raster path.
			const atIdentity =
				motionStateConverged(state) &&
				state.targetScale === 1 &&
				state.targetShift === 0;
			const shifting =
				!atIdentity &&
				(state.targetShift !== 0 ||
					Math.abs(state.displayedShift) >= SHIFT_EPSILON);
			const scaling =
				!atIdentity &&
				(state.targetScale !== 1 ||
					Math.abs(state.displayedScale - 1) >= SCALE_EPSILON);
			if (shifting !== entry.shifting) {
				entry.el.classList.toggle(MOTION_SHIFT_CLASS, shifting);
				entry.shifting = shifting;
			}
			if (scaling !== entry.scaling) {
				entry.el.classList.toggle(MOTION_SCALE_CLASS, scaling);
				entry.scaling = scaling;
			}
			// Keep the visual model in lockstep with what is on screen.
			entry.contentVisualCenter =
				entry.contentCenter + state.displayedShift;
			this.shifts[i] = state.displayedShift;
			// §六/§九: a row stays in the dirty set until it is completely
			// clean — identity, vars removed, classes off. Membership is
			// updated in place so the set never has to be rebuilt.
			const clean =
				atIdentity &&
				Number.isNaN(entry.lastWrittenScale) &&
				Number.isNaN(entry.lastWrittenShift) &&
				!entry.shifting &&
				!entry.scaling;
			if (clean) {
				if (this.dirtyRows.delete(i)) dirtyRemoved++;
			} else if (!this.dirtyRows.has(i)) {
				this.dirtyRows.add(i);
				dirtyAdded++;
			}
		}
		if (measure && perf) {
			perf.markPhase("styleWrite", this.win.performance.now());
			// §十四 range statistics. WRITE range = rows still dirty
			// (unconverged / carrying vars or layer classes) — now the
			// true sparse count, not the span it happens to occupy.
			const scaleRows = isEmptyActiveRange(this.scaleRange)
				? 0
				: this.scaleRange.end - this.scaleRange.start + 1;
			const collisionRows = collisionEmpty ? 0 : cEnd - cStart + 1;
			const writeRows = this.dirtyRows.size;
			perf.addRangeSample(scaleRows, collisionRows, writeRows);
			// §九 sparse dirty-row telemetry: how many rows the next frame
			// must revisit, how many were visited only to be skipped at
			// identity, and how much the set churns frame over frame.
			perf.addDirtyRowsSample(writeRows, identitySkipped);
			if (dirtyAdded > 0 || dirtyRemoved > 0) {
				perf.addDirtyRowChurn(dirtyAdded, dirtyRemoved);
			}
			// §十四 correctness diagnostic (capture-only, never a standing
			// hot path): displayed visual boxes of adjacent VISIBLE rows
			// must keep cardGap within tolerance.
			for (let i = visibleRange.start; i < visibleRange.end; i++) {
				const a = this.cache[i];
				const b = this.cache[i + 1];
				if (!a || !b) break;
				const aBottom =
					this.centers[i] +
					a.motion.displayedShift +
					(this.heights[i] * a.motion.displayedScale) / 2;
				const bTop =
					this.centers[i + 1] +
					b.motion.displayedShift -
					(this.heights[i + 1] * b.motion.displayedScale) / 2;
				perf.recordOverlap(
					aBottom + settings.cardGap - bTop,
					OVERLAP_TOLERANCE_PX,
				);
			}
			// §四: this whole block exists only because a capture is
			// running. Book it to nobody rather than letting it inflate
			// the phase that happens to follow it.
			perf.markPhase("unattributedFrameJs", this.win.performance.now());
		}
		if (writes > 0) {
			perf?.count("cssVarWriteCount", writes);
			// §十四: card/marker rects moved with the motion — derive the
			// cached envelope rects mathematically from the displayed
			// shift/scale deltas instead of re-reading layout. Only rows
			// whose item is missing from the cache fall back to a dirty
			// flag (→ full rebuild on the next needed containment check).
			this.updateEnvelopeFromMotion();
			if (measure && perf) {
				perf.markPhase(
					"envelopeMotionUpdate",
					this.win.performance.now(),
				);
			}
		}
		// Keep the loop alive until every displayed value converged.
		if (converging) this.schedule();

		// Pointer edge auto-scroll + pointer-follow share this frame.
		// Scrolling shifts the cached geometry by delta (scroll handler),
		// so the next frame sees correct centers without any rect reads.
		this.stepAutoScroll(settings);
		if (measure && perf) {
			// §四: closing mark and frame close share one clock read; the
			// remainder (RAF entry glue, the capture's own bookkeeping)
			// lands in unattributedFrameJs and the two reconcile exactly.
			const frameEnd = this.win.performance.now();
			perf.markPhase("autoScroll", frameEnd);
			perf.endFrameAttribution(frameEnd);
		}
		this.endFrame();
	};

	/** Frame epilogue: break perf interval chains when the loop idles. */
	private endFrame(): void {
		// §十: age the frame-counted attribution notes.
		if (this.scrollAttribution && --this.scrollAttribution.ttl <= 0) {
			this.scrollAttribution = null;
		}
		if (this.fileChangeTtl > 0) this.fileChangeTtl--;
		if (this.modeChangeTtl > 0) this.modeChangeTtl--;
		if (this.rafId === 0) {
			this.perf?.markFrameGap();
			this.lastMotionTime = Number.NaN;
		}
	}

	/**
	 * Write CSS vars for one row, thresholded (section 14): only when the
	 * displayed value moved at least epsilon from what is already applied.
	 * A row converged at identity has its properties REMOVED once and is
	 * never rewritten until it moves again.
	 * Returns the number of style writes performed.
	 */
	private applyRowStyle(entry: CachedItem, dpr: number): number {
		const state = entry.motion;
		const el = entry.el;
		let writes = 0;
		const atIdentity =
			motionStateConverged(state) &&
			state.targetScale === 1 &&
			state.targetShift === 0;
		if (atIdentity) {
			if (
				!Number.isNaN(entry.lastWrittenScale) ||
				!Number.isNaN(entry.lastWrittenShift)
			) {
				el.style.removeProperty("--glide-scale");
				el.style.removeProperty("--glide-shift-y");
				entry.lastWrittenScale = Number.NaN;
				entry.lastWrittenShift = Number.NaN;
				writes += 2;
			}
			return writes;
		}
		// §十七: write QUANTIZED values (scale 1e-4, shift device-pixel
		// aligned, §九.3). The epsilon guard compares against the last
		// quantized write, so sub-quantum interpolation churn never
		// reaches the style system.
		const scale = quantizeScale(state.displayedScale);
		const scaleBase = Number.isNaN(entry.lastWrittenScale)
			? 1
			: entry.lastWrittenScale;
		if (scale !== scaleBase && Math.abs(scale - scaleBase) >= SCALE_EPSILON) {
			el.style.setProperty("--glide-scale", String(scale));
			entry.lastWrittenScale = scale;
			writes++;
		}
		const shift = quantizeShift(state.displayedShift, dpr);
		const shiftBase = Number.isNaN(entry.lastWrittenShift)
			? 0
			: entry.lastWrittenShift;
		if (shift !== shiftBase && Math.abs(shift - shiftBase) >= SHIFT_EPSILON) {
			el.style.setProperty("--glide-shift-y", `${shift}px`);
			entry.lastWrittenShift = shift;
			writes++;
		}
		return writes;
	}

	/**
	 * §七 ScrollIntentCoordinator — one step inside the coordinated RAF.
	 *
	 * Two INDEPENDENT intents feed one shared integrator (§十三: they only
	 * ever change scrollTop; magnification reacts through the scroll
	 * handler's delta path):
	 *
	 *   1. EDGE intent — POSITION-ONLY (§八), dwell-gated, latched with
	 *      hysteresis:
	 *        idle ──(edge target≠0, dwell passes)──▶ latched
	 *        latched ──(gap crossing / jitter / <12 px retreat)──▶ latched
	 *        latched ──(explicit stop reason)──▶ idle, reason recorded
	 *   2. KINETIC intent — velocity-driven pointer-follow (§九), NO
	 *      dwell, NO latch: the gesture itself is the intent signal; a
	 *      slow pointer never triggers; mid-viewport flicks work (depth
	 *      factor), and it stays alive through gap crossings (§十二 —
	 *      eligibility is insideEnvelope, independent from the edge
	 *      latch).
	 *
	 * combinedTarget = clamp(edge + kinetic, −maxSpeed, +maxSpeed), fed
	 * through the shared acceleration-capped damping. A manual wheel
	 * pauses BOTH for MANUAL_WHEEL_COOLDOWN_MS (§十一, not a pointer exit).
	 */
	private stepAutoScroll(settings: GlideOutlineSettings): void {
		const pointer = this.pointer;
		const integ = this.integrator;
		const perf = this.perf;
		const measure = perf?.active === true;
		// §四.2 scrollEligibility: everything that decides whether this
		// frame may auto-scroll at all — expansion/press gate, manual-wheel
		// cooldown, dt bookkeeping and ring-velocity decay.
		//
		// §三: every sub-phase below is DEEP-only. In LIGHT the whole step
		// is one exclusive `autoScroll` segment closed by the caller, so
		// this path adds ZERO telemetry clock reads.
		// §3.2: in DEEP it costs reads only while this group is armed.
		const measureDeep = perf?.deepAutoScrollIntentActive === true;
		const eligibilityStart = measureDeep ? this.win.performance.now() : 0;
		if (!this.pointerExpanded || this.pressed) {
			this.resetAllScrollIntent(this.pressed ? "pressed" : "collapsed");
			if (measureDeep && perf) {
				perf.addPhaseSample(
					"scrollEligibility",
					this.win.performance.now() - eligibilityStart,
				);
			}
			return;
		}
		const now = this.win.performance.now();

		// §十一 manual-wheel cooldown: the user's hand is on the wheel —
		// both mechanisms stay paused; the damped velocity restarts from 0
		// when the cooldown expires (the loop stays alive to resume).
		if (now < integ.manualWheelCooldownUntil) {
			integ.edgeIntentVelocity = 0;
			integ.kineticIntentVelocity = 0;
			integ.combinedTargetVelocity = 0;
			integ.appliedVelocity = 0;
			integ.lastFrameTime = Number.NaN;
			this.schedule();
			if (measureDeep && perf) {
				perf.addPhaseSample(
					"scrollEligibility",
					this.win.performance.now() - eligibilityStart,
				);
			}
			return;
		}

		const dt = Number.isNaN(integ.lastFrameTime)
			? 0
			: Math.min(0.05, (now - integ.lastFrameTime) / 1000);
		integ.lastFrameTime = now;

		// §九 decay: between pointermove events the ring velocity decays
		// exponentially (τ = POINTER_FOLLOW_DECAY_TAU_MS), so a stopped
		// pointer stops assisting within a few frames.
		const kin = this.kinematics;
		if (dt > 0 && kin.velocityY !== 0) {
			kin.velocityY *= Math.exp(
				(-dt * 1000) / POINTER_FOLLOW_DECAY_TAU_MS,
			);
			if (Math.abs(kin.velocityY) < 1) kin.velocityY = 0;
		}
		if (measureDeep && perf) {
			perf.addPhaseSample(
				"scrollEligibility",
				this.win.performance.now() - eligibilityStart,
			);
		}

		// P1-3: speed scales max velocity AND acceleration linearly, so the
		// ramp/damp character is identical at every speed setting.
		// §十一/§十六: edge and kinetic now have INDEPENDENT speed knobs —
		// edge uses pointerAutoScrollSpeed, kinetic uses pointerFollowStrength.
		const speed = settings.pointerAutoScrollSpeed;
		const followStrength = settings.pointerFollowStrength;
		const zonePx = settings.pointerAutoScrollZone;
		const edgeMaxSpeed = AUTO_SCROLL_MAX_SPEED * speed;
		const kineticMaxSpeed =
			AUTO_SCROLL_MAX_SPEED * POINTER_FOLLOW_MAX_SHARE * followStrength;
		// Combined clamp honours whichever mechanism can run faster.
		const combinedMaxSpeed = Math.max(edgeMaxSpeed, kineticMaxSpeed);
		const overflow = this.view.getOverflowState();

		// ---- EDGE intent (§八: position-only; §十二: own eligibility) ----
		// §四.2 edgeIntentMath: the whole edge decision — zone math, dwell
		// gate, latch bookkeeping.
		const edgeMathStart = measureDeep ? this.win.performance.now() : 0;
		const edge = this.edgeIntent;
		const edgeEligible =
			pointer.overElement || (edge.latched && pointer.insideEnvelope);
		let edgeTarget = 0;
		let edgeStopReason: string | null = null;
		if (edgeEligible) {
			const result = computeEdgeScrollIntent({
				pointerY: this.lastPointerY,
				viewportTop: this.viewportTop,
				viewportBottom: this.viewportBottom,
			maxSpeed: edgeMaxSpeed,
			triggerZonePx: zonePx,
				canScrollUp: overflow.canScrollUp,
				canScrollDown: overflow.canScrollDown,
				enabled: settings.pointerAutoScroll && overflow.hasOverflow,
			});
			edgeTarget = result.velocity;
			edgeStopReason = result.stopReason;
			// Dwell gate — EDGE only (§九: kinetic has no dwell). Brushing
			// an edge never yanks the intended click target.
			if (edgeTarget !== 0 && !edge.dwellPassed) {
				if (edge.dwellTimer === 0) {
					edge.dwellTimer = this.win.setTimeout(() => {
						edge.dwellTimer = 0;
						edge.dwellPassed = true;
						integ.lastFrameTime = Number.NaN;
						this.schedule();
					}, AUTO_SCROLL_DWELL_MS);
				}
				edgeTarget = 0;
			}
			if (edgeTarget !== 0 && !edge.latched) {
				edge.latched = true;
				pointer.autoScrollLatched = true;
				pointer.lastStopReason = null;
				perf?.count("autoScrollStartCount");
				perf?.count("edgeIntentActivationCount");
			}
			edge.direction = edgeTarget < 0 ? -1 : edgeTarget > 0 ? 1 : 0;
		} else if (
			edge.latched ||
			edge.dwellPassed ||
			edge.dwellTimer !== 0
		) {
			this.stopEdgeIntent("pointer-left");
		}
		if (measureDeep && perf) {
			perf.addPhaseSample(
				"edgeIntentMath",
				this.win.performance.now() - edgeMathStart,
			);
		}

		// ---- KINETIC intent (§九/§十二: independent eligibility) --------
		// §四.2 kineticIntentMath: pointer-follow velocity math.
		const kineticMathStart = measureDeep ? this.win.performance.now() : 0;
		const kineticEligible =
			pointer.overElement || pointer.insideEnvelope;
		let kineticTarget = 0;
		if (kineticEligible) {
			kineticTarget = computeKineticIntentVelocity({
				pointerY: this.lastPointerY,
				// §十: the depth ramp leads the gesture. Eligibility still
				// uses the actual position inside the function.
				predictedY: kin.predictedY,
				pointerVelocityY: kin.velocityY,
				viewportTop: this.viewportTop,
				viewportBottom: this.viewportBottom,
				// §十一/§十六: pass the BASE max speed; the function applies
				// MAX_SHARE × strength internally so the kinetic cap is
				// independent of the edge speed setting.
				maxSpeed: AUTO_SCROLL_MAX_SPEED,
				strength: followStrength,
				canScrollUp: overflow.canScrollUp,
				canScrollDown: overflow.canScrollDown,
				enabled: settings.pointerFollowEnabled && overflow.hasOverflow,
			});
			if (kineticTarget !== 0 && !this.kineticActive) {
				this.kineticActive = true;
				perf?.count("kineticIntentActivationCount");
			} else if (kineticTarget === 0 && this.kineticActive) {
				this.kineticActive = false;
				perf?.countKineticStopReason("decayed");
			}
		} else if (this.kineticActive || kin.velocityY !== 0) {
			this.stopKineticIntent("pointer-left");
		}
		if (measureDeep && perf) {
			perf.addPhaseSample(
				"kineticIntentMath",
				this.win.performance.now() - kineticMathStart,
			);
		}

		// §十八 config echo — only while a capture is running.
		//
		// §三: both echoes are LAST-VALUE-WINS gauges, so rewriting them
		// every frame bought nothing while allocating two objects a frame
		// inside the very loop being measured. They now take primitives
		// (nothing is allocated on the skip path); the config is stored
		// only when it actually changes, the pointer gauges at most every
		// 100 ms.
		if (perf?.active === true) {
			const zones = resolveEdgeZones(
				this.viewportBottom - this.viewportTop,
				zonePx,
			);
			perf.setAutoScrollConfig(
				speed,
				zonePx,
				zones.preZone,
				zones.strongZone,
				AUTO_SCROLL_EXIT_HYSTERESIS_PX,
			);
			// §十.1 pointer-follow echo: the two caps side by side plus the
			// live gauges. `pointerSampleCount` is the honest tell for gap
			// starvation — a healthy flick keeps the ring at capacity, a
			// starved one collapses to 0–1 and takes the velocity with it.
			perf.setPointerFollowEcho(
				followStrength,
				edgeMaxSpeed,
				kineticMaxSpeed,
				combinedMaxSpeed,
				kin.velocityY,
				kin.predictedY,
				kin.samples.length,
			);
		}

		// ---- Shared integrator (§七): combine, clamp, damp --------------
		// §四.2 scrollIntegrator: combine + clamp + acceleration-capped
		// damping — everything between the intents and the actual write.
		const integratorStart = measureDeep ? this.win.performance.now() : 0;
		integ.edgeIntentVelocity = edgeTarget;
		integ.kineticIntentVelocity = kineticTarget;
		const combined = Math.min(
			combinedMaxSpeed,
			Math.max(-combinedMaxSpeed, edgeTarget + kineticTarget),
		);
		integ.combinedTargetVelocity = combined;

		if (combined === 0 && integ.appliedVelocity === 0) {
			if (measureDeep && perf) {
				perf.addPhaseSample(
					"scrollIntegrator",
					this.win.performance.now() - integratorStart,
				);
			}
			// §十一 hysteresis: a latched edge session in the dead zone
			// survives while the pointer is within 12 px of the trigger
			// boundary — re-entering resumes instantly without a second
			// dwell. Any other terminal stop reason releases the latch.
			if (edge.latched) {
				if (
					edgeStopReason === "dead-zone" &&
					this.withinZoneHysteresis(zonePx)
				) {
					return; // latch held; next pointermove reschedules
				}
				this.stopEdgeIntent(
					(edgeStopReason as AutoScrollStopReason | null) ??
						"dead-zone",
				);
			}
			return; // dwell pending — its timer reschedules
		}

		if (dt > 0) {
			// §十六 acceleration-capped chase → continuous ramps and damping.
			// Accel scales with the LARGER of edge speed / follow strength so
			// a low edge speed never makes a high-strength kinetic feel soggy
			// (and vice versa).
			const accelScale = Math.max(speed, followStrength);
			const maxDelta = AUTO_SCROLL_ACCEL * accelScale * dt;
			const delta = combined - integ.appliedVelocity;
			integ.appliedVelocity += Math.min(
				maxDelta,
				Math.max(-maxDelta, delta),
			);
			if (combined === 0 && Math.abs(integ.appliedVelocity) < 4) {
				integ.appliedVelocity = 0;
			}
			if (measureDeep && perf) {
				perf.addPhaseSample(
					"scrollIntegrator",
					this.win.performance.now() - integratorStart,
				);
			}
			if (integ.appliedVelocity !== 0) {
				// §十三: scroll intents ONLY move scrollTop — geometry and
				// magnification react through the scroll handler's delta.
				this.writeScrollTop(
					integ.appliedVelocity * dt,
					measure ? perf : undefined,
					true,
					edgeTarget !== 0 && kineticTarget !== 0
						? "combined"
						: edgeTarget !== 0
							? "edge"
							: "kinetic",
				);
				perf?.count("autoScrollFrameCount");
				perf?.addAutoScrollSample(combined, integ.appliedVelocity);
				perf?.addCombinedIntentSample(combined);
				perf?.addAppliedVelocitySample(integ.appliedVelocity);
				// §十四/§十九: which mechanism(s) contributed this frame.
				if (edgeTarget !== 0) {
					perf?.count("autoScrollEdgeFrameCount");
					perf?.count("edgeIntentFrameCount");
					perf?.addEdgeIntentSample(edgeTarget);
				}
				if (kineticTarget !== 0) {
					perf?.count("pointerFollowFrameCount");
					perf?.count("kineticIntentFrameCount");
					perf?.addKineticIntentSample(kineticTarget);
				}
				// §四.2 mode split: which mechanism(s) produced THIS
				// frame's velocity (mutually exclusive by definition).
				if (edgeTarget !== 0 && kineticTarget === 0) {
					perf?.count("edgeOnlyFrameCount");
				} else if (edgeTarget === 0 && kineticTarget !== 0) {
					perf?.count("kineticOnlyFrameCount");
				} else if (edgeTarget !== 0 && kineticTarget !== 0) {
					perf?.count("combinedIntentFrameCount");
				}
			}
		} else if (measureDeep && perf) {
			perf.addPhaseSample(
				"scrollIntegrator",
				this.win.performance.now() - integratorStart,
			);
		}
		// Keep the loop alive while there is motion or a pending target.
		this.schedule();
	}

	/**
	 * §四.2 the ONE auto-scroll scrollTop mutation point. Distinguishes
	 * requestedDelta (what the integrator asked for) from appliedDelta
	 * (what the scroller actually moved); the shortfall is the
	 * boundary-clamped remainder. `scrollTopMutationCount` only counts
	 * writes that MOVED the scroller — a fully clamped write is counted
	 * as a boundary clamp instead. The reentrancy depth lets the scroll
	 * listener classify a synchronous dispatch (§四.2).
	 */
	/**
	 * §十: best-effort attribution for one scroll event, cheapest test
	 * first. Inside our own write the source is exact; otherwise recent
	 * notes (programmatic reveal, plugin write, context change, mount)
	 * are consulted before falling back to "external" (scrollbar drag,
	 * find-in-page, another plugin — anything that is not us).
	 */
	private classifyScrollSource(): ScrollDeltaSource {
		if (this.scrollTopWriteDepth > 0) {
			return this.activeWriteSource ?? "unknown";
		}
		const note = this.view.takeProgrammaticScrollNote();
		if (note) return note;
		if (this.scrollAttribution) return this.scrollAttribution.source;
		if (this.fileChangeTtl > 0) return "file-change";
		if (this.modeChangeTtl > 0) return "mode-change";
		return "external";
	}

	private writeScrollTop(
		requestedDelta: number,
		perf: PerfCapture | undefined,
		recordPhase = true,
		source: ScrollDeltaSource = "unknown",
	): void {
		const el = this.view.viewportEl;
		const before = el.scrollTop;
		// §三: timing the write itself is DEEP-only; the mutation and
		// boundary-clamp counters below stay on in both modes.
		// §3.2: and only while the "scrollWrite" group is armed.
		const timeWrite = perf?.deepScrollWriteActive === true && recordPhase;
		const writeStart = timeWrite ? this.win.performance.now() : 0;
		this.scrollTopWriteDepth++;
		this.activeWriteSource = source;
		try {
			el.scrollTop = before + requestedDelta;
		} finally {
			this.scrollTopWriteDepth--;
			this.activeWriteSource = null;
		}
		// §十: the browser may deliver the scroll event asynchronously —
		// leave a short-lived note so that event still attributes to us.
		this.scrollAttribution = { source, ttl: 2 };
		if (!perf) return;
		if (timeWrite) {
			perf.addPhaseSample(
				"scrollTopWrite",
				this.win.performance.now() - writeStart,
			);
		}
		const appliedDelta = el.scrollTop - before;
		if (appliedDelta !== 0) perf.count("scrollTopMutationCount");
		const boundaryClampedDelta = requestedDelta - appliedDelta;
		if (Math.abs(boundaryClampedDelta) > 0.5) {
			perf.count("scrollBoundaryClampCount");
		}
	}

	/** §十一: pointer within (preZone + hysteresis) of either edge? */
	private withinZoneHysteresis(zonePx: number): boolean {
		const height = this.viewportBottom - this.viewportTop;
		if (!(height > 0) || !Number.isFinite(this.lastPointerY)) return false;
		const { preZone } = resolveEdgeZones(height, zonePx);
		const distTop = this.lastPointerY - this.viewportTop;
		const distBottom = this.viewportBottom - this.lastPointerY;
		const nearest = Math.min(distTop, distBottom);
		return nearest >= 0 && nearest <= preZone + AUTO_SCROLL_EXIT_HYSTERESIS_PX;
	}

	/**
	 * §十一 Stop the EDGE intent only: cancel the dwell gate, release the
	 * latch, zero the edge target and record WHY. The kinetic intent and
	 * the shared integrator's applied velocity are NOT touched (the
	 * damping smoothly zeroes when both targets are 0).
	 */
	private stopEdgeIntent(reason: AutoScrollStopReason): void {
		const edge = this.edgeIntent;
		const hadSession =
			edge.latched || edge.dwellPassed || edge.dwellTimer !== 0;
		if (edge.dwellTimer !== 0) {
			this.win.clearTimeout(edge.dwellTimer);
			edge.dwellTimer = 0;
		}
		edge.dwellPassed = false;
		edge.direction = 0;
		this.integrator.edgeIntentVelocity = 0;
		if (hadSession) {
			edge.lastStopReason = reason;
			this.pointer.lastStopReason = reason;
			this.perf?.count("autoScrollStopCount");
			this.perf?.countStopReason(reason);
			this.perf?.countEdgeStopReason(reason);
		}
		edge.latched = false;
		this.pointer.autoScrollLatched = false;
	}

	/**
	 * §十一 Stop the KINETIC intent only: clear the sample ring, velocity
	 * and prediction. The edge latch/dwell are NOT touched.
	 */
	private stopKineticIntent(reason: AutoScrollStopReason): void {
		const kin = this.kinematics;
		const hadSession =
			this.kineticActive || kin.velocityY !== 0 || kin.samples.active;
		kin.samples.clear();
		kin.velocityY = 0;
		kin.predictedY = Number.NaN;
		kin.lastSampleTime = Number.NaN;
		kin.active = false;
		this.lastSampleEventId = "";
		// §十: a parked gap sample belongs to the gesture that just ended.
		this.pendingPointerSample = null;
		this.integrator.kineticIntentVelocity = 0;
		if (hadSession) {
			this.perf?.countKineticStopReason(reason);
		}
		this.kineticActive = false;
	}

	/**
	 * §十一 Full reset — pointerdown / pointercancel / window blur /
	 * collapse / dispose / feature-off. Stops BOTH intents and zeroes the
	 * shared integrator immediately (no smooth-out: these are hard exits).
	 */
	private resetAllScrollIntent(reason: AutoScrollStopReason): void {
		this.stopEdgeIntent(reason);
		this.stopKineticIntent(reason);
		const integ = this.integrator;
		integ.combinedTargetVelocity = 0;
		integ.appliedVelocity = 0;
		integ.lastFrameTime = Number.NaN;
	}

	/** Map the DOM-hit anchor element to its cache index (-1 = blank).
	 * O(1) via the element→index map (section 9). Doubles as the seed
	 * update for §八's local probe. */
	private resolveAnchorIndex(): number {
		const el = this.pointerAnchorEl;
		if (!el) return -1;
		const index = this.cacheIndexByEl.get(el) ?? -1;
		if (index >= 0) this.lastAnchorIndex = index;
		return index;
	}

	// --- §六 Coordinate-space conversions (O(1), pure arithmetic) -------

	/** The cached scroll frame the conversions run against. */
	private scrollFrame(): ScrollViewportFrame {
		return {
			viewportTop: this.viewportTop,
			viewportBottom: this.viewportBottom,
			scrollTop: this.currentScrollTop,
		};
	}

	/** Viewport CLIENT y → CONTENT y (see `utils/contentCoords`). */
	private clientYToContentY(clientY: number): number {
		return clientYToContentY(this.scrollFrame(), clientY);
	}

	/** The visible window expressed in CONTENT coordinates. */
	private contentRangeForViewport(): ContentRange {
		return contentRangeForViewport(this.scrollFrame());
	}

	/** Active row window from cached numbers only (sections 6/10). */
	private computeRange(): ActiveMotionRange {
		if (this.cache.length === 0) return emptyActiveRange();
		const settings = this.getSettings();
		const window = this.contentRangeForViewport();
		return computeActiveMotionRange({
			centers: this.centers,
			heights: this.heights,
			viewportTop: window.top,
			viewportBottom: window.bottom,
			pointerY: this.clientYToContentY(this.lastPointerY),
			radius: settings.radius,
			maxScale: settings.maxScale,
		});
	}

	/**
	 * §八 Resolve the row whose displayed visual box contains a CONTENT y —
	 * local probe first, binary search second, never a full scan.
	 *
	 *   1. LOCAL: the ±3 rows around the previous anchor. A stationary
	 *      pointer over a scrolling list crosses one row boundary at a
	 *      time, so this answers the overwhelming majority of resolves in
	 *      O(1) with perfect cache locality.
	 *   2. BINARY: visual boxes are monotonic (the collision solver keeps
	 *      every adjacent pair separated), so a standard binary search over
	 *      `contentVisualCenter ± scaled half-height` finds the row in
	 *      O(log n) — this replaces the old O(n) linear scan that ran on
	 *      every single scroll event.
	 *   3. Neither → the pointer is over a transparent GAP between two
	 *      displaced rows. That resolves to NO anchor on purpose: the
	 *      solver then interpolates continuously from the pointer position
	 *      instead of snapping row to row (§六.3).
	 */
	private resolveAnchorFromContentY(contentY: number): number {
		const n = this.cache.length;
		if (n === 0 || !Number.isFinite(contentY)) return -1;
		const containsAt = (i: number): boolean => {
			const entry = this.cache[i];
			const half = (entry.height * entry.motion.displayedScale) / 2;
			return (
				contentY >= entry.contentVisualCenter - half &&
				contentY <= entry.contentVisualCenter + half
			);
		};
		// 1) Local probe around the previous anchor.
		const seed = this.lastAnchorIndex;
		if (seed >= 0 && seed < n) {
			const lo = Math.max(0, seed - ANCHOR_LOCAL_PROBE_RADIUS);
			const hi = Math.min(n - 1, seed + ANCHOR_LOCAL_PROBE_RADIUS);
			for (let i = lo; i <= hi; i++) {
				if (containsAt(i)) {
					this.perf?.addAnchorResolveSample("local", hi - lo + 1);
					return i;
				}
			}
		}
		// 2) Binary search over the monotonic visual boxes.
		let lo = 0;
		let hi = n - 1;
		let probes = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			probes++;
			const entry = this.cache[mid];
			const half = (entry.height * entry.motion.displayedScale) / 2;
			if (contentY < entry.contentVisualCenter - half) {
				hi = mid - 1;
			} else if (contentY > entry.contentVisualCenter + half) {
				lo = mid + 1;
			} else {
				this.perf?.addAnchorResolveSample("binary", probes);
				return mid;
			}
		}
		// 3) Between two rows — a transparent gap, no anchor.
		this.perf?.addAnchorResolveSample("gap", probes);
		return -1;
	}

	/**
	 * §六/§八 Stale-anchor refresh: after ANY outline scroll (wheel, edge
	 * auto-scroll, pointer-follow) the pointer hovers a DIFFERENT row than
	 * the one that produced `pointerAnchorEl`. Re-resolve the anchor from
	 * the CACHED content-space visual boxes — zero getBoundingClientRect,
	 * zero elementFromPoint, O(1)/O(log n) instead of O(n). Runs at most
	 * once per frame, not once per scroll event.
	 */
	private refreshPointerAnchorAfterScroll(): void {
		if (!this.isExpanded()) return;
		if (!Number.isFinite(this.lastPointerY)) return;
		if (!this.pointer.overElement && !this.pointer.insideEnvelope) return;
		const prev = this.pointerAnchorEl;
		const found = this.resolveAnchorFromContentY(
			this.clientYToContentY(this.lastPointerY),
		);
		// The cached resolution is authoritative — drop any pending DOM
		// target (it predates the scroll and is equally stale).
		this.pendingAnchorTarget = null;
		this.anchorDirty = false;
		if (found >= 0) {
			this.pointerAnchorEl = this.cache[found].el;
			this.lastAnchorIndex = found;
			this.perf?.markCachedAnchorResolve();
		} else {
			this.pointerAnchorEl = null;
			this.perf?.markGapAnchorResolve();
		}
		if (prev !== this.pointerAnchorEl) {
			this.perf?.markStaleAnchorReset();
		}
	}

	/**
	 * Full geometry rebuild — DISCRETE events only (items added/removed/
	 * reordered, size changes, settings, resize, expansion). O(n) single
	 * pass with element→entry maps (section 9); never `find`/`some`.
	 */
	private rebuildCache(): void {
		this.cacheDirty = false;
		this.perf?.count("geometryRebuildCount");
		this.perf?.countRebuildReason(this.cacheDirtyReason);
		// Viewport bounds are cached here (not per frame) — they only move
		// on layout changes, which also dirty this cache.
		const viewportRect = this.view.viewportEl.getBoundingClientRect();
		this.viewportTop = viewportRect.top;
		this.viewportBottom = viewportRect.bottom;
		this.currentScrollTop = this.view.viewportEl.scrollTop;
		const children = this.view.listEl.children;
		// Carry map: previous entries by element (single pass, O(n)).
		const prevByEl = new Map<HTMLElement, CachedItem>();
		for (const entry of this.cache) prevByEl.set(entry.el, entry);
		const next: CachedItem[] = [];
		const nextIndex = new Map<HTMLElement, number>();
		const nextByKey = new Map<string, number>();
		const centers: number[] = [];
		const heights: number[] = [];
		const layout: { center: number; height: number }[] = [];
		const shifts: number[] = [];
		let rectReads = 1; // the viewport rect above
		// §九: indices are about to be reassigned, so the old dirty set is
		// meaningless. It is rebuilt below from the rows that actually
		// carry residual motion across the rebuild.
		const carriedDirty: number[] = [];
		for (let i = 0; i < children.length; i++) {
			const el = children[i];
			// Pop-out safe instanceof (P1-1).
			if (!(el instanceof this.win.HTMLElement)) continue;
			// Row rects are transform-free (only the inner motion element
			// carries --glide-shift-y), so this measures the BASE center.
			const rect = el.getBoundingClientRect();
			rectReads++;
			const key = el.dataset.key ?? "";
			// Height comes from the view's measurement pass (offsetHeight,
			// transform-free); fall back to the row rect for safety.
			const measured = this.view.getBaseCardHeight(key);
			// Carry displayed/target motion across rebuilds: the styles
			// survive on the element, so the model must survive with them.
			const previous = prevByEl.get(el);
			if (previous) prevByEl.delete(el);
			const motion = previous?.motion ?? identityMotionState();
			// §六: store the layout center in CONTENT space so no scroll
			// ever has to touch it again.
			const contentCenter = this.clientYToContentY(
				rect.top + rect.height / 2,
			);
			const height = measured > 0 ? measured : rect.height;
			const index = next.length;
			// §五/§六/§九: rows that carry residual motion across the
			// rebuild seed the new dirty set, so the next frame keeps
			// decaying them even if the pointer is elsewhere. A row that
			// still carries WRITTEN vars counts too — otherwise nobody
			// would ever come back to remove them.
			const carriesMotion =
				Math.abs(motion.displayedShift) >= SHIFT_EPSILON ||
				Math.abs(motion.displayedScale - 1) >= SCALE_EPSILON ||
				!Number.isNaN(previous?.lastWrittenScale ?? Number.NaN) ||
				!Number.isNaN(previous?.lastWrittenShift ?? Number.NaN);
			if (carriesMotion) carriedDirty.push(index);
			nextIndex.set(el, index);
			nextByKey.set(key, index);
			next.push({
				el,
				key,
				contentCenter,
				contentVisualCenter: contentCenter + motion.displayedShift,
				height,
				motion,
				lastWrittenScale: previous?.lastWrittenScale ?? Number.NaN,
				lastWrittenShift: previous?.lastWrittenShift ?? Number.NaN,
					shifting: previous?.shifting ?? false,
					scaling: previous?.scaling ?? false,
					wasSnapped: previous?.wasSnapped ?? false,
			});
			centers.push(contentCenter);
			heights.push(height);
			layout.push({ center: contentCenter, height });
			shifts.push(motion.displayedShift);
		}
		// Whatever is left in the carry map dropped out of the list —
		// reset its styles exactly once (section 14) and drop its layer.
		for (const entry of prevByEl.values()) {
			entry.el.style.removeProperty("--glide-scale");
			entry.el.style.removeProperty("--glide-shift-y");
			entry.el.classList.remove(MOTION_SHIFT_CLASS);
			entry.el.classList.remove(MOTION_SCALE_CLASS);
		}
		this.cache = next;
		this.cacheIndexByEl = nextIndex;
		this.cacheIndexByKey = nextByKey;
		this.centers = centers;
		this.heights = heights;
		this.layout = layout;
		this.shifts = shifts;
		// §九: republish the dirty set against the NEW indices. Recorded as
		// churn so the added/removed ledger stays balanced — a rebuild is a
		// bulk drop followed by a bulk re-seed, not a leak.
		if (this.perf?.active === true) {
			this.perf.addDirtyRowChurn(carriedDirty.length, this.dirtyRows.size);
		}
		this.dirtyRows.clear();
		for (const index of carriedDirty) this.dirtyRows.add(index);
		this.perf?.count("rowRectReadCount", rectReads);
		// The anchor element may have been removed with its heading.
		if (this.pointerAnchorEl && !nextIndex.has(this.pointerAnchorEl)) {
			this.pointerAnchorEl = null;
		}
		// §八: indices moved with the rebuild — invalidate the probe seed
		// (a stale seed would only cost one wasted local probe, but a
		// wrong-row hit is worse than a binary search).
		this.lastAnchorIndex = this.pointerAnchorEl
			? (nextIndex.get(this.pointerAnchorEl) ?? -1)
			: -1;
	}

	/**
	 * Rebuild the geometric Pointer Envelope — ACTIVE range only
	 * (section 6). Falls back to the full list before the first frame
	 * (no cache yet), which is the only time the range is unknown.
	 */
	private rebuildEnvelope(): void {
		this.envelopeDirty = false;
		let start = this.activeRange.start;
		let end = this.activeRange.end;
		if (this.cache.length === 0) {
			// Degenerate pre-first-frame path (e.g. leave before any frame).
			start = 0;
			end = this.view.getItems().length - 1;
		}
		// §六: remember what this envelope actually covers. Without it the
		// cached rects silently stop describing the rows under the pointer
		// as the active range slides, and a containment test on rows the
		// envelope never held reads as "outside".
		this.envelopeRangeStart = start;
		this.envelopeRangeEnd = end;
		this.envelope = this.view.collectEnvelope(
			ENVELOPE_H_TOLERANCE,
			ENVELOPE_V_TOLERANCE,
			start,
			end,
		);
		// §七: the view measures client rects; convert the ITEM rects into
		// content space once, here. From now on an outline scroll leaves
		// the whole envelope untouched (the rail stays client-space — it
		// is viewport-fixed and does not scroll with the content).
		translateEnvelopeItemsY(
			this.envelope,
			this.currentScrollTop - this.viewportTop,
		);
		// §十四: snapshot the motion state each item was collected AT, so
		// later frames can move the rects mathematically by the delta.
		this.envelopeMotionShift.clear();
		this.envelopeMotionScale.clear();
		for (const item of this.envelope.items) {
			const idx = this.cacheIndexByKey.get(item.key);
			const state = idx !== undefined ? this.cache[idx]?.motion : undefined;
			this.envelopeMotionShift.set(item.key, state?.displayedShift ?? 0);
			this.envelopeMotionScale.set(item.key, state?.displayedScale ?? 1);
		}
		const rows = this.envelope.items.length;
		this.perf?.addEnvelopeSample(rows);
		this.perf?.count("markerCardRectReadCount", rows * 2);
	}

	/**
	 * §六: does the cached envelope still span every row the active range
	 * needs? An empty range asks for nothing and is always covered.
	 */
	private envelopeCoversActiveRange(): boolean {
		const range = this.activeRange;
		if (range.end < range.start) return true;
		return (
			this.envelopeRangeStart >= 0 &&
			this.envelopeRangeStart <= range.start &&
			this.envelopeRangeEnd >= range.end
		);
	}

	/**
	 * §十四 CachedVisualGeometry: advance the cached envelope rects by the
	 * motion deltas (displayed shift + vertical scale growth around the
	 * rect center) — pure math, zero getBoundingClientRect. Horizontal
	 * scale growth is deliberately ignored: it only ever ENLARGES the real
	 * card beyond the cached rect, and a pointer over that grown area is
	 * over a real element, which element-level events already handle.
	 */
	private updateEnvelopeFromMotion(): void {
		const items = this.envelope.items;
		if (items.length === 0) return;
		for (const item of items) {
			const idx = this.cacheIndexByKey.get(item.key);
			if (idx === undefined || !this.cache[idx]) {
				// Row left the cache — this item is stale; a full rebuild
				// will run before the next containment decision needs it.
				this.envelopeDirty = true;
				continue;
			}
			const state = this.cache[idx].motion;
			const prevShift = this.envelopeMotionShift.get(item.key) ?? 0;
			const prevScale = this.envelopeMotionScale.get(item.key) ?? 1;
			const dy = state.displayedShift - prevShift;
			const ratio =
				prevScale > 0 ? state.displayedScale / prevScale : 1;
			if (dy === 0 && ratio === 1) continue;
			applyMotionDeltaToRect(item.markerRect, dy, ratio);
			applyMotionDeltaToRect(item.cardRect, dy, ratio);
			const bridge = MagnificationController.buildBridge(
				item.markerRect,
				item.cardRect,
			);
			item.bridgeRect.left = bridge.left;
			item.bridgeRect.top = bridge.top;
			item.bridgeRect.right = bridge.right;
			item.bridgeRect.bottom = bridge.bottom;
			this.envelopeMotionShift.set(item.key, state.displayedShift);
			this.envelopeMotionScale.set(item.key, state.displayedScale);
		}
	}

	private clearMagnification(): void {
		for (const entry of this.cache) {
			entry.el.style.removeProperty("--glide-scale");
			entry.el.style.removeProperty("--glide-shift-y");
			entry.el.classList.remove(MOTION_SHIFT_CLASS);
			entry.el.classList.remove(MOTION_SCALE_CLASS);
			entry.motion = identityMotionState();
			entry.lastWrittenScale = Number.NaN;
			entry.lastWrittenShift = Number.NaN;
			entry.shifting = false;
			entry.scaling = false;
			entry.contentVisualCenter = entry.contentCenter;
		}
		this.shifts.fill(0);
		// Everything snapped to identity — nothing is dirty any more.
		if (this.perf?.active === true && this.dirtyRows.size > 0) {
			this.perf.addDirtyRowChurn(0, this.dirtyRows.size);
		}
		this.dirtyRows.clear();
		this.pointerAnchorEl = null;
		this.anchorDirty = false;
		this.pendingAnchorTarget = null;
	}

	/** Bridge rect builder exposed for tests / geometry verification. */
	static buildBridge(marker: Rect, card: Rect): Rect {
		return bridgeRectFor(marker, card, ENVELOPE_H_TOLERANCE, ENVELOPE_V_TOLERANCE);
	}
}

// Re-export the counter type for consumers wiring the perf commands.
export type { PerfCounters };
