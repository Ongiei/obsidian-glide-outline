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

/* --------------------------------------------------------------------------
   Velocity-assisted pointer-follow auto-scroll (pure math).

   Zone model (fractions of the viewport height, px-clamped for sanity):

     ┌──────────────┐  ─ viewportTop
     │  edge zone   │   strongest ramp        ~10% (12–56 px)
     ├──────────────┤
     │  pre-scroll  │   gentle ramp           ~20% (24–120 px)
     ├──────────────┤
     │              │
     │  dead zone   │   base speed 0
     │              │
     ├──────────────┤
     │  pre-scroll  │
     ├──────────────┤
     │  edge zone   │
     └──────────────┘  ─ viewportBottom

   On top of the positional base speed, the pointer's own (smoothed)
   vertical velocity adds an assist: moving quickly downward while in the
   lower half nudges the list to scroll down toward the pointer — the
   headings "come to meet" fast, decisive movements while a static hover
   stays conservative.
   -------------------------------------------------------------------------- */

/** Pre-scroll zone: fraction of viewport height and px clamps. */
export const PRE_SCROLL_FRACTION = 0.2;
export const PRE_SCROLL_MIN_PX = 24;
export const PRE_SCROLL_MAX_PX = 120;
/** Edge zone (stronger ramp): fraction of viewport height and px clamps. */
export const EDGE_FRACTION = 0.1;
export const EDGE_MIN_PX = 12;
export const EDGE_MAX_PX = 56;
/** Share of maxSpeed reachable in the pre-scroll zone alone. */
export const PRE_SCROLL_SPEED_SHARE = 0.35;
/** px/s of scroll per px/s of pointer velocity (before depth scaling). */
export const VELOCITY_ASSIST_GAIN = 0.25;
/** Assist ceiling as a share of maxSpeed. */
export const VELOCITY_ASSIST_MAX_SHARE = 0.5;

export interface PointerAutoScrollInput {
	/** Pointer Y in the same coordinate space as viewportTop/viewportBottom. */
	pointerY: number;
	/** Smoothed pointer vertical velocity, px/s (+ = moving down). */
	pointerVelocityY: number;
	/** Top edge of the outline viewport (client coords). */
	viewportTop: number;
	/** Bottom edge of the outline viewport (client coords). */
	viewportBottom: number;
	/** Peak scroll speed in px/s. */
	maxSpeed: number;
	/** Current overflow state — speed is 0 toward a dead end. */
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** Feature toggles: settings switch and prefers-reduced-motion. */
	enabled: boolean;
	reducedMotion: boolean;
}

/**
 * Target auto-scroll velocity in px/s (negative = up, positive = down).
 *
 *   base   = maxSpeed × (0.35 × preIntensity² + 0.65 × edgeIntensity²)
 *   assist = clamp(pointerVy × 0.25, ±maxSpeed/2) × halfDepth
 *            (only when the pointer is in the matching half AND moving
 *             toward that edge — otherwise 0)
 *   target = clamp(base + assist, ±maxSpeed), gated by scrollability
 *
 * Both intensity curves are quadratic, so the zone entrances stay gentle
 * and full speed exists only at the physical edge. `halfDepth` scales the
 * assist from 0 at the viewport center to 1 at an edge, which makes a
 * static hover in the dead zone always 0 and fast flicks progressively
 * more assertive as they approach the edge. Returns 0 when disabled,
 * under reduced motion, outside the viewport band, or for any non-finite
 * input — never NaN or ±Infinity.
 */
export function computePointerAutoScrollVelocity(
	input: PointerAutoScrollInput,
): number {
	if (!input.enabled || input.reducedMotion) return 0;
	if (
		!Number.isFinite(input.pointerY) ||
		!Number.isFinite(input.viewportTop) ||
		!Number.isFinite(input.viewportBottom) ||
		!Number.isFinite(input.maxSpeed)
	) {
		return 0;
	}
	const maxSpeed = Math.max(0, input.maxSpeed);
	const height = input.viewportBottom - input.viewportTop;
	if (height <= 0 || maxSpeed === 0) return 0;

	const distanceToTop = input.pointerY - input.viewportTop;
	const distanceToBottom = input.viewportBottom - input.pointerY;
	// Pointer outside the viewport band → no scrolling.
	if (distanceToTop < 0 || distanceToBottom < 0) return 0;

	// Zone depths: fraction-based with px clamps, never overlapping the
	// opposite half of the viewport.
	const preZone = Math.min(
		height / 2,
		Math.min(PRE_SCROLL_MAX_PX, Math.max(PRE_SCROLL_MIN_PX, height * PRE_SCROLL_FRACTION)),
	);
	const edgeZone = Math.min(
		preZone,
		Math.min(EDGE_MAX_PX, Math.max(EDGE_MIN_PX, height * EDGE_FRACTION)),
	);

	const ramp = (distance: number): number => {
		const pre = Math.min(1, Math.max(0, (preZone - distance) / preZone));
		const edge = Math.min(1, Math.max(0, (edgeZone - distance) / edgeZone));
		return (
			PRE_SCROLL_SPEED_SHARE * pre * pre +
			(1 - PRE_SCROLL_SPEED_SHARE) * edge * edge
		);
	};

	// Positional base speed (0 across the whole dead zone).
	let base = 0;
	if (distanceToTop < preZone) {
		base = -maxSpeed * ramp(distanceToTop);
	} else if (distanceToBottom < preZone) {
		base = maxSpeed * ramp(distanceToBottom);
	}

	// Pointer-velocity assist: matching half + matching direction only.
	const vy = Number.isFinite(input.pointerVelocityY)
		? input.pointerVelocityY
		: 0;
	const center = input.viewportTop + height / 2;
	const halfDepth = Math.min(
		1,
		Math.abs(input.pointerY - center) / (height / 2),
	);
	let assist = 0;
	const assistCap = maxSpeed * VELOCITY_ASSIST_MAX_SHARE;
	if (vy > 0 && input.pointerY > center) {
		assist = Math.min(assistCap, vy * VELOCITY_ASSIST_GAIN) * halfDepth;
	} else if (vy < 0 && input.pointerY < center) {
		assist = Math.max(-assistCap, vy * VELOCITY_ASSIST_GAIN) * halfDepth;
	}

	const target = Math.min(maxSpeed, Math.max(-maxSpeed, base + assist));
	// Dead-end gating: never push toward an edge that cannot scroll.
	if (target < 0 && !input.canScrollUp) return 0;
	if (target > 0 && !input.canScrollDown) return 0;
	return target;
}
