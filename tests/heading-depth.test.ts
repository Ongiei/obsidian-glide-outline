import { describe, expect, it } from "vitest";
import { setHeadingDepth } from "../src/utils/headingDepth";

describe("quick heading depth", () => {
	it.each([true, false])("shows H2 through the selected depth without changing H1=%s", h1 => {
		const levels = [h1, false, false, false, false, false];
		setHeadingDepth(levels, 3);
		expect(levels).toEqual([h1, true, true, false, false, false]);
		setHeadingDepth(levels, 6);
		expect(levels).toEqual([h1, true, true, true, true, true]);
		setHeadingDepth(levels, 2);
		expect(levels).toEqual([h1, true, false, false, false, false]);
	});
});
