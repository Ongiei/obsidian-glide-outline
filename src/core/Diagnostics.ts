/**
 * Diagnostic capture for the "Copy Glide Outline diagnostics" command.
 *
 * Two recent interactions are recorded so a mis-jump can be reported with
 * enough context to tell a *wrong heading* apart from a *wrong release
 * point*:
 *   - LastPointerActivationDiagnostic — what a pointer press/release did.
 *   - LastJumpDiagnostic — what an editor/preview jump landed on.
 */

export interface LastPointerActivationDiagnostic {
	headingKey: string;
	headingText: string;
	headingLine: number;
	targetType: "marker" | "card";
	downX: number;
	downY: number;
	upX: number;
	upY: number;
	accepted: boolean;
	rejectionReason?: string;
}

/**
 * §四: how one correction round moved the scroller. The normal path only
 * ever uses the two smooth modes; `instant-fallback` is an explicitly
 * gated escape hatch for targets the editor never renders, and
 * `boundary-accepted` closes a round that could not move any further but
 * left the target fully visible.
 */
export type JumpCorrectionMode =
	| "smooth-estimate"
	| "smooth-client-correction"
	| "boundary-accepted"
	| "instant-fallback";

/** What started a correction round. */
export type JumpAttemptTrigger = "initial" | "verify";

/** How the settle wait of one round ended. */
export type JumpWaitSettledBy = "scrollend" | "timeout";

/**
 * §四.3: one correction round of the editor jump FSM. Recording every
 * attempt (not just the final error) is what makes a "landed 400 px off"
 * report actionable: it shows whether the corrector never converged, or
 * converged in scroll space while the *rendered* line was elsewhere.
 */
export interface JumpCorrectionAttempt {
	/** 1-based round index. */
	attempt: number;
	/** §四: which scroll primitive this round used. */
	mode: JumpCorrectionMode;
	/** §四: what started this round (first estimate vs re-verification). */
	trigger: JumpAttemptTrigger;
	/** Whether coordsAtPos returned coordinates for the target at all. */
	targetRendered: boolean;
	/** coordsAtPos().top at verification time, client space. */
	targetClientTop: number | null;
	/** Where the target SHOULD sit in client space (scroller top + margin). */
	desiredClientTop: number | null;
	/**
	 * Viewport-space error at verification (targetClientTop -
	 * desiredClientTop). Null when the target was not rendered.
	 */
	errorPx: number | null;
	/** scrollTop before this round's scroll request. */
	previousScrollTop: number;
	/** scrollTop this round asked the scroller to reach. */
	requestedScrollTop: number;
	/** scrollTop actually observed after the round settled. */
	resultingScrollTop: number;
	/** scroller.scrollHeight at verification. */
	scrollHeight: number;
	/** scroller.clientHeight at verification. */
	clientHeight: number;
	/** Resulting scrollTop is pinned at the top of the scroll range. */
	atTopBoundary: boolean;
	/** Resulting scrollTop is pinned at the bottom of the scroll range. */
	atBottomBoundary: boolean;
	/** Whether scrollend or the timeout fallback ended the wait. */
	settledBy: JumpWaitSettledBy;
	/** True only for the explicitly gated instant fallback (§四). */
	usedInstantFallback: boolean;
}

export type JumpSettledBy =
	| "within-tolerance"
	| "max-corrections"
	| "scroll-boundary"
	| "timeout"
	| "target-not-rendered";

/** §六: single terminal verdict of where the jump actually landed. */
export type JumpLandingReason =
	| "desired-position"
	| "top-boundary-visible"
	| "bottom-boundary-visible"
	| "failed";

export interface LastJumpDiagnostic {
	headingKey: string;
	headingText: string;
	expectedLine: number;
	mode: "editor" | "preview";
	behavior: "smooth" | "auto";
	finalErrorPx?: number;
	correctionCount: number;
	/** §四.3: every correction round, in order. */
	attempts?: JumpCorrectionAttempt[];
	/** §四.3: which terminal condition ended the correction FSM. */
	settledBy?: JumpSettledBy;
	/** §四.3: did coordsAtPos resolve the target on the final check? */
	targetRenderedAtFinish?: boolean;
	/** §四.3: was the final scrollTop pinned by the document boundary? */
	reachedScrollBoundary?: boolean;
	/**
	 * §五: a document-end heading cannot be brought to the margin because
	 * the scroller has run out of range. When the target is nonetheless
	 * fully visible we accept the landing instead of reporting a failure.
	 */
	acceptedAsVisibleBoundaryLanding?: boolean;
	/** §四.3: final error measured in viewport space (coordsAtPos). */
	finalViewportErrorPx?: number;
	/** §六: terminal landing verdict. */
	landingReason?: JumpLandingReason;
	/**
	 * §六: true when EVERY scroll this jump issued was a smooth one —
	 * i.e. the user never saw an instant reposition.
	 */
	animationConsistent?: boolean;
	/** §六: whether the gated instant fallback fired (normal path: false). */
	usedInstantFallback?: boolean;
	/** §六: number of correction rounds actually recorded. */
	correctionAttemptCount?: number;
}

/**
 * §十: who moved the outline viewport's scrollTop. Attribution is
 * best-effort — plugin writes are exact (we hold the write depth), the
 * rest is classified from short-lived notes left by the code path that
 * most recently touched the outline.
 */
export type ScrollDeltaSource =
	| "manual-wheel"
	| "edge"
	| "kinetic"
	| "combined"
	| "jump"
	| "active-follow"
	| "mount"
	| "file-change"
	| "mode-change"
	| "external"
	| "unknown";

/**
 * §十: one scroll event whose |delta| exceeded the viewport height —
 * exactly the "the outline teleported" class of bug report. Recorded
 * ALWAYS (not only during a perf capture), never clamped, never
 * swallowed: the scroll itself proceeds untouched.
 */
export interface LargeScrollDeltaSnapshot {
	previousScrollTop: number;
	currentScrollTop: number;
	delta: number;
	clientHeight: number;
	scrollHeight: number;
	source: ScrollDeltaSource;
	/** A file switch was noted shortly before this scroll. */
	fileChangePending: boolean;
	/** A view-mode switch was noted shortly before this scroll. */
	modeChangePending: boolean;
	/** The owning mount's instance id (null before the first mount). */
	instanceId: string | null;
}

/** §十: bounded ring — diagnostics must never grow without limit. */
const MAX_LARGE_SCROLL_DELTAS = 10;

/** Mutable collector shared by the magnification controller (activation)
 * and the outline controller (jump). */
export class Diagnostics {
	lastPointerActivation: LastPointerActivationDiagnostic | null = null;
	lastJump: LastJumpDiagnostic | null = null;
	/** §十: most recent large outline scroll deltas, oldest first. */
	largeScrollDeltas: LargeScrollDeltaSnapshot[] = [];

	recordPointerActivation(d: LastPointerActivationDiagnostic): void {
		this.lastPointerActivation = d;
	}

	recordJump(d: LastJumpDiagnostic): void {
		this.lastJump = d;
	}

	/** §十: bounded push — keeps the newest MAX_LARGE_SCROLL_DELTAS. */
	recordLargeScrollDelta(d: LargeScrollDeltaSnapshot): void {
		this.largeScrollDeltas.push(d);
		if (this.largeScrollDeltas.length > MAX_LARGE_SCROLL_DELTAS) {
			this.largeScrollDeltas.shift();
		}
	}
}
