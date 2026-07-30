// @vitest-environment jsdom
//
// §九 Sparse Dirty Rows.
//
// The old model published the settling window as an inclusive span
// `[settleStart, settleEnd]`. Whenever the still-dirty rows were not
// contiguous — which is the normal case after a boundary taper: a short
// chain of snapped rows plus the collision block, with clean rows in
// between — the span covered every clean row between the two islands and
// the write loop walked all of them once per frame just to hit the
// identity fast-skip.
//
// These tests pin the replacement invariant: the per-frame write order is
// exactly `collision ∪ dirty`, so a clean row is never visited at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerfCapture } from "../src/core/PerfCapture";
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

const ROW_COUNT = 240;
const HEADINGS = Array.from({ length: ROW_COUNT }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);
const VIEWPORT_TOP = 100;
const VIEWPORT_BOTTOM = 500;
const ROW_STRIDE = 30;
const ROW_HEIGHT = 28;
const ROW_TOP = (i: number): number => VIEWPORT_TOP + i * ROW_STRIDE;

function fakeRect(top: number, height: number): DOMRect {
	return {
		top,
		bottom: top + height,
		left: 0,
		right: 200,
		width: 200,
		height,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("§九 sparse dirty rows", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let perf: PerfCapture;
	let rafQueue: FrameRequestCallback[];
	let rows: HTMLElement[];

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function settle(maxFrames = 120): void {
		for (let i = 0; i < maxFrames && rafQueue.length > 0; i++) {
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

		view.viewportEl.getBoundingClientRect = () =>
			fakeRect(VIEWPORT_TOP, VIEWPORT_BOTTOM - VIEWPORT_TOP);
		rows = Array.from(view.listEl.children) as HTMLElement[];
		rows.forEach((row, i) => {
			row.getBoundingClientRect = () => fakeRect(ROW_TOP(i), ROW_HEIGHT);
		});
		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: VIEWPORT_BOTTOM - VIEWPORT_TOP,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: ROW_COUNT * ROW_STRIDE,
		});
		view.updateOverflowState();

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

	it("keeps the write set far below the row count", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		const report = perf.stop(window as Window & typeof globalThis)!;
		expect(report.dirtyRows.maxDirtyRows).toBeGreaterThan(0);
		// The whole point: the write budget tracks the active neighbourhood,
		// not the document. 240 rows in, the set stays a small fraction.
		expect(report.dirtyRows.maxDirtyRows).toBeLessThan(ROW_COUNT / 2);
		expect(report.ranges.maxWriteRangeRows).toBe(
			report.dirtyRows.maxDirtyRows,
		);
	});

	it("never visits a clean row (identityRowsSkipped stays 0)", () => {
		// Sweep the pointer across the rail. Every position leaves a trail
		// of settling rows behind it, so under the old span model the loop
		// would repeatedly walk the clean rows between the trail and the
		// new pointer neighbourhood.
		pointer("pointerenter", 120);
		for (let y = 120; y <= 480; y += 20) {
			pointer("pointermove", y);
			vi.advanceTimersByTime(16);
			flushFrame();
		}
		settle();
		const report = perf.stop(window as Window & typeof globalThis)!;
		// A row is only ever in the set while it is genuinely off identity,
		// so no frame can visit a row purely to skip it.
		expect(report.dirtyRows.identityRowsSkipped).toBe(0);
	});

	it("balances churn: every row added to the set is removed again", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		pointer("pointermove", 460);
		settle();
		pointer("pointerleave", -500, -500);
		vi.advanceTimersByTime(400); // collapse grace
		settle();
		const report = perf.stop(window as Window & typeof globalThis)!;
		expect(report.dirtyRows.dirtyRowsAdded).toBeGreaterThan(0);
		// After a full collapse nothing is dirty, so the set drained
		// completely — additions and removals must balance exactly.
		expect(report.dirtyRows.dirtyRowsRemoved).toBe(
			report.dirtyRows.dirtyRowsAdded,
		);
	});

	it("carries residual motion across a cache rebuild", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		const magnified = rows.findIndex(
			(row) => row.style.getPropertyValue("--glide-scale") !== "",
		);
		expect(magnified).toBeGreaterThanOrEqual(0);
		// Rebuild while rows still carry written vars, then leave. The rows
		// must still be reachable by the write loop — i.e. they were
		// re-seeded into the dirty set under their NEW indices.
		controller.invalidate();
		vi.advanceTimersByTime(16);
		flushFrame();
		pointer("pointerleave", -500, -500);
		vi.advanceTimersByTime(400);
		settle();
		for (const row of rows) {
			expect(row.style.getPropertyValue("--glide-scale")).toBe("");
			expect(row.style.getPropertyValue("--glide-shift-y")).toBe("");
		}
	});

	it("drops stale indices when the list shrinks under the dirty set", () => {
		pointer("pointerenter", 460);
		pointer("pointermove", 460);
		settle();
		// Shrink the list so every previously dirty index is out of range.
		view.setItems(HEADINGS.slice(0, 4));
		const shortRows = Array.from(view.listEl.children) as HTMLElement[];
		shortRows.forEach((row, i) => {
			row.getBoundingClientRect = () => fakeRect(ROW_TOP(i), ROW_HEIGHT);
		});
		controller.invalidate();
		expect(() => settle()).not.toThrow();
		pointer("pointerleave", -500, -500);
		vi.advanceTimersByTime(400);
		expect(() => settle()).not.toThrow();
		const report = perf.stop(window as Window & typeof globalThis)!;
		expect(report.dirtyRows.maxDirtyRows).toBeLessThanOrEqual(ROW_COUNT);
	});
});
