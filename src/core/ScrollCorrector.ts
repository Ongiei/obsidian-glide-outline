/**
 * Consistently-smooth editor jump correction (§四/§五/§六, 0.1.5).
 *
 * ## What changed in 0.1.5 and why
 *
 * 0.1.4 animated the FIRST scroll but applied every CORRECTION round with
 * a raw `scroller.scrollTop = …` write. When the smooth animation landed
 * a few px off (fonts, embeds, late layout), the follow-up write was an
 * instant reposition — the "sometimes smooth, sometimes teleports" bug.
 *
 * The corrector now owns EVERY scroll request of a jump and issues all of
 * them through a smooth primitive (`requestScroll`, backed by
 * `scrollTo({ behavior: "smooth" })`). The only non-smooth path left is
 * the explicitly gated `instant-fallback` (`requestInstantFallback`,
 * backed by CM's `scrollIntoView` effect), reached ONLY when a landing
 * cannot even be estimated (`strategy === "none"`: no client coords AND
 * no document-space estimate) — i.e. when no smooth alternative exists.
 * Normal jumps must never take it, and `usedInstantFallback` records it.
 *
 * ## FSM (§四)
 *
 *   idle → estimating → smooth-scrolling → waiting-layout → verifying
 *        → (smooth-correcting → smooth-scrolling → …) → complete
 *
 * Each round: evaluate → smooth scroll → settle (`scrollend` OR timeout,
 * whichever first) → two rAFs (layout + paint flush) → re-evaluate.
 *
 * Settle detection still arms BOTH `scrollend` (Chromium Obsidian) AND a
 * timeout fallback (embeds without `scrollend`); whichever fires first
 * wins and the other is cleaned up.
 */

import type {
	JumpAttemptTrigger,
	JumpCorrectionAttempt,
	JumpCorrectionMode,
	JumpLandingReason,
	JumpSettledBy,
	JumpWaitSettledBy,
} from "./Diagnostics";
import type { JumpLandingResult } from "./jumpLanding";

/** Explicit FSM state (§四) — exposed for tests and diagnostics. */
export type JumpCorrectorState =
	| "idle"
	/** Measuring the initial landing estimate. */
	| "estimating"
	/** A smooth scroll (ours) is in flight; we do not fight it. */
	| "smooth-scrolling"
	/** Scroll settled; flushing layout via two rAFs before measuring. */
	| "waiting-layout"
	/** Re-measuring the landing. */
	| "verifying"
	/** Preparing the next smooth correction round. */
	| "smooth-correcting"
	| "complete";

/** One landing measurement: the verdict plus the scroller geometry. */
export interface JumpLandingEvaluation {
	result: JumpLandingResult;
	scrollTop: number;
	/** scroller.scrollHeight at measurement time (§四 attempt record). */
	scrollHeight: number;
	/** scroller.clientHeight at measurement time (§四 attempt record). */
	clientHeight: number;
	/** coordsAtPos().top in client space; null when not rendered. */
	targetClientTop: number | null;
	/** Where the target SHOULD sit: scrollerClientTop + marginPx. */
	desiredClientTop: number | null;
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
	/** §六: single terminal verdict. */
	landingReason: JumpLandingReason;
	/** §六: true iff every scroll issued was smooth. */
	animationConsistent: boolean;
	/** §六: the gated instant fallback fired (normal path: false). */
	usedInstantFallback: boolean;
}

export interface ScrollCorrectorOptions {
	/** Maximum number of corrective passes. */
	maxCorrections: number;
	/** Fallback timeout (ms) when `scrollend` never fires (600–800). */
	timeoutMs: number;
	/** Measure the current landing. Must never throw. */
	evaluate: () => JumpLandingEvaluation;
	/**
	 * §四: issue a SMOOTH scroll toward `desiredScrollTop`. This is the
	 * ONLY scroll primitive of the normal path — implementations must use
	 * `scrollTo({ behavior: "smooth" })` (or equivalent), never a raw
	 * `scrollTop` write.
	 */
	requestScroll: (desiredScrollTop: number, mode: JumpCorrectionMode) => void;
	/**
	 * §四: explicitly gated instant fallback (CM `scrollIntoView`
	 * dispatch) for targets that produce NO measurable landing at all
	 * (`strategy === "none"`) — there is no position a smooth scroll
	 * could aim for. Omit to disable; the corrector then finishes with
	 * `target-not-rendered` instead.
	 */
	requestInstantFallback?: () => void;
	/** Called exactly once when correction finishes. */
	done: (summary: JumpCorrectionSummary) => void;
	win: Window & typeof globalThis;
	scroller: HTMLElement;
}

/** A correction round that has been requested but not yet verified. */
interface PendingAttempt {
	attempt: number;
	mode: JumpCorrectionMode;
	trigger: JumpAttemptTrigger;
	previousScrollTop: number;
	requestedScrollTop: number;
	usedInstantFallback: boolean;
}

/** Sub-pixel slack when classifying boundary pinning. */
const BOUNDARY_EPSILON_PX = 0.5;

export class ScrollCorrector {
	private corrections = 0;
	private finished = false;
	private timerId = 0;
	private rafId = 0;
	/** True while `rafId` came from setTimeout (no rAF available). */
	private rafViaTimeout = false;
	private readonly onSettle: () => void;
	private readonly attempts: JumpCorrectionAttempt[] = [];
	private pending: PendingAttempt | null = null;
	/** How the CURRENT round's wait ended (scrollend vs timeout). */
	private lastWaitSettledBy: JumpWaitSettledBy = "scrollend";
	/** §六: any round took the gated instant fallback. */
	private usedInstantFallback = false;
	state: JumpCorrectorState = "idle";

	constructor(private readonly opts: ScrollCorrectorOptions) {
		this.onSettle = () => {
			this.lastWaitSettledBy = "scrollend";
			this.afterSettle();
		};
	}

	/** Begin: estimate, smooth-scroll, verify on settle — all rounds smooth. */
	start(): void {
		if (this.finished) return;
		this.state = "estimating";
		this.correctOnce("initial");
	}

	/** One smooth correction round, then wait for the scroll to settle. */
	private correctOnce(trigger: JumpAttemptTrigger): void {
		if (this.finished) return;
		const evaluation = this.opts.evaluate();
		const { result } = evaluation;

		// Already good, or accepted as a visible boundary landing.
		if (result.settled) {
			this.finish(evaluation, this.terminalReasonFor(result));
			return;
		}
		if (result.strategy === "none") {
			this.tryInstantFallback(evaluation, trigger);
			return;
		}

		// §四: mode classification. The initial round is always the smooth
		// estimate; verify-triggered rounds are exact client-space
		// corrections when the target rendered, or another smooth estimate
		// when it is still virtualized (document-fallback).
		const mode: JumpCorrectionMode =
			trigger === "initial" || result.strategy === "document-fallback"
				? "smooth-estimate"
				: "smooth-client-correction";

		this.corrections += 1;
		this.pending = {
			attempt: this.corrections,
			mode,
			trigger,
			previousScrollTop: evaluation.scrollTop,
			requestedScrollTop: result.desiredScrollTop,
			usedInstantFallback: false,
		};
		try {
			this.opts.requestScroll(result.desiredScrollTop, mode);
		} catch {
			// Scroller detached mid-jump — verify whatever state remains.
		}
		this.state = "smooth-scrolling";
		this.awaitSettle();
	}

	/**
	 * §四: gated instant fallback. Reached ONLY when the landing produced
	 * no measurable target (`strategy === "none"`): there is no scrollTop
	 * a smooth scroll could animate toward, so CM's own measure-driven
	 * effect is the last resort. Recorded as `usedInstantFallback`.
	 */
	private tryInstantFallback(
		evaluation: JumpLandingEvaluation,
		trigger: JumpAttemptTrigger,
	): void {
		if (
			!this.opts.requestInstantFallback ||
			this.corrections >= this.opts.maxCorrections
		) {
			this.finish(evaluation, "target-not-rendered");
			return;
		}
		this.usedInstantFallback = true;
		this.corrections += 1;
		this.pending = {
			attempt: this.corrections,
			mode: "instant-fallback",
			trigger,
			previousScrollTop: evaluation.scrollTop,
			requestedScrollTop: evaluation.result.desiredScrollTop,
			usedInstantFallback: true,
		};
		try {
			this.opts.requestInstantFallback();
		} catch {
			// View detached mid-scroll — verify below regardless.
		}
		this.state = "smooth-scrolling";
		this.awaitSettle();
	}

	/** Arm BOTH scrollend and the timeout fallback; first one proceeds. */
	private awaitSettle(): void {
		this.clearSettleListeners();
		this.opts.scroller.addEventListener("scrollend", this.onSettle, {
			once: true,
		});
		this.timerId = this.opts.win.setTimeout(() => {
			this.timerId = 0;
			this.opts.scroller.removeEventListener("scrollend", this.onSettle);
			this.lastWaitSettledBy = "timeout";
			this.afterSettle();
		}, this.opts.timeoutMs);
	}

	/** §四: settle → two rAFs (flush layout + paint) → verify. */
	private afterSettle(): void {
		if (this.finished) return;
		this.clearSettleListeners();
		this.state = "waiting-layout";
		this.requestFrame(() => {
			this.requestFrame(() => this.verify());
		});
	}

	private requestFrame(cb: () => void): void {
		const win = this.opts.win;
		if (typeof win.requestAnimationFrame === "function") {
			this.rafViaTimeout = false;
			this.rafId = win.requestAnimationFrame(() => {
				this.rafId = 0;
				cb();
			});
		} else {
			// Environment without rAF (detached iframe) — next macrotask.
			this.rafViaTimeout = true;
			this.rafId = win.setTimeout(() => {
				this.rafId = 0;
				cb();
			}, 16);
		}
	}

	private verify(): void {
		if (this.finished) return;
		this.state = "verifying";
		const evaluation = this.opts.evaluate();
		const { result, scrollTop } = evaluation;

		// Close the round this settle belongs to.
		if (this.pending) {
			const maxScrollTop = Math.max(
				0,
				evaluation.scrollHeight - evaluation.clientHeight,
			);
			this.attempts.push({
				attempt: this.pending.attempt,
				// §四: a round that ends pinned-but-fully-visible IS the
				// correct landing for a document-edge heading.
				mode: result.acceptedAsVisibleBoundaryLanding
					? "boundary-accepted"
					: this.pending.mode,
				trigger: this.pending.trigger,
				targetRendered: result.targetRendered,
				targetClientTop: evaluation.targetClientTop,
				desiredClientTop: evaluation.desiredClientTop,
				errorPx: result.viewportErrorPx,
				previousScrollTop: this.pending.previousScrollTop,
				requestedScrollTop: this.pending.requestedScrollTop,
				resultingScrollTop: scrollTop,
				scrollHeight: evaluation.scrollHeight,
				clientHeight: evaluation.clientHeight,
				atTopBoundary: scrollTop <= BOUNDARY_EPSILON_PX,
				atBottomBoundary:
					scrollTop >= maxScrollTop - BOUNDARY_EPSILON_PX,
				settledBy: this.lastWaitSettledBy,
				usedInstantFallback: this.pending.usedInstantFallback,
			});
			this.pending = null;
		}

		if (result.settled) {
			this.finish(evaluation, this.terminalReasonFor(result));
			return;
		}
		if (result.strategy === "none") {
			if (this.usedInstantFallback) {
				// The gated fallback already ran and the target is STILL
				// unmeasurable — stop instead of spinning.
				this.finish(evaluation, "target-not-rendered");
				return;
			}
			this.state = "smooth-correcting";
			this.tryInstantFallback(evaluation, "verify");
			return;
		}
		if (this.corrections >= this.opts.maxCorrections) {
			// Distinguish "never settled" from "settled but still off" —
			// the former means the scroll animation outran our budget.
			this.finish(
				evaluation,
				this.lastWaitSettledBy === "timeout"
					? "timeout"
					: "max-corrections",
			);
			return;
		}
		this.state = "smooth-correcting";
		this.correctOnce("verify");
	}

	private terminalReasonFor(result: JumpLandingResult): JumpSettledBy {
		return result.acceptedAsVisibleBoundaryLanding
			? "scroll-boundary"
			: "within-tolerance";
	}

	/** §六: map the terminal condition to a single landing verdict. */
	private landingReasonFor(
		evaluation: JumpLandingEvaluation,
		settledBy: JumpSettledBy,
	): JumpLandingReason {
		if (settledBy === "within-tolerance") return "desired-position";
		if (settledBy === "scroll-boundary") {
			const maxScrollTop = Math.max(
				0,
				evaluation.scrollHeight - evaluation.clientHeight,
			);
			return evaluation.scrollTop <= BOUNDARY_EPSILON_PX &&
				maxScrollTop > BOUNDARY_EPSILON_PX
				? "top-boundary-visible"
				: "bottom-boundary-visible";
		}
		return "failed";
	}

	private finish(
		evaluation: JumpLandingEvaluation,
		settledBy: JumpSettledBy,
	): void {
		if (this.finished) return;
		this.finished = true;
		this.state = "complete";
		this.clearSettleListeners();
		const result = evaluation.result;
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
			landingReason: this.landingReasonFor(evaluation, settledBy),
			animationConsistent: !this.usedInstantFallback,
			usedInstantFallback: this.usedInstantFallback,
		});
	}

	private clearSettleListeners(): void {
		if (this.timerId !== 0) {
			this.opts.win.clearTimeout(this.timerId);
			this.timerId = 0;
		}
		if (this.rafId !== 0) {
			if (
				!this.rafViaTimeout &&
				typeof this.opts.win.cancelAnimationFrame === "function"
			) {
				this.opts.win.cancelAnimationFrame(this.rafId);
			} else {
				this.opts.win.clearTimeout(this.rafId);
			}
			this.rafId = 0;
		}
		this.opts.scroller.removeEventListener("scrollend", this.onSettle);
	}

	dispose(): void {
		this.finished = true;
		this.state = "complete";
		this.clearSettleListeners();
	}
}
