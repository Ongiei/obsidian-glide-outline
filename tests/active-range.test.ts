import { describe, expect, it } from "vitest";
import {
	computeActiveMotionRange,
	displacementAllowance,
	emptyActiveRange,
	isEmptyActiveRange,
	DEFAULT_OVERSCAN_ROWS,
} from "../src/utils/activeRange";
import { defaultShiftAmplitude } from "../src/utils/geometry";

/** Uniform row list helper: centers spaced `step` apart from `first`. */
function rows(count: number, step = 30, first = 15, height = 24) {
	const centers: number[] = [];
	const heights: number[] = [];
	for (let i = 0; i < count; i++) {
		centers.push(first + i * step);
		heights.push(height);
	}
	return { centers, heights };
}

const BASE = {
	viewportTop: 0,
	viewportBottom: 600,
	pointerY: 300,
	radius: 80,
	maxScale: 1.6,
};

describe("displacementAllowance", () => {
	it("combines the shift amplitude and the scale growth half-height", () => {
		expect(displacementAllowance(1.6, 24)).toBeCloseTo(
			defaultShiftAmplitude(1.6) + (0.6 * 24) / 2,
		);
	});

	it("is zero when there is no magnification", () => {
		expect(displacementAllowance(1, 24)).toBe(0);
		expect(displacementAllowance(1, 0)).toBe(0);
	});
});

describe("computeActiveMotionRange", () => {
	it("returns the empty range for an empty list", () => {
		const range = computeActiveMotionRange({
			...BASE,
			centers: [],
			heights: [],
		});
		expect(isEmptyActiveRange(range)).toBe(true);
	});

	it("covers all rows when everything fits in the viewport", () => {
		const { centers, heights } = rows(10);
		const range = computeActiveMotionRange({ ...BASE, centers, heights });
		expect(range.start).toBe(0);
		expect(range.end).toBe(9);
	});

	it("clamps to the first/last item without going out of bounds", () => {
		const { centers, heights } = rows(5);
		const range = computeActiveMotionRange({
			...BASE,
			centers,
			heights,
			pointerY: centers[0],
		});
		expect(range.start).toBeGreaterThanOrEqual(0);
		expect(range.end).toBeLessThanOrEqual(4);
	});

	it("excludes rows far below the viewport in a long list", () => {
		const { centers, heights } = rows(1000);
		const range = computeActiveMotionRange({ ...BASE, centers, heights });
		expect(range.start).toBe(0);
		// 600 px viewport / 30 px rows = 20 visible; allowance + radius +
		// overscan add a bounded margin — nowhere near 1000 rows.
		expect(range.end).toBeLessThan(60);
	});

	it("centers the range on the viewport window mid-list", () => {
		const { centers, heights } = rows(1000);
		const range = computeActiveMotionRange({
			...BASE,
			viewportTop: 15000,
			viewportBottom: 15600,
			pointerY: 15300,
			centers,
			heights,
		});
		// Rows around index 500 (center 15015) are inside.
		expect(range.start).toBeGreaterThan(400);
		expect(range.end).toBeLessThan(600);
		expect(range.start).toBeLessThanOrEqual(500);
		expect(range.end).toBeGreaterThanOrEqual(519);
	});

	it("reaches the last row at the bottom of the list", () => {
		const { centers, heights } = rows(100);
		const range = computeActiveMotionRange({
			...BASE,
			viewportTop: 2400,
			viewportBottom: 3000,
			pointerY: 2990,
			centers,
			heights,
		});
		expect(range.end).toBe(99);
	});

	it("expands with the pointer disc when the pointer is outside the viewport", () => {
		const { centers, heights } = rows(1000);
		const without = computeActiveMotionRange({
			...BASE,
			centers,
			heights,
			pointerY: Number.NaN,
		});
		const withPointer = computeActiveMotionRange({
			...BASE,
			centers,
			heights,
			pointerY: 900, // below the viewport bottom
		});
		expect(withPointer.end).toBeGreaterThan(without.end);
	});

	it("grows with a larger radius", () => {
		const { centers, heights } = rows(1000);
		const small = computeActiveMotionRange({
			...BASE,
			centers,
			heights,
			viewportTop: 15000,
			viewportBottom: 15600,
			pointerY: 15300,
			radius: 40,
		});
		const large = computeActiveMotionRange({
			...BASE,
			centers,
			heights,
			viewportTop: 15000,
			viewportBottom: 15600,
			pointerY: 15300,
			radius: 400,
		});
		expect(large.end - large.start).toBeGreaterThan(small.end - small.start);
	});

	it("adds overscan rows on both sides", () => {
		const { centers, heights } = rows(1000);
		const zero = computeActiveMotionRange({
			...BASE,
			viewportTop: 15000,
			viewportBottom: 15600,
			pointerY: 15300,
			centers,
			heights,
			overscan: 0,
		});
		const dflt = computeActiveMotionRange({
			...BASE,
			viewportTop: 15000,
			viewportBottom: 15600,
			pointerY: 15300,
			centers,
			heights,
		});
		expect(dflt.start).toBe(zero.start - DEFAULT_OVERSCAN_ROWS);
		expect(dflt.end).toBe(zero.end + DEFAULT_OVERSCAN_ROWS);
	});

	it("range boundary rows are provably identity (displacement allowance)", () => {
		// A row strictly outside the influence interval sits farther than
		// the displacement allowance from every influence source, so the
		// cosine falloff is exactly zero there — entering the range
		// mid-scroll can never make a row jump from a non-zero value.
		//
		// §十六: the magnification radius is applied ONCE, at the pointer's
		// disc (pointerY ± radius). Here the pointer (15300) sits inside the
		// viewport window [15000, 15600], so the disc does not extend past
		// the viewport edges — the window is just the viewport expanded by
		// the displacement allowance, not by radius again.
		const { centers, heights } = rows(1000);
		const range = computeActiveMotionRange({
			...BASE,
			viewportTop: 15000,
			viewportBottom: 15600,
			pointerY: 15300,
			centers,
			heights,
			overscan: 0,
		});
		const allowance = displacementAllowance(BASE.maxScale, 24);
		const lo = 15000 - allowance;
		const hi = 15600 + allowance;
		if (range.start > 0) {
			const outsideBottom = centers[range.start - 1] + 12;
			expect(outsideBottom).toBeLessThan(lo);
		}
		if (range.end < 999) {
			const outsideTop = centers[range.end + 1] - 12;
			expect(outsideTop).toBeGreaterThan(hi);
		}
	});

	it("emptyActiveRange round-trips through isEmptyActiveRange", () => {
		expect(isEmptyActiveRange(emptyActiveRange())).toBe(true);
		expect(isEmptyActiveRange({ start: 0, end: 0 })).toBe(false);
	});
});
