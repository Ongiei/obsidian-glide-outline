// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A measurable stub envelope: one generous card box + zero rail. */
const STUB_ENVELOPE: PointerEnvelope = {
	railRect: { left: 0, top: 0, right: 0, bottom: 0 },
	items: [
		{
			key: HEADINGS[0].key,
			markerRect: { left: 10, top: 10, right: 40, bottom: 50 },
			cardRect: { left: 40, top: 10, right: 200, bottom: 50 },
			bridgeRect: { left: 1, top: 5, right: 209, bottom: 55 },
		},
	],
};
const INSIDE = { x: 60, y: 30 };
const OUTSIDE = { x: 500, y: 400 };

describe("MagnificationController pointer hot path (sections 4/5/7)", () => {
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

	function settle(): void {
		for (let i = 0; i < 40 && rafQueue.length > 0; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
		}
	}

	function pointer(type: string, clientX: number, clientY: number): void {
		view.hitZoneEl.dispatchEvent(
			new MouseEvent(type, { clientX, clientY, bubbles: true }),
		);
	}

	function windowPointer(clientX: number, clientY: number): void {
		window.dispatchEvent(
			new MouseEvent("pointermove", { clientX, clientY, bubbles: true }),
		);
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
		// Measurable envelope regardless of jsdom's zero-rect layout.
		view.collectEnvelope = () => structuredClone(STUB_ENVELOPE);
		controller = new MagnificationController(view, () => settings);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	it("coalesces many pointermoves into a single scheduled frame", () => {
		pointer("pointerenter", INSIDE.x, INSIDE.y);
		settle(); // settle enter/measure work
		expect(rafQueue.length).toBe(0);
		for (let i = 0; i < 25; i++) {
			pointer("pointermove", INSIDE.x, INSIDE.y + i);
		}
		expect(rafQueue.length).toBe(1); // exactly ONE frame pending
	});

	it("pointermove handlers perform ZERO DOM reads and ZERO style writes", () => {
		pointer("pointerenter", INSIDE.x, INSIDE.y);
		settle();
		const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
		const styleSpy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
		const querySpy = vi.spyOn(Element.prototype, "querySelector");
		for (let i = 0; i < 10; i++) {
			pointer("pointermove", INSIDE.x + i, INSIDE.y + i);
			windowPointer(INSIDE.x + i, INSIDE.y + i);
		}
		expect(rectSpy).not.toHaveBeenCalled();
		expect(styleSpy).not.toHaveBeenCalled();
		expect(querySpy).not.toHaveBeenCalled();
		rectSpy.mockRestore();
		styleSpy.mockRestore();
		querySpy.mockRestore();
	});

	it("window pointermove INSIDE the envelope cancels a pending collapse (section 7)", () => {
		pointer("pointerenter", INSIDE.x, INSIDE.y);
		settle();
		expect(view.isExpanded()).toBe(true);
		// Leave to a point outside the envelope → collapse grace armed.
		pointer("pointerleave", OUTSIDE.x, OUTSIDE.y);
		// Pointer wanders back INSIDE the envelope via a transparent gap:
		// only the window listener sees it.
		windowPointer(INSIDE.x, INSIDE.y);
		flushFrame(); // deferred containment test runs in the frame
		vi.advanceTimersByTime(400); // well past the collapse grace
		settle();
		expect(view.isExpanded()).toBe(true); // stayed open
	});

	it("window pointermove OUTSIDE the envelope arms the collapse", () => {
		pointer("pointerenter", INSIDE.x, INSIDE.y);
		settle();
		expect(view.isExpanded()).toBe(true);
		windowPointer(OUTSIDE.x, OUTSIDE.y);
		flushFrame();
		vi.advanceTimersByTime(400);
		settle();
		expect(view.isExpanded()).toBe(false); // collapsed
	});

	it("a plain leave outside the envelope still collapses after the grace", () => {
		pointer("pointerenter", INSIDE.x, INSIDE.y);
		settle();
		pointer("pointerleave", OUTSIDE.x, OUTSIDE.y);
		vi.advanceTimersByTime(400);
		settle();
		expect(view.isExpanded()).toBe(false);
	});
});
