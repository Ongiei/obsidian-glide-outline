/**
 * §八/§九/§十一–§十三: one-shot cold-start trace.
 *
 * A performance capture cannot measure the one moment that matters most on
 * a slow machine — the plugin's OWN load — because it has to be started by
 * a command that only exists after load. This trace closes that gap: a
 * command arms a persisted latch, the NEXT `onload` reads the latch, builds
 * the trace at t0 and clears the latch again (so it fires exactly once per
 * arm), then records named milestones through startup and watches frames
 * until the outline reaches a stable steady state.
 *
 * Four things are measured:
 *   - MILESTONES: named timestamps relative to t0 (settings loaded, provider
 *     ready, commands registered, layout ready, and the §十三 first-use
 *     milestones), so a long onload can be localised to the step that owns
 *     it.
 *   - TIME BUCKETS: per-second frame statistics — count, average / p95 /
 *     max interval, over-20 ms and over-33.3 ms counts, renderer long
 *     tasks — so the SHAPE of the post-load transient is visible.
 *   - STABLE WINDOW (§十一): the first instant a 2 s statistical window
 *     qualifies as smooth. The old rule ("no frame slower than 16.7 ms for
 *     500 ms") could not be satisfied on real hardware: vsync jitter alone
 *     produces 17–18 ms intervals, so a perfectly smooth outline reported
 *     "never stable" and the metric was useless for finding the actual
 *     stall. Stability is now a distribution property.
 *   - WARM-UP / FIRST INTERACTION (§十二): a freshly loaded outline that
 *     nobody has touched is trivially "stable" — it is doing nothing. The
 *     number worth reporting is how long after the user's FIRST real
 *     interaction the outline settles, so the trace waits for one.
 *
 * Everything is bounded: the frame watch self-terminates at the 30 s
 * ceiling (or is cancelled on unload / when developer mode is switched
 * off), so there is never a standing RAF loop.
 */

/** §十二: hard ceiling on the observation, ms after the watch begins. */
const MAX_OBSERVATION_MS = 30_000;

/** Width of one settle bucket → MAX_OBSERVATION_MS / this = bucket count. */
const SETTLE_BUCKET_MS = 1000;

const SETTLE_BUCKET_COUNT = Math.ceil(MAX_OBSERVATION_MS / SETTLE_BUCKET_MS);

/** §十一: length of the rolling window judged for stability. */
const STABLE_WINDOW_MS = 2000;

/**
 * §十一: a window holding fewer samples than this cannot declare victory —
 * 90 frames is ~1.5 s of 60 fps, so a couple of lucky frames in an
 * otherwise starved renderer can never qualify.
 */
const STABLE_MIN_FRAME_COUNT = 90;

/** §十一: p95 frame interval ceiling inside the window, ms. */
const STABLE_P95_MS = 20;

/** §十一: share of window frames allowed to exceed 33.3 ms. */
const STABLE_OVER_33_RATIO = 0.02;

/**
 * §十一: 16.7 ms is kept ONLY as a raw statistic. It is the 60 fps frame
 * time, which means an on-time frame lands within a rounding error of it —
 * using it as a pass/fail gate measured vsync jitter, not jank.
 */
const FRAME_BUDGET_MS = 16.7;

/** §十一: the two thresholds that actually describe a dropped frame. */
const OVER_20_MS = 20;
const OVER_33_MS = 33.3;

/** §十二: minimum observation once the first real interaction lands. */
const MIN_INTERACTION_OBSERVATION_MS = 10_000;

/** §十二: keep watching this long after stability is first declared. */
const POST_STABLE_OBSERVATION_MS = 1000;

/**
 * Intervals beyond this are suspension (window hidden, machine asleep), not
 * jank: they must not break the stable streak nor inflate the max. Matches
 * PerfCapture's threshold so the two diagnostics agree on what "paused"
 * means.
 */
const SUSPENDED_GAP_THRESHOLD_MS = 250;

/**
 * Interval histogram: one 1 ms bin per millisecond up to the suspension
 * threshold. p95 is read off the histogram instead of sorting a sample
 * array every frame — the trace runs DURING the cold start it measures, so
 * its own cost has to stay negligible.
 */
const HISTOGRAM_BINS = SUSPENDED_GAP_THRESHOLD_MS + 1;

/** Ring capacity for the rolling stability window (2 s at up to ~500 fps). */
const STABLE_SAMPLE_CAPACITY = 1024;

/** Ring capacity for long tasks inside the rolling window. */
const LONG_TASK_SAMPLE_CAPACITY = 256;

/** §十二: the interactions that open the interaction-observation phase. */
export type ColdStartInteraction =
	| "firstPointerEnter"
	| "firstExpand"
	| "firstMotionFrame"
	| "firstAutoScrollFrame";

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
	/** Raw 16.7 ms statistic — NOT a stability gate (§十一). */
	overBudgetFrameCount: number;
	over20msCount: number;
	over33_3msCount: number;
	intervalAvgMs: number;
	/** ±1 ms resolution (histogram bin floor). */
	intervalP95Ms: number;
	intervalMaxMs: number;
	rendererLongTaskCount: number;
	rendererLongTaskTotalMs: number;
	rendererLongTaskMaxMs: number;
}

export interface ColdStartReport {
	capturedAt: string;
	/** True once the frame watch has finished its window (or was stopped). */
	complete: boolean;
	/** True once the frame watch actually began (after layout-ready). */
	settleWatchStarted: boolean;
	milestones: ColdStartMilestone[];
	settle: {
		/** §十二: ceiling on the whole observation. */
		maxObservationMs: number;
		bucketMs: number;
		/** Raw 16.7 ms statistic threshold (§十一: not a gate). */
		budgetMs: number;
		/** §十一: the stability criteria, echoed so a report is self-describing. */
		stableWindowMs: number;
		stableMinimumFrameCount: number;
		stableP95BudgetMs: number;
		stableOver33RatioBudget: number;
		/** How long the watch actually ran, ms. */
		observedMs: number;
		/** ms from settle start to the first stable window; null if never. */
		timeToStableMs: number | null;
		/** §十二: which interaction opened the observation phase. */
		firstInteraction: ColdStartInteraction | null;
		/** §十二: ms since t0 (onload) of that first interaction. */
		firstInteractionAt: number | null;
		timeFromOnloadToFirstInteractionMs: number | null;
		timeFromFirstInteractionToStableMs: number | null;
		/** §十二: settle start → first interaction, i.e. the idle warm-up. */
		warmupDurationMs: number | null;
		/** Frames with a measured interval (seed frame excluded). */
		frameCount: number;
		/** Raw 16.7 ms statistic (§十一). */
		overBudgetFrameCount: number;
		over20msCount: number;
		over33_3msCount: number;
		intervalAvgMs: number;
		intervalP95Ms: number;
		maxIntervalMs: number;
		/** Intervals > SUSPENDED_GAP_THRESHOLD_MS, kept out of the stats. */
		suspendedGapCount: number;
		rendererLongTaskCount: number;
		rendererLongTaskTotalMs: number;
		rendererLongTaskMaxMs: number;
		buckets: ColdStartBucket[];
	};
	/** §十三: Markdown label rendering during the cold start. */
	markdownLabels: {
		renderCount: number;
		totalMs: number;
		maxMs: number;
		/** ms since t0 of the first / last label render; null if none. */
		firstRenderAtMs: number | null;
		lastRenderAtMs: number | null;
	};
}

interface LongTaskEntryLike {
	duration: number;
}

interface PerformanceObserverLike {
	observe(options: object): void;
	disconnect(): void;
}

/**
 * Minimal window surface the trace needs. Kept narrow so tests can inject a
 * stub with a fake clock and a controllable RAF instead of a whole Window.
 */
export interface ColdStartWindowLike {
	performance: { now(): number };
	requestAnimationFrame(callback: (timestamp: number) => void): number;
	cancelAnimationFrame(handle: number): void;
	/** Optional — a runtime without it simply reports zero long tasks. */
	PerformanceObserver?: new (
		callback: (list: { getEntries(): LongTaskEntryLike[] }) => void,
	) => PerformanceObserverLike;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

export class ColdStartTrace {
	private readonly win: ColdStartWindowLike;
	/** t0 — captured on the FIRST line of onload, before loadData. */
	private readonly startedAt: number;
	private readonly milestones: ColdStartMilestone[] = [];
	private readonly markedOnce = new Set<string>();

	// --- settle watch state ------------------------------------------
	private settleWatchStarted = false;
	private settleComplete = false;
	private settleStartAt = Number.NaN;
	private lastSampleAt = Number.NaN;
	private frameHandle = 0;
	private lastFrameAt = Number.NaN;
	private timeToStableMs: number | null = null;
	private stableDeclaredAt = Number.NaN;
	private frameCount = 0;
	private overBudgetFrameCount = 0;
	private over20Count = 0;
	private over33Count = 0;
	private intervalTotalMs = 0;
	private maxIntervalMs = 0;
	private suspendedGapCount = 0;
	private readonly totalHistogram = new Int32Array(HISTOGRAM_BINS);

	// --- §十二 interaction phase --------------------------------------
	private firstInteraction: ColdStartInteraction | null = null;
	private firstInteractionAt = Number.NaN;
	private interactionStartAt = Number.NaN;

	// --- §十一 rolling stability window --------------------------------
	private readonly windowAt = new Float64Array(STABLE_SAMPLE_CAPACITY);
	private readonly windowInterval = new Float64Array(STABLE_SAMPLE_CAPACITY);
	private readonly windowHistogram = new Int32Array(HISTOGRAM_BINS);
	private windowHead = 0;
	private windowSize = 0;
	private windowOver33 = 0;
	private readonly longTaskWindowAt = new Float64Array(
		LONG_TASK_SAMPLE_CAPACITY,
	);
	private longTaskWindowHead = 0;
	private longTaskWindowSize = 0;

	// --- per-bucket statistics ----------------------------------------
	private readonly bucketFrames = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketOverBudget = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketOver20 = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketOver33 = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketIntervalTotal = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketIntervalMax = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketHistogram = new Int32Array(
		SETTLE_BUCKET_COUNT * HISTOGRAM_BINS,
	);
	private readonly bucketLongTaskCount = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketLongTaskTotal = new Float64Array(SETTLE_BUCKET_COUNT);
	private readonly bucketLongTaskMax = new Float64Array(SETTLE_BUCKET_COUNT);

	// --- renderer long tasks -------------------------------------------
	private longTaskObserver: PerformanceObserverLike | null = null;
	private longTaskCount = 0;
	private longTaskTotalMs = 0;
	private longTaskMaxMs = 0;

	// --- §十三 Markdown labels ------------------------------------------
	private markdownRenderCount = 0;
	private markdownTotalMs = 0;
	private markdownMaxMs = 0;
	private markdownFirstAtMs = Number.NaN;
	private markdownLastAtMs = Number.NaN;

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
	 * §十三: record a milestone the FIRST time it happens and ignore every
	 * repeat. All the first-use milestones fire from hot paths (measure
	 * passes, motion frames, label renders), so the guard has to live here
	 * rather than at every call site.
	 */
	markOnce(name: string): void {
		if (this.markedOnce.has(name)) return;
		this.markedOnce.add(name);
		this.mark(name);
	}

	/** True once `name` has been recorded by `markOnce`. */
	hasMarked(name: string): boolean {
		return this.markedOnce.has(name);
	}

	/**
	 * §十二: the user has actually touched the outline. Opens the
	 * interaction-observation phase — stability is only judged from here
	 * on, because an untouched outline is idle, not fast.
	 */
	noteInteraction(name: ColdStartInteraction): void {
		this.markOnce(name);
		if (this.firstInteraction !== null) return;
		if (this.settleComplete) return;
		this.firstInteraction = name;
		const now = this.now();
		this.firstInteractionAt = now - this.startedAt;
		this.interactionStartAt = now;
		this.mark("firstInteraction");
	}

	/** §十三: one Markdown label finished rendering, `durationMs` long. */
	noteMarkdownLabel(durationMs: number): void {
		if (this.settleComplete) return;
		const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
		const atMs = this.now() - this.startedAt;
		this.markdownRenderCount++;
		this.markdownTotalMs += duration;
		if (duration > this.markdownMaxMs) this.markdownMaxMs = duration;
		if (!Number.isFinite(this.markdownFirstAtMs)) {
			this.markdownFirstAtMs = atMs;
		}
		this.markdownLastAtMs = atMs;
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
		this.lastSampleAt = this.settleStartAt;
		this.mark("settleWatchStart");
		this.observeLongTasks();
		this.scheduleFrame();
	}

	/** Cancel the frame watch. Safe to call any number of times. */
	dispose(): void {
		if (this.frameHandle !== 0) {
			this.win.cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
		this.disconnectLongTasks();
		this.settleComplete = true;
		if (activeTrace === this) activeTrace = null;
	}

	/** Build a snapshot report. May be read before the watch completes. */
	buildReport(): ColdStartReport {
		const observedMs = Number.isFinite(this.settleStartAt)
			? Math.max(0, this.lastSampleAt - this.settleStartAt)
			: 0;
		return {
			capturedAt: new Date().toISOString(),
			complete: this.settleComplete,
			settleWatchStarted: this.settleWatchStarted,
			milestones: this.milestones.map((m) => ({ ...m })),
			settle: {
				maxObservationMs: MAX_OBSERVATION_MS,
				bucketMs: SETTLE_BUCKET_MS,
				budgetMs: FRAME_BUDGET_MS,
				stableWindowMs: STABLE_WINDOW_MS,
				stableMinimumFrameCount: STABLE_MIN_FRAME_COUNT,
				stableP95BudgetMs: STABLE_P95_MS,
				stableOver33RatioBudget: STABLE_OVER_33_RATIO,
				observedMs: round2(observedMs),
				timeToStableMs:
					this.timeToStableMs === null
						? null
						: round2(this.timeToStableMs),
				firstInteraction: this.firstInteraction,
				firstInteractionAt: Number.isFinite(this.firstInteractionAt)
					? round2(this.firstInteractionAt)
					: null,
				timeFromOnloadToFirstInteractionMs: Number.isFinite(
					this.firstInteractionAt,
				)
					? round2(this.firstInteractionAt)
					: null,
				timeFromFirstInteractionToStableMs:
					this.timeToStableMs === null ||
					!Number.isFinite(this.interactionStartAt)
						? null
						: round2(
								this.settleStartAt +
									this.timeToStableMs -
									this.interactionStartAt,
							),
				warmupDurationMs: Number.isFinite(this.interactionStartAt)
					? round2(Math.max(0, this.interactionStartAt - this.settleStartAt))
					: null,
				frameCount: this.frameCount,
				overBudgetFrameCount: this.overBudgetFrameCount,
				over20msCount: this.over20Count,
				over33_3msCount: this.over33Count,
				intervalAvgMs: round2(
					this.frameCount > 0 ? this.intervalTotalMs / this.frameCount : 0,
				),
				intervalP95Ms: percentileFromHistogram(
					this.totalHistogram,
					0,
					this.frameCount,
				),
				maxIntervalMs: round2(this.maxIntervalMs),
				suspendedGapCount: this.suspendedGapCount,
				rendererLongTaskCount: this.longTaskCount,
				rendererLongTaskTotalMs: round2(this.longTaskTotalMs),
				rendererLongTaskMaxMs: round2(this.longTaskMaxMs),
				buckets: this.buildBuckets(),
			},
			markdownLabels: {
				renderCount: this.markdownRenderCount,
				totalMs: round2(this.markdownTotalMs),
				maxMs: round2(this.markdownMaxMs),
				firstRenderAtMs: Number.isFinite(this.markdownFirstAtMs)
					? round2(this.markdownFirstAtMs)
					: null,
				lastRenderAtMs: Number.isFinite(this.markdownLastAtMs)
					? round2(this.markdownLastAtMs)
					: null,
			},
		};
	}

	/**
	 * Buckets are trimmed to the observed extent — 30 mostly-empty rows
	 * would bury the interesting first few seconds.
	 */
	private buildBuckets(): ColdStartBucket[] {
		let last = -1;
		for (let i = 0; i < SETTLE_BUCKET_COUNT; i++) {
			if (this.bucketFrames[i] > 0 || this.bucketLongTaskCount[i] > 0) {
				last = i;
			}
		}
		const buckets: ColdStartBucket[] = [];
		for (let i = 0; i <= last; i++) {
			const frames = this.bucketFrames[i];
			buckets.push({
				startMs: i * SETTLE_BUCKET_MS,
				frameCount: frames,
				overBudgetFrameCount: this.bucketOverBudget[i],
				over20msCount: this.bucketOver20[i],
				over33_3msCount: this.bucketOver33[i],
				intervalAvgMs: round2(
					frames > 0 ? this.bucketIntervalTotal[i] / frames : 0,
				),
				intervalP95Ms: percentileFromHistogram(
					this.bucketHistogram,
					i * HISTOGRAM_BINS,
					frames,
				),
				intervalMaxMs: round2(this.bucketIntervalMax[i]),
				rendererLongTaskCount: this.bucketLongTaskCount[i],
				rendererLongTaskTotalMs: round2(this.bucketLongTaskTotal[i]),
				rendererLongTaskMaxMs: round2(this.bucketLongTaskMax[i]),
			});
		}
		return buckets;
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
		if (!Number.isFinite(sinceSettleStart)) {
			this.finishSettle();
			return;
		}
		this.lastSampleAt = now;
		// §十二: the 30 s ceiling — never idle past it.
		if (sinceSettleStart >= MAX_OBSERVATION_MS) {
			this.finishSettle();
			return;
		}
		// First observed frame seeds the interval clock; there is no
		// interval yet, so nothing is counted this frame.
		if (!Number.isFinite(this.lastFrameAt)) {
			this.lastFrameAt = now;
			return;
		}
		const interval = now - this.lastFrameAt;
		this.lastFrameAt = now;
		if (!Number.isFinite(interval) || interval < 0) return;
		// A suspended gap is not jank: drop the rolling window past it and
		// keep it out of the frame statistics entirely.
		if (interval > SUSPENDED_GAP_THRESHOLD_MS) {
			this.suspendedGapCount++;
			this.resetStabilityWindow();
			return;
		}

		const over20 = interval > OVER_20_MS;
		const over33 = interval > OVER_33_MS;
		this.frameCount++;
		this.intervalTotalMs += interval;
		if (interval > FRAME_BUDGET_MS) this.overBudgetFrameCount++;
		if (over20) this.over20Count++;
		if (over33) this.over33Count++;
		if (interval > this.maxIntervalMs) this.maxIntervalMs = interval;
		this.totalHistogram[histogramBin(interval)]++;
		this.recordBucketFrame(sinceSettleStart, interval, over20, over33);
		this.pushWindowSample(now, interval, over33);
		this.evaluateStability(now, sinceSettleStart);
		this.maybeFinish(now, sinceSettleStart);
	}

	/** §十一: is the rolling window smooth enough to call this settled? */
	private evaluateStability(now: number, sinceSettleStart: number): void {
		if (this.timeToStableMs !== null) return;
		// §十二: an untouched outline is idle, not fast — stability is only
		// judged once the user has actually driven it.
		if (!Number.isFinite(this.interactionStartAt)) return;
		this.evictWindow(now);
		if (this.windowSize < STABLE_MIN_FRAME_COUNT) return;
		if (this.longTaskWindowSize > 0) return;
		if (this.windowOver33 / this.windowSize > STABLE_OVER_33_RATIO) return;
		const p95 = percentileFromHistogram(
			this.windowHistogram,
			0,
			this.windowSize,
		);
		if (p95 > STABLE_P95_MS) return;
		this.timeToStableMs = sinceSettleStart;
		this.stableDeclaredAt = now;
		this.mark("stable");
	}

	/**
	 * §十二: the watch ends when BOTH promises are kept — at least 10 s of
	 * interaction observed, and at least 1 s of continued observation
	 * after stability was declared. Without an interaction it simply runs
	 * to the 30 s ceiling.
	 */
	private maybeFinish(now: number, sinceSettleStart: number): void {
		if (this.timeToStableMs === null) return;
		if (!Number.isFinite(this.interactionStartAt)) return;
		if (now - this.interactionStartAt < MIN_INTERACTION_OBSERVATION_MS) return;
		if (now - this.stableDeclaredAt < POST_STABLE_OBSERVATION_MS) return;
		if (sinceSettleStart < 0) return;
		this.finishSettle();
	}

	private recordBucketFrame(
		sinceSettleStart: number,
		interval: number,
		over20: boolean,
		over33: boolean,
	): void {
		const index = this.bucketIndex(sinceSettleStart);
		this.bucketFrames[index]++;
		if (interval > FRAME_BUDGET_MS) this.bucketOverBudget[index]++;
		if (over20) this.bucketOver20[index]++;
		if (over33) this.bucketOver33[index]++;
		this.bucketIntervalTotal[index] += interval;
		if (interval > this.bucketIntervalMax[index]) {
			this.bucketIntervalMax[index] = interval;
		}
		this.bucketHistogram[index * HISTOGRAM_BINS + histogramBin(interval)]++;
	}

	private bucketIndex(sinceSettleStart: number): number {
		let index = Math.floor(sinceSettleStart / SETTLE_BUCKET_MS);
		if (!Number.isFinite(index) || index < 0) index = 0;
		if (index >= SETTLE_BUCKET_COUNT) index = SETTLE_BUCKET_COUNT - 1;
		return index;
	}

	// --- rolling window ------------------------------------------------

	private pushWindowSample(at: number, interval: number, over33: boolean): void {
		if (this.windowSize === STABLE_SAMPLE_CAPACITY) this.popWindowSample();
		const index = (this.windowHead + this.windowSize) % STABLE_SAMPLE_CAPACITY;
		this.windowAt[index] = at;
		this.windowInterval[index] = interval;
		this.windowSize++;
		this.windowHistogram[histogramBin(interval)]++;
		if (over33) this.windowOver33++;
	}

	private popWindowSample(): void {
		if (this.windowSize === 0) return;
		const interval = this.windowInterval[this.windowHead];
		this.windowHistogram[histogramBin(interval)]--;
		if (interval > OVER_33_MS) this.windowOver33--;
		this.windowHead = (this.windowHead + 1) % STABLE_SAMPLE_CAPACITY;
		this.windowSize--;
	}

	private evictWindow(now: number): void {
		const cutoff = now - STABLE_WINDOW_MS;
		while (this.windowSize > 0 && this.windowAt[this.windowHead] < cutoff) {
			this.popWindowSample();
		}
		while (
			this.longTaskWindowSize > 0 &&
			this.longTaskWindowAt[this.longTaskWindowHead] < cutoff
		) {
			this.longTaskWindowHead =
				(this.longTaskWindowHead + 1) % LONG_TASK_SAMPLE_CAPACITY;
			this.longTaskWindowSize--;
		}
	}

	/** A suspension invalidates everything the window thought it knew. */
	private resetStabilityWindow(): void {
		this.windowHead = 0;
		this.windowSize = 0;
		this.windowOver33 = 0;
		this.windowHistogram.fill(0);
		this.longTaskWindowHead = 0;
		this.longTaskWindowSize = 0;
	}

	private pushLongTaskSample(at: number): void {
		if (this.longTaskWindowSize === LONG_TASK_SAMPLE_CAPACITY) {
			this.longTaskWindowHead =
				(this.longTaskWindowHead + 1) % LONG_TASK_SAMPLE_CAPACITY;
			this.longTaskWindowSize--;
		}
		const index =
			(this.longTaskWindowHead + this.longTaskWindowSize) %
			LONG_TASK_SAMPLE_CAPACITY;
		this.longTaskWindowAt[index] = at;
		this.longTaskWindowSize++;
	}

	// --- renderer long tasks --------------------------------------------

	private observeLongTasks(): void {
		const PO = this.win.PerformanceObserver;
		if (typeof PO !== "function") return;
		try {
			const observer = new PO((list) => {
				const now = this.now();
				for (const entry of list.getEntries()) {
					const duration = Number.isFinite(entry.duration)
						? entry.duration
						: 0;
					this.longTaskCount++;
					this.longTaskTotalMs += duration;
					if (duration > this.longTaskMaxMs) this.longTaskMaxMs = duration;
					this.pushLongTaskSample(now);
					const index = this.bucketIndex(now - this.settleStartAt);
					this.bucketLongTaskCount[index]++;
					this.bucketLongTaskTotal[index] += duration;
					if (duration > this.bucketLongTaskMax[index]) {
						this.bucketLongTaskMax[index] = duration;
					}
				}
			});
			observer.observe({ entryTypes: ["longtask"] });
			this.longTaskObserver = observer;
		} catch {
			// longtask unsupported here — frame statistics still work.
		}
	}

	private disconnectLongTasks(): void {
		this.longTaskObserver?.disconnect();
		this.longTaskObserver = null;
	}

	private finishSettle(): void {
		this.settleComplete = true;
		if (this.frameHandle !== 0) {
			this.win.cancelAnimationFrame(this.frameHandle);
			this.frameHandle = 0;
		}
		this.disconnectLongTasks();
	}
}

/** Interval → histogram bin, clamped to the suspension threshold. */
function histogramBin(interval: number): number {
	let bin = Math.floor(interval);
	if (!Number.isFinite(bin) || bin < 0) bin = 0;
	if (bin >= HISTOGRAM_BINS) bin = HISTOGRAM_BINS - 1;
	return bin;
}

/**
 * p95 read off a 1 ms histogram. Resolution is one millisecond (the bin
 * floor), which is far finer than any threshold this trace compares
 * against and costs a fixed 251-step scan instead of a per-frame sort.
 */
function percentileFromHistogram(
	histogram: Int32Array,
	offset: number,
	count: number,
): number {
	if (count <= 0) return 0;
	const rank = Math.ceil(count * 0.95);
	let cumulative = 0;
	for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
		cumulative += histogram[offset + bin];
		if (cumulative >= rank) return bin;
	}
	return HISTOGRAM_BINS - 1;
}

/**
 * §十三: the live trace, if one is armed.
 *
 * The first-use milestones fire from deep inside the view, the
 * magnification controller and the label renderer. Threading a trace
 * reference through all three constructors would put a diagnostic concern
 * into three hot-path signatures forever; a module-local reference that is
 * `null` in every normal session costs one null check at each call site
 * and disappears completely when the trace is disposed.
 */
let activeTrace: ColdStartTrace | null = null;

export function setActiveColdStartTrace(trace: ColdStartTrace | null): void {
	activeTrace = trace;
}

export function getActiveColdStartTrace(): ColdStartTrace | null {
	return activeTrace;
}

/** §十三: record a first-use milestone (no-op without a live trace). */
export function markColdStart(name: string): void {
	activeTrace?.markOnce(name);
}

/** §十二: report a real user interaction with the outline. */
export function noteColdStartInteraction(name: ColdStartInteraction): void {
	activeTrace?.noteInteraction(name);
}

/** §十三: report one Markdown label render duration. */
export function noteColdStartMarkdownLabel(durationMs: number): void {
	activeTrace?.noteMarkdownLabel(durationMs);
}
