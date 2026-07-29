import { computeCollisionFreeMagnification } from "../utils/geometry";
import { type AutoScrollStopReason } from "../utils/overflow";
import {
	computeEdgeScrollIntent,
	computeKineticIntentVelocity,
	predictedPointerY,
	resolveEdgeZones,
	PointerSampleRing,
	POINTER_FOLLOW_DECAY_TAU_MS,
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
	shiftEnvelopeItems,
} from "../utils/envelope";
import type { PointerEnvelope, Rect } from "../utils/envelope";
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
import type { Diagnostics } from "../core/Diagnostics";
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
	 * Base vertical center in viewport client coordinates — where the row
	 * is LAID OUT. Rows themselves never transform (`--glide-shift-y`
	 * moves the motion element inside), so the row rect is transform-free.
	 * Updated by scroll DELTAS between full rebuilds (section 8).
	 */
	baseCenter: number;
	/** baseCenter + displayed shift — where the card/marker visually is. */
	visualCenter: number;
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
/** §四: guard rows added on each side of the collision seed range. */
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
	/** Solver input view over `cache` (rebuilt with it, delta-shifted). */
	private layout: { center: number; height: number }[] = [];
	/** Cached base centers / heights for the active-range binary search. */
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
	/** Rebuild the envelope during the next frame's READ phase. Only set
	 * on real geometry changes (section 5) — never unconditionally. */
	private envelopeDirty = true;
	/** Window-level containment test deferred to the frame (section 4). */
	private windowCheckPending = false;
	/** Active row window (sections 6/10); recomputed each frame. */
	private activeRange: ActiveMotionRange = emptyActiveRange();
	// --- Scroll-delta geometry (section 8) ------------------------------
	private lastKnownScrollTop = 0;
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
	// --- Settling range (§五/§六) -------------------------------------
	/** Inclusive index window of rows that may still be off identity
	 * (mid-interpolation or carrying written vars / layer classes). The
	 * per-frame write loop iterates ONLY Motion ∪ Settling — never the
	 * whole visible list. `settleEnd < settleStart` = empty. */
	private settleStart = 0;
	private settleEnd = -1;
	// --- Pointer activation lock (section 9) --------------------------
	/** Set on pointerdown over a real marker/card; cleared on pointerup /
	 * pointercancel / window blur / dispose. While set, the frame loop is
	 * suspended entirely, so target AND displayed motion values are frozen
	 * and the locked target cannot slide away (section 12). */
	private pressed: PressedHeadingState | null = null;

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

		// Outline scroll: update cached geometry by DELTA (section 8) —
		// pure cache math, no rect reads, no full rebuild. Full rebuilds
		// stay reserved for discrete events (invalidate / resize).
		this.disposables.listen(
			viewportEl,
			"scroll",
			() => {
				const scrollTop = viewportEl.scrollTop;
				const delta = scrollTop - this.lastKnownScrollTop;
				this.lastKnownScrollTop = scrollTop;
				if (
					!this.cacheDirty &&
					Number.isFinite(delta) &&
					delta !== 0 &&
					this.cache.length > 0
				) {
					this.applyScrollDelta(delta);
				}
				// User is scrolling the outline — pause active-heading follow.
				this.view.setFollowEnabled(false);
				this.schedule();
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
	}

	/** Called when the heading list or settings changed (centers are stale). */
	invalidate(): void {
		this.markCacheDirty("invalidate");
		this.envelopeDirty = true;
		this.perf?.count("cacheInvalidationCount");
		if (this.isExpanded()) this.schedule();
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
		this.cancelCollapse();
		this.pointerExpanded = true;
		this.pointer.overElement = true;
		this.pointer.insideEnvelope = true;
		// §七: expansion does NOT dirty the geometry cache — row layout is
		// identical collapsed/expanded (the reveal animates opacity and a
		// horizontal translate only). Card rects DO move horizontally, so
		// the envelope is refreshed on demand; the row cache is not.
		this.envelopeDirty = true;
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.pendingAnchorTarget = event.target;
		this.anchorDirty = true;
		// Fresh gesture: no carried-over velocity from a previous visit.
		this.kinematics.samples.clear();
		this.kinematics.velocityY = 0;
		this.kinematics.active = false;
		this.lastSampleEventId = "";
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
	 * pointerleave is a DISCRETE event (not the per-move hot path), so a
	 * synchronous envelope refresh here is acceptable and keeps the
	 * collapse decision authoritative at the moment of exit.
	 */
	private onPointerLeave = (event: PointerEvent): void => {
		const related = event.relatedTarget;
		if (this.isNodeInRoot(related)) return;
		if (this.envelopeDirty) {
			this.activeRange = this.computeRange();
			this.rebuildEnvelope();
		}
		if (pointInEnvelope(this.envelope, event.clientX, event.clientY)) {
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
		this.view.viewportEl.scrollTop += decision.deltaPx;
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
		// Degenerate envelope (no measurable geometry — e.g. jsdom, or a
		// detached/zero-size outline): never base a collapse decision on a
		// zero rect. Trust element-level enter/move/leave state instead.
		if (!this.envelopeIsMeasurable()) return;
		if (pointInEnvelope(this.envelope, this.lastPointerX, this.lastPointerY)) {
			// §十二: a window-level move that lands inside the envelope is a
			// gap crossing, not an exit — the latch (if any) survives.
			this.pointer.insideEnvelope = true;
			this.pointer.overElement = false;
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
		const now = event.timeStamp;
		const id = `${event.pointerId}:${now}`;
		if (id === this.lastSampleEventId) return; // dedup double dispatch
		this.lastSampleEventId = id;
		this.kinematics.samples.push(event.clientY, now);
		this.kinematics.lastSampleTime = now;
		this.kinematics.velocityY = this.kinematics.samples.velocityY(now);
		this.kinematics.active = this.kinematics.samples.active;
		this.kinematics.predictedY = predictedPointerY(
			this.lastPointerY,
			this.kinematics.velocityY,
		);
	}

	private onRootPointerDown = (event: PointerEvent): void => {
		const activation = resolveClickTarget(event.target);
		if (!activation) return; // not on a real marker / card
		const item = this.view.getItems().find((c) => c.key === activation.key);
		if (!item) return;
		const targetEl = (event.target as Partial<Element> | null)?.closest?.(
			".glide-outline-marker, .glide-outline-card",
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
		const frameStart = measure ? this.win.performance.now() : 0;
		perf?.recordFrame(now);

		// ---------------- READ PHASE (DOM geometry) ----------------
		if (this.cacheDirty) this.rebuildCache();
		if (this.cache.length === 0) {
			if (measure && perf) {
				perf.addPhaseSample(
					"pluginFrameJs",
					this.win.performance.now() - frameStart,
				);
			}
			this.endFrame();
			return;
		}
		const settings = this.getSettings();
		// Envelope/compat window from cached numbers (pure, O(log n)).
		this.activeRange = this.computeRange();
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
			perf.addPhaseSample(
				"read",
				this.win.performance.now() - frameStart,
			);
		}

		if (Number.isNaN(this.lastPointerY)) {
			if (measure && perf) {
				perf.addPhaseSample(
					"pluginFrameJs",
					this.win.performance.now() - frameStart,
				);
			}
			this.endFrame();
			return;
		}

		// ---------------- PURE CALC PHASE ----------------
		// Resolve the magnification anchor from the last pointer target.
		// `closest` is an ancestor-tree walk (no layout access).
		if (this.anchorDirty) {
			this.anchorDirty = false;
			const target = this.pendingAnchorTarget as Partial<Element> | null;
			this.pointerAnchorEl =
				(target?.closest?.(".glide-outline-row") as HTMLElement | null) ??
				null;
			this.pendingAnchorTarget = null;
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

		// ---------------- §四 three independent ranges ----------------
		// 1) SCALE range: pointerY ± radius (+1 overscan). Answers "which
		//    rows may have scale > 1" and is NEVER enlarged by collision
		//    propagation (the solver's radius falloff enforces this).
		this.scaleRange = computeScaleRange({
			centers: this.centers,
			heights: this.heights,
			pointerY: this.lastPointerY,
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
			viewportTop: this.viewportTop,
			viewportBottom: this.viewportBottom,
		});
		const rowCount = this.cache.length;
		const settleEmpty = this.settleEnd < this.settleStart;
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
			const solverStart = measure ? this.win.performance.now() : 0;
			results = computeCollisionFreeMagnification(
				this.lastPointerY,
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
				perf.addSolverSample(
					this.win.performance.now() - solverStart,
					activeLayout.length,
				);
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
					// Per-pair base clearance — the gap this offscreen
					// pair may compress to absorb the residual push.
					const curEdge = up ? cStart : cEnd;
					const spacing = up
						? this.centers[curEdge] - this.centers[next]
						: this.centers[next] - this.centers[curEdge];
					const baseGap = Math.max(
						0,
						spacing -
							(this.heights[curEdge] ?? 0) / 2 -
							(this.heights[next] ?? 0) / 2,
					);
					// Absorbable per row: the base gap (compress to 0) or,
					// for tight layouts (cardGap=0 → baseGap=0), the
					// tolerance (1px overlap, the original taper).
					const absorb = Math.max(baseGap, OVERLAP_TOLERANCE_PX);
					// Apron: the first rows halve the step so slice-growth
					// handoffs stay within tolerance once DPR rounding
					// noise stacks on top (§三: 1.113px overshoot on the
					// after-scroll handoff with a full-pixel step). Beyond
					// the apron the step grows to the full absorption so
					// the buffer stays short when cardGap > 0.
					const stepBudget =
						added < COLLISION_TAPER_APRON_ROWS
							? COLLISION_TAPER_APRON_STEP_PX
							: absorb;
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
					if (Math.abs(delta) <= absorb) break;
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

		// §五/§六 per-frame iteration window = Collision ∪ Settling.
		// Settling rows OUTSIDE the collision range get identity targets
		// and interpolate home; rows outside both are clean by invariant
		// and never visited.
		let iterStart = Number.MAX_SAFE_INTEGER;
		let iterEnd = -1;
		if (!collisionEmpty) {
			iterStart = cStart;
			iterEnd = cEnd;
		}
		if (!settleEmpty) {
			iterStart = Math.min(iterStart, this.settleStart);
			iterEnd = Math.max(iterEnd, this.settleEnd);
		}
		iterStart = Math.max(0, iterStart);
		iterEnd = Math.min(rowCount - 1, iterEnd);

		// ---------------- WRITE PHASE (styles only) ----------------
		const writeStart = measure ? this.win.performance.now() : 0;
		let converging = false;
		let writes = 0;
		let nextSettleStart = Number.MAX_SAFE_INTEGER;
		let nextSettleEnd = -1;
		for (let i = iterStart; i <= iterEnd; i++) {
			const entry = this.cache[i];
			const state = entry.motion;
			const inMotion = !collisionEmpty && i >= cStart && i <= cEnd;
			if (inMotion) {
				const r = results[i - cStart];
				state.targetScale = r.scale;
				state.targetShift = r.translateY;
				// §四 lockstep taper chain: the target already tracks the
				// boundary row's per-frame interpolation progress, so the
				// chain snaps to it — interpolating on top would lag the
				// anchor and reopen the seam (see taperBoundary).
				if (r.snap) {
					state.displayedScale = r.scale;
					state.displayedShift = r.translateY;
				}
			} else {
				state.targetScale = 1;
				state.targetShift = 0;
				// Fast skip: fully idle settling row — no interpolation,
				// no writes, no repeated identity resets (section 10/14).
				// It simply drops out of the next settling window.
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
					entry.visualCenter = entry.baseCenter;
					this.shifts[i] = 0;
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
			entry.visualCenter = entry.baseCenter + state.displayedShift;
			this.shifts[i] = state.displayedShift;
			// §六: a row stays inside the settling window until it is
			// completely clean — identity, vars removed, classes off.
			const clean =
				atIdentity &&
				Number.isNaN(entry.lastWrittenScale) &&
				Number.isNaN(entry.lastWrittenShift) &&
				!entry.shifting &&
				!entry.scaling;
			if (!clean) {
				if (i < nextSettleStart) nextSettleStart = i;
				if (i > nextSettleEnd) nextSettleEnd = i;
			}
		}
		if (nextSettleEnd >= 0) {
			this.settleStart = nextSettleStart;
			this.settleEnd = nextSettleEnd;
		} else {
			this.settleStart = 0;
			this.settleEnd = -1;
		}
		if (measure && perf) {
			perf.addPhaseSample(
				"styleWrite",
				this.win.performance.now() - writeStart,
			);
			// §十四 range statistics. WRITE range = rows still dirty
			// (unconverged / carrying vars or layer classes) — exactly
			// the settling window published above.
			const scaleRows = isEmptyActiveRange(this.scaleRange)
				? 0
				: this.scaleRange.end - this.scaleRange.start + 1;
			const collisionRows = collisionEmpty ? 0 : cEnd - cStart + 1;
			const writeRows =
				nextSettleEnd >= 0 ? nextSettleEnd - nextSettleStart + 1 : 0;
			perf.addRangeSample(scaleRows, collisionRows, writeRows);
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
		}
		if (writes > 0) {
			perf?.count("cssVarWriteCount", writes);
			// §十四: card/marker rects moved with the motion — derive the
			// cached envelope rects mathematically from the displayed
			// shift/scale deltas instead of re-reading layout. Only rows
			// whose item is missing from the cache fall back to a dirty
			// flag (→ full rebuild on the next needed containment check).
			const envStart = measure ? this.win.performance.now() : 0;
			this.updateEnvelopeFromMotion();
			if (measure && perf) {
				perf.addPhaseSample(
					"envelopeMotionUpdate",
					this.win.performance.now() - envStart,
				);
			}
		}
		// Keep the loop alive until every displayed value converged.
		if (converging) this.schedule();

		// Pointer edge auto-scroll + pointer-follow share this frame.
		// Scrolling shifts the cached geometry by delta (scroll handler),
		// so the next frame sees correct centers without any rect reads.
		const autoScrollStart = measure ? this.win.performance.now() : 0;
		this.stepAutoScroll(settings);
		if (measure && perf) {
			const autoScrollEnd = this.win.performance.now();
			perf.addPhaseSample(
				"autoScroll",
				autoScrollEnd - autoScrollStart,
			);
			perf.addPhaseSample("pluginFrameJs", autoScrollEnd - frameStart);
		}
		this.endFrame();
	};

	/** Frame epilogue: break perf interval chains when the loop idles. */
	private endFrame(): void {
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
		if (!this.pointerExpanded || this.pressed) {
			this.resetAllScrollIntent(this.pressed ? "pressed" : "collapsed");
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

		// P1-3: speed scales max velocity AND acceleration linearly, so the
		// ramp/damp character is identical at every speed setting.
		const speed = settings.pointerAutoScrollSpeed;
		const zonePx = settings.pointerAutoScrollZone;
		const maxSpeed = AUTO_SCROLL_MAX_SPEED * speed;
		const overflow = this.view.getOverflowState();
		const perf = this.perf;

		// ---- EDGE intent (§八: position-only; §十二: own eligibility) ----
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
				maxSpeed,
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

		// ---- KINETIC intent (§九/§十二: independent eligibility) --------
		const kineticEligible =
			pointer.overElement || pointer.insideEnvelope;
		let kineticTarget = 0;
		if (kineticEligible) {
			kineticTarget = computeKineticIntentVelocity({
				pointerY: this.lastPointerY,
				pointerVelocityY: kin.velocityY,
				viewportTop: this.viewportTop,
				viewportBottom: this.viewportBottom,
				maxSpeed,
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

		// §十八 config echo — only while a capture is running.
		if (perf?.active === true) {
			const zones = resolveEdgeZones(
				this.viewportBottom - this.viewportTop,
				zonePx,
			);
			perf.setAutoScrollConfig({
				configuredSpeed: speed,
				configuredTriggerArea: zonePx,
				computedPreZone: zones.preZone,
				computedStrongZone: zones.strongZone,
				hysteresisPx: AUTO_SCROLL_EXIT_HYSTERESIS_PX,
			});
		}

		// ---- Shared integrator (§七): combine, clamp, damp --------------
		integ.edgeIntentVelocity = edgeTarget;
		integ.kineticIntentVelocity = kineticTarget;
		const combined = Math.min(
			maxSpeed,
			Math.max(-maxSpeed, edgeTarget + kineticTarget),
		);
		integ.combinedTargetVelocity = combined;

		if (combined === 0 && integ.appliedVelocity === 0) {
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
			// Acceleration-capped chase → continuous ramps and damping.
			const maxDelta = AUTO_SCROLL_ACCEL * speed * dt;
			const delta = combined - integ.appliedVelocity;
			integ.appliedVelocity += Math.min(
				maxDelta,
				Math.max(-maxDelta, delta),
			);
			if (combined === 0 && Math.abs(integ.appliedVelocity) < 4) {
				integ.appliedVelocity = 0;
			}
			if (integ.appliedVelocity !== 0) {
				// §十三: scroll intents ONLY move scrollTop — geometry and
				// magnification react through the scroll handler's delta.
				this.view.viewportEl.scrollTop += integ.appliedVelocity * dt;
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
			}
		}
		// Keep the loop alive while there is motion or a pending target.
		this.schedule();
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
	 * O(1) via the element→index map (section 9). */
	private resolveAnchorIndex(): number {
		const el = this.pointerAnchorEl;
		if (!el) return -1;
		return this.cacheIndexByEl.get(el) ?? -1;
	}

	/** Active row window from cached numbers only (sections 6/10). */
	private computeRange(): ActiveMotionRange {
		if (this.cache.length === 0) return emptyActiveRange();
		const settings = this.getSettings();
		return computeActiveMotionRange({
			centers: this.centers,
			heights: this.heights,
			viewportTop: this.viewportTop,
			viewportBottom: this.viewportBottom,
			pointerY: this.lastPointerY,
			radius: settings.radius,
			maxScale: settings.maxScale,
		});
	}

	/**
	 * Shift all cached geometry by an outline scroll delta (section 8):
	 * row centers, solver layout, active-range inputs and the cached
	 * envelope item rects all move together — zero DOM reads. The rail
	 * hit zone and viewport bounds are viewport-fixed and stay put.
	 */
	private applyScrollDelta(delta: number): void {
		for (let i = 0; i < this.cache.length; i++) {
			const entry = this.cache[i];
			entry.baseCenter -= delta;
			entry.visualCenter -= delta;
			this.centers[i] -= delta;
			this.layout[i].center -= delta;
		}
		shiftEnvelopeItems(this.envelope, delta);
		// §六: rows moved under a stationary pointer — the DOM-hit anchor
		// is now stale. Refresh it from cached visual geometry.
		this.refreshPointerAnchorAfterScroll();
	}

	/**
	 * §六 Stale-anchor refresh: after ANY outline scroll (wheel, edge
	 * auto-scroll, pointer-follow) the pointer hovers a DIFFERENT row than
	 * the one that produced `pointerAnchorEl`. Re-resolve the anchor from
	 * the CACHED visual boxes (visualCenter ± scaled half-height) — zero
	 * getBoundingClientRect, zero elementFromPoint. A pointer over a gap
	 * resolves to NO anchor: the solver falls back to continuous
	 * visual-center interpolation, so the magnification center keeps
	 * moving smoothly instead of jumping row to row (§六.3).
	 */
	private refreshPointerAnchorAfterScroll(): void {
		if (!this.isExpanded()) return;
		if (!Number.isFinite(this.lastPointerY)) return;
		if (!this.pointer.overElement && !this.pointer.insideEnvelope) return;
		const prev = this.pointerAnchorEl;
		let found = -1;
		for (let i = 0; i < this.cache.length; i++) {
			const entry = this.cache[i];
			const half = (entry.height * entry.motion.displayedScale) / 2;
			if (
				this.lastPointerY >= entry.visualCenter - half &&
				this.lastPointerY <= entry.visualCenter + half
			) {
				found = i;
				break;
			}
		}
		// The cached resolution is authoritative — drop any pending DOM
		// target (it predates the scroll and is equally stale).
		this.pendingAnchorTarget = null;
		this.anchorDirty = false;
		if (found >= 0) {
			this.pointerAnchorEl = this.cache[found].el;
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
		this.lastKnownScrollTop = this.view.viewportEl.scrollTop;
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
		let settleStart = Number.MAX_SAFE_INTEGER;
		let settleEnd = -1;
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
			const baseCenter = rect.top + rect.height / 2;
			const height = measured > 0 ? measured : rect.height;
			const index = next.length;
			// §五/§六: rows that carry residual motion across the rebuild
			// form the initial Settling Range so the next frame keeps
			// decaying them even if the pointer is elsewhere.
			const carriesMotion =
				Math.abs(motion.displayedShift) >= SHIFT_EPSILON ||
				Math.abs(motion.displayedScale - 1) >= SCALE_EPSILON;
			if (carriesMotion) {
				if (index < settleStart) settleStart = index;
				if (index > settleEnd) settleEnd = index;
			}
			nextIndex.set(el, index);
			nextByKey.set(key, index);
			next.push({
				el,
				key,
				baseCenter,
				visualCenter: baseCenter + motion.displayedShift,
				height,
				motion,
				lastWrittenScale: previous?.lastWrittenScale ?? Number.NaN,
				lastWrittenShift: previous?.lastWrittenShift ?? Number.NaN,
				shifting: previous?.shifting ?? false,
				scaling: previous?.scaling ?? false,
			});
			centers.push(baseCenter);
			heights.push(height);
			layout.push({ center: baseCenter, height });
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
		// §五/§六: publish the carried-motion window as the Settling Range
		// (clamped; empty when no row carries residual motion).
		if (settleStart <= settleEnd) {
			this.settleStart = Math.max(0, settleStart);
			this.settleEnd = Math.min(next.length - 1, settleEnd);
		} else {
			this.settleStart = 0;
			this.settleEnd = -1;
		}
		this.perf?.count("rowRectReadCount", rectReads);
		// The anchor element may have been removed with its heading.
		if (this.pointerAnchorEl && !nextIndex.has(this.pointerAnchorEl)) {
			this.pointerAnchorEl = null;
		}
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
		this.envelope = this.view.collectEnvelope(
			ENVELOPE_H_TOLERANCE,
			ENVELOPE_V_TOLERANCE,
			start,
			end,
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
			entry.visualCenter = entry.baseCenter;
		}
		this.shifts.fill(0);
		// Everything snapped to identity — the settling window is empty.
		this.settleStart = 0;
		this.settleEnd = -1;
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
