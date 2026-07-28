/**
 * Motion behaviour — a single, explicit policy shared by every consumer
 * (magnification, reveal/transition CSS, pointer edge auto-scroll and the
 * editor jump).
 *
 * The user-facing "Motion behavior" setting was removed: the plugin now
 * always runs with full motion. An OS `prefers-reduced-motion` report is
 * deliberately NOT honoured here — on Windows the system "Animation
 * effects" toggle maps to that media query, and it kept disabling motion
 * for users who wanted it. Consumers read `FULL_MOTION_STATE` directly.
 */

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

/**
 * The one and only runtime motion policy: everything on. Kept as a typed
 * constant (not scattered `true` literals) so the capability structure
 * survives for diagnostics and future internal gating.
 */
export const FULL_MOTION_STATE: MotionState = {
	reduced: false,
	transitions: true,
	magnification: true,
	autoScroll: true,
	smoothJump: true,
};
