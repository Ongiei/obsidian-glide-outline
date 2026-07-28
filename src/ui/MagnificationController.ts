import { computeCollisionFreeMagnification } from "../utils/geometry";
import { computePointerAutoScrollVelocity } from "../utils/overflow";
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
	emptyActiveRange,
	isEmptyActiveRange,
} from "../utils/activeRange";
import type { ActiveMotionRange } from "../utils/activeRange";
import {
	identityMotionState,
	motionAlpha,
	motionStateConverged,
	stepMotionState,
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
	/** Whether the will-change class is currently applied (section 15). */
	motionActive: boolean;
}

/** Grace period before collapsing, so crossing a transparent gap between
 * two magnification-displaced neighbours does not flicker the outline shut. */
const COLLAPSE_GRACE_MS = 120;

/** Pointer auto-scroll: peak speed in px/s at the very edge (strength 1).
 * `pointerAutoScrollStrength` (P1-3) scales this AND the acceleration cap
 * linearly, so the motion character (ramp shape, damping feel) is
 * preserved at every strength — only the tempo changes. */
export const AUTO_SCROLL_MAX_SPEED = 320;
/** Dwell before the list starts moving, so brushing an edge does not
 * immediately yank the heading the user was about to click. */
export const AUTO_SCROLL_DWELL_MS = 140;
/** Low-pass filter factor for pointer velocity (per pointermove sample).
 * Higher = snappier response, lower = smoother. */
export const POINTER_VELOCITY_SMOOTHING = 0.3;
/** Max change of the APPLIED scroll speed, px/s per second — the
 * acceleration cap that turns raw target speeds into damped motion. */
export const AUTO_SCROLL_ACCEL = 1400;

/** Horizontal / vertical slack (px) added to each heading's bridge rect so
 * the hover envelope stays comfortable without growing to the longest title. */
const ENVELOPE_H_TOLERANCE = 9;
const ENVELOPE_V_TOLERANCE = 5;
/** Release-point tolerance (px) around the locked target on pointerup. */
const ACTIVATION_RELEASE_TOLERANCE = 8;
/** Row class that carries `will-change: transform` (active range only). */
export const MOTION_ACTIVE_CLASS = "glide-outline-row--motion-active";
/** Clamp for the interpolation time step: a frozen tab or a pointer-hold
 * must not turn into a giant catch-up jump on the next frame. */
const MAX_MOTION_DT_MS = 100;
/** Fallback time step for the first frame after the loop was idle. */
const DEFAULT_MOTION_DT_MS = 16.7;

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
	/** Dwell gate: velocity only applies after the pointer lingered. */
	private dwellTimer = 0;
	private dwellPassed = false;
	/** True only while the pointer is physically inside the envelope. */
	private pointerInside = false;
	/** Timestamp of the previous frame for time-based scroll deltas. */
	private lastFrameTime = Number.NaN;
	/** Timestamp base for the motion interpolation step (section 11). */
	private lastMotionTime = Number.NaN;
	// --- Pointer-follow state (velocity-assisted auto-scroll).
	/** Smoothed pointer vertical velocity, px/s (+ = down). */
	private pointerVelocityY = 0;
	/** Timestamp of the previous pointermove sample. */
	private lastMoveTime = Number.NaN;
	/** Currently APPLIED scroll speed after accel-cap damping, px/s. */
	private appliedVelocity = 0;
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

		// Wheel on the rail strip scrolls the outline, not the editor.
		const onWheel = (event: WheelEvent): void => {
			if (!this.isExpanded()) return;
			event.preventDefault();
			viewportEl.scrollTop += event.deltaY;
		};
		this.disposables.listen(hitZoneEl, "wheel", onWheel, { passive: false });

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

		const resizeObserver = new win.ResizeObserver(() => {
			this.cacheDirty = true;
			this.envelopeDirty = true;
			this.schedule();
		});
		resizeObserver.observe(view.listEl);
		resizeObserver.observe(view.rootEl);
		this.disposables.add(() => resizeObserver.disconnect());
	}

	/** Called when the heading list or settings changed (centers are stale). */
	invalidate(): void {
		this.cacheDirty = true;
		this.envelopeDirty = true;
		this.perf?.count("cacheInvalidationCount");
		if (this.isExpanded()) this.schedule();
	}

	dispose(): void {
		this.cancelFrame();
		this.cancelCollapse();
		this.clearPressed();
		this.stopAutoScroll();
		this.clearMagnification();
		this.disposables.dispose();
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
		this.pointerInside = true;
		// Expansion changes layout → full remeasure is genuinely needed.
		this.cacheDirty = true;
		this.envelopeDirty = true;
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.pendingAnchorTarget = event.target;
		this.anchorDirty = true;
		// Fresh gesture: no carried-over velocity from a previous visit.
		this.pointerVelocityY = 0;
		this.lastMoveTime = event.timeStamp;
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
			this.cacheDirty = true;
			this.envelopeDirty = true;
			this.syncExpanded();
		}
		this.pointerInside = true;
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
			// Inside a transparent gap — keep expanded, but the pointer is no
			// longer over a real element, so stop auto-scroll / clear anchor.
			this.pointerInside = false;
			this.pointerAnchorEl = null;
			this.anchorDirty = false;
			this.stopAutoScroll();
			this.cancelCollapse();
			return;
		}
		this.pointerInside = false;
		this.pointerAnchorEl = null;
		this.anchorDirty = false;
		this.stopAutoScroll();
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
		this.perf?.count("pointermoveCount");
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.windowCheckPending = true;
		this.schedule();
	};

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
			this.cancelCollapse();
			return;
		}
		this.pointerInside = false;
		this.pointerAnchorEl = null;
		this.anchorDirty = false;
		this.stopAutoScroll();
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
	 * Low-pass filtered pointer velocity (px/s, + = down). The filter
	 * absorbs pointermove jitter so the assist reacts to the gesture, not
	 * to single-event noise; the frame loop decays it between events.
	 * Pure math on event fields — allowed in the input-only handler.
	 */
	private trackPointerVelocity(event: PointerEvent): void {
		const now = event.timeStamp;
		const dtMs = now - this.lastMoveTime;
		if (Number.isFinite(dtMs) && dtMs > 0 && dtMs < 200) {
			const instant = ((event.clientY - this.lastPointerY) / dtMs) * 1000;
			if (Number.isFinite(instant)) {
				this.pointerVelocityY +=
					(instant - this.pointerVelocityY) * POINTER_VELOCITY_SMOOTHING;
			}
		} else {
			// Gap too long (or clock oddity) — treat as a new gesture.
			this.pointerVelocityY = 0;
		}
		this.lastMoveTime = now;
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
		// Stop pointer edge auto-scroll while the target is held.
		this.pressed = pressed;
		this.stopAutoScroll();
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
		this.stopAutoScroll();
		this.pointerInside = false;
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
			this.stopAutoScroll();
			this.clearMagnification();
			this.envelope = { railRect: emptyRect(), items: [] };
			this.activeRange = emptyActiveRange();
			this.windowCheckPending = false;
			this.lastMotionTime = Number.NaN;
		} else {
			this.cacheDirty = true;
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
		this.perf?.recordFrame(now);

		// ---------------- READ PHASE (DOM geometry) ----------------
		if (this.cacheDirty) this.rebuildCache();
		if (this.cache.length === 0) {
			this.endFrame();
			return;
		}
		const settings = this.getSettings();
		// Active row window from cached numbers (pure, O(log n)).
		this.activeRange = this.computeRange();
		if (this.envelopeDirty) this.rebuildEnvelope();

		// Deferred window containment test — pure math on cached rects.
		this.processWindowCheck();

		if (Number.isNaN(this.lastPointerY)) {
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

		const range = this.activeRange;
		const start = range.start;
		const end = range.end;

		// Solver over the ACTIVE range only (section 10). Rows outside the
		// range are provably identity (the range includes the displacement
		// allowance), so slicing cannot create boundary jumps.
		let results: { scale: number; translateY: number }[] = [];
		if (!isEmptyActiveRange(range)) {
			const activeLayout = this.layout.slice(start, end + 1);
			const activeShifts = this.shifts.slice(start, end + 1);
			const anchorIndex = this.resolveAnchorIndex();
			const anchorInSlice =
				anchorIndex >= start && anchorIndex <= end
					? anchorIndex - start
					: -1;
			const perf = this.perf;
			const measure = perf?.active === true;
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
		}

		// ---------------- WRITE PHASE (styles only) ----------------
		let converging = false;
		let writes = 0;
		for (let i = 0; i < this.cache.length; i++) {
			const entry = this.cache[i];
			const state = entry.motion;
			const inRange = i >= start && i <= end;
			if (inRange) {
				const r = results[i - start];
				state.targetScale = r.scale;
				state.targetShift = r.translateY;
			} else {
				state.targetScale = 1;
				state.targetShift = 0;
				// Fast skip: fully idle out-of-range row — no interpolation,
				// no writes, no repeated identity resets (section 10/14).
				if (
					state.displayedScale === 1 &&
					state.displayedShift === 0 &&
					Number.isNaN(entry.lastWrittenScale) &&
					Number.isNaN(entry.lastWrittenShift)
				) {
					if (entry.motionActive) {
						entry.el.classList.remove(MOTION_ACTIVE_CLASS);
						entry.motionActive = false;
					}
					entry.visualCenter = entry.baseCenter;
					this.shifts[i] = 0;
					continue;
				}
			}
			if (stepMotionState(state, alpha)) converging = true;
			writes += this.applyRowStyle(entry);
			// GPU layer hint (section 15): present exactly while the row is
			// visually in motion or displaced — dropped on convergence back
			// to identity, on range exit and on collapse/dispose.
			const needsLayer = !(
				motionStateConverged(state) &&
				state.targetScale === 1 &&
				state.targetShift === 0
			);
			if (needsLayer !== entry.motionActive) {
				entry.el.classList.toggle(MOTION_ACTIVE_CLASS, needsLayer);
				entry.motionActive = needsLayer;
			}
			// Keep the visual model in lockstep with what is on screen.
			entry.visualCenter = entry.baseCenter + state.displayedShift;
			this.shifts[i] = state.displayedShift;
		}
		if (writes > 0) {
			this.perf?.count("cssVarWriteCount", writes);
			// Card/marker rects moved → the envelope is genuinely stale.
			// This REPLACES the old unconditional per-frame dirty (section 5).
			this.envelopeDirty = true;
		}
		// Keep the loop alive until every displayed value converged.
		if (converging) this.schedule();

		// Pointer edge auto-scroll shares this frame. Scrolling shifts the
		// cached geometry by delta (scroll handler), so the next frame sees
		// correct centers without any rect reads.
		this.stepAutoScroll(settings);
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
	private applyRowStyle(entry: CachedItem): number {
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
		const scale = state.displayedScale;
		const scaleBase = Number.isNaN(entry.lastWrittenScale)
			? 1
			: entry.lastWrittenScale;
		if (Math.abs(scale - scaleBase) >= SCALE_EPSILON) {
			el.style.setProperty("--glide-scale", String(scale));
			entry.lastWrittenScale = scale;
			writes++;
		}
		const shift = state.displayedShift;
		const shiftBase = Number.isNaN(entry.lastWrittenShift)
			? 0
			: entry.lastWrittenShift;
		if (Math.abs(shift - shiftBase) >= SHIFT_EPSILON) {
			el.style.setProperty("--glide-shift-y", `${shift}px`);
			entry.lastWrittenShift = shift;
			writes++;
		}
		return writes;
	}

	/**
	 * One pointer-follow auto-scroll step inside the coordinated RAF loop.
	 */
	private stepAutoScroll(settings: GlideOutlineSettings): void {
		// Focus-only expansion never auto-scrolls; a held pointer locks the
		// list so the click target cannot slide away mid-click.
		if (!this.pointerExpanded || !this.pointerInside || this.pressed) {
			this.stopAutoScroll();
			return;
		}
		const now = this.win.performance.now();
		const dt = Number.isNaN(this.lastFrameTime)
			? 0
			: Math.min(0.05, (now - this.lastFrameTime) / 1000);
		this.lastFrameTime = now;

		// Between pointermove events the smoothed pointer velocity decays,
		// so a stopped pointer stops assisting within a few frames.
		if (dt > 0) {
			this.pointerVelocityY *= Math.max(0, 1 - dt * 6);
			if (Math.abs(this.pointerVelocityY) < 1) this.pointerVelocityY = 0;
		}

		// P1-3: strength scales speed AND acceleration linearly, so the
		// ramp/damp character is identical at every strength setting.
		const strength = settings.pointerAutoScrollStrength;
		const overflow = this.view.getOverflowState();
		const target = computePointerAutoScrollVelocity({
			pointerY: this.lastPointerY,
			pointerVelocityY: this.pointerVelocityY,
			viewportTop: this.viewportTop,
			viewportBottom: this.viewportBottom,
			maxSpeed: AUTO_SCROLL_MAX_SPEED * strength,
			canScrollUp: overflow.canScrollUp,
			canScrollDown: overflow.canScrollDown,
			enabled: settings.pointerAutoScroll && overflow.hasOverflow,
			reducedMotion: false,
		});

		if (target === 0 && this.appliedVelocity === 0) {
			this.stopAutoScroll();
			return;
		}
		if (!this.dwellPassed) {
			// Dwell gate: arm once; motion starts only after the delay so
			// brushing an edge never yanks the intended click target.
			if (this.dwellTimer === 0) {
				this.dwellTimer = this.win.setTimeout(() => {
					this.dwellTimer = 0;
					this.dwellPassed = true;
					this.lastFrameTime = Number.NaN;
					this.schedule();
				}, AUTO_SCROLL_DWELL_MS);
			}
			return;
		}

		if (dt > 0) {
			// Acceleration-capped chase → continuous ramps and damping.
			const maxDelta = AUTO_SCROLL_ACCEL * strength * dt;
			const delta = target - this.appliedVelocity;
			this.appliedVelocity +=
				Math.min(maxDelta, Math.max(-maxDelta, delta));
			if (target === 0 && Math.abs(this.appliedVelocity) < 4) {
				this.appliedVelocity = 0;
			}
			if (this.appliedVelocity !== 0) {
				this.view.viewportEl.scrollTop += this.appliedVelocity * dt;
				this.perf?.count("autoScrollFrameCount");
			}
		}
		// Keep the loop alive while there is motion or a pending target.
		this.schedule();
	}

	/** Cancel the dwell gate, damping state and time base (velocity → 0). */
	private stopAutoScroll(): void {
		if (this.dwellTimer !== 0) {
			this.win.clearTimeout(this.dwellTimer);
			this.dwellTimer = 0;
		}
		this.dwellPassed = false;
		this.lastFrameTime = Number.NaN;
		this.appliedVelocity = 0;
		this.pointerVelocityY = 0;
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
	}

	/**
	 * Full geometry rebuild — DISCRETE events only (items added/removed/
	 * reordered, size changes, settings, resize, expansion). O(n) single
	 * pass with element→entry maps (section 9); never `find`/`some`.
	 */
	private rebuildCache(): void {
		this.cacheDirty = false;
		this.perf?.count("geometryRebuildCount");
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
		const centers: number[] = [];
		const heights: number[] = [];
		const layout: { center: number; height: number }[] = [];
		const shifts: number[] = [];
		let rectReads = 1; // the viewport rect above
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
			nextIndex.set(el, next.length);
			next.push({
				el,
				baseCenter,
				visualCenter: baseCenter + motion.displayedShift,
				height,
				motion,
				lastWrittenScale: previous?.lastWrittenScale ?? Number.NaN,
				lastWrittenShift: previous?.lastWrittenShift ?? Number.NaN,
				motionActive: previous?.motionActive ?? false,
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
			entry.el.classList.remove(MOTION_ACTIVE_CLASS);
		}
		this.cache = next;
		this.cacheIndexByEl = nextIndex;
		this.centers = centers;
		this.heights = heights;
		this.layout = layout;
		this.shifts = shifts;
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
		const rows = this.envelope.items.length;
		this.perf?.addEnvelopeSample(rows);
		this.perf?.count("markerCardRectReadCount", rows * 2);
	}

	private clearMagnification(): void {
		for (const entry of this.cache) {
			entry.el.style.removeProperty("--glide-scale");
			entry.el.style.removeProperty("--glide-shift-y");
			entry.el.classList.remove(MOTION_ACTIVE_CLASS);
			entry.motion = identityMotionState();
			entry.lastWrittenScale = Number.NaN;
			entry.lastWrittenShift = Number.NaN;
			entry.motionActive = false;
			entry.visualCenter = entry.baseCenter;
		}
		this.shifts.fill(0);
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
