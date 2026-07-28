import { describe, expect, it } from "vitest";
import {
	identityMotionState,
	motionAlpha,
	motionStateConverged,
	motionStateIsIdentity,
	stepMotionState,
	stepToward,
	MOTION_TIME_CONSTANT_MS,
	SCALE_EPSILON,
	SHIFT_EPSILON,
} from "../src/utils/motionInterp";

describe("motionAlpha", () => {
	it("is 0 for non-positive or non-finite time steps", () => {
		expect(motionAlpha(0)).toBe(0);
		expect(motionAlpha(-5)).toBe(0);
		expect(motionAlpha(Number.NaN)).toBe(0);
	});

	it("is ~63% after one time constant", () => {
		expect(motionAlpha(MOTION_TIME_CONSTANT_MS)).toBeCloseTo(
			1 - Math.exp(-1),
			10,
		);
	});

	it("approaches 1 for very large steps (no overshoot)", () => {
		const a = motionAlpha(10_000);
		expect(a).toBeGreaterThan(0.999);
		expect(a).toBeLessThanOrEqual(1);
	});

	it("is frame-rate independent: two half steps equal one full step", () => {
		// displayed' = d + (t - d) * alpha ⇒ remaining error scales by
		// (1 - alpha) = exp(-dt/tau). Two 8 ms steps must leave the same
		// error as one 16 ms step.
		const target = 100;
		let twoSteps = 0;
		twoSteps += (target - twoSteps) * motionAlpha(8);
		twoSteps += (target - twoSteps) * motionAlpha(8);
		let oneStep = 0;
		oneStep += (target - oneStep) * motionAlpha(16);
		expect(twoSteps).toBeCloseTo(oneStep, 10);
	});
});

describe("stepToward", () => {
	it("moves proportionally toward the target", () => {
		expect(stepToward(0, 10, 0.5, 0.001)).toBeCloseTo(5);
	});

	it("snaps to the target once within epsilon (terminates)", () => {
		expect(stepToward(9.9995, 10, 0.5, 0.001)).toBe(10);
	});

	it("recovers from a non-finite displayed value", () => {
		expect(stepToward(Number.NaN, 3, 0.5, 0.001)).toBe(3);
	});
});

describe("stepMotionState", () => {
	it("converges to the target and then stops reporting work", () => {
		const state = identityMotionState();
		state.targetScale = 1.5;
		state.targetShift = -20;
		let iterations = 0;
		while (stepMotionState(state, motionAlpha(16)) && iterations < 500) {
			iterations++;
		}
		expect(iterations).toBeLessThan(500); // terminated, no asymptote
		expect(state.displayedScale).toBe(1.5);
		expect(state.displayedShift).toBe(-20);
		expect(motionStateConverged(state)).toBe(true);
		// A converged state must report "no more work".
		expect(stepMotionState(state, motionAlpha(16))).toBe(false);
	});

	it("alpha = 1 applies the target instantly (reduced motion)", () => {
		const state = identityMotionState();
		state.targetScale = 1.4;
		state.targetShift = 12;
		const busy = stepMotionState(state, 1);
		expect(busy).toBe(false);
		expect(state.displayedScale).toBe(1.4);
		expect(state.displayedShift).toBe(12);
	});

	it("alpha = 0 freezes displayed values (pointer held / first frame)", () => {
		const state = identityMotionState();
		state.targetScale = 1.4;
		state.targetShift = 12;
		stepMotionState(state, 0);
		expect(state.displayedScale).toBe(1);
		expect(state.displayedShift).toBe(0);
	});

	it("returning to identity converges exactly to scale 1 / shift 0", () => {
		const state: ReturnType<typeof identityMotionState> = {
			targetScale: 1,
			displayedScale: 1.5,
			targetShift: 0,
			displayedShift: -18,
		};
		let iterations = 0;
		while (stepMotionState(state, motionAlpha(16)) && iterations < 500) {
			iterations++;
		}
		expect(state.displayedScale).toBe(1);
		expect(state.displayedShift).toBe(0);
		expect(motionStateIsIdentity(state)).toBe(true);
	});

	it("epsilons match the CSS write thresholds", () => {
		expect(SCALE_EPSILON).toBe(0.001);
		expect(SHIFT_EPSILON).toBe(0.05);
	});
});
