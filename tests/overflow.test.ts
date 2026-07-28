import { describe, expect, it } from "vitest";
import {
	computeOverflowState,
	computePointerAutoScrollVelocity,
} from "../src/utils/overflow";

describe("computeOverflowState", () => {
	it("reports no overflow when content fits", () => {
		expect(
			computeOverflowState({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 }),
		).toEqual({ hasOverflow: false, canScrollUp: false, canScrollDown: false });
	});

	it("treats sub-tolerance residue as fitting (rounding slack)", () => {
		expect(
			computeOverflowState({
				scrollTop: 0,
				clientHeight: 400,
				scrollHeight: 400.5,
			}).hasOverflow,
		).toBe(false);
	});

	it("at the top only the bottom can scroll", () => {
		expect(
			computeOverflowState({ scrollTop: 0, clientHeight: 400, scrollHeight: 900 }),
		).toEqual({ hasOverflow: true, canScrollUp: false, canScrollDown: true });
	});

	it("in the middle both directions can scroll", () => {
		expect(
			computeOverflowState({
				scrollTop: 250,
				clientHeight: 400,
				scrollHeight: 900,
			}),
		).toEqual({ hasOverflow: true, canScrollUp: true, canScrollDown: true });
	});

	it("at the bottom only the top can scroll", () => {
		expect(
			computeOverflowState({
				scrollTop: 500,
				clientHeight: 400,
				scrollHeight: 900,
			}),
		).toEqual({ hasOverflow: true, canScrollUp: true, canScrollDown: false });
	});

	it("tolerates fractional scroll positions near the bottom", () => {
		expect(
			computeOverflowState({
				scrollTop: 499.4,
				clientHeight: 400,
				scrollHeight: 900,
			}).canScrollDown,
		).toBe(false);
	});

	it("survives non-finite input without throwing", () => {
		expect(
			computeOverflowState({
				scrollTop: Number.NaN,
				clientHeight: Number.POSITIVE_INFINITY,
				scrollHeight: Number.NaN,
			}),
		).toEqual({ hasOverflow: false, canScrollUp: false, canScrollDown: false });
	});
});

describe("computePointerAutoScrollVelocity", () => {
	// Viewport 100–500 (height 400) → pre-scroll zone 100 px, edge zone 50 px.
	const BASE = {
		pointerVelocityY: 0,
		viewportTop: 100,
		viewportBottom: 500,
		maxSpeed: 320,
		canScrollUp: true,
		canScrollDown: true,
		enabled: true,
		reducedMotion: false,
	};

	it("returns 0 across the whole dead zone", () => {
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 300 })).toBe(0);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 200 })).toBe(0);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 400 })).toBe(0);
	});

	it("scrolls up (negative) inside the top pre-scroll zone", () => {
		const v = computePointerAutoScrollVelocity({ ...BASE, pointerY: 150 });
		expect(v).toBeLessThan(0);
	});

	it("scrolls down (positive) inside the bottom pre-scroll zone", () => {
		const v = computePointerAutoScrollVelocity({ ...BASE, pointerY: 450 });
		expect(v).toBeGreaterThan(0);
	});

	it("ramps speed continuously with penetration depth", () => {
		const pre = computePointerAutoScrollVelocity({ ...BASE, pointerY: 430 });
		const edge = computePointerAutoScrollVelocity({ ...BASE, pointerY: 480 });
		const deep = computePointerAutoScrollVelocity({ ...BASE, pointerY: 495 });
		expect(edge).toBeGreaterThan(pre);
		expect(deep).toBeGreaterThan(edge);
		// Quadratic curve: the pre-scroll entrance is gentle.
		const entrance = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 500 - 99.9,
		});
		expect(entrance).toBeLessThan(320 * 0.01);
	});

	it("keeps the pre-scroll zone below its speed share", () => {
		// Just outside the edge zone (distance 51 px) only the pre-scroll
		// ramp contributes → strictly below 35% of maxSpeed.
		const v = computePointerAutoScrollVelocity({ ...BASE, pointerY: 449 });
		expect(v).toBeGreaterThan(0);
		expect(v).toBeLessThan(320 * 0.35);
	});

	it("uses the enlarged sensing zones (section 3)", () => {
		// Height 400: pre-scroll = 25% → 100 px, edge = 12.5% → 50 px.
		// 405 (distance 95) is INSIDE the new pre-scroll zone but was in
		// the old dead zone (old zone was 80 px) — must now scroll.
		expect(
			computePointerAutoScrollVelocity({ ...BASE, pointerY: 405 }),
		).toBeGreaterThan(0);
		// Symmetric at the top.
		expect(
			computePointerAutoScrollVelocity({ ...BASE, pointerY: 195 }),
		).toBeLessThan(0);
		// 445 (distance 55) sits between the old edge boundary (40) and the
		// new one (50): still pre-scroll only, below the 35% share.
		const between = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 445,
		});
		expect(between).toBeGreaterThan(0);
		expect(between).toBeLessThan(320 * 0.35);
	});

	it("hits max speed exactly at the physical edges", () => {
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 500 })).toBe(320);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 100 })).toBe(-320);
	});

	it("adds a velocity assist when flicking toward the near edge", () => {
		const idle = computePointerAutoScrollVelocity({ ...BASE, pointerY: 470 });
		const flick = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 470,
			pointerVelocityY: 900,
		});
		expect(flick).toBeGreaterThan(idle);

		const idleUp = computePointerAutoScrollVelocity({ ...BASE, pointerY: 130 });
		const flickUp = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 130,
			pointerVelocityY: -900,
		});
		expect(flickUp).toBeLessThan(idleUp);
	});

	it("lets a fast flick pre-scroll before reaching the positional zones", () => {
		// pointerY 380 is inside the dead zone (base 0) but in the lower
		// half — a decisive downward flick should already move the list.
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 380 })).toBe(0);
		const v = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 380,
			pointerVelocityY: 800,
		});
		expect(v).toBeGreaterThan(0);
	});

	it("ignores velocity pointing away from the near edge", () => {
		// Moving up while hovering in the lower half must not fight the
		// positional intent.
		const v = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 380,
			pointerVelocityY: -2000,
		});
		expect(v).toBe(0);
	});

	it("adds no assist at the exact center regardless of velocity", () => {
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 300,
				pointerVelocityY: 5000,
			}),
		).toBe(0);
	});

	it("clamps the total speed to maxSpeed even with a huge assist", () => {
		const v = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 500,
			pointerVelocityY: 100000,
		});
		expect(v).toBe(320);
	});

	it("stops at dead ends (cannot scroll further)", () => {
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 105,
				canScrollUp: false,
			}),
		).toBe(0);
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				canScrollDown: false,
			}),
		).toBe(0);
	});

	it("returns 0 when disabled or under reduced motion", () => {
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				enabled: false,
			}),
		).toBe(0);
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				reducedMotion: true,
			}),
		).toBe(0);
	});

	it("returns 0 outside the viewport band", () => {
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 50 })).toBe(0);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 600 })).toBe(0);
	});

	it("keeps a calm center in a short viewport (no zone tug-of-war)", () => {
		// Height 60 → the half-height clamp caps pre-scroll at 30 px and
		// the edge zone at its 16 px minimum; the exact middle stays 0.
		const short = { ...BASE, viewportTop: 100, viewportBottom: 160 };
		expect(computePointerAutoScrollVelocity({ ...short, pointerY: 130 })).toBe(0);
		expect(
			computePointerAutoScrollVelocity({ ...short, pointerY: 101 }),
		).toBeLessThan(0);
		expect(
			computePointerAutoScrollVelocity({ ...short, pointerY: 159 }),
		).toBeGreaterThan(0);
	});

	it("never returns NaN or Infinity", () => {
		const weird = [
			{ ...BASE, pointerY: Number.NaN },
			{ ...BASE, pointerY: 495, pointerVelocityY: Number.NaN },
			{ ...BASE, pointerY: 495, viewportTop: Number.NaN },
			{ ...BASE, pointerY: 495, viewportBottom: Number.POSITIVE_INFINITY },
			{ ...BASE, pointerY: 495, maxSpeed: -10 },
			{ ...BASE, pointerY: 495, viewportTop: 500, viewportBottom: 100 },
		];
		for (const input of weird) {
			const v = computePointerAutoScrollVelocity(input);
			expect(Number.isFinite(v)).toBe(true);
		}
	});
});
