/**
 * §八/§九: one-shot cold-start trace.
 *
 * A performance capture cannot measure the one moment that matters most on
 * a slow machine — the plugin's OWN load — because it has to be started by
 * a command that only exists after load. This trace closes that gap: a
 * command arms a persisted latch, the NEXT `onload` reads the latch, builds
 * the trace at t0 and clears the latch again (so it fires exactly once per
 * arm), then records named milestones through startup and, after layout is
 * ready, watches frames until the outline reaches a stable steady state.
 *
 * Three things are measured:
 *   - MILESTONES: named timestamps relative to t0 (settings loaded, provider
 *     ready, commands registered, layout ready…), so a long onload can be
 *     localised to the step that owns it.
 *   - TIME BUCKETS: frame counts and over-budget frame counts binned over
 *     the first few seconds, so the shape of the post-load transient is
 *     visible, not just its total.
 *   - STABLE WINDOW: the first instant a contiguous window of good frames
 *     is observed — "time to stable", the number a cold-start fix moves.
 *
 * Everything is bounded: the frame watch self-terminates at the end of the
 * observation window (or is cancelled on unload), so there is never a
 * standing RAF loop.
 */

/** Total time the frame watch observes after layout-ready. */
const SETTLE_WINDOW_MS = 4000;

/** Width of one settle bucket → SETTLE_WINDOW_MS / this = bucket count. */
const SETTLE_BUCKET_MS = 500;

/**
 * A contiguous window of this length with no over-budget frame counts as
 * "stable". 500 ms ≈ 30 clean frames at 60 fps — long enough that a single
 * lucky frame cannot declare victory.
 */
const STABLE_WINDOW_MS = 500;

/** Frame intervals above this are over budget (the 60 fps frame time). */
const FRAME_BUDGET_MS = 16.7;

/**
 * Intervals beyond this are suspension (window hidden, machine asleep), not
 * jank: they must not break the stable streak nor inflate the max. Matches
 * PerfCapture's threshold so the two diagnostics agree on what "paused"
 * means.
 */
const SUSPENDED_GAP_THRESHOLD_MS = 250;

const SETTLE_BUCKET_COUNT = Math.ceil(SETTLE_WINDOW_MS / SETTLE_BUCKET_MS);

/** A named point in startup, in ms since t0. */
export interface ColdStartMilestone {
	name: string;
	atMs: number;
}

/** One time bucket of the post-load frame watch. */
export interface ColdStartBucket {
	/** Bucket start, ms since the settle watch began. */
	startMs: number;
	frameCount: number;
	overBudgetFrameCount: number;
}

export interface ColdStartReport {
	capturedAt: string;
	/** True once the frame watch has finished its window (or was stopped). */
	complete: boolean;
	/** True once the frame watch actually began (after layout-ready). */
	settleWatchStarted: boolean;
	milestones: ColdStartMilestone[];
	settle: {
		windowMs: number;
		bucketMs: number;
		budgetMs: number;
		stableWindowMs: number;
		/** ms from settle start to the first stable window; null if never. */
		timeToStableMs: number | null;
		/** Frames with a measured interval (seed frame excluded). */
		frameCount: number;
		overBudgetFrameCount: number;
		maxIntervalMs: number;
		/** Intervals > SUSPENDED_GAP_THRESHOLD_MS, kept out of the stats. */
		suspendedGapCount: number;
		buckets: ColdStartBucket[];
	};
}

/**
 * Minimal window surface the trace needs. Kept narrow so tests can inject a
 * stub with a fake clock and a controllable RAF instead of a whole Window.
 */
export interface ColdStartWindowLike {
	performance: { now(): number };
	requestAnimationFrame(callback: (timestamp: number) => void): number;
	cancelAnimationFrame(handle: number): void;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

export class ColdStartTrace {
	private readonly win: ColdStartWindowLike;
	/** t0 — captured on the FIRST line of onload, before loadData. */
	private readonly startedAt: number;
	private readonly milestones: ColdStartMilestone[] = [];

	// --- settle watch state ------------------------------------------
	private settleWatchStarted = false;
	private settleComplete = false;
	private settleStartAt = Number.NaN;
	private frameHandle = 0;
	private lastFrameAt = Number.NaN;
	private stableStreakStart = Number.NaN;
	private timeToStableMs: number | null = null;
	private frameCount = 0;
	private overBudgetFrameCount = 0;
	private maxIntervalMs = 0;
	private suspendedGapCount = 0;
	private readonly bucketFrames = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketOverBudget = new Float64Array(SETTLE_BUCKET_COUNT);

	constructor(win: ColdStartWindowLike, startedAt: number) {
		this.win = win;
		this.startedAt = startedAt;
		// t0 itself is the implicit onload start; record it at exactly 0 so
		// the milestone list always begins from a known origin.
		this.milestones.push({ name: "onloadStart", atMs: 0 });
	}

	/** Record a named milestone at the current elapsed time since t0. */
	mark(name: string): void {
		this.milestones.push({ name, atMs: round2(this.now() - this.startedAt) });
	}

	/**
	 * Begin the post-load frame watch. Called from `onLayoutReady`, after
	 * the outline has had its first chance to mount. Idempotent — a second
	 * call is ignored so a re-entrant layout event cannot start two loops.
	 */
	beginSettleWatch(): void {
		if (this.settleWatchStarted || this.settleComplete) return;
		this.settleWatchStarted = true;
		this.settleStartAt = this.now();
		this.mark("settleWatchStart");
		this.scheduleFrame();
	}

	/** Cancel the frame watch. Safe to call any number of times. */
	dispose(): void {
		if (this.frameHandle !== 0) {
			this.win.cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
		this.settleComplete = true;
	}

	/** Build a snapshot report. May be read before the watch completes. */
	buildReport(): ColdStartReport {
		const buckets: ColdStartBucket[] = [];
		for (let i = 0; i < SETTLE_BUCKET_COUNT; i++) {
			buckets.push({
				startMs: i * SETTLE_BUCKET_MS,
				frameCount: this.bucketFrames[i],
				overBudgetFrameCount: this.bucketOverBudget[i],
			});
		}
		return {
			capturedAt: new Date().toISOString(),
			complete: this.settleComplete,
			settleWatchStarted: this.settleWatchStarted,
			milestones: this.milestones.map((m) => ({ ...m })),
			settle: {
				windowMs: SETTLE_WINDOW_MS,
				bucketMs: SETTLE_BUCKET_MS,
				budgetMs: FRAME_BUDGET_MS,
				stableWindowMs: STABLE_WINDOW_MS,
				timeToStableMs:
					this.timeToStableMs === null
						? null
						: round2(this.timeToStableMs),
				frameCount: this.frameCount,
				overBudgetFrameCount: this.overBudgetFrameCount,
				maxIntervalMs: round2(this.maxIntervalMs),
				suspendedGapCount: this.suspendedGapCount,
				buckets,
			},
		};
	}

	private now(): number {
		const clock = this.win.performance;
		return typeof clock?.now === "function" ? clock.now() : this.startedAt;
	}

	private scheduleFrame(): void {
		if (this.settleComplete) return;
		if (typeof this.win.requestAnimationFrame !== "function") return;
		this.frameHandle = this.win.requestAnimationFrame(this.onFrame);
	}

	/**
	 * One watched frame. The RAF timestamp is used directly (it is free);
	 * a runtime that hands back a non-finite value falls back to the clock.
	 */
	private readonly onFrame = (timestamp: number): void => {
		this.frameHandle = 0;
		const now = Number.isFinite(timestamp) ? timestamp : this.now();
		this.sampleFrame(now);
		if (!this.settleComplete) this.scheduleFrame();
	};

	private sampleFrame(now: number): void {
		const sinceSettleStart = now - this.settleStartAt;
		// The window is over — stop the loop, never idle past it.
		if (!Number.isFinite(sinceSettleStart) || sinceSettleStart >= SETTLE_WINDOW_MS) {
			this.finishSettle();
			return;
		}
		// First observed frame seeds the interval + streak clocks; there is
		// no interval yet, so nothing is counted this frame.
		if (!Number.isFinite(this.lastFrameAt)) {
			this.lastFrameAt = now;
			this.stableStreakStart = now;
			return;
		}
		const interval = now - this.lastFrameAt;
		this.lastFrameAt = now;
		if (!Number.isFinite(interval) || interval < 0) return;
		// A suspended gap is not jank: reseed the streak past it and keep it
		// out of the frame/over-budget/max statistics entirely.
		if (interval > SUSPENDED_GAP_THRESHOLD_MS) {
			this.suspendedGapCount++;
			this.stableStreakStart = now;
			return;
		}
		const overBudget = interval > FRAME_BUDGET_MS;
		this.frameCount++;
		if (interval > this.maxIntervalMs) this.maxIntervalMs = interval;
		if (overBudget) {
			this.overBudgetFrameCount++;
			this.stableStreakStart = now;
		} else if (
			this.timeToStableMs === null &&
			Number.isFinite(this.stableStreakStart) &&
			now - this.stableStreakStart >= STABLE_WINDOW_MS
		) {
			this.timeToStableMs = now - this.settleStartAt;
		}
		this.recordBucketFrame(sinceSettleStart, overBudget);
	}

	private recordBucketFrame(sinceSettleStart: number, overBudget: boolean): void {
		let index = Math.floor(sinceSettleStart / SETTLE_BUCKET_MS);
		if (index < 0) index = 0;
		if (index >= SETTLE_BUCKET_COUNT) index = SETTLE_BUCKET_COUNT - 1;
		this.bucketFrames[index]++;
		if (overBudget) this.bucketOverBudget[index]++;
	}

	private finishSettle(): void {
		this.settleComplete = true;
		if (this.frameHandle !== 0) {
			this.win.cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
	}
}
