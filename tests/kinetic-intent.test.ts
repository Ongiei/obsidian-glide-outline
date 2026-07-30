// §十 Kinetic (pointer-follow) intent — predictedY wiring.
//
// `predictedPointerY` existed and was computed on every pointer move, but
// nothing ever read it: the depth ramp was evaluated at the pointer's
// CURRENT position, so the assist only strengthened after the pointer had
// already reached the edge. These tests pin the corrected contract:
//
//   • the DEPTH factor is evaluated at the predicted position (anticipation);
//   • ELIGIBILITY still uses the actual position (a prediction may not
//     switch the follow on or off);
//   • an absent / non-finite prediction degrades to the old behaviour.
import { describe, expect, it } from "vitest";
import {
	POINTER_FOLLOW_LOOKAHEAD_MS,
	POINTER_FOLLOW_MIN_SPEED,
	PointerSampleRing,
	computeKineticIntentVelocity,
	predictedPointerY,
} from "../src/utils/scrollIntent";
import type { KineticIntentInput } from "../src/utils/scrollIntent";

const VIEWPORT_TOP = 100;
const VIEWPORT_BOTTOM = 500;
const CENTER = (VIEWPORT_TOP + VIEWPORT_BOTTOM) / 2; // 300

function input(overrides: Partial<KineticIntentInput> = {}): KineticIntentInput {
	return {
		pointerY: CENTER,
		pointerVelocityY: 0,
		viewportTop: VIEWPORT_TOP,
		viewportBottom: VIEWPORT_BOTTOM,
		maxSpeed: 900,
		strength: 1,
		canScrollUp: true,
		canScrollDown: true,
		enabled: true,
		...overrides,
	};
}

describe("§十 computeKineticIntentVelocity + predictedY", () => {
	it("omitting predictedY keeps the depth factor on the actual position", () => {
		const withoutPrediction = computeKineticIntentVelocity(
			input({ pointerVelocityY: 800 }),
		);
		const explicitlyAtPointer = computeKineticIntentVelocity(
			input({ pointerVelocityY: 800, predictedY: CENTER }),
		);
		expect(withoutPrediction).toBe(explicitlyAtPointer);
		expect(withoutPrediction).toBeGreaterThan(0);
	});

	it("a non-finite prediction degrades to the actual position", () => {
		const baseline = computeKineticIntentVelocity(
			input({ pointerVelocityY: 800 }),
		);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				computeKineticIntentVelocity(
					input({ pointerVelocityY: 800, predictedY: bad }),
				),
			).toBe(baseline);
		}
	});

	it("anticipates: a flick toward the edge assists harder than its current depth", () => {
		// Dead centre, moving down fast. Without the prediction the depth
		// factor is the minimum 0.35; with it the ramp already reflects the
		// position the pointer is about to occupy.
		const velocity = 1200;
		const predicted = predictedPointerY(CENTER, velocity);
		expect(predicted).toBeGreaterThan(CENTER);
		const reactive = computeKineticIntentVelocity(
			input({ pointerVelocityY: velocity }),
		);
		const anticipating = computeKineticIntentVelocity(
			input({ pointerVelocityY: velocity, predictedY: predicted }),
		);
		expect(anticipating).toBeGreaterThan(reactive);
	});

	it("calms down when the flick is heading back toward centre", () => {
		// Near the bottom edge but moving UP: the pointer is leaving the
		// strong zone, so the assist should already be relaxing.
		const pointerY = VIEWPORT_BOTTOM - 20;
		const velocity = -1200;
		const predicted = predictedPointerY(pointerY, velocity);
		const reactive = Math.abs(
			computeKineticIntentVelocity(
				input({ pointerY, pointerVelocityY: velocity }),
			),
		);
		const anticipating = Math.abs(
			computeKineticIntentVelocity(
				input({ pointerY, pointerVelocityY: velocity, predictedY: predicted }),
			),
		);
		expect(anticipating).toBeLessThan(reactive);
	});

	it("a prediction that overshoots the viewport does NOT disable the follow", () => {
		// The pointer is genuinely inside; the 80 ms guess lands past the
		// bottom edge. That must saturate the depth factor, not zero the
		// intent — eligibility reads the ACTUAL position.
		const pointerY = VIEWPORT_BOTTOM - 5;
		const predicted = VIEWPORT_BOTTOM + 400;
		const value = computeKineticIntentVelocity(
			input({ pointerY, pointerVelocityY: 900, predictedY: predicted }),
		);
		expect(value).toBeGreaterThan(0);
		// Saturated at the edge: identical to a prediction exactly on it.
		expect(value).toBe(
			computeKineticIntentVelocity(
				input({
					pointerY,
					pointerVelocityY: 900,
					predictedY: VIEWPORT_BOTTOM,
				}),
			),
		);
	});

	it("a prediction inside the viewport cannot rescue a pointer that left", () => {
		expect(
			computeKineticIntentVelocity(
				input({
					pointerY: VIEWPORT_BOTTOM + 50,
					pointerVelocityY: -900,
					predictedY: CENTER,
				}),
			),
		).toBe(0);
	});

	it("still respects the dead ends and the speed floor", () => {
		const predicted = predictedPointerY(CENTER, 900);
		expect(
			computeKineticIntentVelocity(
				input({
					pointerVelocityY: 900,
					predictedY: predicted,
					canScrollDown: false,
				}),
			),
		).toBe(0);
		expect(
			computeKineticIntentVelocity(
				input({
					pointerVelocityY: POINTER_FOLLOW_MIN_SPEED,
					predictedY: predicted,
				}),
			),
		).toBe(0);
	});
});

describe("§十 predictedPointerY", () => {
	it("projects the lookahead window", () => {
		expect(predictedPointerY(200, 1000)).toBeCloseTo(
			200 + POINTER_FOLLOW_LOOKAHEAD_MS,
			6,
		);
	});

	it("is the identity for a stationary pointer", () => {
		expect(predictedPointerY(200, 0)).toBe(200);
	});
});

describe("§十 PointerSampleRing.length (gap-starvation gauge)", () => {
	it("reports how many samples back the current estimate", () => {
		const ring = new PointerSampleRing(4, 1000);
		expect(ring.length).toBe(0);
		ring.push(0, 0);
		ring.push(10, 10);
		expect(ring.length).toBe(2);
		ring.push(20, 20);
		ring.push(30, 30);
		ring.push(40, 40);
		expect(ring.length).toBe(4); // capped at capacity
		ring.clear();
		expect(ring.length).toBe(0);
	});
});
