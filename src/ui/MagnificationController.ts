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

/**
 * Pointer-proximity expand/collapse + dock magnification.
 *
 * Coordinate system: viewport client coordinates for BOTH the pointer
 * (`event.clientY`) and cached item centers (`getBoundingClientRect()`),
 * so no scroll compensation is applied anywhere — the cache is simply
 * rebuilt when the outline scrolls, resizes, or its items change.
 *
 * Per-frame work is limited to reading the cache and writing two CSS
 * custom properties per item; no layout reads happen inside the RAF.
 */
export class MagnificationController {
	private readonly disposables = new DisposableStore();
	private readonly win: Window;
	private cache: CachedItem[] = [];
	private cacheDirty = true;
	private expanded = false;
	private rafId = 0;
	private lastPointerY = Number.NaN;
	private reducedMotionQuery: MediaQueryList;

	constructor(
		private readonly view: GlideOutlineView,
		private readonly getSettings: () => GlideOutlineSettings,
	) {
		const doc = view.rootEl.ownerDocument;
		const win = doc.defaultView;
		if (!win) throw new Error("glide-outline: detached document");
		this.win = win;
		this.reducedMotionQuery = win.matchMedia("(prefers-reduced-motion: reduce)");

		const { hitZoneEl, viewportEl } = view;

		this.disposables.listen(hitZoneEl, "pointerenter", this.onPointerEnter);
		this.disposables.listen(hitZoneEl, "pointermove", this.onPointerMove);
		this.disposables.listen(hitZoneEl, "pointerleave", this.onPointerLeave);
		// One listener each on the two interactive surfaces — items themselves
		// never get individual pointermove handlers.
		this.disposables.listen(viewportEl, "pointermove", this.onPointerMove);
		this.disposables.listen(viewportEl, "pointerleave", this.onPointerLeave);
		this.disposables.listen(
			viewportEl,
			"scroll",
			() => {
				this.cacheDirty = true;
				this.schedule();
			},
			{ passive: true },
		);

		const resizeObserver = new win.ResizeObserver(() => {
			this.cacheDirty = true;
			this.schedule();
		});
		resizeObserver.observe(view.listEl);
		this.disposables.add(() => resizeObserver.disconnect());
	}

	/** Called when the heading list changed (item centers are stale). */
	invalidate(): void {
		this.cacheDirty = true;
		if (this.expanded) this.schedule();
	}

	dispose(): void {
		this.cancelFrame();
		this.clearMagnification();
		this.disposables.dispose();
	}

	private onPointerEnter = (event: PointerEvent): void => {
		this.expanded = true;
		this.view.setExpanded(true);
		this.cacheDirty = true;
		this.lastPointerY = event.clientY;
		this.schedule();
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (!this.expanded) {
			this.expanded = true;
			this.view.setExpanded(true);
			this.cacheDirty = true;
		}
		this.lastPointerY = event.clientY;
		this.schedule();
	};

	private onPointerLeave = (event: PointerEvent): void => {
		const related = event.relatedTarget;
		if (related instanceof Node && this.view.rootEl.contains(related)) return;
		this.collapse();
	};

	private collapse(): void {
		if (!this.expanded) return;
		this.expanded = false;
		this.view.setExpanded(false);
		this.cancelFrame();
		this.clearMagnification();
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
		if (!this.expanded) return;
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
			if (!(el instanceof HTMLElement)) continue;
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
