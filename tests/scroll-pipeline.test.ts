// @vitest-environment jsdom
/**
 * §八/§九 (0.1.5): the scroll-pipeline sub-phase diagnostics and the
 * mode/mutation counters must be WIRED — a capture taken while the edge
 * auto-scroll is running must show non-zero counts, and the counters must
 * classify frames/writes truthfully. 0.1.4 shipped the fields with no
 * call sites, so every value was silently 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerfCapture } from "../src/core/PerfCapture";
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
const SCROLL_HEIGHT = 1200;
const CLIENT_HEIGHT = VIEWPORT_BOTTOM - VIEWPORT_TOP;
const MAX_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;

describe("scroll pipeline diagnostics wiring (§八/§九)", () => {
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

	/** Replace the plain scrollTop stub with a CLAMPING one (like a real
	 * scroller), optionally dispatching "scroll" synchronously on writes
	 * (like Obsidian's Electron renderer does). */
	function installScrollTopSetter(options: {
		initial: number;
		clamp: boolean;
		syncDispatch: boolean;
	}): void {
		let value = options.initial;
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			get: () => value,
			set: (next: number) => {
				let applied = next;
				if (options.clamp) {
					applied = Math.min(MAX_SCROLL_TOP, Math.max(0, applied));
				}
				const moved = applied !== value;
				value = applied;
				if (moved && options.syncDispatch) {
					view.viewportEl.dispatchEvent(new Event("scroll"));
				}
			},
		});
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

		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: CLIENT_HEIGHT,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: SCROLL_HEIGHT,
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
				height: CLIENT_HEIGHT,
				x: 0,
				y: VIEWPORT_TOP,
				toJSON: () => ({}),
			}) as DOMRect;
		view.updateOverflowState();

		perf = new PerfCapture();
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

	it("records the auto-scroll sub-phases and mode counters during an edge scroll capture", () => {
		perf.start(window);
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		runScrollFrames();
		const report = perf.stop(window)!;
		expect(report).not.toBeNull();
		// §八: the sub-phases actually sampled — 0.1.4 regression gate.
		expect(report.pluginPhases.scrollEligibility.count).toBeGreaterThan(0);
		expect(report.pluginPhases.edgeIntentMath.count).toBeGreaterThan(0);
		expect(report.pluginPhases.kineticIntentMath.count).toBeGreaterThan(0);
		expect(report.pluginPhases.scrollIntegrator.count).toBeGreaterThan(0);
		expect(report.pluginPhases.scrollTopWrite.count).toBeGreaterThan(0);
		// §九: this session was edge-only — classified as such, and the
		// write moved the scroller.
		const pipeline = report.scrollPipeline;
		expect(pipeline.edgeOnlyFrameCount).toBeGreaterThan(0);
		expect(pipeline.kineticOnlyFrameCount).toBe(0);
		expect(pipeline.combinedIntentFrameCount).toBe(0);
		expect(pipeline.scrollTopMutationCount).toBeGreaterThan(0);
		// Mode split never exceeds the aggregate frame count (§八: no
		// double counting beyond autoScroll).
		const split =
			pipeline.edgeOnlyFrameCount +
			pipeline.kineticOnlyFrameCount +
			pipeline.combinedIntentFrameCount;
		expect(split).toBeLessThanOrEqual(
			report.counters.autoScrollFrameCount,
		);
	});

	it("records scrollEventHandler / scrollOffsetUpdate / scrollFrameReschedule for an async scroll event", () => {
		perf.start(window);
		view.viewportEl.scrollTop = 260; // plain value stub — no dispatch
		view.viewportEl.dispatchEvent(new Event("scroll"));
		const report = perf.stop(window)!;
		expect(report.pluginPhases.scrollEventHandler.count).toBe(1);
		expect(report.pluginPhases.scrollOffsetUpdate.count).toBe(1);
		expect(report.pluginPhases.scrollFrameReschedule.count).toBe(1);
		// Not inside our own write → NOT a synchronous dispatch.
		expect(report.pluginPhases.synchronousScrollDispatch.count).toBe(0);
		expect(report.scrollPipeline.scrollEventReentrantCount).toBe(0);
		expect(report.scrollPipeline.scrollEventCount).toBe(1);
	});

	it("classifies a scroll event dispatched inside our own write as synchronous (reentrant)", () => {
		installScrollTopSetter({
			initial: 200,
			clamp: true,
			syncDispatch: true,
		});
		perf.start(window);
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		runScrollFrames();
		const report = perf.stop(window)!;
		expect(
			report.pluginPhases.synchronousScrollDispatch.count,
		).toBeGreaterThan(0);
		expect(
			report.scrollPipeline.scrollEventReentrantCount,
		).toBeGreaterThan(0);
		// The reentrant dispatch replaces the async handler phase for
		// those events — no double classification.
		expect(report.pluginPhases.scrollEventHandler.count).toBe(0);
	});

	it("records scrollAnchorResolve and scrollEnvelopeUpdate on the frame after a scroll", () => {
		pointer("pointerenter", 300);
		pointer("pointermove", 300);
		flushFrame(); // builds the cache (cacheDirty → false)
		perf.start(window);
		view.viewportEl.scrollTop = 300;
		view.viewportEl.dispatchEvent(new Event("scroll")); // delta ≠ 0
		vi.advanceTimersByTime(16);
		flushFrame(); // the frame that re-resolves the anchor
		const report = perf.stop(window)!;
		expect(
			report.pluginPhases.scrollAnchorResolve.count,
		).toBeGreaterThan(0);
		expect(
			report.pluginPhases.scrollEnvelopeUpdate.count,
		).toBeGreaterThan(0);
	});

	it("counts a fully clamped boundary write as a clamp, not a mutation", () => {
		installScrollTopSetter({
			initial: MAX_SCROLL_TOP, // already at the bottom
			clamp: true,
			syncDispatch: false,
		});
		view.updateOverflowState();
		perf.start(window);
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		runScrollFrames();
		const report = perf.stop(window)!;
		// Overflow state says it cannot scroll further down, so either the
		// intent never fires (no write at all) or a write is fully clamped
		// — in NO case may a non-moving write count as a mutation.
		expect(report.scrollPipeline.scrollTopMutationCount).toBe(0);
	});

	it("records nothing while capture is off (counters stay zero for later captures)", () => {
		// Real activity BEFORE the capture starts…
		pointer("pointerenter", 495);
		pointer("pointermove", 495);
		runScrollFrames();
		// …must not leak into a capture that starts afterwards.
		perf.start(window);
		const report = perf.stop(window)!;
		expect(report.pluginPhases.scrollEligibility.count).toBe(0);
		expect(report.pluginPhases.scrollTopWrite.count).toBe(0);
		expect(report.scrollPipeline.edgeOnlyFrameCount).toBe(0);
		expect(report.scrollPipeline.scrollTopMutationCount).toBe(0);
		expect(report.scrollPipeline.scrollEventCount).toBe(0);
	});

	it("counts a wheel-routed write as a mutation without a scrollTopWrite phase sample", () => {
		pointer("pointerenter", 300);
		pointer("pointermove", 300);
		flushFrame(); // caches viewport bounds for wheel routing
		perf.start(window);
		view.hitZoneEl.dispatchEvent(
			new WheelEvent("wheel", {
				deltaY: 60,
				deltaMode: 0,
				bubbles: true,
				cancelable: true,
			}),
		);
		const report = perf.stop(window)!;
		expect(report.counters.wheelOutlineCount).toBe(1);
		expect(report.scrollPipeline.scrollTopMutationCount).toBe(1);
		// The wheel write happens OUTSIDE the RAF — it must not inflate
		// the autoScroll sub-phase decomposition.
		expect(report.pluginPhases.scrollTopWrite.count).toBe(0);
	});
});
