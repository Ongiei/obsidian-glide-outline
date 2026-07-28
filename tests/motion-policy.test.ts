import { describe, expect, it } from "vitest";
import { MOTION_MODES, resolveMotionState } from "../src/utils/motion";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

/**
 * Motion policy (sections 4–5): the explicit MotionMode replaces the old
 * boolean `animationEnabled`. The single most important property is that
 * "full" OVERRIDES an OS prefers-reduced-motion report — that is the
 * Windows "Animation effects" fix.
 */
describe("resolveMotionState", () => {
	it("full: everything on even when the OS reports reduced motion", () => {
		const state = resolveMotionState("full", true);
		expect(state.reduced).toBe(false);
		expect(state.transitions).toBe(true);
		expect(state.magnification).toBe(true);
		expect(state.autoScroll).toBe(true);
		expect(state.smoothJump).toBe(true);
	});

	it("reduced: everything off even when the OS allows motion", () => {
		const state = resolveMotionState("reduced", false);
		expect(state.reduced).toBe(true);
		expect(state.transitions).toBe(false);
		expect(state.magnification).toBe(false);
		expect(state.autoScroll).toBe(false);
		expect(state.smoothJump).toBe(false);
	});

	it("system: follows the OS report exactly", () => {
		expect(resolveMotionState("system", false).reduced).toBe(false);
		expect(resolveMotionState("system", false).magnification).toBe(true);
		expect(resolveMotionState("system", true).reduced).toBe(true);
		expect(resolveMotionState("system", true).autoScroll).toBe(false);
		expect(resolveMotionState("system", true).smoothJump).toBe(false);
	});

	it("resolves consistently for every declared mode (no partial states)", () => {
		for (const mode of MOTION_MODES) {
			for (const os of [false, true]) {
				const s = resolveMotionState(mode, os);
				// All capability flags agree with `reduced` — one policy,
				// consumed identically by CSS, magnification and jumps.
				expect(s.transitions).toBe(!s.reduced);
				expect(s.magnification).toBe(!s.reduced);
				expect(s.autoScroll).toBe(!s.reduced);
				expect(s.smoothJump).toBe(!s.reduced);
			}
		}
	});
});

describe("motionMode settings migration", () => {
	it("defaults to system", () => {
		expect(DEFAULT_SETTINGS.motionMode).toBe("system");
		expect(normalizeSettings({}).motionMode).toBe("system");
	});

	it("migrates legacy animationEnabled: true → system", () => {
		const s = normalizeSettings({ animationEnabled: true });
		expect(s.motionMode).toBe("system");
	});

	it("migrates legacy animationEnabled: false → reduced", () => {
		const s = normalizeSettings({ animationEnabled: false });
		expect(s.motionMode).toBe("reduced");
	});

	it("an explicit valid motionMode wins over the legacy boolean", () => {
		const s = normalizeSettings({
			motionMode: "full",
			animationEnabled: false,
		});
		expect(s.motionMode).toBe("full");
	});

	it("rejects invalid motionMode values (falls back to default)", () => {
		expect(normalizeSettings({ motionMode: "warp" }).motionMode).toBe(
			"system",
		);
		expect(normalizeSettings({ motionMode: 3 }).motionMode).toBe("system");
	});

	it("drops the legacy field from the normalized object", () => {
		const s = normalizeSettings({ animationEnabled: true });
		expect("animationEnabled" in s).toBe(false);
	});
});
