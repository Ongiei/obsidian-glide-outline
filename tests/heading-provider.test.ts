import { describe, expect, it } from "vitest";
import { parseMarkdownHeadings } from "../src/core/HeadingProvider";
import {
	buildHeadingItems,
	normalizeHeadingText,
	sameHeadingKeys,
} from "../src/utils/headingIdentity";

describe("parseMarkdownHeadings", () => {
	it("parses ATX H1–H6", () => {
		const md = [
			"# One",
			"## Two",
			"### Three",
			"#### Four",
			"##### Five",
			"###### Six",
		].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result).toHaveLength(6);
		expect(result.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(result[0]).toEqual({ level: 1, text: "One", line: 0 });
		expect(result[5]).toEqual({ level: 6, text: "Six", line: 5 });
	});

	it("requires a space after the hashes", () => {
		expect(parseMarkdownHeadings("#NotAHeading")).toHaveLength(0);
		expect(parseMarkdownHeadings("####### seven hashes")).toHaveLength(0);
	});

	it("strips optional closing hashes", () => {
		const result = parseMarkdownHeadings("## Title ##");
		expect(result).toEqual([{ level: 2, text: "Title", line: 0 }]);
	});

	it("skips # lines inside fenced code blocks", () => {
		const md = [
			"# Real",
			"```",
			"# not a heading",
			"## also not",
			"```",
			"## Real too",
		].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result.map((h) => h.text)).toEqual(["Real", "Real too"]);
	});

	it("handles tilde fences and nested backtick fences", () => {
		const md = [
			"~~~",
			"# inside tilde",
			"```",
			"# still inside",
			"~~~",
			"# outside",
		].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result.map((h) => h.text)).toEqual(["outside"]);
	});

	it("requires closing fence to be at least as long as the opener", () => {
		const md = ["````", "```", "# still inside", "````", "# out"].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result.map((h) => h.text)).toEqual(["out"]);
	});

	it("keeps duplicate headings", () => {
		const md = ["# Intro", "# Intro", "## Intro"].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result).toHaveLength(3);
	});

	it("excludes empty headings", () => {
		expect(parseMarkdownHeadings("#")).toHaveLength(0);
		expect(parseMarkdownHeadings("#   ")).toHaveLength(0);
		expect(parseMarkdownHeadings("##  ##")).toHaveLength(0);
	});

	it("returns nothing for an empty document", () => {
		expect(parseMarkdownHeadings("")).toHaveLength(0);
		expect(parseMarkdownHeadings("\n\n\n")).toHaveLength(0);
	});

	it("reflects deleted and renamed headings", () => {
		const before = parseMarkdownHeadings("# A\n\n## B\n\n## C");
		expect(before.map((h) => h.text)).toEqual(["A", "B", "C"]);
		const afterDelete = parseMarkdownHeadings("# A\n\n## C");
		expect(afterDelete.map((h) => h.text)).toEqual(["A", "C"]);
		const afterRename = parseMarkdownHeadings("# A\n\n## B2\n\n## C");
		expect(afterRename.map((h) => h.text)).toEqual(["A", "B2", "C"]);
	});

	it("skips YAML frontmatter", () => {
		const md = ["---", "title: Doc", "---", "# First"].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result).toEqual([{ level: 1, text: "First", line: 3 }]);
	});

	it("parses Setext H1/H2", () => {
		const md = ["Title", "=====", "", "Subtitle", "---"].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result).toEqual([
			{ level: 1, text: "Title", line: 0 },
			{ level: 2, text: "Subtitle", line: 3 },
		]);
	});

	it("does not treat a thematic break after a blank line as Setext", () => {
		const md = ["Paragraph", "", "---", "", "# Real"].join("\n");
		const result = parseMarkdownHeadings(md);
		expect(result.map((h) => h.text)).toEqual(["Real"]);
	});
});

describe("stable heading identity", () => {
	const parse = (md: string) => buildHeadingItems(parseMarkdownHeadings(md));

	it("keeps identity when plain lines are inserted above", () => {
		const before = parse("# A\n## B");
		const after = parse("intro text\n\nmore text\n# A\n## B");
		expect(sameHeadingKeys(before, after)).toBe(true);
		// but line info follows the shift
		expect(after[0].line).toBe(3);
	});

	it("distinguishes duplicate headings by occurrence", () => {
		const items = parse("## Intro\n\n## Intro");
		expect(items[0].key).not.toBe(items[1].key);
		expect(items[0].key).toBe("2::Intro::0");
		expect(items[1].key).toBe("2::Intro::1");
	});

	it("updates identity when the heading text changes", () => {
		const before = parse("# Alpha");
		const after = parse("# Beta");
		expect(before[0].key).not.toBe(after[0].key);
	});

	it("updates identity when the level changes", () => {
		const before = parse("# Same");
		const after = parse("## Same");
		expect(before[0].key).not.toBe(after[0].key);
	});

	it("normalizes whitespace in heading text", () => {
		expect(normalizeHeadingText("  Hello \t world  ")).toBe("Hello world");
		const items = parse("#  Hello \t world ");
		expect(items[0].text).toBe("Hello world");
	});

	it("drops headings whose text normalizes to empty", () => {
		const items = buildHeadingItems([{ level: 2, text: "   ", line: 0 }]);
		expect(items).toHaveLength(0);
	});
});
