import {
	computeMagnification,
	defaultShiftAmplitude,
} from "../utils/geometry";
import { DisposableStore } from "../utils/disposable";
import type { GlideOutlineSettings } from "../settings";
import type { GlideOutlineView } from "./GlideOutlineView";

interface CachedItem {
	el: HTMLElement;
	/** Vertical center in viewport client coordinates. */
	center: number;
	lastScale: number;
	lastShift: number;
}

/** Grace period before collapsing, so crossing the transparent gap between
 * the rail and a label card does not flicker the outline shut. */
const COLLAPSE_GRACE_MS = 120;

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
		this.cacheDirty = true;
		this.lastPointerY = event.clientY;
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
		this.lastPointerY = event.clientY;
		this.schedule();
	};

	private onPointerLeave = (event: PointerEvent): void => {
		const related = event.relatedTarget;
		if (this.isNodeInRoot(related)) return;
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
		const results = computeMagnification(
			this.lastPointerY,
			this.cache.map((entry) => entry.center),
			settings.maxScale,
			settings.radius,
			{
				reducedMotion: reduced,
				shiftAmplitude: defaultShiftAmplitude(settings.maxScale),
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
		}
	};

	private rebuildCache(): void {
		this.cacheDirty = false;
		const children = this.view.listEl.children;
		const next: CachedItem[] = [];
		for (let i = 0; i < children.length; i++) {
			const el = children[i];
			// Pop-out safe instanceof (P1-1).
			if (!(el instanceof this.win.HTMLElement)) continue;
			const rect = el.getBoundingClientRect();
			next.push({
				el,
				center: rect.top + rect.height / 2,
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
