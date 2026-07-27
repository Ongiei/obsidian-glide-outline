/**
 * Overflow helpers (pure functions):
 * - edge fade state (which ends of the list can still scroll)
 * - pointer edge auto-scroll velocity
 */

export interface OverflowStateInput {
	/** viewport.scrollTop */
	scrollTop: number;
	/** viewport.clientHeight */
	clientHeight: number;
	/** viewport.scrollHeight */
	scrollHeight: number;
	/** Slack in px below which a residual scroll distance counts as zero. */
	tolerance?: number;
}

export interface OverflowState {
	hasOverflow: boolean;
	canScrollUp: boolean;
	canScrollDown: boolean;
}

export const OVERFLOW_TOLERANCE = 1;

/** Which edges of the outline viewport hide more content. */
export function computeOverflowState(
	input: OverflowStateInput,
): OverflowState {
	const tolerance = input.tolerance ?? OVERFLOW_TOLERANCE;
	const scrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0;
	const clientHeight = Math.max(
		0,
		Number.isFinite(input.clientHeight) ? input.clientHeight : 0,
	);
	const scrollHeight = Math.max(
		0,
		Number.isFinite(input.scrollHeight) ? input.scrollHeight : 0,
	);
	const hasOverflow = scrollHeight > clientHeight + tolerance;
	if (!hasOverflow) {
		return { hasOverflow: false, canScrollUp: false, canScrollDown: false };
	}
	return {
		hasOverflow: true,
		canScrollUp: scrollTop > tolerance,
		canScrollDown: scrollTop + clientHeight < scrollHeight - tolerance,
	};
}

export interface AutoScrollVelocityInput {
	/** Pointer Y in the same coordinate space as viewportTop/viewportBottom. */
	pointerY: number;
	/** Top edge of the outline viewport (client coords). */
	viewportTop: number;
	/** Bottom edge of the outline viewport (client coords). */
	viewportBottom: number;
	/** Depth of the reactive zone at each edge, px. */
	edgeZone: number;
	/** Peak scroll speed in px/s (applied at zero distance to the edge). */
	maxSpeed: number;
	/** Current overflow state — speed is 0 toward a dead end. */
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** Feature toggles: settings switch and prefers-reduced-motion. */
	enabled: boolean;
	reducedMotion: boolean;
}

/**
 * Pointer edge auto-scroll velocity in px/s (pure function).
 *
 * Negative = scroll up (content moves down), positive = scroll down.
 * Speed ramps continuously with penetration depth into the edge zone:
 *
 *   intensity = clamp((edgeZone - distanceToEdge) / edgeZone, 0, 1)
 *   speed     = maxSpeed * intensity²
 *
 * The quadratic curve keeps the zone entrance gentle so headings near the
 * edge remain easy to click, and reaches full speed only at the very edge.
 * Returns 0 in the middle safe band, at dead ends, when disabled, under
 * reduced motion, or for non-finite input.
 */
export function computeAutoScrollVelocity(
	input: AutoScrollVelocityInput,
): number {
	if (!input.enabled || input.reducedMotion) return 0;
	if (
		!Number.isFinite(input.pointerY) ||
		!Number.isFinite(input.viewportTop) ||
		!Number.isFinite(input.viewportBottom)
	) {
		return 0;
	}
	const edgeZone = Math.max(1, input.edgeZone);
	const maxSpeed = Math.max(0, input.maxSpeed);
	const height = input.viewportBottom - input.viewportTop;
	if (height <= 0) return 0;
	// With a short viewport the two zones could overlap; split at the middle.
	const zone = Math.min(edgeZone, height / 2);

	const distanceToTop = input.pointerY - input.viewportTop;
	const distanceToBottom = input.viewportBottom - input.pointerY;
	// Pointer outside the viewport band → no scrolling.
	if (distanceToTop < 0 || distanceToBottom < 0) return 0;

	if (distanceToTop < zone && input.canScrollUp) {
		const intensity = Math.min(1, Math.max(0, (zone - distanceToTop) / zone));
		return -maxSpeed * intensity * intensity;
	}
	if (distanceToBottom < zone && input.canScrollDown) {
		const intensity = Math.min(
			1,
			Math.max(0, (zone - distanceToBottom) / zone),
		);
		return maxSpeed * intensity * intensity;
	}
	return 0;
}
