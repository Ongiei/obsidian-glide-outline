/**
 * On-demand performance sampling (section 3). NEVER always-on: every hot
 * path guards with `perf.active` (a plain boolean read) and records only
 * while a capture is running. All storage is a fixed-length ring buffer —
 * a runaway capture can never grow memory. Nothing here prints to the
 * console per frame; the report is produced once, on stop.
 */

/** Ring buffer capacity for frame intervals (~85 s at 60 fps). */
const FRAME_RING_CAPACITY = 5120;

/**
 * Frame intervals above this are treated as SUSPENDED time (window hidden,
 * app in background, machine asleep) rather than jank: they are excluded
 * from avg/p95/max/over-budget stats and tracked separately. No real
 * render loop produces a 250 ms+ frame that is meaningfully "slow" —
 * beyond this the RAF loop was throttled or paused entirely.
 */
const SUSPENDED_GAP_THRESHOLD_MS = 250;

/** Counter keys — one increment site per hot-path event. */
export interface PerfCounters {
	rafCount: number;
	pointermoveCount: number;
	solverRuns: number;
	/** Total solver time, ms (only measured while capturing). */
	solverDurationMs: number;
	/** Rows fed to the solver, summed over runs (avg = /solverRuns). */
	activeSolverRowTotal: number;
	geometryRebuildCount: number;
	rowRectReadCount: number;
	markerCardRectReadCount: number;
	cssVarWriteCount: number;
	cacheInvalidationCount: number;
	/** Envelope rebuilds and the rows they touched. */
	envelopeRebuildCount: number;
	envelopeRowTotal: number;
	autoScrollFrameCount: number;
	longTaskCount: number;
	longTaskTotalMs: number;
}

function zeroCounters(): PerfCounters {
	return {
		rafCount: 0,
		pointermoveCount: 0,
		solverRuns: 0,
		solverDurationMs: 0,
		activeSolverRowTotal: 0,
		geometryRebuildCount: 0,
		rowRectReadCount: 0,
		markerCardRectReadCount: 0,
		cssVarWriteCount: 0,
		cacheInvalidationCount: 0,
		envelopeRebuildCount: 0,
		envelopeRowTotal: 0,
		autoScrollFrameCount: 0,
		longTaskCount: 0,
		longTaskTotalMs: 0,
	};
}

export interface PerfReport {
	capturedAt: string;
	captureDurationMs: number;
	frames: {
		count: number;
		intervalAvgMs: number;
		intervalP95Ms: number;
		intervalMaxMs: number;
		over16_7ms: number;
		over33_3ms: number;
		/** Intervals > 250 ms treated as suspension, not jank. */
		suspendedGapCount: number;
		suspendedGapTotalMs: number;
		maxSuspendedGapMs: number;
	};
	counters: PerfCounters;
	derived: {
		avgSolverRows: number;
		avgSolverDurationMs: number;
		avgEnvelopeRows: number;
		avgCssWritesPerFrame: number;
		avgRectReadsPerFrame: number;
	};
}

interface LongTaskEntryLike {
	duration: number;
}

export class PerfCapture {
	/** Hot-path guard — read directly (cheaper than a method call). */
	active = false;

	private counters: PerfCounters = zeroCounters();
	private readonly intervals = new Float64Array(FRAME_RING_CAPACITY);
	private ringLength = 0;
	private ringNext = 0;
	private lastFrameTime = Number.NaN;
	private startedAt = 0;
	private longTaskObserver: { disconnect(): void } | null = null;
	/** Suspension stats (section: pause-aware capture). */
	private suspendedGapCount = 0;
	private suspendedGapTotalMs = 0;
	private maxSuspendedGapMs = 0;
	/** Removes visibilitychange/blur/focus listeners added on start. */
	private removeSuspensionListeners: (() => void) | null = null;

	/** Begin a capture; resets all previous data. Idempotent. */
	start(win: Window & typeof globalThis): void {
		if (this.active) return;
		this.counters = zeroCounters();
		this.ringLength = 0;
		this.ringNext = 0;
		this.lastFrameTime = Number.NaN;
		this.suspendedGapCount = 0;
		this.suspendedGapTotalMs = 0;
		this.maxSuspendedGapMs = 0;
		this.startedAt = win.performance.now();
		this.active = true;
		this.observeLongTasks(win);
		this.observeSuspension(win);
	}

	/**
	 * Stop and build the report. The longtask observer AND the suspension
	 * listeners are ALWAYS removed here — sampling has zero standing cost
	 * afterwards.
	 */
	stop(win: Window & typeof globalThis): PerfReport | null {
		if (!this.active) return null;
		this.active = false;
		this.longTaskObserver?.disconnect();
		this.longTaskObserver = null;
		this.removeSuspensionListeners?.();
		this.removeSuspensionListeners = null;
		const durationMs = win.performance.now() - this.startedAt;
		return this.buildReport(durationMs);
	}

	/** Feed one RAF timestamp; consecutive calls produce intervals. */
	recordFrame(now: number): void {
		if (!this.active) return;
		this.counters.rafCount++;
		if (Number.isFinite(this.lastFrameTime)) {
			const interval = now - this.lastFrameTime;
			if (Number.isFinite(interval) && interval >= 0) {
				if (interval > SUSPENDED_GAP_THRESHOLD_MS) {
					// Window was hidden/backgrounded — this is not a slow
					// frame. Track it separately, keep it out of the ring.
					this.suspendedGapCount++;
					this.suspendedGapTotalMs += interval;
					if (interval > this.maxSuspendedGapMs) {
						this.maxSuspendedGapMs = interval;
					}
				} else {
					this.intervals[this.ringNext] = interval;
					this.ringNext = (this.ringNext + 1) % FRAME_RING_CAPACITY;
					if (this.ringLength < FRAME_RING_CAPACITY) {
						this.ringLength++;
					}
				}
			}
		}
		this.lastFrameTime = now;
	}

	/** Break the frame-interval chain (RAF loop went idle). */
	markFrameGap(): void {
		this.lastFrameTime = Number.NaN;
	}

	count(key: keyof PerfCounters, n = 1): void {
		if (!this.active) return;
		this.counters[key] += n;
	}

	addSolverSample(durationMs: number, rows: number): void {
		if (!this.active) return;
		this.counters.solverRuns++;
		this.counters.solverDurationMs += durationMs;
		this.counters.activeSolverRowTotal += rows;
	}

	addEnvelopeSample(rows: number): void {
		if (!this.active) return;
		this.counters.envelopeRebuildCount++;
		this.counters.envelopeRowTotal += rows;
	}

	/**
	 * Break the frame chain the moment the window hides or loses focus, so
	 * the (possibly enormous) wall-clock gap never reaches the interval
	 * math at all — the >250 ms threshold is only the fallback for gaps
	 * these events do not cover (e.g. OS-level sleep without an event).
	 */
	private observeSuspension(win: Window & typeof globalThis): void {
		// Accessed defensively like the longtask observer: a stripped-down
		// runtime without events still gets the >250 ms threshold fallback.
		const doc = (win as { document?: Document }).document;
		if (
			typeof win.addEventListener !== "function" ||
			typeof doc?.addEventListener !== "function"
		) {
			return;
		}
		const onGap = (): void => this.markFrameGap();
		doc.addEventListener("visibilitychange", onGap);
		win.addEventListener("blur", onGap);
		win.addEventListener("focus", onGap);
		this.removeSuspensionListeners = () => {
			doc.removeEventListener("visibilitychange", onGap);
			win.removeEventListener("blur", onGap);
			win.removeEventListener("focus", onGap);
		};
	}

	private observeLongTasks(win: Window & typeof globalThis): void {
		const PO = (
			win as unknown as {
				PerformanceObserver?: new (
					cb: (list: { getEntries(): LongTaskEntryLike[] }) => void,
				) => { observe(o: object): void; disconnect(): void };
			}
		).PerformanceObserver;
		if (typeof PO !== "function") return;
		try {
			const observer = new PO((list) => {
				for (const entry of list.getEntries()) {
					this.counters.longTaskCount++;
					this.counters.longTaskTotalMs += entry.duration;
				}
			});
			observer.observe({ entryTypes: ["longtask"] });
			this.longTaskObserver = observer;
		} catch {
			// longtask unsupported in this runtime — frame stats still work.
		}
	}

	private buildReport(durationMs: number): PerfReport {
		const n = this.ringLength;
		const sorted = new Float64Array(n);
		let sum = 0;
		let max = 0;
		let over16 = 0;
		let over33 = 0;
		for (let i = 0; i < n; i++) {
			const v = this.intervals[i];
			sorted[i] = v;
			sum += v;
			if (v > max) max = v;
			if (v > 16.7) over16++;
			if (v > 33.3) over33++;
		}
		sorted.sort();
		const p95 = n > 0 ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
		const c = this.counters;
		const frameDiv = Math.max(1, c.rafCount);
		return {
			capturedAt: new Date().toISOString(),
			captureDurationMs: round2(durationMs),
			frames: {
				count: n,
				intervalAvgMs: round2(n > 0 ? sum / n : 0),
				intervalP95Ms: round2(p95),
				intervalMaxMs: round2(max),
				over16_7ms: over16,
				over33_3ms: over33,
				suspendedGapCount: this.suspendedGapCount,
				suspendedGapTotalMs: round2(this.suspendedGapTotalMs),
				maxSuspendedGapMs: round2(this.maxSuspendedGapMs),
			},
			counters: { ...c },
			derived: {
				avgSolverRows: round2(
					c.solverRuns > 0 ? c.activeSolverRowTotal / c.solverRuns : 0,
				),
				avgSolverDurationMs: round2(
					c.solverRuns > 0 ? c.solverDurationMs / c.solverRuns : 0,
				),
				avgEnvelopeRows: round2(
					c.envelopeRebuildCount > 0
						? c.envelopeRowTotal / c.envelopeRebuildCount
						: 0,
				),
				avgCssWritesPerFrame: round2(c.cssVarWriteCount / frameDiv),
				avgRectReadsPerFrame: round2(
					(c.rowRectReadCount + c.markerCardRectReadCount) / frameDiv,
				),
			},
		};
	}
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
