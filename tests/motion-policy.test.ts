import { describe, expect, it } from "vitest";
import { FULL_MOTION_STATE } from "../src/utils/motion";
import { normalizeSettings } from "../src/settings";

/**
 * Motion policy: the plugin always runs with full motion. There is no
 * user-facing motion setting anymore — the runtime state is the constant
 * FULL_MOTION_STATE and an OS prefers-reduced-motion report never turns
 * the plugin's animations off.
 */
describe("FULL_MOTION_STATE", () => {
	it("has every capability enabled and reduced off", () => {
		expect(FULL_MOTION_STATE.reduced).toBe(false);
		expect(FULL_MOTION_STATE.transitions).toBe(true);
		expect(FULL_MOTION_STATE.magnification).toBe(true);
		expect(FULL_MOTION_STATE.autoScroll).toBe(true);
		expect(FULL_MOTION_STATE.smoothJump).toBe(true);
	});
});

describe("legacy motion settings are silently ignored", () => {
	it("drops a stored motionMode without failing", () => {
		const s = normalizeSettings({ motionMode: "reduced" });
		expect("motionMode" in s).toBe(false);
	});

	it("drops the even older animationEnabled boolean", () => {
		const s = normalizeSettings({ animationEnabled: false });
		expect("animationEnabled" in s).toBe(false);
		expect("motionMode" in s).toBe(false);
	});

	it("ignores garbage values in the legacy fields", () => {
		const s = normalizeSettings({ motionMode: 3, animationEnabled: "x" });
		expect("motionMode" in s).toBe(false);
		expect("animationEnabled" in s).toBe(false);
	});
});
