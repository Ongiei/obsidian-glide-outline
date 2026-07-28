// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import { MagnificationController } from "../src/ui/MagnificationController";

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
];

/**
 * The hover corridor has two halves:
 *  1. CSS — `.glide-outline-motion` becomes pointer-interactive while the
 *     outline is expanded, so the blank marker→card gap and the card's
 *     transparent padding keep the hover alive (asserted in
 *     appearance-css.test.ts).
 *  2. Controller — pointerleave events whose relatedTarget is still
 *     inside the outline root are ignored, and true exits get a collapse
 *     grace period. That half lives here.
 */
describe("hover corridor (controller half)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.stubGlobal("requestAnimationFrame", () => 1);
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		vi.stubGlobal(
			"matchMedia",
			() =>
				({
					matches: false,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				}) as unknown as MediaQueryList,
		);
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			},
		);

		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);
		controller = new MagnificationController(view, () => settings);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	function enter(): void {
		view.hitZoneEl.dispatchEvent(
			new MouseEvent("pointerenter", { clientY: 200, bubbles: true }),
		);
	}

	function leaveTo(target: Element | null): void {
		const ev = new MouseEvent("pointerleave", {
			clientY: 200,
			bubbles: true,
		});
		Object.defineProperty(ev, "relatedTarget", { value: target });
		view.hitZoneEl.dispatchEvent(ev);
	}

	it("expands on pointerenter", () => {
		enter();
		expect(view.isExpanded()).toBe(true);
	});

	it("ignores pointerleave when moving onto another outline element", () => {
		enter();
		// Crossing from the rail strip onto a card (blank gap in between):
		// relatedTarget is inside the root → no collapse, not even a timer.
		const card = view.listEl.querySelector(".glide-outline-card");
		leaveTo(card);
		vi.advanceTimersByTime(1000);
		expect(view.isExpanded()).toBe(true);
	});

	it("keeps the outline expanded through the collapse grace period", () => {
		enter();
		leaveTo(document.body); // a true exit
		// Still expanded immediately — the grace period absorbs accidental
		// exits across transparent areas.
		expect(view.isExpanded()).toBe(true);
		vi.advanceTimersByTime(60); // < COLLAPSE_GRACE_MS (100)
		expect(view.isExpanded()).toBe(true);
	});

	it("collapses only after the grace period on a true exit", () => {
		enter();
		leaveTo(document.body);
		vi.advanceTimersByTime(300);
		expect(view.isExpanded()).toBe(false);
	});

	it("re-entering during the grace period cancels the collapse", () => {
		enter();
		leaveTo(document.body);
		vi.advanceTimersByTime(60);
		enter(); // back inside before the timer fires
		vi.advanceTimersByTime(1000);
		expect(view.isExpanded()).toBe(true);
	});
});
