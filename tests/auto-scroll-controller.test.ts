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
		// pointerdown must land on a REAL marker/card to arm the activation
		// lock (blank space / drawing layers never lock or jump).
		const marker = view.rootEl.querySelector(
			".glide-outline-marker",
		) as HTMLElement;
		expect(marker).toBeTruthy();
		const down = new MouseEvent("pointerdown", { bubbles: true });
		Object.defineProperty(down, "pointerId", { value: 1 });
		marker.dispatchEvent(down);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(before); // locked

		const up = new MouseEvent("pointerup", { bubbles: true });
		Object.defineProperty(up, "pointerId", { value: 1 });
		marker.dispatchEvent(up);
		// Re-enter: releasing the press cleared the gesture; the resumed
		// auto-scroll still requires the pointer parked at the edge.
		pointer("pointermove", 495);
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

	/** Dispatch a pointer event with a deterministic timeStamp (px/s math). */
	function pointerAt(type: string, clientY: number, timeStamp: number): void {
		const ev = new MouseEvent(type, { clientY, bubbles: true });
		Object.defineProperty(ev, "timeStamp", { value: timeStamp });
		view.hitZoneEl.dispatchEvent(ev);
	}

	/** Advance the fake clock and run one RAF frame N times. */
	function runFrames(count: number): void {
		for (let i = 0; i < count; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
		}
	}

	it("velocity assist: a fast downward flick scrolls from the dead zone", () => {
		// Static hover at 380 (lower half but outside the pre-scroll zone):
		// no positional scrolling. The >200 ms gap counts as a new gesture,
		// so the reposition itself carries no velocity.
		pointerAt("pointerenter", 300, 0);
		pointerAt("pointermove", 380, 500);
		const before = view.viewportEl.scrollTop;
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBe(before);

		// A decisive downward flick ending at the same 380 must pre-scroll:
		// the headings come to meet the gesture.
		pointerAt("pointermove", 320, 200);
		pointerAt("pointermove", 340, 216);
		pointerAt("pointermove", 360, 232);
		pointerAt("pointermove", 380, 248);
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBeGreaterThan(before);
	});

	it("velocity assist decays after the flick stops (no runaway scrolling)", () => {
		pointerAt("pointerenter", 300, 0);
		pointerAt("pointermove", 320, 16);
		pointerAt("pointermove", 340, 32);
		pointerAt("pointermove", 360, 48);
		pointerAt("pointermove", 380, 64);
		runScrollFrames();
		expect(view.viewportEl.scrollTop).toBeGreaterThan(200);

		// No further pointer movement: the smoothed velocity decays and the
		// damped applied velocity returns to 0 — the list settles.
		runFrames(150);
		const settled = view.viewportEl.scrollTop;
		runFrames(5);
		expect(view.viewportEl.scrollTop).toBe(settled);
	});

	it("ramps continuously under the acceleration cap (no velocity jump)", () => {
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		const start = view.viewportEl.scrollTop;
		runScrollFrames(); // first frame with motion
		const firstDelta = view.viewportEl.scrollTop - start;
		// Accel cap 1400 px/s² × 16 ms → ≤ 22.4 px/s → ≤ ~0.36 px in the
		// first frame. Never an instant full-speed jump (320 px/s ≈ 5 px).
		expect(firstDelta).toBeGreaterThan(0);
		expect(firstDelta).toBeLessThan(1);

		// Each subsequent frame moves farther while the ramp builds.
		const deltas: number[] = [];
		let prev = view.viewportEl.scrollTop;
		for (let i = 0; i < 5; i++) {
			runFrames(1);
			deltas.push(view.viewportEl.scrollTop - prev);
			prev = view.viewportEl.scrollTop;
		}
		for (let i = 1; i < deltas.length; i++) {
			expect(deltas[i]).toBeGreaterThan(deltas[i - 1]);
		}
	});
});
