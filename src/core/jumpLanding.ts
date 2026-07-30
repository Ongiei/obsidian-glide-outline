/**
 * §五: editor jump landing math — pure, DOM-free, unit-testable.
 *
 * ## Why this file exists
 *
 * The 0.1.3 corrector compared `cm.lineBlockAt(offset).top` against
 * `scrollDOM.scrollTop`. Those are two DIFFERENT coordinate spaces:
 *
 *   - `lineBlockAt().top` is measured from the top of the CM **content**
 *     (`contentDOM`), i.e. document space.
 *   - `scrollTop` is measured from the top of the **scroller**
 *     (`scrollDOM`), i.e. scroll space.
 *
 * In Obsidian the scroller also contains the inline title and the
 * properties/frontmatter block, so the origin of content space sits some
 * way below the origin of scroll space. Subtracting one from the other
 * leaves exactly that offset as a residual error — which is why a
 * "corrected" jump could still settle hundreds of px away and report
 * `finalErrorPx = 416.65625` while believing it had converged.
 *
 * The fix is to stop inferring and instead ask the editor where the line
 * ACTUALLY rendered (`coordsAtPos`), then work entirely in client space:
 *
 *   viewportError = (lineClientTop - scrollerClientTop) - margin
 *   desiredScrollTop = scrollTop + viewportError
 *
 * Both terms of the subtraction are client coordinates, so every hidden
 * offset cancels out regardless of what Obsidian puts above the content.
 */

/** How the landing was computed for one evaluation round. */
export type JumpLandingStrategy =
	/** Authoritative: `coordsAtPos` returned real client coordinates. */
	| "coords"
	/** Target outside the rendered range — estimated via document space. */
	| "document-fallback"
	/** Nothing usable to measure against. */
	| "none";

export interface JumpLandingInput {
	/** `coordsAtPos(offset).top` in client space, or null if not rendered. */
	targetClientTop: number | null;
	/** `coordsAtPos(offset).bottom` in client space, or null. */
	targetClientBottom: number | null;
	/** Scroller bounding-rect top, client space. */
	scrollerClientTop: number;
	/** Scroller visible height (clientHeight). */
	scrollerClientHeight: number;
	/** Current `scrollDOM.scrollTop`. */
	scrollTop: number;
	/** Current `scrollDOM.scrollHeight`. */
	scrollHeight: number;
	/**
	 * `lineBlockAt(offset).top` — document space. Used ONLY when the
	 * target is not rendered, and only together with `contentOriginOffset`.
	 */
	documentTop: number | null;
	/**
	 * Scroll-space position of the content origin, i.e.
	 * `contentRect.top - scrollerRect.top + scrollTop`. This is the
	 * offset that 0.1.3 silently dropped.
	 */
	contentOriginOffset: number | null;
	/** Desired gap between the scroller top and the target line. */
	marginPx: number;
	/** Landing is accepted once |error| is within this. */
	tolerancePx: number;
}

export interface JumpLandingResult {
	strategy: JumpLandingStrategy;
	/** Did the editor actually render the target line? */
	targetRendered: boolean;
	/** Error in viewport space; null when it could not be measured. */
	viewportErrorPx: number | null;
	/** Absolute scrollTop to write, already clamped into range. */
	desiredScrollTop: number;
	/** The desired position was outside the scroll range. */
	clampedAtBoundary: boolean;
	/** `desiredScrollTop - scrollTop`. */
	deltaPx: number;
	/** No further correction needed. */
	settled: boolean;
	/**
	 * The scroller cannot move any further, but the target is fully
	 * visible — for a heading near the end of the document this IS the
	 * correct landing, not a failure.
	 */
	acceptedAsVisibleBoundaryLanding: boolean;
}

/** Sub-pixel slack when deciding "already at the boundary" / "fully visible". */
const EPSILON_PX = 0.5;

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.min(max, Math.max(min, value));
}

export function evaluateJumpLanding(input: JumpLandingInput): JumpLandingResult {
	const maxScrollTop = Math.max(
		0,
		input.scrollHeight - input.scrollerClientHeight,
	);
	const targetRendered =
		input.targetClientTop !== null && Number.isFinite(input.targetClientTop);

	let desiredUnclamped: number;
	let strategy: JumpLandingStrategy;
	let viewportErrorPx: number | null = null;

	if (targetRendered) {
		// Client space on both sides — every hidden offset cancels.
		const relativeTop =
			(input.targetClientTop as number) - input.scrollerClientTop;
		viewportErrorPx = relativeTop - input.marginPx;
		desiredUnclamped = input.scrollTop + viewportErrorPx;
		strategy = "coords";
	} else if (
		input.documentTop !== null &&
		Number.isFinite(input.documentTop) &&
		input.contentOriginOffset !== null &&
		Number.isFinite(input.contentOriginOffset)
	) {
		// Not rendered yet: estimate, but convert document → scroll space
		// properly instead of pretending they are the same axis.
		desiredUnclamped =
			input.contentOriginOffset + input.documentTop - input.marginPx;
		strategy = "document-fallback";
	} else {
		return {
			strategy: "none",
			targetRendered: false,
			viewportErrorPx: null,
			desiredScrollTop: input.scrollTop,
			clampedAtBoundary: false,
			deltaPx: 0,
			settled: false,
			acceptedAsVisibleBoundaryLanding: false,
		};
	}

	const desiredScrollTop = clamp(desiredUnclamped, 0, maxScrollTop);
	const clampedAtBoundary =
		Math.abs(desiredScrollTop - desiredUnclamped) > EPSILON_PX;
	const deltaPx = desiredScrollTop - input.scrollTop;

	const withinTolerance =
		viewportErrorPx !== null
			? Math.abs(viewportErrorPx) <= input.tolerancePx
			: Math.abs(deltaPx) <= input.tolerancePx;

	// Boundary acceptance: the write would not move us (we are already
	// pinned) AND the row is wholly inside the viewport.
	const pinned = clampedAtBoundary && Math.abs(deltaPx) <= EPSILON_PX;
	const scrollerClientBottom =
		input.scrollerClientTop + input.scrollerClientHeight;
	const fullyVisible =
		targetRendered &&
		input.targetClientBottom !== null &&
		(input.targetClientTop as number) >= input.scrollerClientTop - EPSILON_PX &&
		input.targetClientBottom <= scrollerClientBottom + EPSILON_PX;
	const acceptedAsVisibleBoundaryLanding =
		!withinTolerance && pinned && fullyVisible;

	return {
		strategy,
		targetRendered,
		viewportErrorPx,
		desiredScrollTop,
		clampedAtBoundary,
		deltaPx,
		settled: withinTolerance || acceptedAsVisibleBoundaryLanding,
		acceptedAsVisibleBoundaryLanding,
	};
}
