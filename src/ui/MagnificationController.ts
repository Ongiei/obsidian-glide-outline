import { computeCollisionFreeMagnification } from "../utils/geometry";
import { computePointerAutoScrollVelocity } from "../utils/overflow";
import { DisposableStore } from "../utils/disposable";
import type { GlideOutlineSettings } from "../settings";
import type { GlideOutlineView } from "./GlideOutlineView";

interface CachedItem {
	el: HTMLElement;
	/** Vertical center in viewport client coordinates. */
	center: number;
	/** Unscaled card height (measured by the view, cached here). */
	height: number;
	lastScale: number;
	lastShift: number;
}

/** Grace period before collapsing, so crossing the transparent gap between
 * the rail and a label card does not flicker the outline shut. */
const COLLAPSE_GRACE_MS = 120;

/** Pointer auto-scroll: peak speed in px/s at the very edge. */
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
 */
export class MagnificationController {
	private readonly disposables = new DisposableStore();
	private readonly win: Window & typeof globalThis;
	private cache: CachedItem[] = [];
	private cacheDirty = true;
	private pointerExpanded = false;
	private focusExpanded = false;
	private rafId = 0;
	private collapseTimer = 0;
	private lastPointerY = Number.NaN;
	private reducedMotionQuery: MediaQueryList;
	// --- Pointer edge auto-scroll state (coordinated in the same RAF as
	// magnification, so the two never fight over frames).
	/** Viewport bounds cached alongside the item cache — no per-frame rect. */
	private viewportTop = 0;
	private viewportBottom = 0;
	/** Dwell gate: velocity only applies after the pointer lingered. */
	private dwellTimer = 0;
	private dwellPassed = false;
	/** pointerdown → scrolling locked until pointerup re-evaluates. */
	private pointerHeld = false;
	/** True only while the pointer is physically inside the outline. */
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

	constructor(
		private readonly view: GlideOutlineView,
		private readonly getSettings: () => GlideOutlineSettings,
	) {
		const doc = view.rootEl.ownerDocument;
		const win = doc.defaultView as (Window & typeof globalThis) | null;
		if (!win) throw new Error("glide-outline: detached document");
		this.win = win;
		this.reducedMotionQuery = win.matchMedia("(prefers-reduced-motion: reduce)");

		const { hitZoneEl, viewportEl, listEl, rootEl } = view;

		// Rail strip: enter/move/leave.
		this.disposables.listen(hitZoneEl, "pointerenter", this.onPointerEnter);
		this.disposables.listen(hitZoneEl, "pointermove", this.onPointerMove);
		this.disposables.listen(hitZoneEl, "pointerleave", this.onPointerLeave);
		// Cards and markers bubble through the list — one listener set, no
		// per-item handlers. The viewport itself is pointer-transparent.
		this.disposables.listen(listEl, "pointerenter", this.onPointerEnter);
		this.disposables.listen(listEl, "pointermove", this.onPointerMove);
		this.disposables.listen(listEl, "pointerleave", this.onPointerLeave);

		// Wheel on the rail strip scrolls the outline, not the editor (Phase 10).
		this.disposables.listen(
			hitZoneEl,
			"wheel",
			(event: WheelEvent) => {
				if (!this.isExpanded()) return;
				event.preventDefault();
				viewportEl.scrollTop += event.deltaY;
			},
			{ passive: false },
		);

		this.disposables.listen(
			viewportEl,
			"scroll",
			() => {
				this.cacheDirty = true;
				// User is scrolling the outline — pause active-heading follow.
				this.view.setFollowEnabled(false);
				this.schedule();
			},
			{ passive: true },
		);

		// Pointer edge auto-scroll: pointerdown locks the list so the user's
		// click target cannot slide away mid-click; pointerup re-evaluates.
		this.disposables.listen(rootEl, "pointerdown", () => {
			this.pointerHeld = true;
		});
		this.disposables.listen(rootEl, "pointerup", () => {
			this.pointerHeld = false;
			// Position unchanged but the lock lifted — resume if still edged.
			this.schedule();
		});
		this.disposables.listen(rootEl, "pointercancel", () => {
			this.pointerHeld = false;
		});

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

		const resizeObserver = new win.ResizeObserver(() => {
			this.cacheDirty = true;
			this.schedule();
		});
		resizeObserver.observe(view.listEl);
		resizeObserver.observe(view.rootEl);
		this.disposables.add(() => resizeObserver.disconnect());
	}

	/** Called when the heading list or settings changed (centers are stale). */
	invalidate(): void {
		this.cacheDirty = true;
		if (this.isExpanded()) this.schedule();
	}

	dispose(): void {
		this.cancelFrame();
		this.cancelCollapse();
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
		this.lastPointerY = event.clientY;
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
			this.syncExpanded();
		}
		this.pointerInside = true;
		this.trackPointerVelocity(event);
		this.lastPointerY = event.clientY;
		this.schedule();
	};

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

	private onPointerLeave = (event: PointerEvent): void => {
		const related = event.relatedTarget;
		if (this.isNodeInRoot(related)) return;
		// Auto-scroll must stop IMMEDIATELY on pointerleave — only the
		// expand/collapse state gets the grace period.
		this.pointerInside = false;
		this.stopAutoScroll();
		// Grace period: crossing the transparent gap must not collapse.
		this.cancelCollapse();
		this.collapseTimer = this.win.setTimeout(() => {
			this.collapseTimer = 0;
			this.pointerExpanded = false;
			this.syncExpanded();
		}, COLLAPSE_GRACE_MS);
	};

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
		} else {
			this.cacheDirty = true;
			this.schedule();
		}
	}

	private schedule(): void {
		if (this.rafId !== 0) return;
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
		if (!this.isExpanded()) return;
		if (this.cacheDirty) this.rebuildCache();
		if (this.cache.length === 0 || Number.isNaN(this.lastPointerY)) return;

		const settings = this.getSettings();
		const reduced =
			this.reducedMotionQuery.matches || !settings.animationEnabled;
		// Pure math over cached geometry — no DOM reads inside the frame.
		const results = computeCollisionFreeMagnification(
			this.lastPointerY,
			this.cache,
			settings.maxScale,
			settings.radius,
			settings.cardGap,
			reduced,
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
		}

		// Pointer edge auto-scroll shares this frame: scrolling marks the
		// cache dirty (viewport scroll event), so the NEXT frame recomputes
		// client centers and magnification follows the moving rows smoothly.
		this.stepAutoScroll(settings, reduced);
	};

	/**
	 * One pointer-follow auto-scroll step inside the coordinated RAF loop.
	 *
	 * Pipeline per frame:
	 *   1. target = computePointerAutoScrollVelocity(position, pointer
	 *      velocity, zones, scrollability)  — pure math
	 *   2. appliedVelocity chases target under an ACCELERATION CAP
	 *      (AUTO_SCROLL_ACCEL px/s²) — no per-pointermove jumps, motion
	 *      always ramps and damps continuously
	 *   3. mutate viewport.scrollTop (time-based, refresh-rate independent)
	 *   4. the scroll event marks the geometry cache dirty
	 *   5. next frame rebuilds item client centers
	 *   6. magnification continues from the unchanged pointerY
	 *   7. the view's scroll listener updates the edge fade state
	 */
	private stepAutoScroll(
		settings: GlideOutlineSettings,
		reduced: boolean,
	): void {
		// Focus-only expansion never auto-scrolls; a held pointer locks the
		// list so the click target cannot slide away mid-click.
		if (!this.pointerExpanded || !this.pointerInside || this.pointerHeld) {
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

		const overflow = this.view.getOverflowState();
		const target = computePointerAutoScrollVelocity({
			pointerY: this.lastPointerY,
			pointerVelocityY: this.pointerVelocityY,
			viewportTop: this.viewportTop,
			viewportBottom: this.viewportBottom,
			maxSpeed: AUTO_SCROLL_MAX_SPEED,
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
			const maxDelta = AUTO_SCROLL_ACCEL * dt;
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
			const rect = el.getBoundingClientRect();
			const key = el.dataset.key ?? "";
			// Height comes from the view's measurement pass (offsetHeight,
			// transform-free); fall back to the row rect for safety.
			const measured = this.view.getBaseCardHeight(key);
			next.push({
				el,
				center: rect.top + rect.height / 2,
				height: measured > 0 ? measured : rect.height,
				lastScale: Number.NaN,
				lastShift: Number.NaN,
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
	}

	private clearMagnification(): void {
		for (const entry of this.cache) {
			entry.el.style.removeProperty("--glide-scale");
			entry.el.style.removeProperty("--glide-shift-y");
			entry.lastScale = Number.NaN;
			entry.lastShift = Number.NaN;
		}
	}
}
