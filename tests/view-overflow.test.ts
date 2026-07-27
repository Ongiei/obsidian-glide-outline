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
	heading(6, "Zeta", 15),
];

/** jsdom has no layout — fake the three scroll metrics the view reads. */
function mockScrollMetrics(
	el: HTMLElement,
	metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
	Object.defineProperty(el, "clientHeight", {
		configurable: true,
		value: metrics.clientHeight,
	});
	Object.defineProperty(el, "scrollHeight", {
		configurable: true,
		value: metrics.scrollHeight,
	});
	Object.defineProperty(el, "scrollTop", {
		configurable: true,
		writable: true,
		value: metrics.scrollTop,
	});
}

describe("GlideOutlineView placement & hierarchy variables", () => {
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

	it("writes the horizontal offset as a root CSS variable", () => {
		expect(
			view.rootEl.style.getPropertyValue("--glide-horizontal-offset"),
		).toBe("12px");
		settings.horizontalOffset = 40;
		view.applySettings();
		expect(
			view.rootEl.style.getPropertyValue("--glide-horizontal-offset"),
		).toBe("40px");
	});

	it("indents each item by (level - 1) × levelIndent", () => {
		settings.levelIndent = 3;
		view.applySettings();
		const indents = [...view.listEl.querySelectorAll<HTMLElement>(
			"button.glide-outline-item",
		)].map((el) => el.style.getPropertyValue("--glide-level-indent"));
		// H1 → 0, H2 → 3, H3 → 6, H6 → 15.
		expect(indents).toEqual(["0px", "3px", "6px", "15px"]);
	});

	it("collapses the staircase when levelIndent is 0", () => {
		settings.levelIndent = 0;
		view.applySettings();
		for (const el of view.listEl.querySelectorAll<HTMLElement>(
			"button.glide-outline-item",
		)) {
			expect(el.style.getPropertyValue("--glide-level-indent")).toBe("0px");
		}
	});

	it("applies the text shadow class and variable only when enabled", () => {
		expect(
			view.rootEl.classList.contains("glide-outline-root--text-shadow"),
		).toBe(false);
		expect(view.rootEl.style.getPropertyValue("--glide-text-shadow")).toBe(
			"none",
		);

		settings.card.textShadow = {
			enabled: true,
			color: "#000000",
			opacity: 55,
			blur: 4,
			offsetX: 0,
			offsetY: 1,
		};
		view.applySettings();
		expect(
			view.rootEl.classList.contains("glide-outline-root--text-shadow"),
		).toBe(true);
		expect(view.rootEl.style.getPropertyValue("--glide-text-shadow")).toBe(
			"0px 1px 4px rgba(0, 0, 0, 0.55)",
		);
	});

	it("toggles the edge fade feature class from settings", () => {
		expect(
			view.rootEl.classList.contains("glide-outline-root--edge-fade"),
		).toBe(true);
		expect(view.rootEl.style.getPropertyValue("--glide-edge-fade-size")).toBe(
			"28px",
		);
		settings.edgeFadeEnabled = false;
		settings.edgeFadeSize = 40;
		view.applySettings();
		expect(
			view.rootEl.classList.contains("glide-outline-root--edge-fade"),
		).toBe(false);
		expect(view.rootEl.style.getPropertyValue("--glide-edge-fade-size")).toBe(
			"40px",
		);
	});
});

describe("GlideOutlineView overflow state & fade classes", () => {
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

	it("shows no fades when the list fits", () => {
		mockScrollMetrics(view.viewportEl, {
			scrollTop: 0,
			clientHeight: 400,
			scrollHeight: 400,
		});
		view.updateOverflowState();
		expect(view.getOverflowState().hasOverflow).toBe(false);
		expect(view.rootEl.classList.contains("glide-outline-root--fade-top")).toBe(false);
		expect(view.rootEl.classList.contains("glide-outline-root--fade-bottom")).toBe(false);
	});

	it("shows only the bottom fade at the top of an overflowing list", () => {
		mockScrollMetrics(view.viewportEl, {
			scrollTop: 0,
			clientHeight: 400,
			scrollHeight: 900,
		});
		view.updateOverflowState();
		expect(view.rootEl.classList.contains("glide-outline-root--fade-top")).toBe(false);
		expect(view.rootEl.classList.contains("glide-outline-root--fade-bottom")).toBe(true);
	});

	it("shows both fades in the middle", () => {
		mockScrollMetrics(view.viewportEl, {
			scrollTop: 250,
			clientHeight: 400,
			scrollHeight: 900,
		});
		view.updateOverflowState();
		expect(view.rootEl.classList.contains("glide-outline-root--fade-top")).toBe(true);
		expect(view.rootEl.classList.contains("glide-outline-root--fade-bottom")).toBe(true);
	});

	it("shows only the top fade at the bottom", () => {
		mockScrollMetrics(view.viewportEl, {
			scrollTop: 500,
			clientHeight: 400,
			scrollHeight: 900,
		});
		view.updateOverflowState();
		expect(view.rootEl.classList.contains("glide-outline-root--fade-top")).toBe(true);
		expect(view.rootEl.classList.contains("glide-outline-root--fade-bottom")).toBe(false);
	});

	it("re-evaluates the fades on viewport scroll events", () => {
		mockScrollMetrics(view.viewportEl, {
			scrollTop: 0,
			clientHeight: 400,
			scrollHeight: 900,
		});
		view.viewportEl.dispatchEvent(new Event("scroll"));
		expect(view.rootEl.classList.contains("glide-outline-root--fade-bottom")).toBe(true);

		(view.viewportEl as unknown as { scrollTop: number }).scrollTop = 500;
		view.viewportEl.dispatchEvent(new Event("scroll"));
		expect(view.rootEl.classList.contains("glide-outline-root--fade-bottom")).toBe(false);
		expect(view.rootEl.classList.contains("glide-outline-root--fade-top")).toBe(true);
	});

	it("exposes the overflow state to the auto-scroll controller", () => {
		mockScrollMetrics(view.viewportEl, {
			scrollTop: 250,
			clientHeight: 400,
			scrollHeight: 900,
		});
		view.updateOverflowState();
		expect(view.getOverflowState()).toEqual({
			hasOverflow: true,
			canScrollUp: true,
			canScrollDown: true,
		});
	});

	it("stops reacting after dispose", () => {
		view.dispose();
		expect(() => view.updateOverflowState()).not.toThrow();
	});
});
