/**
 * Continuous motion interpolation (section 11).
 *
 * CSS transitions no longer drive the pointer-follow transforms; instead
 * each active row keeps target/displayed pairs and the RAF loop advances
 * `displayed` toward `target` with a TIME-BASED exponential step, so the
 * feel is identical at 60 Hz, 120 Hz or under a janky frame. Pure math —
 * no DOM access.
 */

/** Convergence threshold for --glide-scale writes. */
export const SCALE_EPSILON = 0.001;
/** Convergence threshold for --glide-shift-y writes, px. */
export const SHIFT_EPSILON = 0.05;
/**
 * Exponential time constant, ms. Chosen to sit between the removed CSS
 * transitions (90 ms card / 140 ms motion): ~63% of the way after 55 ms,
 * ~95% after ~165 ms.
 */
export const MOTION_TIME_CONSTANT_MS = 55;

export interface MotionItemState {
	targetScale: number;
	displayedScale: number;
	targetShift: number;
	displayedShift: number;
}

export function identityMotionState(): MotionItemState {
	return {
		targetScale: 1,
		displayedScale: 1,
		targetShift: 0,
		displayedShift: 0,
	};
}

/**
 * Frame-rate independent interpolation factor:
 *   alpha = 1 - exp(-deltaTime / timeConstant)
 * deltaTime <= 0 or non-finite → 0 (no movement, e.g. the first frame
 * after the time base reset).
 */
export function motionAlpha(
	deltaTimeMs: number,
	timeConstantMs: number = MOTION_TIME_CONSTANT_MS,
): number {
	if (!Number.isFinite(deltaTimeMs) || deltaTimeMs <= 0) return 0;
	if (timeConstantMs <= 0) return 1;
	return 1 - Math.exp(-deltaTimeMs / timeConstantMs);
}

/**
 * One interpolation step. Snaps to the target once within `epsilon`, so
 * the loop terminates instead of asymptoting forever.
 */
export function stepToward(
	displayed: number,
	target: number,
	alpha: number,
	epsilon: number,
): number {
	if (!Number.isFinite(displayed)) return target;
	const next = displayed + (target - displayed) * alpha;
	return Math.abs(target - next) <= epsilon ? target : next;
}

/**
 * Advance a motion state by one frame; returns true while the state is
 * still converging (the RAF loop must stay alive).
 */
export function stepMotionState(
	state: MotionItemState,
	alpha: number,
): boolean {
	state.displayedScale = stepToward(
		state.displayedScale,
		state.targetScale,
		alpha,
		SCALE_EPSILON,
	);
	state.displayedShift = stepToward(
		state.displayedShift,
		state.targetShift,
		alpha,
		SHIFT_EPSILON,
	);
	return !motionStateConverged(state);
}

export function motionStateConverged(state: MotionItemState): boolean {
	return (
		state.displayedScale === state.targetScale &&
		state.displayedShift === state.targetShift
	);
}

/** Whether a displayed pair is visually identity (no transform needed). */
export function motionStateIsIdentity(state: MotionItemState): boolean {
	return (
		Math.abs(state.displayedScale - 1) < SCALE_EPSILON &&
		Math.abs(state.displayedShift) < SHIFT_EPSILON
	);
}
