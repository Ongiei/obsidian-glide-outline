// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::0`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = [
	heading(1, "Alpha", 0),
	heading(2, "Beta", 5),
	heading(3, "Gamma", 10),
];

describe("GlideOutlineView DOM structure (single visual card)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);
	});

	it("renders exactly ONE .glide-outline-card per heading", () => {
		const rows = view.listEl.querySelectorAll(".glide-outline-row");
		expect(rows.length).toBe(3);
		for (const row of rows) {
			expect(row.querySelectorAll(".glide-outline-card").length).toBe(1);
		}
	});

	it("gives no card class to row, item, motion or reveal", () => {
		for (const selector of [
			".glide-outline-row",
			".glide-outline-item",
			".glide-outline-motion",
			".glide-outline-reveal",
		]) {
			for (const el of view.listEl.querySelectorAll(selector)) {
				expect(el.classList.contains("glide-outline-card")).toBe(false);
			}
		}
	});

	it("nests marker and card inside the SAME motion container", () => {
		for (const row of view.listEl.querySelectorAll(".glide-outline-row")) {
			const motion = row.querySelector(".glide-outline-motion");
			expect(motion).not.toBeNull();
			// Both marker and card are descendants of the shared motion layer,
			// so --glide-shift-y moves them together (no desync possible).
			expect(motion?.querySelector(".glide-outline-marker")).not.toBeNull();
			expect(motion?.querySelector(".glide-outline-card")).not.toBeNull();
		}
	});

	it("uses a native button as the item with type=button", () => {
		const buttons = view.listEl.querySelectorAll("button.glide-outline-item");
		expect(buttons.length).toBe(3);
		for (const button of buttons) {
			expect(button.getAttribute("type")).toBe("button");
			expect(button.getAttribute("aria-label")).toMatch(/^H\d: /);
		}
	});

	it("carries the heading key on the row for the magnification cache", () => {
		const rows = [...view.listEl.querySelectorAll<HTMLElement>(".glide-outline-row")];
		expect(rows.map((row) => row.dataset.key)).toEqual(
			HEADINGS.map((item) => item.key),
		);
	});

	it("keeps DOM order marker → reveal inside motion (CSS flips sides)", () => {
		const motion = view.listEl.querySelector(".glide-outline-motion");
		const children = [...(motion?.children ?? [])];
		expect(children[0]?.classList.contains("glide-outline-marker")).toBe(true);
		expect(children[1]?.classList.contains("glide-outline-reveal")).toBe(true);
	});

	it("exposes measured base card heights (0 in jsdom, never negative)", () => {
		for (const item of HEADINGS) {
			expect(view.getBaseCardHeight(item.key)).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("styles.css regression (button reset / single card)", async () => {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	// jsdom rewrites import.meta.url to a non-file scheme; resolve from cwd
	// (vitest always runs from the project root).
	const css = await fs.readFile(
		path.resolve(process.cwd(), "styles.css"),
		"utf8",
	);

	/** Return the declaration block bodies of every rule whose selector matches. */
	function blocksFor(selectorPart: string): string[] {
		const blocks: string[] = [];
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(css)) !== null) {
			if (match[1].includes(selectorPart)) blocks.push(match[2]);
		}
		return blocks;
	}

	it("never uses width: 100% on the item button", () => {
		for (const block of blocksFor(".glide-outline-item")) {
			expect(block).not.toMatch(/width:\s*100%/);
		}
	});

	it("hard-resets the button with all: unset at high specificity", () => {
		expect(css).toMatch(
			/\.glide-outline-root button\.glide-outline-item\s*\{[^}]*all:\s*unset/,
		);
	});

	it("covers hover, active, focus and focus-visible in the reset", () => {
		for (const state of [":hover", ":active", ":focus", ":focus-visible"]) {
			expect(css).toContain(
				`.glide-outline-root button.glide-outline-item${state}`,
			);
		}
	});

	it("allows visible chrome ONLY on .glide-outline-card", () => {
		// Non-card structural layers must not declare a visible background,
		// border or box-shadow (only `none`/transparent resets are allowed).
		for (const selector of [
			".glide-outline-row",
			".glide-outline-motion",
			".glide-outline-reveal",
		]) {
			for (const block of blocksFor(selector)) {
				const decls = block
					.split(";")
					.map((decl) => decl.trim())
					.filter(Boolean);
				for (const decl of decls) {
					if (/^background(-color)?\s*:/.test(decl)) {
						expect(decl).toMatch(/none|transparent/);
					}
					if (/^border\s*:/.test(decl)) {
						expect(decl).toMatch(/none/);
					}
					if (/^box-shadow\s*:/.test(decl)) {
						expect(decl).toMatch(/none/);
					}
				}
			}
		}
	});

	it("keeps focus styling scoped to card and marker, not the button", () => {
		// The button's own focus states must not declare an outline ring.
		const buttonStates = css.match(
			/\.glide-outline-root button\.glide-outline-item:hover,[\s\S]*?\{([\s\S]*?)\}/,
		);
		expect(buttonStates?.[1]).toMatch(/outline:\s*none/);
		expect(css).toContain(
			".glide-outline-root button.glide-outline-item:focus-visible .glide-outline-card",
		);
		expect(css).toContain(
			".glide-outline-root button.glide-outline-item:focus-visible .glide-outline-marker::before",
		);
	});

	it("contains no !important declarations (comments excluded)", () => {
		const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(withoutComments).not.toContain("!important");
	});

	it("contains no :has selector (comments excluded)", () => {
		const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(withoutComments).not.toContain(":has(");
	});
});
