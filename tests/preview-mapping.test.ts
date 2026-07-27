// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import {
	matchPreviewHeadings,
	readPreviewSourceLine,
} from "../src/utils/previewHeadings";

function heading(
	level: number,
	text: string,
	line: number,
	occurrence = 0,
): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${occurrence}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

interface DomHeadingSpec {
	tag: string;
	text: string;
	line?: number;
	/** Wrap in an embed / callout container (should be excluded). */
	wrapIn?: string;
}

/** Build a minimal Reading Mode DOM: preview → sizer → headings. */
function buildPreview(specs: DomHeadingSpec[]): HTMLElement {
	const preview = document.createElement("div");
	preview.className = "markdown-preview-view";
	const sizer = document.createElement("div");
	sizer.className = "markdown-preview-sizer";
	preview.appendChild(sizer);
	for (const spec of specs) {
		const section = document.createElement("div");
		if (spec.line !== undefined) section.dataset.line = String(spec.line);
		const el = document.createElement(spec.tag);
		el.textContent = spec.text;
		(el as HTMLElement).dataset.heading = spec.text;
		if (spec.wrapIn) {
			const wrapper = document.createElement("div");
			wrapper.className = spec.wrapIn;
			wrapper.appendChild(el);
			section.appendChild(wrapper);
		} else {
			section.appendChild(el);
		}
		sizer.appendChild(section);
	}
	return preview;
}

describe("readPreviewSourceLine (P0-4)", () => {
	it("reads data-line from the element itself first", () => {
		const el = document.createElement("h2");
		el.dataset.line = "7";
		expect(readPreviewSourceLine(el)).toBe(7);
	});

	it("walks up to the wrapping section for data-line", () => {
		const preview = buildPreview([{ tag: "h2", text: "A", line: 12 }]);
		const el = preview.querySelector<HTMLElement>("h2");
		expect(el).not.toBeNull();
		expect(readPreviewSourceLine(el as HTMLElement)).toBe(12);
	});

	it("returns null when no line info exists", () => {
		const preview = buildPreview([{ tag: "h2", text: "A" }]);
		const el = preview.querySelector<HTMLElement>("h2");
		expect(readPreviewSourceLine(el as HTMLElement)).toBeNull();
	});

	it("rejects garbage values", () => {
		const el = document.createElement("h2");
		el.dataset.line = "banana";
		expect(readPreviewSourceLine(el)).toBeNull();
		el.dataset.line = "-4";
		expect(readPreviewSourceLine(el)).toBeNull();
	});
});

describe("matchPreviewHeadings (P0-4)", () => {
	it("matches by source line when data-line is present", () => {
		const items = [heading(1, "Alpha", 0), heading(2, "Beta", 5)];
		const preview = buildPreview([
			{ tag: "h1", text: "Alpha", line: 0 },
			{ tag: "h2", text: "Beta", line: 5 },
		]);
		const matches = matchPreviewHeadings(preview, items);
		expect(matches.map((m) => m.modelIndex)).toEqual([0, 1]);
		expect(matches.every((m) => m.matchedBy === "line")).toBe(true);
	});

	it("maps repeated titles to the RIGHT copies (occurrence-aware)", () => {
		// Two "Notes" headings at the same level, no line info in the DOM.
		const items = [
			heading(2, "Notes", 2, 0),
			heading(2, "Summary", 6),
			heading(2, "Notes", 10, 1),
		];
		const preview = buildPreview([
			{ tag: "h2", text: "Notes" },
			{ tag: "h2", text: "Summary" },
			{ tag: "h2", text: "Notes" },
		]);
		const matches = matchPreviewHeadings(preview, items);
		expect(matches.map((m) => m.modelIndex)).toEqual([0, 1, 2]);
		expect(matches.every((m) => m.matchedBy === "occurrence")).toBe(true);
		// The SECOND DOM "Notes" is bound to the SECOND model "Notes".
		const second = matches[2];
		expect(second.element).toBe(
			preview.querySelectorAll("h2")[2] as HTMLElement,
		);
	});

	it("excludes headings inside embeds and callouts", () => {
		const items = [heading(1, "Doc", 0), heading(2, "Own", 4)];
		const preview = buildPreview([
			{ tag: "h1", text: "Doc", line: 0 },
			// Same text as a model heading, but inside an embed — noise.
			{ tag: "h2", text: "Own", wrapIn: "markdown-embed" },
			{ tag: "h2", text: "Own", wrapIn: "callout" },
			{ tag: "h2", text: "Own", line: 4 },
		]);
		const matches = matchPreviewHeadings(preview, items);
		expect(matches).toHaveLength(2);
		expect(matches[1].modelIndex).toBe(1);
		expect(matches[1].matchedBy).toBe("line");
		// The matched element is the real one, not the embedded copies.
		expect(matches[1].element.closest(".markdown-embed, .callout")).toBeNull();
	});

	it("keeps occurrence counting aligned when some copies line-match", () => {
		// First "Notes" carries line info, second does not: the second
		// must still fall back to model occurrence #1, not #0.
		const items = [heading(2, "Notes", 2, 0), heading(2, "Notes", 9, 1)];
		const preview = buildPreview([
			{ tag: "h2", text: "Notes", line: 2 },
			{ tag: "h2", text: "Notes" },
		]);
		const matches = matchPreviewHeadings(preview, items);
		expect(matches.map((m) => m.modelIndex)).toEqual([0, 1]);
		expect(matches[0].matchedBy).toBe("line");
		expect(matches[1].matchedBy).toBe("occurrence");
	});

	it("tolerates virtualization holes (missing elements)", () => {
		const items = [
			heading(1, "Alpha", 0),
			heading(2, "Beta", 5),
			heading(2, "Gamma", 9),
		];
		// Beta is not rendered.
		const preview = buildPreview([
			{ tag: "h1", text: "Alpha", line: 0 },
			{ tag: "h2", text: "Gamma", line: 9 },
		]);
		const matches = matchPreviewHeadings(preview, items);
		expect(matches.map((m) => m.modelIndex)).toEqual([0, 2]);
	});

	it("never matches across levels", () => {
		const items = [heading(2, "Title", 3)];
		// Same text and line but rendered as h3 → level mismatch.
		const preview = buildPreview([{ tag: "h3", text: "Title", line: 3 }]);
		expect(matchPreviewHeadings(preview, items)).toHaveLength(0);
	});
});
