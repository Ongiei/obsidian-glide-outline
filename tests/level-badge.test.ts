// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
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
	heading(4, "Delta", 15),
	heading(5, "Epsilon", 20),
	heading(6, "Zeta", 25),
];

describe("edge level badge", () => {
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

	it("renders one badge per item with the heading level text", () => {
		const badges = [
			...view.listEl.querySelectorAll<HTMLElement>(
				".glide-outline-level-badge",
			),
		];
		expect(badges).toHaveLength(6);
		expect(badges.map((el) => el.textContent)).toEqual([
			"H1",
			"H2",
			"H3",
			"H4",
			"H5",
			"H6",
		]);
	});

	it("places the badge inside the card, before the label (rail side)", () => {
		const card = view.listEl.querySelector<HTMLElement>(
			".glide-outline-card",
		);
		expect(card).not.toBeNull();
		const children = [...(card as HTMLElement).children];
		expect(children[0].classList.contains("glide-outline-level-badge")).toBe(
			true,
		);
		expect(children[1].classList.contains("glide-outline-label")).toBe(true);
	});

	it("hides the badge from the accessibility tree", () => {
		const badge = view.listEl.querySelector<HTMLElement>(
			".glide-outline-level-badge",
		);
		expect(badge?.getAttribute("aria-hidden")).toBe("true");
	});

	it("keeps hierarchy readable for screen readers via aria-labelledby", () => {
		const button = view.listEl.querySelector<HTMLElement>(
			"button.glide-outline-item",
		);
		// The accessible name lives in a sr-only span referenced by
		// aria-labelledby (NOT aria-label, which Obsidian renders as a
		// hover tooltip that duplicated the magnified card text).
		const labelId = button?.getAttribute("aria-labelledby");
		expect(labelId).toBeTruthy();
		const a11y = labelId
			? view.rootEl.querySelector<HTMLElement>(`#${labelId}`)
			: null;
		expect(a11y?.textContent).toBe("H1: Alpha");
	});

	it("toggles the feature class from levelIndicatorStyle", () => {
		expect(
			view.rootEl.classList.contains("glide-outline-root--level-badge"),
		).toBe(true); // default is "badge"

		settings.levelIndicatorStyle = "none";
		view.applySettings();
		expect(
			view.rootEl.classList.contains("glide-outline-root--level-badge"),
		).toBe(false);

		settings.levelIndicatorStyle = "badge";
		view.applySettings();
		expect(
			view.rootEl.classList.contains("glide-outline-root--level-badge"),
		).toBe(true);
	});

	it("updates the badge text when a heading changes level", () => {
		view.setItems([heading(4, "Alpha", 0)]);
		const badge = view.listEl.querySelector<HTMLElement>(
			".glide-outline-level-badge",
		);
		expect(badge?.textContent).toBe("H4");
	});

	it("ships zero indent by default — the badge replaces the staircase", () => {
		for (const el of view.listEl.querySelectorAll<HTMLElement>(
			"button.glide-outline-item",
		)) {
			expect(el.style.getPropertyValue("--glide-level-indent")).toBe("0px");
		}
	});
});
