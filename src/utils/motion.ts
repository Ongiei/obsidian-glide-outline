/**
 * Motion behaviour — a single, explicit policy shared by every consumer
 * (magnification, reveal/transition CSS, pointer edge auto-scroll and the
 * editor jump). Replaces the old boolean `animationEnabled`, whose only
 * failure was that it could not override an OS `prefers-reduced-motion`
 * report — on Windows the system "Animation effects" toggle maps to that
 * media query, so a user who wanted motion got none.
 */

export type MotionMode = "system" | "full" | "reduced";

/** Resolved, platform-agnostic motion capabilities for one frame. */
export interface MotionState {
	/** True when the outline should behave as reduced-motion. */
	reduced: boolean;
	/** CSS transitions (reveal, magnification, marker) are enabled. */
	transitions: boolean;
	/** Dock magnification + vertical give-way displacement. */
	magnification: boolean;
	/** Pointer edge auto-scroll near the viewport edges. */
	autoScroll: boolean;
	/** Smooth (animated) editor / preview jump. */
	smoothJump: boolean;
}

export const MOTION_MODES: readonly MotionMode[] = ["system", "full", "reduced"];

/**
 * Resolve the effective motion state from the user's chosen mode and the
 * OS `prefers-reduced-motion` report.
 *
 * - "system": follow the OS. transitions/magnification/auto-scroll/smooth
 *   jump are all gated on `!systemReduced`.
 * - "full": motion always on, even when the OS asks for reduced. This is
 *   the fix for Windows — Full motion must override the system setting.
 * - "reduced": everything off; headings still reveal instantly.
 */
export function resolveMotionState(
	mode: MotionMode,
	systemReduced: boolean,
): MotionState {
	if (mode === "full") {
		return {
			reduced: false,
			transitions: true,
			magnification: true,
			autoScroll: true,
			smoothJump: true,
		};
	}
	if (mode === "reduced") {
		return {
			reduced: true,
			transitions: false,
			magnification: false,
			autoScroll: false,
			smoothJump: false,
		};
	}
	// "system" — follow the OS prefers-reduced-motion report.
	const reduced = systemReduced;
	return {
		reduced,
		transitions: !reduced,
		magnification: !reduced,
		autoScroll: !reduced,
		smoothJump: !reduced,
	};
}
