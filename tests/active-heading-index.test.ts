import { describe, expect, it } from "vitest";
import { activeHeadingIndex } from "../src/utils/activeHeadingIndex";

describe("ordered heading lookup", () => {
	it("matches a linear reference across boundaries and folded equal positions", () => {
		const tops = [20, 80, 80, 80, 240, 400];
		for (let y = -20; y <= 440; y++) {
			let reference = 0;
			for (let i = 0; i < tops.length; i++) if (tops[i] <= y) reference = i;
			expect(activeHeadingIndex(tops.length, (i) => tops[i], y)).toBe(reference);
		}
		expect(activeHeadingIndex(0, () => { throw new Error("empty lookup"); }, 100)).toBe(-1);
	});

	it("bounds expensive position queries logarithmically", () => {
		let queries = 0;
		const result = activeHeadingIndex(10_000, (i) => { queries++; return i * 20; }, 125_000);
		expect(result).toBe(6250);
		expect(queries).toBeLessThanOrEqual(14);
	});
});
