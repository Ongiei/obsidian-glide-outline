import { computeCollisionFreeMagnification } from "../utils/geometry";
import { computePointerAutoScrollVelocity } from "../utils/overflow";
import { DisposableStore } from "../utils/disposable";
import { resolveMotionState } from "../utils/motion";
import {
	bridgeRectFor,
	emptyRect,
	pointInEnvelope,
} from "../utils/envelope";
import type { PointerEnvelope, Rect } from "../utils/envelope";
import { resolveClickTarget } from "../utils/activation";
import type { Diagnostics } from "../core/Diagnostics";
import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";
import type { GlideOutlineView } from "./GlideOutlineView";

interface CachedItem {
	el: HTMLElement;
	/**
	 * Base vertical center in viewport client coordinates — where the row
	 * is LAID OUT. Rows themselves never transform (`--glide-shift-y`
	 * moves the motion element inside), so the row rect is transform-free.
	 */
	baseCenter: number;
	/** translateY currently applied to the row's motion element, px. */
	currentShift: number;
	/** baseCenter + currentShift — where the card/marker visually is. */
	visualCenter: number;
	/** Unscaled card height (measured by the view, cached here). */
	height: number;
	lastScale: number;
	lastShift: number;
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
 * Coordinate system: viewport client coordinates for BOTH the pointer
 * (`event.clientY`) and cached item centers (`getBoundingClientRect()`),
 * so no scroll compensation is applied anywhere — the cache is simply
 * rebuilt when the outline scrolls, resizes, or its items change.
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
 * transparent DOM plane): the union of the rail hit zone and each visible
 * heading's actual marker / card / bridge rectangles. A long heading
 * cannot widen a short neighbour's hover range, and only real markers and
 * cards ever trigger a jump.
 */
export class MagnificationController {
	private readonly disposables = new DisposableStore();
	private readonly win: Window & typeof globalThis;
	private cache: CachedItem[] = [];
	/** Solver input view over `cache` (rebuilt with it, stable per frame). */
	private layout: { center: number; height: number }[] = [];
	/** Per-item shifts fed back into the solver (visual → base mapping). */
	private shifts: number[] = [];
	/**
	 * Row element the pointer is physically over (DOM hit-testing via
	 * `closest(".glide-outline-row")`). Authoritative magnification anchor
	 * — visual truth beats any base-center distance guess (P0-5).
	 */
	private pointerAnchorEl: HTMLElement | null = null;
	private cacheDirty = true;
	private pointerExpanded = false;
	private focusExpanded = false;
	private rafId = 0;
	private collapseTimer = 0;
	private lastPointerX = Number.NaN;
	private lastPointerY = Number.NaN;
	private reducedMotionQuery: MediaQueryList;
	// --- Pointer Envelope (geometric hover maintenance) ----------------
	/** Union of rail hit zone + per-heading marker/card/bridge rects. */
	private envelope: PointerEnvelope = { railRect: emptyRect(), items: [] };
	/** Rebuild the envelope on the next demand (RAF-coalesced — never per
	 * pointermove). */
	private envelopeDirty = true;
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
	// --- Pointer-follow state (velocity-assisted auto-scroll).
	/** Smoothed pointer vertical velocity, px/s (+ = down). */
	private pointerVelocityY = 0;
	/** Timestamp of the previous pointermove sample. */
	private lastMoveTime = Number.NaN;
	/** Currently APPLIED scroll speed after accel-cap damping, px/s. */
	private appliedVelocity = 0;
	// --- Pointer activation lock (section 9) --------------------------
	/** Set on pointerdown over a real marker/card; cleared on pointerup /
	 * pointercancel / window blur / dispose. While set, magnification
	 * displacement is frozen so the locked target cannot slide away. */
	private pressed: PressedHeadingState | null = null;

	constructor(
		private readonly view: GlideOutlineView,
		private readonly getSettings: () => GlideOutlineSettings,
		private readonly diagnostics: Diagnostics | null = null,
		/** Pointer activation path (pointerup lock). Keyboard activation
		 * goes through the view's click handler instead — never both. */
		private readonly onJump: ((item: HeadingItem) => void) | null = null,
	) {
		const doc = view.rootEl.ownerDocument;
		const win = doc.defaultView as (Window & typeof globalThis) | null;
		if (!win) throw new Error("glide-outline: detached document");
		this.win = win;
		this.reducedMotionQuery = win.matchMedia("(prefers-reduced-motion: reduce)");

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
		// there, so only a window listener can detect the exit. Cheap: it
		// only does a cached-rect containment test and rebuilds geometry
		// only when the dirty flag is set.
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

		this.disposables.listen(
			viewportEl,
			"scroll",
			() => {
				this.cacheDirty = true;
				this.envelopeDirty = true;
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
		this.cacheDirty = true;
		this.envelopeDirty = true;
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		this.trackPointerAnchor(event);
		// Fresh gesture: no carried-over velocity from a previous visit.
		this.pointerVelocityY = 0;
		this.lastMoveTime = event.timeStamp;
		this.syncExpanded();
		this.schedule();
	};

	private onPointerMove = (event: PointerEvent): void => {
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
		this.trackPointerAnchor(event);
		this.schedule();
	};

	/**
	 * Leaving a real element (rail / marker / card): if the pointer moved to
	 * another outline element (relatedTarget still in root) do nothing. If
	 * it is still inside the geometric envelope (a transparent gap between
	 * magnified neighbours, or the intra-row marker↔card gap) keep the
	 * outline open but stop auto-scroll. Otherwise start the collapse grace.
	 */
	private onPointerLeave = (event: PointerEvent): void => {
		const related = event.relatedTarget;
		if (this.isNodeInRoot(related)) return;
		if (this.envelopeDirty) this.rebuildEnvelope();
		if (pointInEnvelope(this.envelope, event.clientX, event.clientY)) {
			// Inside a transparent gap — keep expanded, but the pointer is no
			// longer over a real element, so stop auto-scroll / clear anchor.
			this.pointerInside = false;
			this.pointerAnchorEl = null;
			this.stopAutoScroll();
			this.cancelCollapse();
			return;
		}
		this.pointerInside = false;
		this.pointerAnchorEl = null;
		this.stopAutoScroll();
		this.armCollapse();
	};

	/**
	 * Window-level move: catches exits from transparent gaps (no real
	 * element fires a leave there). Only collapses when the pointer is
	 * genuinely outside the envelope; otherwise it is a no-op. Geometry is
	 * rebuilt only when dirty, so this stays cheap on every window move.
	 */
	private onWindowPointerMove = (event: PointerEvent): void => {
		if (!this.isExpanded() || this.pressed) return;
		this.lastPointerX = event.clientX;
		this.lastPointerY = event.clientY;
		if (this.envelopeDirty) this.rebuildEnvelope();
		// Degenerate envelope (no measurable geometry — e.g. jsdom, or a
		// detached/zero-size outline): never base a collapse decision on a
		// zero rect, or the pointer would be "always outside" and auto-scroll
		// would be killed on the first window move. In that case trust the
		// element-level enter/move/leave state instead.
		if (!this.envelopeIsMeasurable()) return;
		if (!pointInEnvelope(this.envelope, event.clientX, event.clientY)) {
			this.pointerInside = false;
			this.pointerAnchorEl = null;
			this.stopAutoScroll();
			this.armCollapse();
		}
	};

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
	 * DOM hit-testing for the magnification anchor (P0-5): when the event
	 * target sits inside a row, that row is what the user visually points
	 * at — even when magnification displaced it away from its base center.
	 * Blank-area events (rail strip) clear the anchor; the solver then falls
	 * back to nearest-visual-center interpolation. Duck-typed `closest` —
	 * safe in pop-out windows.
	 */
	private trackPointerAnchor(event: PointerEvent): void {
		const target = event.target as Partial<Element> | null;
		this.pointerAnchorEl =
			(target?.closest?.(".glide-outline-row") as HTMLElement | null) ??
			null;
	}

	/**
	 * Low-pass filtered pointer velocity (px/s, + = down). The filter
	 * absorbs pointermove jitter so the assist reacts to the gesture, not
	 * to single-event noise; the frame loop decays it between events.
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
		// Capture the pointer so pointerup fires even if it drifts off the
		// (possibly magnified / displaced) target. Magnification displacement
		// is frozen while held (frame returns early), so the locked rect
		// stays valid for the release-point tolerance test.
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

	private frame = (): void => {
		this.rafId = 0;
		// While a heading is held (pointerdown) the displacement is frozen so
		// the locked target cannot slide away; auto-scroll is already stopped.
		if (this.pressed) return;
		if (!this.isExpanded()) return;
		if (this.cacheDirty) this.rebuildCache();
		if (this.envelopeDirty) this.rebuildEnvelope();
		if (this.cache.length === 0 || Number.isNaN(this.lastPointerY)) return;

		const settings = this.getSettings();
		// Single resolved motion policy — shared with the view (CSS) and the
		// controller (jump behaviour). Replaces the old boolean that could not
		// override an OS reduced-motion report (the Windows failure).
		const motion = resolveMotionState(
			settings.motionMode,
			this.reducedMotionQuery.matches,
		);
		const reduced = motion.reduced;
		// Pure math over cached geometry — no DOM reads inside the frame.
		// The pointer is in VISUAL space; `shifts` + the DOM-hit anchor let
		// the solver map it back to base space (P0-5), so the row the user
		// visually points at is the one that magnifies.
		const results = computeCollisionFreeMagnification(
			this.lastPointerY,
			this.layout,
			settings.maxScale,
			settings.radius,
			settings.cardGap,
			reduced,
			{
				currentShifts: this.shifts,
				preferredAnchorIndex: this.resolveAnchorIndex(),
			},
		);

		for (let i = 0; i < this.cache.length; i++) {
			const entry = this.cache[i];
			const { scale, translateY } = results[i];
			if (entry.lastScale !== scale) {
				entry.el.style.setProperty("--glide-scale", String(scale));
				entry.lastScale = scale;
			}
			if (entry.lastShift !== translateY) {
				entry.el.style.setProperty("--glide-shift-y", `${translateY}px`);
				entry.lastShift = translateY;
			}
			// Keep the visual model in lockstep with what was just applied.
			entry.currentShift = translateY;
			entry.visualCenter = entry.baseCenter + translateY;
			this.shifts[i] = translateY;
		}

		// Pointer edge auto-scroll shares this frame: scrolling marks the
		// cache dirty (viewport scroll event), so the NEXT frame recomputes
		// client centers and magnification follows the moving rows smoothly.
		// The envelope is rebuilt next frame so hover tracks the new rects.
		this.envelopeDirty = true;
		this.stepAutoScroll(settings, reduced);
	};

	/**
	 * One pointer-follow auto-scroll step inside the coordinated RAF loop.
	 */
	private stepAutoScroll(
		settings: GlideOutlineSettings,
		reduced: boolean,
	): void {
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
			reducedMotion: reduced,
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

	/** Map the DOM-hit anchor element to its cache index (-1 = blank). */
	private resolveAnchorIndex(): number {
		const el = this.pointerAnchorEl;
		if (!el) return -1;
		for (let i = 0; i < this.cache.length; i++) {
			if (this.cache[i].el === el) return i;
		}
		return -1;
	}

	private rebuildCache(): void {
		this.cacheDirty = false;
		// Viewport bounds are cached here (not per frame) — they only move
		// on layout changes, which also dirty this cache.
		const viewportRect = this.view.viewportEl.getBoundingClientRect();
		this.viewportTop = viewportRect.top;
		this.viewportBottom = viewportRect.bottom;
		const children = this.view.listEl.children;
		const next: CachedItem[] = [];
		for (let i = 0; i < children.length; i++) {
			const el = children[i];
			// Pop-out safe instanceof (P1-1).
			if (!(el instanceof this.win.HTMLElement)) continue;
			// Row rects are transform-free (only the inner motion element
			// carries --glide-shift-y), so this measures the BASE center.
			const rect = el.getBoundingClientRect();
			const key = el.dataset.key ?? "";
			// Height comes from the view's measurement pass (offsetHeight,
			// transform-free); fall back to the row rect for safety.
			const measured = this.view.getBaseCardHeight(key);
			// Carry the applied shift across rebuilds: the style survives on
			// the element, so the visual model must survive with it.
			const previous = this.cache.find((entry) => entry.el === el);
			const carried =
				previous && Number.isFinite(previous.lastShift)
					? previous.lastShift
					: 0;
			const baseCenter = rect.top + rect.height / 2;
			next.push({
				el,
				baseCenter,
				currentShift: carried,
				visualCenter: baseCenter + carried,
				height: measured > 0 ? measured : rect.height,
				lastScale: previous?.lastScale ?? Number.NaN,
				lastShift: previous?.lastShift ?? Number.NaN,
			});
		}
		// Reset styles on elements that dropped out of the cache.
		for (const entry of this.cache) {
			if (!next.some((candidate) => candidate.el === entry.el)) {
				entry.el.style.removeProperty("--glide-scale");
				entry.el.style.removeProperty("--glide-shift-y");
			}
		}
		this.cache = next;
		this.layout = next.map((entry) => ({
			center: entry.baseCenter,
			height: entry.height,
		}));
		this.shifts = next.map((entry) => entry.currentShift);
		// The anchor element may have been removed with its heading.
		if (
			this.pointerAnchorEl &&
			!next.some((entry) => entry.el === this.pointerAnchorEl)
		) {
			this.pointerAnchorEl = null;
		}
	}

	/** Rebuild the geometric Pointer Envelope from the view's live rects. */
	private rebuildEnvelope(): void {
		this.envelopeDirty = false;
		this.envelope = this.view.collectEnvelope(
			ENVELOPE_H_TOLERANCE,
			ENVELOPE_V_TOLERANCE,
		);
	}

	private clearMagnification(): void {
		for (const entry of this.cache) {
			entry.el.style.removeProperty("--glide-scale");
			entry.el.style.removeProperty("--glide-shift-y");
			entry.lastScale = Number.NaN;
			entry.lastShift = Number.NaN;
			entry.currentShift = 0;
			entry.visualCenter = entry.baseCenter;
		}
		this.shifts.fill(0);
		this.pointerAnchorEl = null;
	}

	/** Bridge rect builder exposed for tests / geometry verification. */
	static buildBridge(marker: Rect, card: Rect): Rect {
		return bridgeRectFor(marker, card, ENVELOPE_H_TOLERANCE, ENVELOPE_V_TOLERANCE);
	}
}
