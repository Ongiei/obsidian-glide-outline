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
 * §四.3: one correction round of the editor jump FSM. Recording every
 * attempt (not just the final error) is what makes a "landed 400 px off"
 * report actionable: it shows whether the corrector never converged, or
 * converged in scroll space while the *rendered* line was elsewhere.
 */
export interface JumpCorrectionAttempt {
	/** 1-based round index. */
	attempt: number;
	/** scrollTop before this correction was applied. */
	scrollTopBefore: number;
	/** scrollTop the corrector asked for. */
	desiredScrollTop: number;
	/** scrollTop actually observed after the write settled. */
	scrollTopAfter: number;
	/** Error in SCROLL space (scrollTopAfter - desiredScrollTop). */
	scrollErrorPx: number;
	/**
	 * Error in VIEWPORT space from coordsAtPos — the authoritative
	 * "where did the line actually render" verdict. Null when the target
	 * offset was outside the rendered range and produced no coordinates.
	 */
	viewportErrorPx: number | null;
	/** Whether coordsAtPos returned coordinates for the target at all. */
	targetRendered: boolean;
	/** True when the write was clamped by the document scroll range. */
	clampedAtBoundary: boolean;
}

export type JumpSettledBy =
	| "within-tolerance"
	| "max-corrections"
	| "scroll-boundary"
	| "timeout"
	| "target-not-rendered";

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
}

/** Mutable collector shared by the magnification controller (activation)
 * and the outline controller (jump). */
export class Diagnostics {
	lastPointerActivation: LastPointerActivationDiagnostic | null = null;
	lastJump: LastJumpDiagnostic | null = null;

	recordPointerActivation(d: LastPointerActivationDiagnostic): void {
		this.lastPointerActivation = d;
	}

	recordJump(d: LastJumpDiagnostic): void {
		this.lastJump = d;
	}
}
