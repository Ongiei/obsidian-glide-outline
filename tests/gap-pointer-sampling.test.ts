// @vitest-environment jsdom
//
// §十 Transparent-gap pointer sampling.
//
// The outline is not a solid surface. Between two magnified cards, and in
// the corridor between a marker and its card, there is nothing under the
// pointer — those moves reach the WINDOW listener only. The old code used
// the window listener purely to decide "did the pointer leave?", and never
// fed the velocity ring from it. A flick that crossed a gap therefore
// starved the ring mid-gesture: `velocityY` decayed toward 0 and the
// pointer-follow assist visibly stuttered.
//
// Worse, `pointerenter` re-fires when the pointer lands on the next card,
// and the handler unconditionally cleared the ring — so the gesture was
// wiped precisely when it resumed.
//
// These tests pin both halves of the fix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerfCapture } from "../src/core/PerfCapture";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import { MagnificationController } from "../src/ui/MagnificationController";
import type { PointerEnvelope } from "../src/utils/envelope";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: 12 }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

/** A measurable stub envelope: one tall card column, zero rail. The whole
 * column counts as "inside", which is what a transparent gap between two
 * magnified neighbours looks like geometrically. */
const STUB_ENVELOPE: PointerEnvelope = {
	railRect: { left: 0, top: 0, right: 0, bottom: 0 },
	items: [
		{
			key: HEADINGS[0].key,
			markerRect: { left: 10, top: 0, right: 40, bottom: 600 },
			cardRect: { left: 40, top: 0, right: 200, bottom: 600 },
			bridgeRect: { left: 1, top: 0, right: 209, bottom: 600 },
		},
	],
};
const GAP_X = 60;
const OUTSIDE = { x: 900, y: 900 };

describe("§十 transparent-gap pointer sampling", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let perf: PerfCapture;
	let rafQueue: FrameRequestCallback[];

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function settle(maxFrames = 40): void {
		for (let i = 0; i < maxFrames && rafQueue.length > 0; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
		}
	}

	/**
	 * jsdom stamps events from its own real-time clock, which does not move
	 * with the faked `performance` and does not even tick within a
	 * millisecond — every event in a synchronous burst would share a
	 * timeStamp and be swallowed by the controller's (pointerId:timeStamp)
	 * dedup. Pin the stamp to the faked clock so the sample stream is
	 * deterministic and matches what a real device produces.
	 */
	function pointerEvent(type: string, clientX: number, clientY: number): Event {
		const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
		Object.defineProperty(event, "timeStamp", {
			value: performance.now(),
			configurable: true,
		});
		Object.defineProperty(event, "pointerId", {
			value: 1,
			configurable: true,
		});
		return event;
	}

	function elementPointer(type: string, clientX: number, clientY: number): void {
		view.hitZoneEl.dispatchEvent(pointerEvent(type, clientX, clientY));
	}

	/** A move over a transparent gap: no outline element is the target, so
	 * only the window listener sees it. */
	function gapPointer(clientX: number, clientY: number): void {
		window.dispatchEvent(pointerEvent("pointermove", clientX, clientY));
	}

	function follow(): {
		pointerSampleCount: number;
		currentPointerVelocityY: number;
		predictedPointerY: number;
	} {
		const report = perf.stop(window as Window & typeof globalThis)!;
		expect(report.pointerFollow).not.toBeNull();
		return report.pointerFollow!;
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
		view.collectEnvelope = () => structuredClone(STUB_ENVELOPE);
		perf = new PerfCapture();
		perf.start(window as Window & typeof globalThis);
		controller = new MagnificationController(
			view,
			() => settings,
			null,
			null,
			perf,
		);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	it("feeds the velocity ring from moves inside the envelope", () => {
		elementPointer("pointerenter", GAP_X, 100);
		settle();
		// A downward flick that never touches an outline element again.
		for (let i = 1; i <= 5; i++) {
			vi.advanceTimersByTime(10);
			gapPointer(GAP_X, 100 + i * 24);
			flushFrame();
		}
		const echo = follow();
		expect(echo.pointerSampleCount).toBeGreaterThanOrEqual(2);
		expect(echo.currentPointerVelocityY).toBeGreaterThan(0);
		// The prediction leads the last sampled position.
		expect(echo.predictedPointerY).toBeGreaterThan(100 + 5 * 24);
	});

	it("discards samples from moves that genuinely left the envelope", () => {
		elementPointer("pointerenter", GAP_X, 100);
		settle();
		for (let i = 1; i <= 5; i++) {
			vi.advanceTimersByTime(10);
			gapPointer(OUTSIDE.x, OUTSIDE.y + i * 24);
			flushFrame();
		}
		const echo = follow();
		// Leaving resets the whole gesture — nothing carried over.
		expect(echo.pointerSampleCount).toBe(0);
		expect(echo.currentPointerVelocityY).toBe(0);
	});

	it("re-entering from a gap does NOT wipe the gesture", () => {
		elementPointer("pointerenter", GAP_X, 100);
		elementPointer("pointermove", GAP_X, 100);
		// Glide off the card into the transparent gap…
		for (let i = 1; i <= 3; i++) {
			vi.advanceTimersByTime(10);
			gapPointer(GAP_X, 100 + i * 24);
			flushFrame();
		}
		const midFlight = perf.stop(window as Window & typeof globalThis)!
			.pointerFollow!;
		expect(midFlight.pointerSampleCount).toBeGreaterThanOrEqual(2);

		// …and land on the next card. `pointerenter` fires again.
		perf.start(window as Window & typeof globalThis);
		vi.advanceTimersByTime(10);
		elementPointer("pointerenter", GAP_X, 100 + 4 * 24);
		flushFrame();
		const afterReentry = follow();
		// The ring kept its history: the gesture continues seamlessly.
		expect(afterReentry.pointerSampleCount).toBeGreaterThanOrEqual(2);
		expect(afterReentry.currentPointerVelocityY).toBeGreaterThan(0);
	});

	it("a genuinely fresh visit still starts from a clean ring", () => {
		elementPointer("pointerenter", GAP_X, 100);
		for (let i = 1; i <= 4; i++) {
			vi.advanceTimersByTime(10);
			elementPointer("pointermove", GAP_X, 100 + i * 24);
		}
		flushFrame();
		// Leave for real, wait out the collapse, then come back.
		elementPointer("pointerleave", OUTSIDE.x, OUTSIDE.y);
		vi.advanceTimersByTime(400);
		settle();
		perf.start(window as Window & typeof globalThis);
		vi.advanceTimersByTime(10);
		elementPointer("pointerenter", GAP_X, 100);
		flushFrame();
		const echo = follow();
		expect(echo.pointerSampleCount).toBeLessThanOrEqual(1);
		expect(echo.currentPointerVelocityY).toBe(0);
	});

	it("keeps the window handler free of DOM reads and writes", () => {
		elementPointer("pointerenter", GAP_X, 100);
		settle();
		const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
		const styleSpy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
		for (let i = 1; i <= 10; i++) {
			vi.advanceTimersByTime(4);
			gapPointer(GAP_X, 100 + i * 8);
		}
		// Parking the sample must stay pure input work — the ring is fed
		// from the frame, not from the listener.
		expect(rectSpy).not.toHaveBeenCalled();
		expect(styleSpy).not.toHaveBeenCalled();
		rectSpy.mockRestore();
		styleSpy.mockRestore();
	});
});
