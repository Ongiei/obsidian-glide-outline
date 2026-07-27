import { describe, expect, it } from "vitest";
import { computeResponsiveWidth } from "../src/utils/layout";

const BASE = {
	maxLabelWidth: 240,
	maxScale: 1.25,
	railWidth: 28,
	labelGap: 6,
	safeSlack: 20,
	compactThreshold: 60,
};

describe("computeResponsiveWidth", () => {
	it("uses the ideal width on a wide host", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 1200 });
		expect(result.rootWidth).toBe(28 + Math.ceil(240 * 1.25) + 6 + 20);
		expect(result.labelWidth).toBe(240);
		expect(result.compact).toBe(false);
	});

	it("clamps root width to the host width in narrow panes", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 200 });
		expect(result.rootWidth).toBe(200);
		expect(result.labelWidth).toBeLessThan(240);
	});

	it("keeps the magnified label inside the clamped root", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 260 });
		const magnified = result.labelWidth * BASE.maxScale;
		expect(
			BASE.railWidth + magnified + BASE.labelGap + BASE.safeSlack,
		).toBeLessThanOrEqual(result.rootWidth + BASE.maxScale); // floor rounding slack
	});

	it("enters compact mode when the effective label width is tiny", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 110 });
		expect(result.compact).toBe(true);
	});

	it("never produces a negative label width", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 10 });
		expect(result.labelWidth).toBeGreaterThanOrEqual(0);
		expect(result.compact).toBe(true);
	});

	it("treats maxScale below 1 as 1", () => {
		const result = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			maxScale: 0.5,
		});
		expect(result.labelWidth).toBe(240);
	});

	it("handles zero host width without NaN", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 0 });
		expect(Number.isFinite(result.rootWidth)).toBe(true);
		expect(result.labelWidth).toBe(0);
		expect(result.compact).toBe(true);
	});
});
