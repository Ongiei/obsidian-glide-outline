// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import {
	MagnificationController,
	MOTION_SCALE_CLASS,
	MOTION_SHIFT_CLASS,
} from "../src/ui/MagnificationController";
import { PerfCapture } from "../src/core/PerfCapture";

// =====================================================================
// §十三: cover the Windows frame-budget hot paths.
//
// Five areas, one per perf commit in this branch:
//   Capture      → PerfCapture side of §六/§七/§九 (counter math)
//   Overflow      → §五.1 cached scroll-box geometry + §五.2 fade memo
//   Envelope      → §六 pointerenter reuse / pointerleave derive-or-rebuild
//   LayerPromo    → §七 GPU-layer hints bounded to the scale disc + guard
//   FrameSchedule → §九 schedule() attribution + the idle-RAF invariant
//
// No test asserts a real wall-clock budget — every check is structural
// (counters, class membership, list-length independence), matching the
// existing perf test convention.
// =====================================================================

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

// --- PerfCapture-level helpers (mirrors tests/perf-capture.test.ts) ----

function fakeWin(): Window & typeof globalThis {
	let clock = 0;
	const win = {
		performance: { now: () => clock },
		__advance: (ms: number) => {
			clock += ms;
		},
	} as unknown as Window & typeof globalThis;
	return win;
}

// ---------------------------------------------------------------------
// Capture: the new PerfCapture counters that the §六/§七/§九 commits add.
// ---------------------------------------------------------------------
describe("PerfCapture frame-budget counters (sections 6/7/9)", () => {
	it("addLayerPromotionSample tracks standing layers + class churn", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.addLayerPromotionSample(3, 5); // frame 1: 3 shift, 5 scale
		perf.addLayerPromotionSample(1, 2); // frame 2: smaller
		perf.count("promotionClassMutationCount", 4);
		perf.count("promotionClassSkippedCount", 6);
		const report = perf.stop(win)!;
		expect(report.counters.promotedShiftLayerRows).toBe(4);
		expect(report.counters.promotedScaleLayerRows).toBe(7);
		expect(report.layers.maxPromotedShiftLayers).toBe(3);
		expect(report.layers.maxPromotedScaleLayers).toBe(5);
		expect(report.layers.avgPromotedShiftLayers).toBe(2); // (3+1)/2
		expect(report.layers.avgPromotedScaleLayers).toBeCloseTo(3.5);
		expect(report.layers.classMutationCount).toBe(4);
		expect(report.layers.classSkippedCount).toBe(6);
		expect(report.layers.classSkippedShare).toBeCloseTo(0.6); // 6/10
	});

	it("noteSchedule splits scheduled / deduped / suppressed by reason", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.noteSchedule("pointerEnter", "scheduled");
		perf.noteSchedule("pointerMove", "deduped");
		perf.noteSchedule("pointerMove", "deduped");
		perf.noteSchedule("scrollEvent", "suppressed");
		const report = perf.stop(win)!;
		expect(report.frameScheduling.scheduledRafCount).toBe(1);
		expect(report.frameScheduling.dedupedRafCount).toBe(2);
		expect(report.frameScheduling.suppressedRafCount).toBe(1);
		expect(report.frameScheduling.scheduledRafByReason).toEqual({
			pointerEnter: 1,
		});
		expect(report.frameScheduling.dedupedRafByReason).toEqual({
			pointerMove: 2,
		});
	});

	it("envelopeEnterReuseShare is reused / (reused + dirty)", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.count("envelopeEnterDirtyCount", 1);
		perf.count("envelopeEnterReusedCount", 3);
		const report = perf.stop(win)!;
		expect(report.counters.envelopeEnterDirtyCount).toBe(1);
		expect(report.counters.envelopeEnterReusedCount).toBe(3);
		// 3 / (3 + 1) = 0.75 — a rail glide should sit near 1.
		expect(report.derived.envelopeEnterReuseShare).toBeCloseTo(0.75);
	});

	it("envelope leave counters separate sync rebuilds from derivations", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.count("envelopeSyncRebuildCount", 2);
		perf.count("envelopeDerivedLeaveCount", 7);
		const report = perf.stop(win)!;
		expect(report.counters.envelopeSyncRebuildCount).toBe(2);
		expect(report.counters.envelopeDerivedLeaveCount).toBe(7);
	});

	it("idleFrameShare derives from frameWithoutMotionOrIntentCount", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.count("rafCount", 10); // normally set by recordFrame
		perf.count("frameWithoutMotionOrIntentCount", 4);
		const report = perf.stop(win)!;
		expect(report.frameScheduling.idleFrameShare).toBeCloseTo(0.4);
	});
});

// ---------------------------------------------------------------------
// Overflow: §五.1 caches clientHeight/scrollHeight and reads only
// scrollTop on the scroll path; §五.2 remembers the last fade classes.
// ---------------------------------------------------------------------
describe("GlideOutlineView overflow cache (section 5)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let perf: PerfCapture;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		perf = new PerfCapture();
		perf.start(window);
	});

	afterEach(() => {
		perf.stop(window);
		host.remove();
	});

	it("§五.1: the scroll path reuses cached box geometry (no refresh)", () => {
		const view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		}, perf);
		view.setItems([
			heading(1, "A", 0),
			heading(2, "B", 5),
			heading(3, "C", 10),
		]);
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			value: 0,
		});
		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: 400,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: 900,
		});
		// First evaluation pays the two layout reads.
		view.updateOverflowState();
		// A scroll event must NOT re-read clientHeight/scrollHeight.
		view.viewportEl.dispatchEvent(new Event("scroll"));
		const report = perf.stop(window)!;
		expect(report.counters.overflowMetricRefreshCount).toBe(1);
		expect(report.counters.overflowMetricReadCount).toBe(1);
		expect(report.overflow.cachedMetricShare).toBeCloseTo(0.5); // 1/(1+1)
	});

	it("§五.2: identical fade evaluation is skipped, a change mutates", () => {
		const view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		}, perf);
		view.setItems([
			heading(1, "A", 0),
			heading(2, "B", 5),
			heading(3, "C", 10),
		]);
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			writable: true,
			value: 0,
		});
		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: 400,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: 900,
		});
		view.updateOverflowState(); // fade-bottom on (overflowing)
		view.updateOverflowState(); // identical → skipped
		expect(perf.stop(window)!.counters.overflowClassSkippedCount).toBe(1);

		// Restart, change scrollTop to the bottom → fade pair flips.
		perf.start(window);
		(view.viewportEl as unknown as { scrollTop: number }).scrollTop = 500;
		view.updateOverflowState();
		const report = perf.stop(window)!;
		expect(report.counters.overflowClassMutationCount).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------
// Controller hot paths: §六 envelope events, §七 layer promotion bound,
// §九 frame scheduling + idle-RAF invariant.
// ---------------------------------------------------------------------
describe("MagnificationController frame-budget hot paths (sections 6/7/9)", () => {
	const ROW_COUNT = 100;
	const HEADINGS = Array.from({ length: ROW_COUNT }, (_, i) =>
		heading(2, `Section ${i}`, i * 4),
	);
	const VIEWPORT_TOP = 100;
	const VIEWPORT_BOTTOM = 500;
	const ROW_TOP = (i: number): number => VIEWPORT_TOP + i * 30;
	const ROW_HEIGHT = 28;

	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let perf: PerfCapture;
	let rafQueue: FrameRequestCallback[];
	let rows: HTMLElement[];

	function makeView(list: HeadingItem[]): GlideOutlineView {
		const v = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		}, perf);
		v.setItems(list);
		v.viewportEl.getBoundingClientRect = () =>
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
		const listRows = Array.from(v.listEl.children) as HTMLElement[];
		listRows.forEach((row, i) => {
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
		Object.defineProperty(v.viewportEl, "clientHeight", {
			configurable: true,
			value: 400,
		});
		Object.defineProperty(v.viewportEl, "scrollHeight", {
			configurable: true,
			value: 400,
		});
		v.updateOverflowState();
		return v;
	}

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
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

	function countPromoted(list: HTMLElement[]): number {
		let n = 0;
		for (const row of list) {
			if (
				row.classList.contains(MOTION_SCALE_CLASS) ||
				row.classList.contains(MOTION_SHIFT_CLASS)
			) {
				n++;
			}
		}
		return n;
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
		perf = new PerfCapture();
		perf.start(window);

		view = makeView(HEADINGS);
		rows = Array.from(view.listEl.children) as HTMLElement[];
		controller = new MagnificationController(view, () => settings, null, null, perf);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	it("§六: a fresh pointerenter dirties the envelope, a re-entry reuses it", () => {
		pointer("pointerenter", 200); // collapsed → fresh → dirty
		vi.advanceTimersByTime(16);
		flushFrame(); // expands, rebuilds the envelope
		pointer("pointerenter", 200); // still inside → re-entry → reused
		const report = perf.stop(window)!;
		expect(report.counters.envelopeEnterDirtyCount).toBe(1);
		expect(report.counters.envelopeEnterReusedCount).toBe(1);
		expect(report.derived.envelopeEnterReuseShare).toBeCloseTo(0.5);
	});

	it("§六: pointerleave rebuilds when stale, derives when fresh", () => {
		// --- stale path: leave WITHOUT a frame running, envelope still dirty.
		const perfA = new PerfCapture();
		perfA.start(window);
		const cA = new MagnificationController(view, () => settings, null, null, perfA);
		pointer("pointerenter", 200); // sets envelopeDirty, schedules a frame
		pointer("pointerleave", 50, 10); // no frame yet → envelopeDirty still true
		const reportA = perfA.stop(window)!;
		expect(reportA.counters.envelopeSyncRebuildCount).toBe(1);
		expect(reportA.counters.envelopeDerivedLeaveCount).toBe(0);
		cA.dispose();

		// --- fresh path: run a frame (rebuild clears the dirty flag), then leave.
		pointer("pointerenter", 200);
		vi.advanceTimersByTime(16);
		flushFrame(); // envelope rebuilt → envelopeDirty = false
		pointer("pointerleave", 50, 10);
		const report = perf.stop(window)!;
		expect(report.counters.envelopeDerivedLeaveCount).toBeGreaterThanOrEqual(1);
	});

	it("§七: GPU-layer promotion is bounded by the scale disc, not list length", () => {
		// Small list.
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle();
		const promotedSmall = countPromoted(rows);
		expect(promotedSmall).toBeGreaterThan(0);
		expect(promotedSmall).toBeLessThanOrEqual(20); // disc + 2-row guard, not the window

		// Big list with identical geometry — promotion must NOT grow.
		const many = Array.from({ length: 1000 }, (_, i) =>
			heading(2, `Big ${i}`, i * 2),
		);
		const bigView = makeView(many);
		const bigRows = Array.from(bigView.listEl.children) as HTMLElement[];
		const bigController = new MagnificationController(
			bigView,
			() => settings,
			null,
			null,
			perf,
		);
		bigView.hitZoneEl.dispatchEvent(
			new MouseEvent("pointerenter", { clientX: 10, clientY: 200, bubbles: true }),
		);
		bigView.hitZoneEl.dispatchEvent(
			new MouseEvent("pointermove", { clientX: 10, clientY: 200, bubbles: true }),
		);
		for (let i = 0; i < 80 && rafQueue.length > 0; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
		}
		const promotedBig = countPromoted(bigRows);
		bigController.dispose();
		// The promotion set is anchored to the magnification disc, so the
		// count is the same regardless of how many rows are visible.
		expect(promotedBig).toBe(promotedSmall);
		// Far rows never hold a layer hint even in a 1000-row list.
		for (const i of [200, 500, 999]) {
			expect(bigRows[i].classList.contains(MOTION_SCALE_CLASS)).toBe(false);
			expect(bigRows[i].classList.contains(MOTION_SHIFT_CLASS)).toBe(false);
		}
	});

	it("§九: schedule() attributes by reason and dedupes a pending frame", () => {
		// pointerenter → onPointerEnter expands (syncExpanded wins the first
		// schedule as "expand"); the trailing schedule("pointerEnter") and a
		// pointermove before the frame runs are both deduped against it.
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		const report = perf.stop(window)!;
		expect(report.frameScheduling.scheduledRafCount).toBe(1);
		expect(report.frameScheduling.scheduledRafByReason).toEqual({
			expand: 1,
		});
		expect(report.frameScheduling.dedupedRafCount).toBe(2);
		expect(report.frameScheduling.dedupedRafByReason).toEqual({
			pointerEnter: 1,
			pointerMove: 1,
		});
		// Exactly one RAF was requested despite three schedule() calls.
		expect(
			report.frameScheduling.scheduledRafCount +
				report.frameScheduling.dedupedRafCount +
				report.frameScheduling.suppressedRafCount,
		).toBe(3);
	});

	it("§九: the self-scheduled idle-RAF invariant holds (idleRafCount === 0)", () => {
		pointer("pointerenter", 200);
		pointer("pointermove", 200);
		settle(); // loop converges and goes idle
		const report = perf.stop(window)!;
		expect(report.frameScheduling.idleRafCount).toBe(0);
		expect(report.frameScheduling.scheduledRafCount).toBeGreaterThanOrEqual(1);
	});
});
