// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ColdStartTrace, type ColdStartWindowLike } from "../src/core/ColdStartTrace";

/**
 * A window stub with a controllable clock and RAF queue. Each `__tick(ms)`
 * advances the clock and fires every RAF callback currently queued, passing
 * the new clock value as the RAF timestamp — exactly the shape
 * ColdStartTrace consumes (it uses the RAF timestamp directly, falls back to
 * performance.now() when that is non-finite).
 */
function makeFakeWindow(): ColdStartWindowLike & {
	__tick: (ms: number) => void;
	__pending: () => number;
} {
	let clock = 0;
	let nextHandle = 1;
	const queue: Array<{ handle: number; cb: (ts: number) => void }> = [];
	const win = {
		performance: { now: () => clock },
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
	};
	return win as unknown as ColdStartWindowLike & {
		__tick: (ms: number) => void;
		__pending: () => number;
	};
}

describe("ColdStartTrace milestones (§八)", () => {
	it("records onloadStart at exactly t0 and marks relative to it", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0); // t0 = 0 ms (matches the clock)
		const report0 = trace.buildReport();
		expect(report0.milestones).toHaveLength(1);
		expect(report0.milestones[0]).toEqual({ name: "onloadStart", atMs: 0 });

		// Advance the clock to 1120 and mark a later milestone.
		win.__tick(120); // clock → 1120
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

	it("dispose cancels the pending frame and marks the report complete", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		expect(win.__pending()).toBe(1);
		trace.dispose();
		expect(win.__pending()).toBe(0);
		const report = trace.buildReport();
		expect(report.complete).toBe(true);
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

	it("self-terminates after the settle window and stops scheduling", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		// 100 ms per frame; the window ends at 4000 ms → finishes around tick 40.
		for (let i = 0; i < 60; i++) win.__tick(100);
		const report = trace.buildReport();
		expect(report.complete).toBe(true);
		expect(win.__pending()).toBe(0); // no standing RAF loop
		// Confirm it stays quiet after the window closes.
		win.__tick(100);
		expect(win.__pending()).toBe(0);
	});
});

describe("ColdStartTrace frame buckets (§九)", () => {
	it("bins frame counts into 500 ms buckets over the 4000 ms window", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		// 12 frames at 100 ms → cumulative sinceSettleStart 100…1200 ms.
		// First frame seeds (no interval); the remaining 11 are counted.
		for (let i = 0; i < 12; i++) win.__tick(100);
		const report = trace.buildReport();
		expect(report.settle.buckets).toHaveLength(8);
		// bucket 0: since 200,300,400 → 3 intervals (100 ms each)
		// bucket 1: since 500,600,700,800,900 → 5 intervals
		// bucket 2: since 1000,1100,1200 → 3 intervals
		expect(report.settle.buckets[0].frameCount).toBe(3);
		expect(report.settle.buckets[1].frameCount).toBe(5);
		expect(report.settle.buckets[2].frameCount).toBe(3);
		// 100 ms > 16.7 ms budget → every counted frame is over budget.
		expect(report.settle.buckets[0].overBudgetFrameCount).toBe(3);
		expect(report.settle.buckets[1].overBudgetFrameCount).toBe(5);
		expect(report.settle.frameCount).toBe(11);
		expect(report.settle.overBudgetFrameCount).toBe(11);
		expect(report.settle.maxIntervalMs).toBe(100);
	});

	it("assigns late frames to the final bucket, then closes the window", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		// 100 ms/frame. Bucket 7 covers sinceSettleStart ∈ [3500, 4000) →
		// frames at ticks 35..39. The 4000 ms frame self-terminates.
		for (let i = 0; i < 45; i++) win.__tick(100);
		const report = trace.buildReport();
		expect(report.complete).toBe(true);
		expect(report.settle.buckets[7].frameCount).toBe(5);
		// 38 counted intervals (ticks 2..39); the 4000 ms frame ends nothing.
		expect(report.settle.frameCount).toBe(38);
		expect(report.settle.overBudgetFrameCount).toBe(38); // 100 ms > budget
	});
});

describe("ColdStartTrace stable window (§九)", () => {
	it("records time-to-stable once 500 ms of contiguous good frames elapse", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		// 10 ms frames are within the 16.7 ms budget → a clean streak.
		// ~51 frames needed before the 500 ms stable window is satisfied.
		for (let i = 0; i < 60; i++) win.__tick(10);
		const report = trace.buildReport();
		expect(report.settle.timeToStableMs).not.toBeNull();
		// Stable at the first frame where (now - streakStart) >= 500 ms.
		expect(report.settle.timeToStableMs).toBeGreaterThanOrEqual(500);
		expect(report.settle.timeToStableMs).toBeLessThanOrEqual(520);
		expect(report.settle.overBudgetFrameCount).toBe(0);
	});

	it("never declares stable under sustained jank (every frame over budget)", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		for (let i = 0; i < 50; i++) win.__tick(100); // 100 ms > budget → streak resets
		const report = trace.buildReport();
		expect(report.settle.timeToStableMs).toBeNull();
		expect(report.settle.overBudgetFrameCount).toBeGreaterThan(0);
	});
});

describe("ColdStartTrace suspended gaps (§九)", () => {
	it("excludes >250 ms gaps from frame stats and keeps the streak intact", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		trace.beginSettleWatch();
		win.__tick(10); // seed
		win.__tick(10); // frame 1 (interval 10)
		win.__tick(10); // frame 2 (interval 10)
		win.__tick(300); // suspension, not jank
		win.__tick(10); // frame 3 after the gap (interval 10)
		const report = trace.buildReport();
		expect(report.settle.suspendedGapCount).toBe(1);
		// Only the two counted 10 ms frames + one post-gap frame reach stats.
		expect(report.settle.frameCount).toBe(3);
		expect(report.settle.maxIntervalMs).toBe(10);
		// The streak survived the gap (it was reseeded), so a later clean
		// run can still reach stable.
		for (let i = 0; i < 60; i++) win.__tick(10);
		const after = trace.buildReport();
		expect(after.settle.timeToStableMs).not.toBeNull();
	});
});

describe("ColdStartTrace report shape (§八/§九)", () => {
	it("exposes the documented window/bucket/budget metadata", () => {
		const win = makeFakeWindow();
		const trace = new ColdStartTrace(win, 0);
		const report = trace.buildReport();
		expect(report.settle.windowMs).toBe(4000);
		expect(report.settle.bucketMs).toBe(500);
		expect(report.settle.budgetMs).toBe(16.7);
		expect(report.settle.stableWindowMs).toBe(500);
		expect(report.settle.buckets).toHaveLength(8);
		expect(typeof report.capturedAt).toBe("string");
		expect(report.complete).toBe(false);
		expect(report.settleWatchStarted).toBe(false);
	});
});
