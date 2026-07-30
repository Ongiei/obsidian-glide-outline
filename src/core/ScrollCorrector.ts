/**
 * Platform-safe editor jump correction (section 12, reworked in §五).
 *
 * ## What changed and why
 *
 * 0.1.3 drove this loop from a single `measureError()` that subtracted a
 * DOCUMENT-space line top from a SCROLL-space `scrollTop`. Because the
 * Obsidian scroller holds the inline title and properties block above the
 * CodeMirror content, those two origins differ, and the loop happily
 * "converged" on a position that was off by exactly that offset (the
 * Windows baseline reported `finalErrorPx = 416.65625`).
 *
 * The corrector now consumes a full landing evaluation (see
 * `jumpLanding.ts`) computed from `coordsAtPos` — i.e. where the line
 * ACTUALLY rendered — and records every round so a bad landing can be
 * diagnosed from a capture instead of guessed at.
 *
 * Settle detection still arms BOTH `scrollend` (Chromium Obsidian) AND a
 * timeout fallback (embeds without `scrollend`); whichever fires first
 * wins and the other is cleaned up.
 */

import type { JumpCorrectionAttempt, JumpSettledBy } from "./Diagnostics";
import type { JumpLandingResult } from "./jumpLanding";

/** Explicit FSM state (§五) — exposed for tests and diagnostics. */
export type JumpCorrectorState =
	| "idle"
	/** A smooth animation is in flight; we do not fight it. */
	| "waiting-smooth"
	/** Dispatching / writing the exact scroll position. */
	| "applying-exact"
	/** Waiting for the scroll + layout to settle. */
	| "waiting-layout"
	/** Re-measuring the landing. */
	| "verifying"
	| "complete";

/** One landing measurement: the verdict plus the scrollTop it was read at. */
export interface JumpLandingEvaluation {
	result: JumpLandingResult;
	scrollTop: number;
}

export interface JumpCorrectionSummary {
	/** Absolute final error (viewport space when known, else scroll space). */
	finalErrorPx: number;
	/** Absolute final error in viewport space; null if never measurable. */
	finalViewportErrorPx: number | null;
	correctionCount: number;
	attempts: JumpCorrectionAttempt[];
	settledBy: JumpSettledBy;
	targetRenderedAtFinish: boolean;
	reachedScrollBoundary: boolean;
	acceptedAsVisibleBoundaryLanding: boolean;
}

export interface ScrollCorrectorOptions {
	/** Maximum number of corrective passes. */
	maxCorrections: number;
	/** Fallback timeout (ms) when `scrollend` never fires (600–800). */
	timeoutMs: number;
	/** Measure the current landing. Must never throw. */
	evaluate: () => JumpLandingEvaluation;
	/** Move to `result.desiredScrollTop` (idempotent). */
	apply: (result: JumpLandingResult) => void;
	/** Called exactly once when correction finishes. */
	done: (summary: JumpCorrectionSummary) => void;
	win: Window & typeof globalThis;
	scroller: HTMLElement;
	/**
	 * When true the FIRST pass only waits for the in-flight smooth scroll
	 * to settle (no exact dispatch), so the animation is not cancelled.
	 */
	smoothFirst?: boolean;
}

/** A correction that has been applied but not yet verified. */
interface PendingAttempt {
	attempt: number;
	scrollTopBefore: number;
	desiredScrollTop: number;
}

export class ScrollCorrector {
	private corrections = 0;
	private finished = false;
	private timerId = 0;
	private readonly onSettle: () => void;
	private readonly attempts: JumpCorrectionAttempt[] = [];
	private pending: PendingAttempt | null = null;
	/** True when the last settle came from the timeout, not `scrollend`. */
	private settledViaTimeout = false;
	state: JumpCorrectorState = "idle";

	constructor(private readonly opts: ScrollCorrectorOptions) {
		this.onSettle = () => {
			this.settledViaTimeout = false;
			this.verify();
		};
	}

	/** Begin: correct (or await the smooth scroll) and verify on settle. */
	start(): void {
		if (this.finished) return;
		if (this.opts.smoothFirst) {
			this.state = "waiting-smooth";
			this.awaitSettle();
		} else {
			this.correctOnce();
		}
	}

	/** One exact correction pass, then wait for the scroll to settle. */
	private correctOnce(): void {
		if (this.finished) return;
		const { result, scrollTop } = this.opts.evaluate();

		// Already good, or nothing measurable to correct toward.
		if (result.settled) {
			this.finish(result, this.terminalReasonFor(result));
			return;
		}
		if (result.strategy === "none") {
			this.finish(result, "target-not-rendered");
			return;
		}

		this.corrections += 1;
		this.pending = {
			attempt: this.corrections,
			scrollTopBefore: scrollTop,
			desiredScrollTop: result.desiredScrollTop,
		};
		this.state = "applying-exact";
		this.opts.apply(result);
		this.state = "waiting-layout";
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
			this.settledViaTimeout = true;
			this.verify();
		}, this.opts.timeoutMs);
	}

	private verify(): void {
		if (this.finished) return;
		this.clearSettleListeners();
		this.state = "verifying";
		const { result, scrollTop } = this.opts.evaluate();

		// Close the attempt this settle belongs to (smoothFirst's initial
		// wait has no pending correction).
		if (this.pending) {
			this.attempts.push({
				attempt: this.pending.attempt,
				scrollTopBefore: this.pending.scrollTopBefore,
				desiredScrollTop: this.pending.desiredScrollTop,
				scrollTopAfter: scrollTop,
				scrollErrorPx: scrollTop - this.pending.desiredScrollTop,
				viewportErrorPx: result.viewportErrorPx,
				targetRendered: result.targetRendered,
				clampedAtBoundary: result.clampedAtBoundary,
			});
			this.pending = null;
		}

		if (result.settled) {
			this.finish(result, this.terminalReasonFor(result));
			return;
		}
		if (result.strategy === "none") {
			this.finish(result, "target-not-rendered");
			return;
		}
		if (this.corrections >= this.opts.maxCorrections) {
			// Distinguish "never settled" from "settled but still off" —
			// the former means the scroll animation outran our budget.
			this.finish(
				result,
				this.settledViaTimeout ? "timeout" : "max-corrections",
			);
			return;
		}
		this.correctOnce();
	}

	private terminalReasonFor(result: JumpLandingResult): JumpSettledBy {
		return result.acceptedAsVisibleBoundaryLanding
			? "scroll-boundary"
			: "within-tolerance";
	}

	private finish(result: JumpLandingResult, settledBy: JumpSettledBy): void {
		if (this.finished) return;
		this.finished = true;
		this.state = "complete";
		this.clearSettleListeners();
		const viewportError =
			result.viewportErrorPx !== null
				? Math.abs(result.viewportErrorPx)
				: null;
		this.opts.done({
			finalErrorPx: viewportError ?? Math.abs(result.deltaPx),
			finalViewportErrorPx: viewportError,
			correctionCount: this.corrections,
			attempts: this.attempts.slice(),
			settledBy,
			targetRenderedAtFinish: result.targetRendered,
			reachedScrollBoundary: result.clampedAtBoundary,
			acceptedAsVisibleBoundaryLanding:
				result.acceptedAsVisibleBoundaryLanding,
		});
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
		this.state = "complete";
		this.clearSettleListeners();
	}
}
