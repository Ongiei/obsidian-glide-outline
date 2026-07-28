/**
 * Platform-safe editor jump correction (section 12).
 *
 * A smooth scroll only *estimates* the landing position; CM6's exact
 * `scrollIntoView` effect is what lands the heading precisely. After each
 * corrective `apply()` we wait for the scroll to settle and verify:
 *
 *   |measureError()| <= tolerance
 *
 * `measureError` returns the SIGNED landing error in px (current scroll
 * position minus the desired one, clamped by the caller to the scrollable
 * range so an unreachable bottom heading is not treated as a failure).
 * If the error is too large we correct again, but the total number of
 * corrections is capped so a pathological layout can never loop forever.
 *
 * Settle detection uses BOTH `scrollend` (Chromium Obsidian) AND a timeout
 * fallback (embeds without `scrollend`), exactly as the spec requires —
 * the timeout is never dropped just because `scrollend` exists in the type
 * declarations. Whichever fires first wins; the other is cleaned up.
 */

export interface ScrollCorrectorOptions {
	/** Acceptable final |error|, in px (2–4). */
	tolerance: number;
	/** Maximum number of `apply()` passes. */
	maxCorrections: number;
	/** Fallback timeout (ms) when `scrollend` never fires (600–800). */
	timeoutMs: number;
	/** Signed landing error in px (actual − desired, range-clamped). */
	measureError: () => number;
	/** Dispatch the exact scroll effect (idempotent). */
	apply: () => void;
	/** Called once when correction finishes (settled or capped). */
	done: (finalErrorPx: number, correctionCount: number) => void;
	win: Window & typeof globalThis;
	scroller: HTMLElement;
	/** When true, the FIRST pass only waits for the in-flight smooth
	 * scroll to settle (no exact dispatch) — so the animation is not
	 * cancelled by an instant correction. */
	smoothFirst?: boolean;
}

export class ScrollCorrector {
	private corrections = 0;
	private finished = false;
	private timerId = 0;
	private readonly onSettle: () => void;

	constructor(private readonly opts: ScrollCorrectorOptions) {
		this.onSettle = () => this.verify();
	}

	/** Begin: correct (or await the smooth scroll) and verify on settle. */
	start(): void {
		if (this.finished) return;
		if (this.opts.smoothFirst) {
			this.awaitSettle();
		} else {
			this.correctOnce();
		}
	}

	/** One exact correction pass, then wait for the scroll to settle. */
	private correctOnce(): void {
		if (this.finished) return;
		this.corrections += 1;
		this.opts.apply();
		this.awaitSettle();
	}

	/** Arm BOTH scrollend and the timeout fallback; first one verifies. */
	private awaitSettle(): void {
		this.clearSettleListeners();
		this.opts.scroller.addEventListener("scrollend", this.onSettle, {
			once: true,
		});
		this.timerId = this.opts.win.setTimeout(() => {
			this.timerId = 0;
			this.opts.scroller.removeEventListener("scrollend", this.onSettle);
			this.verify();
		}, this.opts.timeoutMs);
	}

	private verify(): void {
		if (this.finished) return;
		this.clearSettleListeners();
		const error = Math.abs(this.opts.measureError());
		if (
			error <= this.opts.tolerance ||
			this.corrections >= this.opts.maxCorrections
		) {
			this.finish(error);
			return;
		}
		// Landed off-target and we still have correction budget — correct
		// again and re-verify on the next settle.
		this.correctOnce();
	}

	private finish(finalErrorPx: number): void {
		if (this.finished) return;
		this.finished = true;
		this.clearSettleListeners();
		this.opts.done(finalErrorPx, this.corrections);
	}

	private clearSettleListeners(): void {
		if (this.timerId !== 0) {
			this.opts.win.clearTimeout(this.timerId);
			this.timerId = 0;
		}
		this.opts.scroller.removeEventListener("scrollend", this.onSettle);
	}

	dispose(): void {
		this.finished = true;
		this.clearSettleListeners();
	}
}
