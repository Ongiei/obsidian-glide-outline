// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	ColdStartTrace,
	getActiveColdStartTrace,
	markColdStart,
	noteColdStartInteraction,
	noteColdStartMarkdownLabel,
	setActiveColdStartTrace,
	type ColdStartWindowLike,
} from "../src/core/ColdStartTrace";

/**
 * A window stub with a controllable clock, RAF queue and long-task
 * observer. Each `__tick(ms)` advances the clock and fires every RAF
 * callback currently queued, passing the new clock value as the RAF
 * timestamp — exactly the shape ColdStartTrace consumes (it uses the RAF
 * timestamp directly, falls back to performance.now() when that is
 * non-finite).
 */
function makeFakeWindow(): ColdStartWindowLike & {
	__tick: (ms: number) => void;
	__pending: () => number;
	__emitLongTask: (durationMs: number) => void;
	__observerCount: () => number;
} {
	let clock = 0;
	let nextHandle = 1;
	const queue: Array<{ handle: number; cb: (ts: number) => void }> = [];
	type LongTaskSink = (list: { getEntries(): { duration: number }[] }) => void;
	const sinks: LongTaskSink[] = [];

	class FakeObserver {
		constructor(private readonly cb: LongTaskSink) {}
		observe(): void {
			sinks.push(this.cb);
		}
		disconnect(): void {
			const i = sinks.indexOf(this.cb);
			if (i >= 0) sinks.splice(i, 1);
		}
	}

	const win = {
		performance: { now: () => clock },
		PerformanceObserver: FakeObserver,
		requestAnimationFrame(cb: (ts: number) => void): number {
			const handle = nextHandle++;
			queue.push({ handle, cb });
			return handle;
		},
		cancelAnimationFrame(handle: number): void {
			const i = queue.findIndex((e) => e.handle === handle);
			if (i >= 0) queue.splice(i, 1);
		},
		__tick(ms: number): void {
			clock += ms;
			const pending = queue.splice(0, queue.length);
			for (const entry of pending) entry.cb(clock);
		},
		__pending(): number {
			return queue.length;
		},
		__emitLongTask(durationMs: number): void {
			for (const sink of sinks.slice()) {
				sink({ getEntries: () => [{ duration: durationMs }] });
			}
		},
		__observerCount(): number {
			return sinks.length;
		},
	};
	return win as unknown as ColdStartWindowLike & {
		__tick: (ms: number) => void;
		__pending: () => number;
		__emitLongTask: (durationMs: number) => void;
		__observerCount: () => number;
	};
}

type FakeWindow = ReturnType<typeof makeFakeWindow>;

/** Watch + a first interaction at t=0, i.e. the §十二 observation phase. */
function startWatched(win: FakeWindow): ColdStartTrace {
	const trace = new ColdStartTrace(win, 0);
	trace.beginSettleWatch();
	trace.noteInteraction("firstPointerEnter");
	return trace;
}

function drive(win: FakeWindow, frames: number, intervalMs: number): void {
	for (let i = 0; i < frames; i++) win.__tick(intervalMs);
}

afterEach(() => {
	setActiveColdStartTrace(null);
});

describe("ColdStartTrace milestones (§八)", () => {
	it("records onloadStart at exactly t0 and marks relative to it", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0); // t0 = 0 ms (matches the clock)
		const report0 = trace.buildReport();
		expect(report0.milestones).toHaveLength(1);
		expect(report0.milestones[0]).toEqual({ name: "onloadStart", atMs: 0 });

		win.__tick(120);
		trace.mark("settingsLoaded");
		const report1 = trace.buildReport();
		expect(report1.milestones).toHaveLength(2);
		expect(report1.milestones[1]).toEqual({
			name: "settingsLoaded",
			atMs: 120,
		});
	});

	it("round-trips milestones without aliasing the internal array", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.mark("a");
		trace.mark("b");
		const r1 = trace.buildReport();
		const r2 = trace.buildReport();
		expect(r1.milestones).not.toBe(r2.milestones); // defensive copy
		expect(r1.milestones.map((m) => m.name)).toEqual([
			"onloadStart",
			"a",
			"b",
		]);
	});

	it("markOnce records a first-use milestone exactly once (§十三)", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		expect(trace.hasMarked("firstMeasureRowsStart")).toBe(false);
		trace.markOnce("firstMeasureRowsStart");
		win.__tick(50);
		trace.markOnce("firstMeasureRowsStart");
		trace.markOnce("firstMeasureRowsStart");
		expect(trace.hasMarked("firstMeasureRowsStart")).toBe(true);
		const names = trace.buildReport().milestones.map((m) => m.name);
		expect(names.filter((n) => n === "firstMeasureRowsStart")).toHaveLength(1);
	});
});

describe("ColdStartTrace settle watch lifecycle (§九)", () => {
	it("beginSettleWatch schedules exactly one RAF and is idempotent", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		expect(win.__pending()).toBe(1);
		const report = trace.buildReport();
		expect(report.settleWatchStarted).toBe(true);
		expect(report.milestones.some((m) => m.name === "settleWatchStart")).toBe(
			true,
		);

		// A second call must NOT start a second loop.
		trace.beginSettleWatch();
		expect(win.__pending()).toBe(1);
	});

	it("a trace that is never armed schedules zero RAF work (zero-cost path)", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		expect(win.__pending()).toBe(0);
		trace.dispose(); // disposed before any watch began
		expect(win.__pending()).toBe(0);
		const report = trace.buildReport();
		expect(report.settleWatchStarted).toBe(false);
		expect(report.complete).toBe(true);
		expect(report.settle.frameCount).toBe(0);
	});

	it("dispose cancels the pending frame and the long-task observer", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		expect(win.__pending()).toBe(1);
		expect(win.__observerCount()).toBe(1);
		trace.dispose();
		expect(win.__pending()).toBe(0);
		expect(win.__observerCount()).toBe(0);
		expect(trace.buildReport().complete).toBe(true);
		// A disposed trace never schedules again.
		win.__tick(16);
		expect(win.__pending()).toBe(0);
	});

	it("dispose is safe to call more than once", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		expect(() => {
			trace.dispose();
			trace.dispose();
		}).not.toThrow();
		expect(win.__pending()).toBe(0);
	});

	it("self-terminates at the 30 s ceiling when nobody interacts (§十二)", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		drive(win, 250, 100); // 25 s — still watching
		expect(trace.buildReport().complete).toBe(false);
		drive(win, 70, 100); // past 30 s
		const report = trace.buildReport();
		expect(report.complete).toBe(true);
		// Never touched → never judged stable, however quiet the frames were.
		expect(report.settle.timeToStableMs).toBeNull();
		expect(win.__pending()).toBe(0); // no standing RAF loop
		win.__tick(100);
		expect(win.__pending()).toBe(0);
	});
});

describe("ColdStartTrace frame buckets (§十一)", () => {
	it("bins frame counts into 1000 ms buckets", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		// 12 frames at 100 ms → cumulative sinceSettleStart 100…1200 ms.
		// The first frame seeds (no interval); the remaining 11 are counted.
		drive(win, 12, 100);
		const report = trace.buildReport();
		expect(report.settle.buckets).toHaveLength(2);
		// bucket 0: since 200…900 → 8 intervals; bucket 1: 1000…1200 → 3.
		expect(report.settle.buckets[0].frameCount).toBe(8);
		expect(report.settle.buckets[1].frameCount).toBe(3);
		// 100 ms clears every threshold.
		expect(report.settle.buckets[0].overBudgetFrameCount).toBe(8);
		expect(report.settle.buckets[0].over20msCount).toBe(8);
		expect(report.settle.buckets[0].over33_3msCount).toBe(8);
		expect(report.settle.buckets[0].intervalAvgMs).toBe(100);
		expect(report.settle.buckets[0].intervalP95Ms).toBe(100);
		expect(report.settle.buckets[0].intervalMaxMs).toBe(100);
		expect(report.settle.frameCount).toBe(11);
		expect(report.settle.overBudgetFrameCount).toBe(11);
		expect(report.settle.maxIntervalMs).toBe(100);
	});

	it("assigns late frames to the final bucket, then closes the window", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		// 100 ms/frame. Bucket 29 covers sinceSettleStart ∈ [29000, 30000) →
		// frames at ticks 290..299. The 30000 ms frame self-terminates.
		drive(win, 320, 100);
		const report = trace.buildReport();
		expect(report.complete).toBe(true);
		expect(report.settle.buckets).toHaveLength(30);
		expect(report.settle.buckets[29].frameCount).toBe(10);
		// 298 counted intervals (ticks 2..299); the 30000 ms frame ends it.
		expect(report.settle.frameCount).toBe(298);
	});

	it("attributes renderer long tasks to their bucket", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		drive(win, 15, 100); // clock → 1500, i.e. bucket 1
		win.__emitLongTask(120);
		const report = trace.buildReport();
		expect(report.settle.rendererLongTaskCount).toBe(1);
		expect(report.settle.rendererLongTaskTotalMs).toBe(120);
		expect(report.settle.rendererLongTaskMaxMs).toBe(120);
		expect(report.settle.buckets[1].rendererLongTaskCount).toBe(1);
		expect(report.settle.buckets[1].rendererLongTaskTotalMs).toBe(120);
		expect(report.settle.buckets[0].rendererLongTaskCount).toBe(0);
	});
});

describe("ColdStartTrace stable window (§十一)", () => {
	it("declares stable after 90 clean frames inside the 2 s window", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		drive(win, 91, 10); // 1 seed + 90 counted intervals
		const report = trace.buildReport();
		expect(report.settle.frameCount).toBe(90);
		expect(report.settle.timeToStableMs).toBe(910);
		expect(report.settle.intervalP95Ms).toBe(10);
		expect(report.settle.firstInteraction).toBe("firstPointerEnter");
		expect(report.settle.warmupDurationMs).toBe(0);
		expect(report.settle.timeFromOnloadToFirstInteractionMs).toBe(0);
		expect(report.settle.timeFromFirstInteractionToStableMs).toBe(910);
		expect(report.milestones.some((m) => m.name === "stable")).toBe(true);
	});

	it("refuses to call a window of fewer than 90 frames stable", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		drive(win, 90, 10); // 89 counted intervals — one short
		expect(trace.buildReport().settle.frameCount).toBe(89);
		expect(trace.buildReport().settle.timeToStableMs).toBeNull();
		win.__tick(10); // the 90th
		expect(trace.buildReport().settle.timeToStableMs).not.toBeNull();
	});

	it("tolerates vsync jitter the old 16.7 ms gate rejected (§十一)", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		win.__tick(17); // seed
		for (let i = 0; i < 90; i++) win.__tick(i % 2 === 0 ? 17 : 18);
		const report = trace.buildReport();
		// Every single frame is "over budget" by the old rule …
		expect(report.settle.overBudgetFrameCount).toBe(90);
		// … yet p95 is 18 ms, so this is a smooth outline and it says so.
		expect(report.settle.intervalP95Ms).toBe(18);
		expect(report.settle.over33_3msCount).toBe(0);
		expect(report.settle.timeToStableMs).not.toBeNull();
	});

	it("never declares stable when p95 exceeds 20 ms", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		// One frame in ten costs 30 ms → p95 lands on 30 ms.
		for (let i = 0; i < 400; i++) win.__tick(i % 10 === 9 ? 30 : 10);
		const report = trace.buildReport();
		expect(report.settle.frameCount).toBeGreaterThan(90);
		expect(report.settle.over33_3msCount).toBe(0); // not the failing gate
		expect(report.settle.intervalP95Ms).toBeGreaterThan(20);
		expect(report.settle.timeToStableMs).toBeNull();
	});

	it("never declares stable when over 2 % of frames exceed 33.3 ms", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		// 4 % of frames at 40 ms: p95 still reads 10 ms, so only the
		// over-33.3 ms ratio can be rejecting this window.
		for (let i = 0; i < 400; i++) win.__tick(i % 25 === 24 ? 40 : 10);
		const report = trace.buildReport();
		expect(report.settle.intervalP95Ms).toBeLessThanOrEqual(20);
		expect(report.settle.over33_3msCount).toBeGreaterThan(0);
		expect(report.settle.timeToStableMs).toBeNull();
	});

	it("blocks stability while a renderer long task sits in the window", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		drive(win, 40, 10); // clock → 400
		win.__emitLongTask(80);
		drive(win, 60, 10); // clock → 1000, 99 frames, long task still inside
		expect(trace.buildReport().settle.timeToStableMs).toBeNull();
		drive(win, 300, 10); // clock → 4000, long task has aged out
		const stableAt = trace.buildReport().settle.timeToStableMs;
		expect(stableAt).not.toBeNull();
		expect(stableAt as number).toBeGreaterThan(2400);
	});

	it("never judges stability before the first interaction (§十二)", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		drive(win, 300, 10); // perfectly smooth, but nobody touched it
		expect(trace.buildReport().settle.timeToStableMs).toBeNull();
		expect(trace.buildReport().settle.firstInteraction).toBeNull();
		trace.noteInteraction("firstExpand");
		drive(win, 100, 10);
		const report = trace.buildReport();
		expect(report.settle.firstInteraction).toBe("firstExpand");
		expect(report.settle.warmupDurationMs).toBe(3000);
		expect(report.settle.timeToStableMs).not.toBeNull();
	});

	it("keeps the first interaction and ignores later ones", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		win.__tick(200);
		trace.noteInteraction("firstPointerEnter");
		win.__tick(200);
		trace.noteInteraction("firstExpand");
		const report = trace.buildReport();
		expect(report.settle.firstInteraction).toBe("firstPointerEnter");
		expect(report.settle.firstInteractionAt).toBe(200);
		// Both interactions still leave their own first-use milestone.
		const names = report.milestones.map((m) => m.name);
		expect(names).toContain("firstPointerEnter");
		expect(names).toContain("firstExpand");
		expect(names.filter((n) => n === "firstInteraction")).toHaveLength(1);
	});
});

describe("ColdStartTrace observation phase (§十二)", () => {
	it("keeps watching for 10 s after the interaction and 1 s after stable", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		drive(win, 91, 10); // stable at 910 ms
		expect(trace.buildReport().settle.timeToStableMs).toBe(910);
		drive(win, 400, 10); // clock → 4910: stable long ago, interaction young
		expect(trace.buildReport().complete).toBe(false);
		drive(win, 600, 10); // clock → 10910, past the 10 s interaction floor
		const report = trace.buildReport();
		expect(report.complete).toBe(true);
		expect(win.__pending()).toBe(0);
		expect(report.settle.observedMs).toBeGreaterThanOrEqual(10000);
	});
});

describe("ColdStartTrace suspended gaps (§九)", () => {
	it("excludes >250 ms gaps from frame stats and restarts the window", () => {
		const win = makeFakeWindow();
		const trace = startWatched(win);
		win.__tick(10); // seed
		win.__tick(10); // frame 1 (interval 10)
		win.__tick(10); // frame 2 (interval 10)
		win.__tick(300); // suspension, not jank
		win.__tick(10); // frame 3 after the gap (interval 10)
		const report = trace.buildReport();
		expect(report.settle.suspendedGapCount).toBe(1);
		expect(report.settle.frameCount).toBe(3);
		expect(report.settle.maxIntervalMs).toBe(10);
		// The window was dropped, so stability needs a fresh 90 frames —
		// the post-gap frame above is the first of them.
		drive(win, 88, 10);
		expect(trace.buildReport().settle.timeToStableMs).toBeNull();
		win.__tick(10); // the 90th frame since the suspension
		expect(trace.buildReport().settle.timeToStableMs).not.toBeNull();
	});
});

describe("ColdStartTrace Markdown labels (§十三)", () => {
	it("aggregates label render durations with first/last timestamps", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		win.__tick(120);
		trace.noteMarkdownLabel(4);
		win.__tick(80);
		trace.noteMarkdownLabel(7.5);
		const labels = trace.buildReport().markdownLabels;
		expect(labels.renderCount).toBe(2);
		expect(labels.totalMs).toBe(11.5);
		expect(labels.maxMs).toBe(7.5);
		expect(labels.firstRenderAtMs).toBe(120);
		expect(labels.lastRenderAtMs).toBe(200);
	});

	it("reports zeroed label statistics when nothing rendered", () => {
		const win = makeFakeWindow();
		const labels = new ColdStartTrace(win, 0).buildReport().markdownLabels;
		expect(labels).toEqual({
			renderCount: 0,
			totalMs: 0,
			maxMs: 0,
			firstRenderAtMs: null,
			lastRenderAtMs: null,
		});
	});

	it("stops collecting once the trace is complete", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.dispose();
		trace.noteMarkdownLabel(9);
		expect(trace.buildReport().markdownLabels.renderCount).toBe(0);
	});
});

describe("ColdStartTrace ambient hooks (§十三)", () => {
	it("is a no-op when no trace is armed", () => {
		expect(getActiveColdStartTrace()).toBeNull();
		expect(() => {
			markColdStart("firstOutlineDomCommit");
			noteColdStartInteraction("firstMotionFrame");
			noteColdStartMarkdownLabel(3);
		}).not.toThrow();
	});

	it("routes hot-path hooks into the armed trace", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		setActiveColdStartTrace(trace);
		expect(getActiveColdStartTrace()).toBe(trace);

		win.__tick(40);
		markColdStart("firstOutlineDomCommit");
		markColdStart("firstOutlineDomCommit"); // deduped
		noteColdStartInteraction("firstAutoScrollFrame");
		noteColdStartMarkdownLabel(2.5);

		const report = trace.buildReport();
		const names = report.milestones.map((m) => m.name);
		expect(names.filter((n) => n === "firstOutlineDomCommit")).toHaveLength(1);
		expect(report.settle.firstInteraction).toBe("firstAutoScrollFrame");
		expect(report.markdownLabels.renderCount).toBe(1);
	});

	it("clears the ambient reference when the armed trace is disposed", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		setActiveColdStartTrace(trace);
		trace.dispose();
		expect(getActiveColdStartTrace()).toBeNull();
		expect(() => markColdStart("firstGeometryBuild")).not.toThrow();
	});
});

describe("ColdStartTrace report shape (§十一/§十二)", () => {
	it("echoes the stability criteria so a report is self-describing", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		const report = trace.buildReport();
		expect(report.settle.maxObservationMs).toBe(30000);
		expect(report.settle.bucketMs).toBe(1000);
		expect(report.settle.budgetMs).toBe(16.7);
		expect(report.settle.stableWindowMs).toBe(2000);
		expect(report.settle.stableMinimumFrameCount).toBe(90);
		expect(report.settle.stableP95BudgetMs).toBe(20);
		expect(report.settle.stableOver33RatioBudget).toBe(0.02);
		expect(report.settle.buckets).toHaveLength(0); // trimmed to observed
		expect(typeof report.capturedAt).toBe("string");
		expect(report.complete).toBe(false);
		expect(report.settleWatchStarted).toBe(false);
		expect(report.settle.firstInteraction).toBeNull();
		expect(report.settle.warmupDurationMs).toBeNull();
	});
});
