import { describe, expect, it, vi } from "vitest";
import { PerfCapture } from "../src/core/PerfCapture";

/** Minimal window stub: performance clock + optional PerformanceObserver. */
function fakeWin(observerHooks?: {
	onObserve?: () => void;
	onDisconnect?: () => void;
}): Window & typeof globalThis {
	let clock = 0;
	const win: Record<string, unknown> = {
		performance: {
			now: () => clock,
		},
		__advance: (ms: number) => {
			clock += ms;
		},
	};
	if (observerHooks) {
		win.PerformanceObserver = class {
			constructor(_cb: unknown) {}
			observe(): void {
				observerHooks.onObserve?.();
			}
			disconnect(): void {
				observerHooks.onDisconnect?.();
			}
		};
	}
	return win as unknown as Window & typeof globalThis;
}

function advance(win: Window & typeof globalThis, ms: number): void {
	(win as unknown as { __advance: (ms: number) => void }).__advance(ms);
}

describe("PerfCapture", () => {
	it("is inactive by default and ignores all recording calls", () => {
		const perf = new PerfCapture();
		expect(perf.active).toBe(false);
		perf.recordFrame(0);
		perf.count("cssVarWriteCount", 5);
		perf.addSolverSample(2, 10);
		perf.addEnvelopeSample(4);
		const win = fakeWin();
		expect(perf.stop(win)).toBeNull(); // stop without start → null
	});

	it("records frame intervals and computes avg / p95 / max / budget overruns", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		// Frames at 0, 10, 20, 60 → intervals 10, 10, 40.
		perf.recordFrame(0);
		perf.recordFrame(10);
		perf.recordFrame(20);
		perf.recordFrame(60);
		advance(win, 60);
		const report = perf.stop(win);
		expect(report).not.toBeNull();
		expect(report!.frames.count).toBe(3);
		expect(report!.frames.intervalAvgMs).toBeCloseTo(20, 1);
		expect(report!.frames.intervalMaxMs).toBe(40);
		expect(report!.frames.over16_7ms).toBe(1);
		expect(report!.frames.over33_3ms).toBe(1);
		expect(report!.counters.rafCount).toBe(4);
	});

	it("markFrameGap breaks the interval chain (idle loop ≠ giant frame)", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(16);
		perf.markFrameGap(); // loop idled
		perf.recordFrame(5000); // would be a 4984 ms "interval" without the gap
		perf.recordFrame(5016);
		const report = perf.stop(win)!;
		expect(report.frames.count).toBe(2);
		expect(report.frames.intervalMaxMs).toBeLessThan(20);
	});

	it("accumulates counters and derives per-frame averages", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(16);
		perf.count("pointermoveCount", 7);
		perf.count("cssVarWriteCount", 6);
		perf.addSolverSample(1.5, 20);
		perf.addSolverSample(0.5, 10);
		perf.addEnvelopeSample(12);
		const report = perf.stop(win)!;
		expect(report.counters.pointermoveCount).toBe(7);
		expect(report.counters.solverRuns).toBe(2);
		expect(report.derived.avgSolverRows).toBe(15);
		expect(report.derived.avgSolverDurationMs).toBe(1);
		expect(report.derived.avgEnvelopeRows).toBe(12);
		expect(report.derived.avgCssWritesPerFrame).toBe(3);
	});

	it("connects the longtask observer on start and ALWAYS disconnects on stop", () => {
		const onObserve = vi.fn();
		const onDisconnect = vi.fn();
		const win = fakeWin({ onObserve, onDisconnect });
		const perf = new PerfCapture();
		perf.start(win);
		expect(onObserve).toHaveBeenCalledTimes(1);
		perf.stop(win);
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});

	it("works without PerformanceObserver (pop-out / older runtimes)", () => {
		const perf = new PerfCapture();
		const win = fakeWin(); // no PerformanceObserver at all
		expect(() => perf.start(win)).not.toThrow();
		perf.recordFrame(0);
		perf.recordFrame(16);
		const report = perf.stop(win)!;
		expect(report.counters.rendererLongTaskCount).toBe(0);
	});

	it("start resets all data from a previous capture", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(16);
		perf.count("cssVarWriteCount", 99);
		perf.stop(win);
		perf.start(win);
		advance(win, 10);
		const report = perf.stop(win)!;
		expect(report.frames.count).toBe(0);
		expect(report.counters.cssVarWriteCount).toBe(0);
	});

	it("ring buffer caps memory: more samples than capacity still report", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		for (let i = 0; i <= 6000; i++) perf.recordFrame(i * 16);
		const report = perf.stop(win)!;
		expect(report.frames.count).toBeLessThanOrEqual(5120);
		expect(report.frames.intervalAvgMs).toBe(16);
	});

	it("routes >250 ms intervals to suspended-gap stats, not frame stats", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		// Frames at 0, 16, 32 → normal intervals; then the app sleeps.
		perf.recordFrame(0);
		perf.recordFrame(16);
		perf.recordFrame(32);
		perf.recordFrame(5032); // 5000 ms — suspension, not jank
		perf.recordFrame(5048);
		perf.recordFrame(5348); // 300 ms — a second suspended gap
		const report = perf.stop(win)!;
		// Only the 3 normal intervals (16, 16, 16) reached the ring.
		expect(report.frames.count).toBe(3);
		expect(report.frames.intervalAvgMs).toBe(16);
		expect(report.frames.intervalMaxMs).toBe(16);
		expect(report.frames.over33_3ms).toBe(0);
		// Both large gaps are tracked separately.
		expect(report.frames.suspendedGapCount).toBe(2);
		expect(report.frames.suspendedGapTotalMs).toBe(5300);
		expect(report.frames.maxSuspendedGapMs).toBe(5000);
	});

	it("intervals at exactly 250 ms still count as (slow) frames", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(250);
		const report = perf.stop(win)!;
		expect(report.frames.count).toBe(1);
		expect(report.frames.intervalMaxMs).toBe(250);
		expect(report.frames.suspendedGapCount).toBe(0);
	});

	it("adds and ALWAYS removes suspension listeners; events break the chain", () => {
		const listeners = new Map<string, () => void>();
		const win = fakeWin();
		const w = win as unknown as Record<string, unknown>;
		w.addEventListener = (type: string, cb: () => void) =>
			listeners.set(`win:${type}`, cb);
		w.removeEventListener = (type: string) => listeners.delete(`win:${type}`);
		w.document = {
			addEventListener: (type: string, cb: () => void) =>
				listeners.set(`doc:${type}`, cb),
			removeEventListener: (type: string) => listeners.delete(`doc:${type}`),
		};
		const perf = new PerfCapture();
		perf.start(win);
		expect(listeners.has("doc:visibilitychange")).toBe(true);
		expect(listeners.has("win:blur")).toBe(true);
		expect(listeners.has("win:focus")).toBe(true);

		// A hide event breaks the frame chain: the next frame produces no
		// interval at all (neither ring nor suspended stats).
		perf.recordFrame(0);
		perf.recordFrame(16);
		listeners.get("doc:visibilitychange")!();
		perf.recordFrame(10016);
		perf.recordFrame(10032);
		const report = perf.stop(win)!;
		expect(report.frames.count).toBe(2); // 16 + 16, no 10000 anywhere
		expect(report.frames.suspendedGapCount).toBe(0);
		expect(listeners.size).toBe(0); // stop removed every listener
	});

	it("reports zeroed pluginPhases for every phase when never sampled (§四.2)", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		const report = perf.stop(win)!;
		for (const phase of [
			"pluginFrameJs",
			"read",
			"styleWrite",
			"envelopeMotionUpdate",
			"autoScroll",
		] as const) {
			expect(report.pluginPhases[phase]).toEqual({
				count: 0,
				avgMs: 0,
				p95Ms: 0,
				maxMs: 0,
			});
		}
	});

	it("accumulates plugin phase samples into count/avg/p95/max (§四.2)", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.addPhaseSample("pluginFrameJs", 2);
		perf.addPhaseSample("pluginFrameJs", 4);
		perf.addPhaseSample("pluginFrameJs", 12);
		perf.addPhaseSample("styleWrite", 1);
		// Invalid samples are dropped, never poisoning the stats.
		perf.addPhaseSample("read", Number.NaN);
		perf.addPhaseSample("read", -5);
		const report = perf.stop(win)!;
		const frame = report.pluginPhases.pluginFrameJs;
		expect(frame.count).toBe(3);
		expect(frame.avgMs).toBe(6);
		expect(frame.maxMs).toBe(12);
		expect(frame.p95Ms).toBe(12);
		expect(report.pluginPhases.styleWrite.count).toBe(1);
		expect(report.pluginPhases.read.count).toBe(0);
	});

	it("ignores phase samples while inactive and resets them on start", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.addPhaseSample("pluginFrameJs", 100); // inactive → dropped
		perf.start(win);
		perf.addPhaseSample("pluginFrameJs", 3);
		perf.stop(win);
		perf.start(win);
		const report = perf.stop(win)!;
		expect(report.pluginPhases.pluginFrameJs.count).toBe(0);
	});

	it("start resets suspended-gap stats from a previous capture", () => {
		const perf = new PerfCapture();
		const win = fakeWin();
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(1000);
		perf.stop(win);
		perf.start(win);
		const report = perf.stop(win)!;
		expect(report.frames.suspendedGapCount).toBe(0);
		expect(report.frames.suspendedGapTotalMs).toBe(0);
		expect(report.frames.maxSuspendedGapMs).toBe(0);
	});
});

describe("PerfCapture abort (§七 dev-mode shutdown)", () => {
	it("stops an active capture, disconnects the observer, and discards the report", () => {
		const onObserve = vi.fn();
		const onDisconnect = vi.fn();
		const win = fakeWin({ onObserve, onDisconnect });
		const perf = new PerfCapture();
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(16);
		expect(onObserve).toHaveBeenCalledTimes(1);
		// Abort: no report, but the longtask observer is torn down so the
		// capture has zero standing cost (matching stop()).
		perf.abort();
		expect(perf.active).toBe(false);
		expect(onDisconnect).toHaveBeenCalledTimes(1);
		// A second stop finds nothing left to report and disconnects nothing.
		expect(perf.stop(win)).toBeNull();
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when nothing is running", () => {
		const onDisconnect = vi.fn();
		fakeWin({ onDisconnect }); // nothing is observed until a capture starts
		const perf = new PerfCapture();
		expect(() => perf.abort()).not.toThrow();
		expect(perf.active).toBe(false);
		expect(onDisconnect).not.toHaveBeenCalled();
	});

	it("clears every deep/intent flag so no hot path keeps sampling", () => {
		const win = fakeWin();
		const perf = new PerfCapture();
		perf.start(win, "deep");
		expect(perf.deepActive).toBe(true);
		expect(perf.deepFrameCalcActive).toBe(true);
		expect(perf.deepScrollWriteActive).toBe(true);
		expect(perf.deepScrollEventActive).toBe(true);
		expect(perf.deepAutoScrollIntentActive).toBe(true);
		perf.abort();
		expect(perf.deepActive).toBe(false);
		expect(perf.deepFrameCalcActive).toBe(false);
		expect(perf.deepScrollWriteActive).toBe(false);
		expect(perf.deepScrollEventActive).toBe(false);
		expect(perf.deepAutoScrollIntentActive).toBe(false);
	});

	it("can be re-armed cleanly after an abort (no stuck state)", () => {
		const win = fakeWin();
		const perf = new PerfCapture();
		perf.start(win);
		perf.recordFrame(0);
		perf.abort();
		expect(perf.stop(win)).toBeNull(); // nothing to report after abort
		// Re-arm and capture fresh.
		perf.start(win);
		perf.recordFrame(0);
		perf.recordFrame(16);
		const report = perf.stop(win)!;
		expect(report.frames.count).toBe(1);
	});
});
