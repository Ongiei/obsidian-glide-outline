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

   Zone model — driven by the user's `pointerAutoScrollZone` setting
   (trigger area in px, clamped to the viewport half so the two ends can
   never fight over the center):

     ┌──────────────┐  ─ viewportTop
     │ strong zone  │   strongest ramp   min(preZone, max(20, zone×0.45))
     ├──────────────┤
     │  pre-scroll  │   gentle ramp      min(viewportHeight/2, zone)
     ├──────────────┤
     │              │
     │  dead zone   │   base speed 0
     │              │
     ├──────────────┤
     │  pre-scroll  │
     ├──────────────┤
     │ strong zone  │
     └──────────────┘  ─ viewportBottom

   On top of the positional base speed, the pointer's own (smoothed)
   vertical velocity adds an assist: moving quickly downward while in the
   lower half nudges the list to scroll down toward the pointer — the
   headings "come to meet" fast, decisive movements while a static hover
   stays conservative.
   -------------------------------------------------------------------------- */

/** Fallback trigger area when the caller passes no zone (settings default). */
export const DEFAULT_TRIGGER_ZONE_PX = 120;
/** Strong (inner) zone: share of the configured trigger area + px floor. */
export const STRONG_ZONE_SHARE = 0.45;
export const STRONG_ZONE_MIN_PX = 20;
/** Share of maxSpeed reachable in the pre-scroll zone alone. */
export const PRE_SCROLL_SPEED_SHARE = 0.35;
/**
 * @deprecated §八: the edge mechanism is now purely positional
 * (`computeEdgeScrollIntent` in scrollIntent.ts). Velocity assist belongs
 * ONLY to the kinetic (pointer-follow) path. These constants are retained
 * for one release of migration parity but are no longer read here.
 */
export const VELOCITY_ASSIST_GAIN = 0.25;
/** @deprecated see VELOCITY_ASSIST_GAIN. */
export const VELOCITY_ASSIST_MAX_SHARE = 0.5;

/**
 * Why the auto-scroll target is 0 (pure-math reasons) or why the
 * controller ended a session (interaction reasons). A single enum keeps
 * PerfCapture's stop-reason histogram uniform across both layers.
 */
export type AutoScrollStopReason =
	// Pure-math reasons (computePointerAutoScroll):
	| "disabled"
	| "reduced-motion"
	| "invalid-geometry"
	| "outside-band"
	| "dead-zone"
	| "dead-end"
	// Controller/interaction reasons (MagnificationController):
	| "zone-exit"
	| "pointer-left"
	| "pressed"
	| "collapsed"
	| "window-blur"
	| "manual-wheel"
	| "dispose";

/** Resolved zone depths for the current viewport + setting. */
export interface AutoScrollZones {
	/** Outer (gentle) band depth in px. */
	preZone: number;
	/** Inner (strong) band depth in px, always ≤ preZone. */
	strongZone: number;
}

/**
 * Resolve the configured trigger area into concrete band depths.
 * Shared by the velocity math, the controller's hysteresis test and the
 * PerfCapture config echo, so all three always agree.
 */
export function computeAutoScrollZones(
	viewportHeight: number,
	triggerZonePx?: number,
): AutoScrollZones {
	const height = Number.isFinite(viewportHeight)
		? Math.max(0, viewportHeight)
		: 0;
	const zone =
		typeof triggerZonePx === "number" &&
		Number.isFinite(triggerZonePx) &&
		triggerZonePx > 0
			? triggerZonePx
			: DEFAULT_TRIGGER_ZONE_PX;
	const preZone = Math.min(height / 2, zone);
	const strongZone = Math.min(
		preZone,
		Math.max(STRONG_ZONE_MIN_PX, zone * STRONG_ZONE_SHARE),
	);
	return { preZone, strongZone };
}

export interface PointerAutoScrollInput {
	/** Pointer Y in the same coordinate space as viewportTop/viewportBottom. */
	pointerY: number;
	/**
	 * @deprecated §八: the edge mechanism is now purely positional and does
	 * NOT read pointer velocity. Retained for migration parity only; any
	 * value passed here is ignored. Velocity-driven scrolling lives in the
	 * kinetic (pointer-follow) path (`computeKineticIntentVelocity`).
	 */
	pointerVelocityY: number;
	/** Top edge of the outline viewport (client coords). */
	viewportTop: number;
	/** Bottom edge of the outline viewport (client coords). */
	viewportBottom: number;
	/** Peak scroll speed in px/s. */
	maxSpeed: number;
	/** Trigger area depth in px (`pointerAutoScrollZone`). */
	triggerZonePx?: number;
	/** Current overflow state — speed is 0 toward a dead end. */
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** Feature toggles: settings switch and prefers-reduced-motion. */
	enabled: boolean;
	reducedMotion: boolean;
}

export interface PointerAutoScrollResult {
	/** Target velocity in px/s (negative = up, positive = down). */
	velocity: number;
	/** Why the velocity is 0; null while actively scrolling. */
	stopReason: AutoScrollStopReason | null;
}

/**
 * §八 Position-only edge auto-scroll intent.
 *
 *   base = maxSpeed × (0.35 × preIntensity² + 0.65 × strongIntensity²)
 *
 * The velocity field is IGNORED (deprecated): the edge mechanism must not
 * read pointer velocity — that belongs to the kinetic (pointer-follow)
 * path (`computeKineticIntentVelocity` in scrollIntent.ts). For the
 * canonical position-only intent use `computeEdgeScrollIntent`; this
 * function is kept for migration parity and delegates to the same math.
 *
 * Returns 0 when disabled, under reduced motion, outside the viewport
 * band, in the dead zone, or at a dead end — never NaN/Infinity.
 */
export function computePointerAutoScroll(
	input: PointerAutoScrollInput,
): PointerAutoScrollResult {
	if (!input.enabled) return { velocity: 0, stopReason: "disabled" };
	if (input.reducedMotion) {
		return { velocity: 0, stopReason: "reduced-motion" };
	}
	if (
		!Number.isFinite(input.pointerY) ||
		!Number.isFinite(input.viewportTop) ||
		!Number.isFinite(input.viewportBottom) ||
		!Number.isFinite(input.maxSpeed)
	) {
		return { velocity: 0, stopReason: "invalid-geometry" };
	}
	const maxSpeed = Math.max(0, input.maxSpeed);
	const height = input.viewportBottom - input.viewportTop;
	if (height <= 0 || maxSpeed === 0) {
		return { velocity: 0, stopReason: "invalid-geometry" };
	}

	const distanceToTop = input.pointerY - input.viewportTop;
	const distanceToBottom = input.viewportBottom - input.pointerY;
	// Pointer outside the viewport band → no scrolling.
	if (distanceToTop < 0 || distanceToBottom < 0) {
		return { velocity: 0, stopReason: "outside-band" };
	}

	// Band depths from the configured trigger area (§十).
	const { preZone, strongZone } = computeAutoScrollZones(
		height,
		input.triggerZonePx,
	);
	if (preZone <= 0) return { velocity: 0, stopReason: "invalid-geometry" };

	const ramp = (distance: number): number => {
		const pre = Math.min(1, Math.max(0, (preZone - distance) / preZone));
		const strong = Math.min(
			1,
			Math.max(0, (strongZone - distance) / strongZone),
		);
		return (
			PRE_SCROLL_SPEED_SHARE * pre * pre +
			(1 - PRE_SCROLL_SPEED_SHARE) * strong * strong
		);
	};

	// Positional base speed only (§八: no velocity assist here).
	let base = 0;
	if (distanceToTop < preZone) {
		base = -maxSpeed * ramp(distanceToTop);
	} else if (distanceToBottom < preZone) {
		base = maxSpeed * ramp(distanceToBottom);
	}

	if (base === 0) return { velocity: 0, stopReason: "dead-zone" };
	// Dead-end gating: never push toward an edge that cannot scroll.
	if (base < 0 && !input.canScrollUp) {
		return { velocity: 0, stopReason: "dead-end" };
	}
	if (base > 0 && !input.canScrollDown) {
		return { velocity: 0, stopReason: "dead-end" };
	}
	return { velocity: base, stopReason: null };
}

/** Velocity-only convenience wrapper (tests / simple callers). */
export function computePointerAutoScrollVelocity(
	input: PointerAutoScrollInput,
): number {
	return computePointerAutoScroll(input).velocity;
}

/* --------------------------------------------------------------------------
   §十三–§十五 Pointer-follow pre-scroll (pure math).

   INDEPENDENT of the edge dwell/latch machinery above: a fast, decisive
   vertical pointer movement pre-scrolls the list in the SAME direction
   anywhere inside the viewport band — the headings come to meet the
   gesture before the pointer ever reaches an edge. No dwell: the gesture
   itself is the intent signal. A slow or stationary pointer is always 0.
   -------------------------------------------------------------------------- */

/** Smoothed pointer speed below this (px/s) is browsing, not a flick. */
export const POINTER_FOLLOW_MIN_VELOCITY = 140;
/** Scroll px/s produced per pointer px/s ABOVE the threshold. */
export const POINTER_FOLLOW_GAIN = 0.25;
/** Follow ceiling as a share of maxSpeed — the edge machinery always
 * remains the stronger mechanism (§十七 combined result is clamped). */
export const POINTER_FOLLOW_MAX_SHARE = 0.45;

import { computeKineticIntentVelocity } from "./scrollIntent";

export type { PointerSample, PointerSampleRing } from "./scrollIntent";
export {
	computeKineticIntentVelocity,
	computeEdgeScrollIntent,
	predictedPointerY,
	POINTER_FOLLOW_LOOKAHEAD_MS,
	POINTER_FOLLOW_DECAY_TAU_MS,
} from "./scrollIntent";

export interface PointerFollowInput {
	/** Pointer Y in the same space as viewportTop/viewportBottom. */
	pointerY: number;
	/** Smoothed pointer vertical velocity, px/s (+ = moving down). */
	pointerVelocityY: number;
	viewportTop: number;
	viewportBottom: number;
	/** Peak scroll speed in px/s (shared with the edge mechanism). */
	maxSpeed: number;
	/** Current overflow state — 0 toward a dead end. */
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** `pointerFollowEnabled` setting gate. */
	enabled: boolean;
}

/**
 * Target pre-scroll velocity in px/s (negative = up, positive = down).
 *
 * §九 kinetic (pointer-follow) intent. Velocity comes from the controller's
 * sample ring; here it is turned into a target with a depth factor so a
 * mid-viewport flick still registers while the dead-center stays calm:
 *
 *   depthFactor = 0.35 + 0.65 × |pointerY − center| / (height/2)
 *   kinetic = clamp((|vy| − min) × gain × depthFactor,
 *                   −maxSpeed×maxShare, +maxSpeed×maxShare)
 *
 * Delegates to `computeKineticIntentVelocity` (scrollIntent.ts), the single
 * canonical implementation. Gated by scrollability; 0 when disabled, outside
 * the viewport band, or on any non-finite input — never NaN.
 */
export function computePointerFollowVelocity(
	input: PointerFollowInput,
): number {
	return computeKineticIntentVelocity({
		pointerY: input.pointerY,
		pointerVelocityY: input.pointerVelocityY,
		viewportTop: input.viewportTop,
		viewportBottom: input.viewportBottom,
		maxSpeed: input.maxSpeed,
		canScrollUp: input.canScrollUp,
		canScrollDown: input.canScrollDown,
		enabled: input.enabled,
	});
}
