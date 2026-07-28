import { defaultShiftAmplitude } from "./geometry";

/**
 * Active motion range (section 10): the contiguous row window that is
 * allowed to participate in the collision solver, scale/shift motion,
 * CSS variable writes, the Pointer Envelope and will-change.
 *
 * Pure function — works on cached numbers only, no DOM access.
 */

export interface ActiveMotionRangeInput {
	/** Cached base row centers, ascending (viewport client coordinates). */
	centers: readonly number[];
	/** Cached unscaled row heights (same order as `centers`). */
	heights: readonly number[];
	/** Outline viewport bounds in the same coordinate system. */
	viewportTop: number;
	viewportBottom: number;
	/** Current pointer Y; NaN when unknown (viewport-only range). */
	pointerY: number;
	/** Magnification falloff radius, px. */
	radius: number;
	/** Peak magnification scale (drives the displacement allowance). */
	maxScale: number;
	/** Extra boundary rows on each side (spec: 2–4). */
	overscan?: number;
}

/** Inclusive index range; `end < start` means "no active rows". */
export interface ActiveMotionRange {
	start: number;
	end: number;
}

export const DEFAULT_OVERSCAN_ROWS = 3;

/** The canonical empty range. */
export function emptyActiveRange(): ActiveMotionRange {
	return { start: 0, end: -1 };
}

export function isEmptyActiveRange(range: ActiveMotionRange): boolean {
	return range.end < range.start;
}

/**
 * Maximum vertical influence any row inside the range can exert on a row
 * outside it: peak give-way displacement plus the extra half-height a
 * fully magnified card gains. Rows farther than `radius + allowance`
 * from every influence source are provably identity (scale 1, shift 0).
 */
export function displacementAllowance(
	maxScale: number,
	maxRowHeight: number,
): number {
	const scaleGrowth = Math.max(0, maxScale - 1) * Math.max(0, maxRowHeight);
	return defaultShiftAmplitude(maxScale) + scaleGrowth / 2;
}

/**
 * Compute the active row window from cached geometry.
 *
 * The influence interval is the union of the visible viewport and the
 * pointer's magnification disc, expanded by the displacement allowance;
 * rows whose boxes intersect it — plus `overscan` boundary rows on each
 * side — form the range. Never a fixed row count.
 */
export function computeActiveMotionRange(
	input: ActiveMotionRangeInput,
): ActiveMotionRange {
	const { centers, heights } = input;
	const n = centers.length;
	if (n === 0) return emptyActiveRange();

	let maxRowHeight = 0;
	for (let i = 0; i < n; i++) {
		const h = heights[i];
		if (Number.isFinite(h) && h > maxRowHeight) maxRowHeight = h;
	}
	const allowance = displacementAllowance(input.maxScale, maxRowHeight);
	const radius = Math.max(0, input.radius);

	let lo = input.viewportTop;
	let hi = input.viewportBottom;
	if (Number.isFinite(input.pointerY)) {
		lo = Math.min(lo, input.pointerY - radius);
		hi = Math.max(hi, input.pointerY + radius);
	}
	lo -= allowance + radius;
	hi += allowance + radius;

	// Binary search: first row whose bottom edge reaches `lo`.
	let start = lowerBound(centers, heights, lo);
	// Last row whose top edge is at or above `hi`.
	let end = upperBound(centers, heights, hi);
	if (start > end) return emptyActiveRange();

	const overscan = Math.max(0, input.overscan ?? DEFAULT_OVERSCAN_ROWS);
	start = Math.max(0, start - overscan);
	end = Math.min(n - 1, end + overscan);
	return { start, end };
}

/** First index i with centers[i] + heights[i]/2 >= lo. */
function lowerBound(
	centers: readonly number[],
	heights: readonly number[],
	lo: number,
): number {
	let a = 0;
	let b = centers.length; // exclusive
	while (a < b) {
		const mid = (a + b) >> 1;
		const bottom = centers[mid] + (heights[mid] || 0) / 2;
		if (bottom < lo) a = mid + 1;
		else b = mid;
	}
	return a;
}

/** Last index i with centers[i] - heights[i]/2 <= hi (-1 when none). */
function upperBound(
	centers: readonly number[],
	heights: readonly number[],
	hi: number,
): number {
	let a = -1;
	let b = centers.length - 1;
	while (a < b) {
		const mid = (a + b + 1) >> 1;
		const top = centers[mid] - (heights[mid] || 0) / 2;
		if (top > hi) b = mid - 1;
		else a = mid;
	}
	return a;
}
