// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import {
	MagnificationController,
	MOTION_ACTIVE_CLASS,
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

const ROW_COUNT = 100;
const HEADINGS = Array.from({ length: ROW_COUNT }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);
const VIEWPORT_TOP = 100;
const VIEWPORT_BOTTOM = 500;
const ROW_TOP = (i: number): number => VIEWPORT_TOP + i * 30;
const ROW_HEIGHT = 28;

describe("MagnificationController DOM write budget (sections 10/14/15)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let rafQueue: FrameRequestCallback[];
	let rows: HTMLElement[];

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function runFrames(count: number): void {
		for (let i = 0; i < count; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
			if (rafQueue.length === 0) break;
		}
	}

	function settle(): void {
		for (let i = 0; i < 80 && rafQueue.length > 0; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
		}
	}

	function pointer(type: string, clientY: number, clientX = 10): void {
		view.hitZoneEl.dispatchEvent(
			new MouseEvent(type, { clientX, clientY, bubbles: true }),
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

		// jsdom has no layout: fake row + viewport geometry.
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
		rows = Array.from(view.listEl.children) as HTMLElement[];
		rows.forEach((row, i) => {
			row.getBoundingClientRect = () =>
				({
					top: ROW_TOP(i),
					bottom: ROW_TOP(i) + ROW_HEIGHT,
					left: 0,
					right: 200,
					width: 200,
					height: ROW_HEIGHT,
					x: 0,
					y: ROW_TOP(i),
					toJSON: () => ({}),
				}) as DOMRect;
		});
		// No overflow → auto-scroll stays quiet in these tests.
		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: 400,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: 400,
		});
		view.updateOverflowState();

		controller = new MagnificationController(view, () => settings);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	it("magnifies in-range rows and NEVER writes to far out-of-range rows", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200); // near row 3 (center 214)
		settle();
		// A row near the pointer carries a magnification scale…
		const near = rows[3];
		const nearScale = near.style.getPropertyValue("--glide-scale");
		expect(nearScale).not.toBe("");
		expect(Number.parseFloat(nearScale)).toBeGreaterThan(1);
		expect(near.classList.contains(MOTION_ACTIVE_CLASS)).toBe(true);
		// …while a row far below the viewport was never touched.
		const far = rows[60];
		expect(far.style.getPropertyValue("--glide-scale")).toBe("");
		expect(far.style.getPropertyValue("--glide-shift-y")).toBe("");
		expect(far.classList.contains(MOTION_ACTIVE_CLASS)).toBe(false);
	});

	it("stops writing once displayed values converge (no per-frame churn)", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle(); // fully converged, RAF loop went idle
		const styleSpy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
		// Same pointer position again: identical targets, converged state.
		pointer("pointermove", 200);
		runFrames(5);
		expect(styleSpy).not.toHaveBeenCalled();
		styleSpy.mockRestore();
	});

	it("interpolates over multiple frames (no instant CSS jump)", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		vi.advanceTimersByTime(16);
		flushFrame(); // first motion frame
		const first = Number.parseFloat(
			rows[3].style.getPropertyValue("--glide-scale") || "1",
		);
		settle();
		const final = Number.parseFloat(
			rows[3].style.getPropertyValue("--glide-scale") || "1",
		);
		// The first frame moves only part of the way; convergence finishes it.
		expect(first).toBeGreaterThan(1);
		expect(first).toBeLessThan(final);
		expect(final).toBeCloseTo(settings.maxScale, 2);
	});

	it("reduced motion applies targets instantly (no interpolation tail)", () => {
		settings.motionMode = "reduced";
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		vi.advanceTimersByTime(16);
		flushFrame();
		// Reduced motion: solver outputs identity — nothing is written and
		// nothing converges over time.
		expect(rows[3].style.getPropertyValue("--glide-scale")).toBe("");
		expect(rafQueue.length).toBe(0); // no interpolation tail scheduled
	});

	it("collapse resets every written row and drops all GPU layer hints", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		expect(rows[3].style.getPropertyValue("--glide-scale")).not.toBe("");
		pointer("pointerleave", -500, -500);
		vi.advanceTimersByTime(400); // collapse grace passes
		settle();
		for (const row of rows) {
			expect(row.style.getPropertyValue("--glide-scale")).toBe("");
			expect(row.style.getPropertyValue("--glide-shift-y")).toBe("");
			expect(row.classList.contains(MOTION_ACTIVE_CLASS)).toBe(false);
		}
	});

	it("rows removed from the list get their styles reset exactly once", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		const removedRow = rows[3];
		expect(removedRow.style.getPropertyValue("--glide-scale")).not.toBe("");
		// Remove heading 3; the old row element must be cleaned up on the
		// next cache rebuild even though it left the DOM.
		view.setItems(HEADINGS.filter((_, i) => i !== 3));
		controller.invalidate();
		vi.advanceTimersByTime(16);
		flushFrame();
		expect(removedRow.style.getPropertyValue("--glide-scale")).toBe("");
		expect(removedRow.style.getPropertyValue("--glide-shift-y")).toBe("");
		expect(removedRow.classList.contains(MOTION_ACTIVE_CLASS)).toBe(false);
	});

	it("scales to 1000 rows without touching rows outside the active range", () => {
		// Rebuild with a big list — access stays linear, no quadratic scan.
		const many = Array.from({ length: 1000 }, (_, i) =>
			heading(2, `Big ${i}`, i * 2),
		);
		view.setItems(many);
		const bigRows = Array.from(view.listEl.children) as HTMLElement[];
		bigRows.forEach((row, i) => {
			row.getBoundingClientRect = () =>
				({
					top: ROW_TOP(i),
					bottom: ROW_TOP(i) + ROW_HEIGHT,
					left: 0,
					right: 200,
					width: 200,
					height: ROW_HEIGHT,
					x: 0,
					y: ROW_TOP(i),
					toJSON: () => ({}),
				}) as DOMRect;
		});
		controller.invalidate();
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		// In-range row magnified; the tail of the list untouched.
		expect(
			bigRows[3].style.getPropertyValue("--glide-scale"),
		).not.toBe("");
		for (const i of [200, 500, 999]) {
			expect(bigRows[i].style.getPropertyValue("--glide-scale")).toBe("");
			expect(
				bigRows[i].classList.contains(MOTION_ACTIVE_CLASS),
			).toBe(false);
		}
	});
});
