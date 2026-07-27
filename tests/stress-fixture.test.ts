import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkdownHeadings } from "../src/core/HeadingProvider";
import { buildHeadingItems } from "../src/utils/headingIdentity";

/**
 * The stress fixture is a REAL, readable manual — these tests pin down the
 * structural properties the visual stress test relies on, so future edits
 * to the fixture cannot silently destroy its coverage.
 */
const fixture = readFileSync(
	resolve(process.cwd(), "tests/fixtures/glide-outline-stress-test.md"),
	"utf8",
);
const headings = parseMarkdownHeadings(fixture);

describe("stress fixture structure", () => {
	it("contains at least 100 headings", () => {
		expect(headings.length).toBeGreaterThanOrEqual(100);
	});

	it("covers every level H1–H6", () => {
		const levels = new Set(headings.map((h) => h.level));
		for (let level = 1; level <= 6; level++) {
			expect(levels.has(level)).toBe(true);
		}
	});

	it("keeps fake headings inside fenced code blocks OUT of the outline", () => {
		const texts = headings.map((h) => h.text);
		expect(texts).not.toContain("这不是标题，只是注释");
		expect(texts).not.toContain("this is not a heading either");
		expect(texts).not.toContain("依然不是标题");
		expect(texts).not.toContain("波浪线围栏里的伪标题");
		expect(texts).not.toContain("也不应该出现在大纲里");
	});

	it("parses the Setext H1/H2 headings", () => {
		expect(
			headings.some((h) => h.level === 1 && h.text === "架构总览"),
		).toBe(true);
		expect(
			headings.some((h) => h.level === 2 && h.text === "数据平面"),
		).toBe(true);
	});

	it("repeats the same heading text three times at the same level", () => {
		const faq = headings.filter(
			(h) => h.text === "常见问题" && h.level === 3,
		);
		expect(faq).toHaveLength(3);
	});

	it("uses the same text at two different levels", () => {
		const levels = headings
			.filter((h) => h.text === "监控")
			.map((h) => h.level)
			.sort();
		expect(levels).toEqual([2, 4]);
	});

	it("starts and ends with very long titles (edge magnification cases)", () => {
		expect(headings[0].level).toBe(1);
		expect(headings[0].text.length).toBeGreaterThan(40);
		const last = headings[headings.length - 1];
		expect(last.text.length).toBeGreaterThan(40);
	});

	it("contains a space-less overlong token that cannot soft-wrap", () => {
		const token = headings.find((h) =>
			h.text.includes("Supercalifragilisticexpialidocious"),
		);
		expect(token).toBeDefined();
		// The no-space part must be long enough to overflow any card width.
		expect(token?.text.replace(/\s/g, "").length).toBeGreaterThan(80);
	});

	it("contains a long English title WITH spaces (soft-wrap case)", () => {
		expect(
			headings.some(
				(h) => /[a-zA-Z]/.test(h.text) && h.text.includes(" ") && h.text.length > 60,
			),
		).toBe(true);
	});

	it("keeps inline markdown in heading sources", () => {
		expect(headings.some((h) => h.text.includes("**"))).toBe(true);
		expect(headings.some((h) => h.text.includes("`"))).toBe(true);
	});

	it("assigns a unique stable key to every heading (duplicates included)", () => {
		const items = buildHeadingItems(
			headings.map((h) => ({ level: h.level, text: h.text, line: h.line })),
		);
		const keys = new Set(items.map((item) => item.key));
		expect(keys.size).toBe(items.length);
	});

	it("is long enough to overflow any realistic outline viewport", () => {
		// 100+ rows × ~24 px ≫ any laptop viewport — guaranteed edge fades
		// and auto-scroll coverage in manual testing.
		expect(fixture.split("\n").length).toBeGreaterThan(400);
	});

	it("contains a run of 8+ consecutive same-level headings", () => {
		// Badge column alignment + steady auto-scroll need a long uniform
		// stretch (附录 L 值班速查卡).
		let best = 0;
		let run = 0;
		let prev = 0;
		for (const h of headings) {
			run = h.level === prev ? run + 1 : 1;
			prev = h.level;
			best = Math.max(best, run);
		}
		expect(best).toBeGreaterThanOrEqual(8);
	});

	it("contains a level jump of 3+ (badge must not show intermediate levels)", () => {
		// 附录 M jumps H2 → H5 directly.
		let maxJump = 0;
		for (let i = 1; i < headings.length; i++) {
			maxJump = Math.max(maxJump, headings[i].level - headings[i - 1].level);
		}
		expect(maxJump).toBeGreaterThanOrEqual(3);
	});
});
