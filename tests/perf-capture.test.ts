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
		expect(report.counters.longTaskCount).toBe(0);
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
});
