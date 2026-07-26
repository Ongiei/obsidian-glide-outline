import { describe, expect, it } from "vitest";
import {
	computeMagnification,
	computeScale,
	computeShift,
	defaultShiftAmplitude,
} from "../src/utils/geometry";

const MAX_SCALE = 1.25;
const RADIUS = 90;

describe("computeScale", () => {
	it("returns maxScale at distance 0", () => {
		expect(computeScale(0, MAX_SCALE, RADIUS)).toBeCloseTo(MAX_SCALE, 6);
	});

	it("returns 1 at or beyond the radius", () => {
		expect(computeScale(RADIUS, MAX_SCALE, RADIUS)).toBe(1);
		expect(computeScale(RADIUS + 1, MAX_SCALE, RADIUS)).toBe(1);
		expect(computeScale(10_000, MAX_SCALE, RADIUS)).toBe(1);
	});

	it("decreases monotonically with distance", () => {
		let previous = computeScale(0, MAX_SCALE, RADIUS);
		for (let d = 5; d <= RADIUS; d += 5) {
			const current = computeScale(d, MAX_SCALE, RADIUS);
			expect(current).toBeLessThanOrEqual(previous);
			previous = current;
		}
	});

	it("is symmetric in distance sign", () => {
		expect(computeScale(-30, MAX_SCALE, RADIUS)).toBeCloseTo(
			computeScale(30, MAX_SCALE, RADIUS),
			10,
		);
	});

	it("degrades safely for invalid inputs", () => {
		expect(computeScale(10, MAX_SCALE, 0)).toBe(1);
		expect(computeScale(10, MAX_SCALE, -5)).toBe(1);
		expect(computeScale(10, 1, RADIUS)).toBe(1);
		expect(computeScale(Number.NaN, MAX_SCALE, RADIUS)).toBe(1);
		expect(computeScale(Number.POSITIVE_INFINITY, MAX_SCALE, RADIUS)).toBe(1);
	});
});

describe("computeMagnification", () => {
	const centers = [0, 30, 60, 90, 120, 150, 180];

	it("gives items above the pointer negative translateY and below positive", () => {
		const pointerY = 90;
		const results = computeMagnification(pointerY, centers, MAX_SCALE, RADIUS);
		for (let i = 0; i < centers.length; i++) {
			const offset = centers[i] - pointerY;
			if (offset < 0 && Math.abs(offset) < RADIUS) {
				expect(results[i].translateY).toBeLessThan(0);
			} else if (offset > 0 && Math.abs(offset) < RADIUS) {
				expect(results[i].translateY).toBeGreaterThan(0);
			} else {
				expect(results[i].translateY).toBe(0);
			}
		}
	});

	it("never produces NaN or Infinity", () => {
		const weirdPointers = [0, -50, Number.NaN, Number.POSITIVE_INFINITY];
		const weirdCenters = [
			[],
			[0],
			[Number.NaN, 10],
			[-1e9, 0, 1e9],
		];
		for (const pointer of weirdPointers) {
			for (const list of weirdCenters) {
				const results = computeMagnification(pointer, list, MAX_SCALE, RADIUS);
				for (const r of results) {
					expect(Number.isFinite(r.scale)).toBe(true);
					expect(Number.isFinite(r.translateY)).toBe(true);
				}
			}
		}
		// radius 0 must not divide by zero
		const zeroRadius = computeMagnification(50, [40, 50, 60], MAX_SCALE, 0);
		for (const r of zeroRadius) {
			expect(r.scale).toBe(1);
			expect(r.translateY).toBe(0);
		}
	});

	it("returns scale 1 and shift 0 under reduced motion", () => {
		const results = computeMagnification(90, centers, MAX_SCALE, RADIUS, {
			reducedMotion: true,
		});
		for (const r of results) {
			expect(r.scale).toBe(1);
			expect(r.translateY).toBe(0);
		}
	});

	it("keeps the focused item unshifted (continuity at the pointer)", () => {
		const results = computeMagnification(60, centers, MAX_SCALE, RADIUS);
		expect(results[2].translateY).toBe(0);
		expect(results[2].scale).toBeCloseTo(MAX_SCALE, 3);
	});

	it("shift is continuous across the radius edge", () => {
		const justInside = computeShift(RADIUS - 0.001, RADIUS, 10);
		expect(Math.abs(justInside)).toBeLessThan(0.01);
		expect(computeShift(RADIUS, RADIUS, 10)).toBe(0);
	});

	it("default shift amplitude grows with magnification strength", () => {
		expect(defaultShiftAmplitude(1)).toBe(0);
		expect(defaultShiftAmplitude(1.5)).toBeGreaterThan(
			defaultShiftAmplitude(1.25),
		);
	});
});
