// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import {
	AUTO_SCROLL_DWELL_MS,
	MagnificationController,
} from "../src/ui/MagnificationController";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: 30 }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

const VIEWPORT_TOP = 100;
const VIEWPORT_BOTTOM = 500;

describe("MagnificationController pointer edge auto-scroll", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let rafQueue: FrameRequestCallback[];

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function pointer(type: string, clientY: number): void {
		view.hitZoneEl.dispatchEvent(
			new MouseEvent(type, { clientY, bubbles: true }),
		);
	}

	/** Arm the dwell gate and run one measured frame (~16 ms). */
	function runScrollFrames(): void {
		flushFrame(); // arms the dwell timer
		vi.advanceTimersByTime(AUTO_SCROLL_DWELL_MS + 10); // dwell passes
		flushFrame(); // establishes the time base (dt = 0)
		vi.advanceTimersByTime(16);
		flushFrame(); // dt ≈ 16 ms → applies velocity
	}

	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "performance"],
		});
		rafQueue = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
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

		// jsdom has no layout: fake the scroll metrics and viewport rect.
		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: VIEWPORT_BOTTOM - VIEWPORT_TOP,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: 1200,
		});
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			writable: true,
			value: 200,
		});
		view.viewportEl.getBoundingClientRect = () =>
			({
				top: VIEWPORT_TOP,
				bottom: VIEWPORT_BOTTOM,
				left: 0,
				right: 200,
				width: 200,
				height: VIEWPORT_BOTTOM - VIEWPORT_TOP,
				x: 0,
				y: VIEWPORT_TOP,
				toJSON: () => ({}),
			}) as DOMRect;
		view.updateOverflowState();

		controller = new MagnificationController(view, () => settings);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	it("scrolls down after the dwell delay when the pointer parks at the bottom edge", () => {
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBeGreaterThan(before);
	});

	it("scrolls up near the top edge", () => {
		pointer("pointerenter", 105);
		pointer("pointermove", 105);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBeLessThan(before);
	});

	it("does NOT move before the dwell delay has passed", () => {
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		const before = view.viewportEl.scrollTop;
		flushFrame(); // arms the dwell only
		vi.advanceTimersByTime(AUTO_SCROLL_DWELL_MS - 50);
		flushFrame();
		expect(view.viewportEl.scrollTop).toBe(before);
	});

	it("does not scroll while the pointer rests in the middle", () => {
		pointer("pointerenter", 300);
		pointer("pointermove", 300);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(before);
	});

	it("pauses while the pointer is held down and resumes on release", () => {
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		view.rootEl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(before); // locked

		view.rootEl.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBeGreaterThan(before); // resumed
	});

	it("stops immediately on pointerleave", () => {
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		runScrollFrames();
		const scrolled = view.viewportEl.scrollTop;

		pointer("pointerleave", 495);
		vi.advanceTimersByTime(500);
		flushFrame();
		expect(view.viewportEl.scrollTop).toBe(scrolled);
	});

	it("respects the pointerAutoScroll setting", () => {
		settings.pointerAutoScroll = false;
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(before);
	});

	it("respects reduced motion (animationEnabled off)", () => {
		settings.animationEnabled = false;
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(before);
	});

	it("stops at the dead end (bottom of the list)", () => {
		(view.viewportEl as unknown as { scrollTop: number }).scrollTop = 800; // 1200 - 400
		view.updateOverflowState();
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(800);
	});

	it("disposes cleanly with pending dwell timers", () => {
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		flushFrame(); // dwell armed
		expect(() => controller.dispose()).not.toThrow();
		expect(() => {
			vi.advanceTimersByTime(1000);
			flushFrame();
		}).not.toThrow();
	});
});
