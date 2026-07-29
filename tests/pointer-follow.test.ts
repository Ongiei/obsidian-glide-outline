import { describe, expect, it } from "vitest";
import {
	POINTER_FOLLOW_GAIN,
	POINTER_FOLLOW_MAX_SHARE,
	POINTER_FOLLOW_MIN_VELOCITY,
	computePointerFollowVelocity,
} from "../src/utils/overflow";
import type { PointerFollowInput } from "../src/utils/overflow";

function input(overrides: Partial<PointerFollowInput> = {}): PointerFollowInput {
	return {
		pointerY: 300,
		pointerVelocityY: 0,
		viewportTop: 100,
		viewportBottom: 500,
		maxSpeed: 900,
		strength: 1,
		canScrollUp: true,
		canScrollDown: true,
		enabled: true,
		...overrides,
	};
}

describe("computePointerFollowVelocity (§十三–§十五)", () => {
	it("a stationary pointer never pre-scrolls", () => {
		expect(computePointerFollowVelocity(input())).toBe(0);
	});

	it("slow browsing below the threshold stays at 0 (no dwell needed either)", () => {
		expect(
			computePointerFollowVelocity(
				input({ pointerVelocityY: POINTER_FOLLOW_MIN_VELOCITY }),
			),
		).toBe(0);
		expect(
			computePointerFollowVelocity(
				input({ pointerVelocityY: -POINTER_FOLLOW_MIN_VELOCITY }),
			),
		).toBe(0);
	});

	it("a fast downward gesture pre-scrolls DOWN with the documented gain (at edge)", () => {
		// AT the viewport edge the depth factor is exactly 1, so the
		// magnitude is exactly (|vy| − min) × gain × 1.
		const vy = POINTER_FOLLOW_MIN_VELOCITY + 400;
		const v = computePointerFollowVelocity(
			input({ pointerVelocityY: vy, pointerY: 500 }),
		);
		expect(v).toBeCloseTo(400 * POINTER_FOLLOW_GAIN, 10);
		expect(v).toBeGreaterThan(0);
	});

	it("a fast upward gesture pre-scrolls UP (sign follows the gesture)", () => {
		const vy = -(POINTER_FOLLOW_MIN_VELOCITY + 400);
		const v = computePointerFollowVelocity(
			input({ pointerVelocityY: vy, pointerY: 100 }),
		);
		expect(v).toBeCloseTo(-400 * POINTER_FOLLOW_GAIN, 10);
	});

	it("scales with the depth factor: an edge flick beats a center flick", () => {
		// Same velocity at the dead-center (depthFactor 0.35) must produce
		// a smaller target than at the edge (depthFactor ~1).
		const vy = POINTER_FOLLOW_MIN_VELOCITY + 1000;
		const center = computePointerFollowVelocity(
			input({ pointerVelocityY: vy, pointerY: 300 }),
		);
		const edge = computePointerFollowVelocity(
			input({ pointerVelocityY: vy, pointerY: 499 }),
		);
		expect(center).toBeGreaterThan(0);
		expect(edge).toBeGreaterThan(center);
	});

	it("a fast flick in the dead-center still pre-scrolls (depthFactor > 0)", () => {
		// §九: the center is not a hard dead zone for the kinetic path —
		// depthFactor is 0.35 there, so a decisive flick still moves.
		const v = computePointerFollowVelocity(
			input({ pointerVelocityY: 5000, pointerY: 300 }),
		);
		expect(v).toBeGreaterThan(0);
	});

	it("magnitude is capped at maxSpeed × POINTER_FOLLOW_MAX_SHARE", () => {
		const v = computePointerFollowVelocity(
			input({ pointerVelocityY: 100000, maxSpeed: 900 }),
		);
		expect(v).toBe(900 * POINTER_FOLLOW_MAX_SHARE);
	});

	it("gated OFF by the pointerFollowEnabled setting", () => {
		expect(
			computePointerFollowVelocity(
				input({ pointerVelocityY: 5000, enabled: false }),
			),
		).toBe(0);
	});

	it("inactive outside the viewport band (above and below)", () => {
		const fast = { pointerVelocityY: 5000 };
		expect(
			computePointerFollowVelocity(input({ ...fast, pointerY: 50 })),
		).toBe(0);
		expect(
			computePointerFollowVelocity(input({ ...fast, pointerY: 600 })),
		).toBe(0);
	});

	it("dead-end gating: no downward follow at the bottom, no upward at the top", () => {
		expect(
			computePointerFollowVelocity(
				input({ pointerVelocityY: 5000, canScrollDown: false }),
			),
		).toBe(0);
		expect(
			computePointerFollowVelocity(
				input({ pointerVelocityY: -5000, canScrollUp: false }),
			),
		).toBe(0);
	});

	it("dead-end gating is directional — the open direction still works", () => {
		const v = computePointerFollowVelocity(
			input({ pointerVelocityY: 5000, canScrollUp: false }),
		);
		expect(v).toBeGreaterThan(0);
	});

	it("degenerate band or zero maxSpeed yields 0", () => {
		expect(
			computePointerFollowVelocity(
				input({
					pointerVelocityY: 5000,
					viewportTop: 500,
					viewportBottom: 100,
				}),
			),
		).toBe(0);
		expect(
			computePointerFollowVelocity(
				input({ pointerVelocityY: 5000, maxSpeed: 0 }),
			),
		).toBe(0);
	});

	it("never returns NaN on non-finite inputs", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				computePointerFollowVelocity(input({ pointerVelocityY: bad })),
			).toBe(0);
			expect(
				computePointerFollowVelocity(
					input({ pointerVelocityY: 5000, pointerY: bad }),
				),
			).toBe(0);
			expect(
				computePointerFollowVelocity(
					input({ pointerVelocityY: 5000, maxSpeed: bad }),
				),
			).toBe(0);
		}
	});

	it("follow ceiling stays below the edge mechanism's full speed (§十七)", () => {
		expect(POINTER_FOLLOW_MAX_SHARE).toBeLessThan(1);
	});
});
