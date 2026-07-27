import { describe, expect, it } from "vitest";
import {
	computeAutoScrollVelocity,
	computeOverflowState,
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

describe("computeAutoScrollVelocity", () => {
	const BASE = {
		viewportTop: 100,
		viewportBottom: 500,
		edgeZone: 48,
		maxSpeed: 320,
		canScrollUp: true,
		canScrollDown: true,
		enabled: true,
		reducedMotion: false,
	};

	it("returns 0 in the middle safe band", () => {
		expect(computeAutoScrollVelocity({ ...BASE, pointerY: 300 })).toBe(0);
	});

	it("scrolls up (negative) near the top edge", () => {
		const v = computeAutoScrollVelocity({ ...BASE, pointerY: 110 });
		expect(v).toBeLessThan(0);
	});

	it("scrolls down (positive) near the bottom edge", () => {
		const v = computeAutoScrollVelocity({ ...BASE, pointerY: 490 });
		expect(v).toBeGreaterThan(0);
	});

	it("ramps speed continuously with penetration depth", () => {
		const shallow = computeAutoScrollVelocity({ ...BASE, pointerY: 460 });
		const deep = computeAutoScrollVelocity({ ...BASE, pointerY: 495 });
		expect(deep).toBeGreaterThan(shallow);
		// Quadratic curve: zone entrance is gentle relative to max speed.
		const entrance = computeAutoScrollVelocity({
			...BASE,
			pointerY: 500 - 47.9,
		});
		expect(entrance).toBeLessThan(320 * 0.01);
	});

	it("hits max speed exactly at the edge", () => {
		expect(computeAutoScrollVelocity({ ...BASE, pointerY: 500 })).toBe(320);
		expect(computeAutoScrollVelocity({ ...BASE, pointerY: 100 })).toBe(-320);
	});

	it("stops at dead ends (cannot scroll further)", () => {
		expect(
			computeAutoScrollVelocity({ ...BASE, pointerY: 105, canScrollUp: false }),
		).toBe(0);
		expect(
			computeAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				canScrollDown: false,
			}),
		).toBe(0);
	});

	it("returns 0 when disabled or under reduced motion", () => {
		expect(
			computeAutoScrollVelocity({ ...BASE, pointerY: 495, enabled: false }),
		).toBe(0);
		expect(
			computeAutoScrollVelocity({ ...BASE, pointerY: 495, reducedMotion: true }),
		).toBe(0);
	});

	it("returns 0 outside the viewport band", () => {
		expect(computeAutoScrollVelocity({ ...BASE, pointerY: 50 })).toBe(0);
		expect(computeAutoScrollVelocity({ ...BASE, pointerY: 600 })).toBe(0);
	});

	it("splits overlapping zones at the middle of a short viewport", () => {
		// Height 60 with zone 48 → effective zone 30 per side; the exact
		// middle must still be 0 (no dead zone tug-of-war).
		const short = {
			...BASE,
			viewportTop: 100,
			viewportBottom: 160,
		};
		expect(computeAutoScrollVelocity({ ...short, pointerY: 130 })).toBe(0);
		expect(
			computeAutoScrollVelocity({ ...short, pointerY: 101 }),
		).toBeLessThan(0);
		expect(
			computeAutoScrollVelocity({ ...short, pointerY: 159 }),
		).toBeGreaterThan(0);
	});

	it("never returns NaN or Infinity", () => {
		const weird = [
			{ ...BASE, pointerY: Number.NaN },
			{ ...BASE, pointerY: 495, viewportTop: Number.NaN },
			{ ...BASE, pointerY: 495, viewportBottom: Number.POSITIVE_INFINITY },
			{ ...BASE, pointerY: 495, edgeZone: 0 },
			{ ...BASE, pointerY: 495, maxSpeed: -10 },
			{ ...BASE, pointerY: 495, viewportTop: 500, viewportBottom: 100 },
		];
		for (const input of weird) {
			const v = computeAutoScrollVelocity(input);
			expect(Number.isFinite(v)).toBe(true);
		}
	});
});
