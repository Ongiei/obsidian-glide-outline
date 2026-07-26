import { describe, expect, it } from "vitest";
import { selectActiveIndex } from "../src/utils/geometry";

describe("selectActiveIndex", () => {
	const tops = [0, 200, 400, 600, 800];

	it("selects the last heading at or above the activation line", () => {
		expect(selectActiveIndex(tops, 450)).toBe(2);
		expect(selectActiveIndex(tops, 400)).toBe(2); // intersecting counts
		expect(selectActiveIndex(tops, 399)).toBe(1);
	});

	it("falls back to the first heading at the top of the page", () => {
		// Activation line above every heading (e.g. content before heading 0
		// scrolled to top with a negative offset scenario).
		expect(selectActiveIndex([120, 300, 500], 50)).toBe(0);
	});

	it("selects the last heading at the bottom of the page", () => {
		expect(selectActiveIndex(tops, 10_000)).toBe(4);
	});

	it("returns -1 when there are no headings", () => {
		expect(selectActiveIndex([], 100)).toBe(-1);
	});

	it("depends only on scroll position, not on any cursor state", () => {
		// Pure function of (tops, activationY): same inputs, same output —
		// this encodes the "scroll without moving the cursor" contract.
		const a = selectActiveIndex(tops, 620);
		const b = selectActiveIndex(tops, 620);
		expect(a).toBe(b);
		expect(a).toBe(3);
	});

	it("handles a single heading document", () => {
		expect(selectActiveIndex([100], 0)).toBe(0);
		expect(selectActiveIndex([100], 100)).toBe(0);
		expect(selectActiveIndex([100], 5000)).toBe(0);
	});
});
