import { describe, expect, it } from "vitest";
import {
	buildHeadingItems,
	normalizeHeadingText,
	sameHeadingKeys,
} from "../src/utils/headingIdentity";

describe("buildHeadingItems — displaySource", () => {
	it("keeps raw inline Markdown in displaySource while text is normalized", () => {
		const items = buildHeadingItems([
			{ level: 2, text: "**Bold**   heading ", line: 3 },
		]);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("**Bold** heading");
		expect(items[0].displaySource).toBe("**Bold**   heading");
	});

	it("keys stay stable when only line numbers change", () => {
		const a = buildHeadingItems([{ level: 1, text: "Intro", line: 0 }]);
		const b = buildHeadingItems([{ level: 1, text: "Intro", line: 42 }]);
		expect(sameHeadingKeys(a, b)).toBe(true);
	});

	it("duplicate headings get distinct occurrence keys", () => {
		const items = buildHeadingItems([
			{ level: 2, text: "Notes", line: 1 },
			{ level: 2, text: "Notes", line: 9 },
		]);
		expect(items[0].key).not.toBe(items[1].key);
	});

	it("drops headings whose normalized text is empty", () => {
		expect(buildHeadingItems([{ level: 1, text: "   ", line: 0 }])).toEqual([]);
	});
});

describe("normalizeHeadingText", () => {
	it("collapses whitespace and trims", () => {
		expect(normalizeHeadingText("  a\t b\n c  ")).toBe("a b c");
	});
});
