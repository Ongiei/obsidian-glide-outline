/**
 * §七–§九 Unified scroll-intent primitives.
 *
 * Two INDEPENDENT intent sources feed one shared integrator:
 *
 *   1. EDGE intent  — purely positional: how far the pointer is from the
 *      top/bottom edge of the viewport band. It must NOT read pointer
 *      velocity (§八): any velocity assist belongs to the kinetic path only.
 *   2. KINETIC intent — velocity-driven "pointer-follow" pre-scroll. The
 *      velocity comes from a small fixed sample ring maintained by the
 *      controller (§九/§十); here we only turn a velocity into a scroll
 *      target with a depth factor so mid-viewport flicks still register.
 *
 * `combinedTarget = clamp(edge + kinetic, -maxSpeed, maxSpeed)` is produced
 * by the coordinator in the controller, which also owns the dwell gate, the
 * acceleration-capped damping and the manual-wheel cooldown.
 */

/** One pointer sample for the kinetic velocity ring (§九/§十). */
export interface PointerSample {
	/** Client Y at sample time. */
	y: number;
	/** Timestamp (performance.now()) at sample time. */
	time: number;
}

/**
 * §七 Edge intent state — purely positional dwell/latch machinery. Kept
 * fully independent from the kinetic (pointer-follow) state so one can stop
 * without disturbing the other (§十一).
 */
export interface EdgeIntentState {
	/** Pending dwell gate before edge scrolling engages. */
	dwellTimer: number;
	/** True once the dwell elapsed (edge may scroll). */
	dwellPassed: boolean;
	/** An edge session is engaged and survives gap crossings. */
	latched: boolean;
	/** Last scroll direction: -1 up, 0 none, +1 down. */
	direction: -1 | 0 | 1;
	/** Why the last session ended (diagnostics / perf). */
	lastStopReason: string | null;
}

/** §七 Kinetic (pointer-follow) state — the velocity sampler + decay. */
export interface PointerKinematicsState {
	/** Recent pointer samples (§九/§十 ring). */
	samples: PointerSampleRing;
	/** Last computed velocity, px/s (+ = down). */
	velocityY: number;
	/** Forward-looking predicted pointer Y (§九). */
	predictedY: number;
	/** Timestamp of the last sample. */
	lastSampleTime: number;
	/** True while fresh samples support an active gesture. */
	active: boolean;
}

/** §七 Shared scroll integrator — the two intents combine here. */
export interface ScrollIntegratorState {
	/** Velocity from the edge mechanism this frame, px/s. */
	edgeIntentVelocity: number;
	/** Velocity from the kinetic mechanism this frame, px/s. */
	kineticIntentVelocity: number;
	/** Combined, clamped target velocity, px/s. */
	combinedTargetVelocity: number;
	/** Currently applied (damped) velocity, px/s. */
	appliedVelocity: number;
	/** Last frame timestamp for dt-based damping. */
	lastFrameTime: number;
	/** Manual-wheel cooldown expiry timestamp. */
	manualWheelCooldownUntil: number;
}

/**
 * Fixed-capacity ring of recent pointer samples. Velocity is the secant
 * between the OLDEST and NEWEST sample in the window — a smoothed,
 * direction-stable estimate that ignores single-event noise. Pure math,
 * no DOM access.
 */
export class PointerSampleRing {
	private readonly samples: PointerSample[] = [];

	/**
	 * @param capacity max samples retained (§九: 4–8).
	 * @param windowMs samples older than this are dropped (§九: ~80–100 ms).
	 */
	constructor(
		private readonly capacity = 6,
		private readonly windowMs = 90,
	) {}

	/** Record a sample, dropping anything outside the time window first.
	 * A sample whose timestamp runs BACKWARDS starts a new gesture — the
	 * old samples describe a different clock and must not contribute. */
	push(y: number, time: number): void {
		const last = this.samples[this.samples.length - 1];
		if (last !== undefined && time < last.time) {
			this.samples.length = 0;
		}
		const cutoff = time - this.windowMs;
		while (this.samples.length > 0 && this.samples[0].time < cutoff) {
			this.samples.shift();
		}
		this.samples.push({ y, time });
		if (this.samples.length > this.capacity) {
			this.samples.shift();
		}
	}

	/** Velocity in px/s (+ = down). 0 when fewer than two usable samples. */
	velocityY(now: number = Number.NaN): number {
		const cutoff = Number.isFinite(now)
			? now - this.windowMs
			: Number.NEGATIVE_INFINITY;
		let first = 0;
		while (first < this.samples.length && this.samples[first].time < cutoff) {
			first++;
		}
		if (this.samples.length - first < 2) return 0;
		const a = this.samples[first];
		const b = this.samples[this.samples.length - 1];
		const dt = (b.time - a.time) / 1000;
		if (!(dt > 0)) return 0;
		return (b.y - a.y) / dt;
	}

	/** True while the ring holds a fresh, multi-sample gesture. */
	get active(): boolean {
		return this.samples.length >= 2;
	}

	/** Clear all samples (e.g. on pointerdown / collapse / dispose). */
	clear(): void {
		this.samples.length = 0;
	}
}

export interface EdgeScrollIntentInput {
	/** Pointer Y in the same coordinate space as viewportTop/Bottom. */
	pointerY: number;
	/** Top edge of the outline viewport (client coords). */
	viewportTop: number;
	/** Bottom edge of the outline viewport (client coords). */
	viewportBottom: number;
	/** Peak scroll speed in px/s (shared with the kinetic mechanism). */
	maxSpeed: number;
	/** Trigger area depth in px (`pointerAutoScrollZone`). */
	triggerZonePx?: number;
	/** Current overflow state — speed is 0 toward a dead end. */
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** Feature toggle (`pointerAutoScroll`). */
	enabled: boolean;
}

export interface EdgeScrollIntentResult {
	/** Target velocity in px/s (negative = up, positive = down). */
	velocity: number;
	/** Why the velocity is 0; null while actively scrolling. */
	stopReason: string | null;
}

/**
 * §八 Position-only edge auto-scroll intent.
 *
 *   base = maxSpeed × (0.35 × preIntensity² + 0.65 × strongIntensity²)
 *
 * Purely a function of the pointer's distance to the nearest viewport edge
 * and the trigger zone. Pointer velocity is NEVER read here (it lives in the
 * kinetic path). Returns 0 when disabled, outside the viewport band, in the
 * dead zone, or at a dead end — never NaN/Infinity.
 */
export function computeEdgeScrollIntent(
	input: EdgeScrollIntentInput,
): EdgeScrollIntentResult {
	if (!input.enabled) return { velocity: 0, stopReason: "disabled" };
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
	if (distanceToTop < 0 || distanceToBottom < 0) {
		return { velocity: 0, stopReason: "outside-band" };
	}

	const { preZone, strongZone } = resolveEdgeZones(height, input.triggerZonePx);
	if (preZone <= 0) return { velocity: 0, stopReason: "invalid-geometry" };

	const ramp = (distance: number): number => {
		const pre = Math.min(1, Math.max(0, (preZone - distance) / preZone));
		const strong = Math.min(
			1,
			Math.max(0, (strongZone - distance) / strongZone),
		);
		return (
			0.35 * pre * pre + 0.65 * strong * strong
		);
	};

	let base = 0;
	if (distanceToTop < preZone) {
		base = -maxSpeed * ramp(distanceToTop);
	} else if (distanceToBottom < preZone) {
		base = maxSpeed * ramp(distanceToBottom);
	}

	if (base === 0) return { velocity: 0, stopReason: "dead-zone" };
	if (base < 0 && !input.canScrollUp) {
		return { velocity: 0, stopReason: "dead-end" };
	}
	if (base > 0 && !input.canScrollDown) {
		return { velocity: 0, stopReason: "dead-end" };
	}
	return { velocity: base, stopReason: null };
}

/** Band depths shared by the edge math and the controller's hysteresis. */
export function resolveEdgeZones(
	viewportHeight: number,
	triggerZonePx?: number,
): { preZone: number; strongZone: number } {
	const height = Number.isFinite(viewportHeight)
		? Math.max(0, viewportHeight)
		: 0;
	const zone =
		typeof triggerZonePx === "number" &&
		Number.isFinite(triggerZonePx) &&
		triggerZonePx > 0
			? triggerZonePx
			: 120;
	const preZone = Math.min(height / 2, zone);
	const strongZone = Math.min(preZone, Math.max(20, zone * 0.45));
	return { preZone, strongZone };
}

export interface KineticIntentInput {
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

/** §九 suggested parameters. */
export const POINTER_FOLLOW_MIN_SPEED = 140;
export const POINTER_FOLLOW_LOOKAHEAD_MS = 80;
export const POINTER_FOLLOW_GAIN = 0.25;
export const POINTER_FOLLOW_MAX_SHARE = 0.45;
export const POINTER_FOLLOW_DECAY_TAU_MS = 120;

/**
 * §九 Kinetic (pointer-follow) scroll intent.
 *
 *   predictedY = pointerY + velocityY × (lookahead/1000)   // forward guess
 *   depthFactor = 0.35 + 0.65 × |pointerY − center| / (height/2)
 *   kinetic = clamp(velocityY × gain × depthFactor,
 *                   −maxSpeed×maxShare, +maxSpeed×maxShare)
 *
 * No dwell (the gesture is the intent); a stationary or slow pointer is 0;
 * a fast flick anywhere in the band pre-scrolls toward the gesture; the
 * depth factor keeps the dead-center calm while the edges get stronger.
 */
export function computeKineticIntentVelocity(
	input: KineticIntentInput,
): number {
	if (!input.enabled) return 0;
	if (
		!Number.isFinite(input.pointerY) ||
		!Number.isFinite(input.viewportTop) ||
		!Number.isFinite(input.viewportBottom) ||
		!Number.isFinite(input.maxSpeed) ||
		!Number.isFinite(input.pointerVelocityY)
	) {
		return 0;
	}
	const maxSpeed = Math.max(0, input.maxSpeed);
	if (maxSpeed === 0) return 0;
	const height = input.viewportBottom - input.viewportTop;
	if (
		input.pointerY < input.viewportTop ||
		input.pointerY > input.viewportBottom ||
		height <= 0
	) {
		return 0;
	}
	const vy = input.pointerVelocityY;
	const speed = Math.abs(vy);
	if (speed <= POINTER_FOLLOW_MIN_SPEED) return 0;

	const center = input.viewportTop + height / 2;
	const half = height / 2;
	const norm = half > 0 ? Math.min(1, Math.abs(input.pointerY - center) / half) : 0;
	const depthFactor = 0.35 + 0.65 * norm;
	const cap = maxSpeed * POINTER_FOLLOW_MAX_SHARE;
	const magnitude = Math.min(
		cap,
		(speed - POINTER_FOLLOW_MIN_SPEED) * POINTER_FOLLOW_GAIN * depthFactor,
	);
	const target = vy > 0 ? magnitude : -magnitude;
	if (target < 0 && !input.canScrollUp) return 0;
	if (target > 0 && !input.canScrollDown) return 0;
	return target;
}

/** §九 forward-looking position guess (consumable by callers/tests). */
export function predictedPointerY(
	pointerY: number,
	velocityY: number,
	lookaheadMs: number = POINTER_FOLLOW_LOOKAHEAD_MS,
): number {
	if (!Number.isFinite(pointerY) || !Number.isFinite(velocityY)) return pointerY;
	return pointerY + velocityY * (lookaheadMs / 1000);
}
