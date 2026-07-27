import { describe, expect, it } from "vitest";
import {
	MIN_VERTICAL_PAD,
	computeResponsiveWidth,
	computeVerticalSafeSpace,
} from "../src/utils/layout";

const BASE = {
	maxLabelWidth: 240,
	maxScale: 1.25,
	railWidth: 28,
	labelGap: 6,
	cardPaddingX: 7,
	cardBorderWidth: 0,
	shadowAllowance: 0,
	safeSlack: 20,
	compactThreshold: 60,
	horizontalOffset: 0,
	maxLevelIndent: 0,
};

/** Full magnified card budget for a given result (mirrors the CSS model). */
function magnifiedBudget(
	input: typeof BASE & { hostWidth: number },
	labelContentWidth: number,
): number {
	const cardBase =
		labelContentWidth + 2 * input.cardPaddingX + 2 * input.cardBorderWidth;
	return (
		input.railWidth +
		input.labelGap +
		cardBase * Math.max(1, input.maxScale) +
		input.shadowAllowance +
		input.safeSlack
	);
}

describe("computeResponsiveWidth", () => {
	it("budgets the complete card (text + padding + border) on a wide host", () => {
		const input = { ...BASE, hostWidth: 1200 };
		const result = computeResponsiveWidth(input);
		expect(result.labelContentWidth).toBe(240);
		expect(result.rootWidth).toBe(
			28 + 6 + Math.ceil((240 + 14) * 1.25) + 0 + 20,
		);
		expect(result.compact).toBe(false);
	});

	it("adds border width per side when the border is on", () => {
		const off = computeResponsiveWidth({ ...BASE, hostWidth: 1200 });
		const on = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			cardBorderWidth: 1,
		});
		expect(on.rootWidth).toBeGreaterThan(off.rootWidth);
	});

	it("adds shadow allowance when the shadow is on", () => {
		const off = computeResponsiveWidth({ ...BASE, hostWidth: 1200 });
		const on = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			shadowAllowance: 12,
		});
		expect(on.rootWidth).toBe(off.rootWidth + 12);
	});

	it("handles zero padding without shrinking the text budget", () => {
		const result = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			cardPaddingX: 0,
		});
		expect(result.labelContentWidth).toBe(240);
	});

	it("handles maximum padding, border and shadow together", () => {
		const input = {
			...BASE,
			hostWidth: 1200,
			cardPaddingX: 18,
			cardBorderWidth: 1,
			shadowAllowance: 12,
		};
		const result = computeResponsiveWidth(input);
		expect(result.labelContentWidth).toBe(240);
		expect(magnifiedBudget(input, result.labelContentWidth)).toBeLessThanOrEqual(
			result.rootWidth,
		);
	});

	it("clamps root width to the host and keeps the full card inside", () => {
		const input = {
			...BASE,
			hostWidth: 260,
			cardPaddingX: 10,
			cardBorderWidth: 1,
			shadowAllowance: 12,
		};
		const result = computeResponsiveWidth(input);
		expect(result.rootWidth).toBeLessThanOrEqual(260);
		expect(result.labelContentWidth).toBeLessThan(240);
		// The COMPLETE magnified card (padding + border + shadow) must fit.
		expect(magnifiedBudget(input, result.labelContentWidth)).toBeLessThanOrEqual(
			result.rootWidth + input.maxScale, // floor rounding slack
		);
	});

	it("never mutates the semantics of the configured maxLabelWidth", () => {
		// Reverse solve in a narrow pane, then verify a wide pane still
		// restores the configured value untouched.
		const narrow = computeResponsiveWidth({ ...BASE, hostWidth: 200 });
		expect(narrow.labelContentWidth).toBeLessThan(240);
		const wide = computeResponsiveWidth({ ...BASE, hostWidth: 1600 });
		expect(wide.labelContentWidth).toBe(240);
	});

	it("enters compact mode when the effective text width is tiny", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 110 });
		expect(result.compact).toBe(true);
	});

	it("never produces a negative text width in ultra narrow panes", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 10 });
		expect(result.labelContentWidth).toBeGreaterThanOrEqual(0);
		expect(result.compact).toBe(true);
	});

	it("treats maxScale below 1 as 1", () => {
		const result = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			maxScale: 0.5,
		});
		expect(result.labelContentWidth).toBe(240);
	});

	it("handles zero host width without NaN", () => {
		const result = computeResponsiveWidth({ ...BASE, hostWidth: 0 });
		expect(Number.isFinite(result.rootWidth)).toBe(true);
		expect(result.labelContentWidth).toBe(0);
		expect(result.compact).toBe(true);
	});

	it("does not change the root width on a wide host when offset grows", () => {
		// Plenty of room: the ideal width already fits, the offset only
		// moves the root inward (CSS right/left), never shrinks it.
		const zero = computeResponsiveWidth({ ...BASE, hostWidth: 1200 });
		const offset = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			horizontalOffset: 64,
		});
		expect(offset.rootWidth).toBe(zero.rootWidth);
		expect(offset.labelContentWidth).toBe(240);
	});

	it("subtracts the horizontal offset from the usable host width", () => {
		const input = { ...BASE, hostWidth: 300, horizontalOffset: 40 };
		const result = computeResponsiveWidth(input);
		expect(result.rootWidth).toBeLessThanOrEqual(300 - 40);
	});

	it("reverse-solves a smaller text width when the offset eats the pane", () => {
		const loose = computeResponsiveWidth({ ...BASE, hostWidth: 320 });
		const tight = computeResponsiveWidth({
			...BASE,
			hostWidth: 320,
			horizontalOffset: 64,
		});
		expect(tight.labelContentWidth).toBeLessThan(loose.labelContentWidth);
	});

	it("budgets the worst-case level indent on a wide host", () => {
		const flat = computeResponsiveWidth({ ...BASE, hostWidth: 1200 });
		const indented = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			maxLevelIndent: 15, // H6 at levelIndent 3 → (6-1)×3
		});
		expect(indented.rootWidth).toBe(flat.rootWidth + 15);
		expect(indented.labelContentWidth).toBe(240);
	});

	it("subtracts the level indent when reverse-solving a narrow pane", () => {
		const flat = computeResponsiveWidth({ ...BASE, hostWidth: 260 });
		const indented = computeResponsiveWidth({
			...BASE,
			hostWidth: 260,
			maxLevelIndent: 40, // levelIndent 8 × H6
		});
		expect(indented.labelContentWidth).toBeLessThan(flat.labelContentWidth);
		expect(indented.rootWidth).toBeLessThanOrEqual(260);
	});

	it("survives extreme offset + indent without NaN or negatives", () => {
		const result = computeResponsiveWidth({
			...BASE,
			hostWidth: 100,
			horizontalOffset: 64,
			maxLevelIndent: 40,
		});
		expect(Number.isFinite(result.rootWidth)).toBe(true);
		expect(result.labelContentWidth).toBeGreaterThanOrEqual(0);
		expect(result.compact).toBe(true);
	});

	it("treats negative offset and indent as zero", () => {
		const clean = computeResponsiveWidth({ ...BASE, hostWidth: 1200 });
		const dirty = computeResponsiveWidth({
			...BASE,
			hostWidth: 1200,
			horizontalOffset: -10,
			maxLevelIndent: -5,
		});
		expect(dirty).toEqual(clean);
	});

	it("is side-agnostic (left and right use the same budget)", () => {
		// The function has no side parameter by design — asserting the
		// contract stays side-free.
		const a = computeResponsiveWidth({ ...BASE, hostWidth: 300 });
		const b = computeResponsiveWidth({ ...BASE, hostWidth: 300 });
		expect(a).toEqual(b);
	});
});

describe("computeVerticalSafeSpace", () => {
	const INPUT = {
		maxBaseCardHeight: 22,
		maxScale: 1.25,
		radius: 90,
		cardGap: 4,
		shadowAllowance: 0,
	};

	it("covers worst-case edge displacement plus card growth", () => {
		const pad = computeVerticalSafeSpace(INPUT);
		const displacement = (90 * 0.25) / 2;
		const growth = (22 * 0.25) / 2;
		expect(pad).toBe(Math.max(MIN_VERTICAL_PAD, Math.ceil(displacement + growth + 4)));
	});

	it("returns the baseline pad when magnification is off", () => {
		expect(
			computeVerticalSafeSpace({ ...INPUT, maxScale: 1 }),
		).toBe(MIN_VERTICAL_PAD);
	});

	it("grows with maxScale 1.75 and a tall card", () => {
		const strong = computeVerticalSafeSpace({
			...INPUT,
			maxScale: 1.75,
			maxBaseCardHeight: 40,
			radius: 240,
		});
		const weak = computeVerticalSafeSpace(INPUT);
		expect(strong).toBeGreaterThan(weak);
		// Explainable expansion: radius*(s-1)/2 + h*(s-1)/2 + gap.
		expect(strong).toBe(Math.ceil((240 * 0.75) / 2 + (40 * 0.75) / 2 + 4));
	});

	it("adds shadow allowance", () => {
		const withShadow = computeVerticalSafeSpace({
			...INPUT,
			shadowAllowance: 12,
		});
		expect(withShadow).toBe(computeVerticalSafeSpace(INPUT) + 12);
	});

	it("never returns less than the baseline", () => {
		expect(
			computeVerticalSafeSpace({
				maxBaseCardHeight: 0,
				maxScale: 1,
				radius: 0,
				cardGap: 0,
				shadowAllowance: 0,
			}),
		).toBe(MIN_VERTICAL_PAD);
	});
});
