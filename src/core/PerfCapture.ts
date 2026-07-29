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
	/** Auto-scroll session lifecycle (§十八). */
	autoScrollFrameCount: number;
	autoScrollStartCount: number;
	autoScrollStopCount: number;
	/** §十九: frames where the EDGE mechanism contributed velocity. */
	autoScrollEdgeFrameCount: number;
	/** §十九: frames where pointer-follow pre-scroll contributed. */
	pointerFollowFrameCount: number;
	/**
	 * §四.1: renderer long tasks (PerformanceObserver "longtask"). The
	 * "renderer" prefix is deliberate — these are whole-renderer stalls
	 * (any plugin, Obsidian itself, GC), NOT necessarily ours; the plugin
	 * phase stats below are what isolates OUR share of a frame.
	 */
	rendererLongTaskCount: number;
	rendererLongTaskTotalMs: number;
	rendererLongTaskMaxMs: number;
	/** §八: measureRows dedup effectiveness. */
	measureRowsRunCount: number;
	measureRowsReadCount: number;
	measureRowsWriteCount: number;
	measureRowsSkippedWriteCount: number;
	/** §十一: wheel routing outcome histogram. */
	wheelEventCount: number;
	wheelOutlineCount: number;
	wheelEditorHandoffCount: number;
	wheelIgnoredCount: number;
	wheelCooldownStartCount: number;
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
		autoScrollStartCount: 0,
		autoScrollStopCount: 0,
		autoScrollEdgeFrameCount: 0,
		pointerFollowFrameCount: 0,
		rendererLongTaskCount: 0,
		rendererLongTaskTotalMs: 0,
		rendererLongTaskMaxMs: 0,
		measureRowsRunCount: 0,
		measureRowsReadCount: 0,
		measureRowsWriteCount: 0,
		measureRowsSkippedWriteCount: 0,
		wheelEventCount: 0,
		wheelOutlineCount: 0,
		wheelEditorHandoffCount: 0,
		wheelIgnoredCount: 0,
		wheelCooldownStartCount: 0,
	};
}

/**
 * §四.2 plugin RAF phase names. Every duration is measured INSIDE our own
 * frame callback with performance.now() pairs, so — unlike the renderer
 * long tasks — these are unambiguously the plugin's own JS cost.
 */
export type PluginPhase =
	| "pluginFrameJs"
	| "read"
	| "styleWrite"
	| "envelopeMotionUpdate"
	| "autoScroll";

const PLUGIN_PHASES: readonly PluginPhase[] = [
	"pluginFrameJs",
	"read",
	"styleWrite",
	"envelopeMotionUpdate",
	"autoScroll",
];

/** Per-phase ring capacity (~17 s of frames at 60 fps — enough for p95). */
const PHASE_RING_CAPACITY = 1024;

export interface PhaseStats {
	count: number;
	avgMs: number;
	p95Ms: number;
	maxMs: number;
}

class PhaseAccumulator {
	count = 0;
	totalMs = 0;
	maxMs = 0;
	private readonly ring = new Float64Array(PHASE_RING_CAPACITY);
	private ringLength = 0;
	private ringNext = 0;

	add(ms: number): void {
		this.count++;
		this.totalMs += ms;
		if (ms > this.maxMs) this.maxMs = ms;
		this.ring[this.ringNext] = ms;
		this.ringNext = (this.ringNext + 1) % PHASE_RING_CAPACITY;
		if (this.ringLength < PHASE_RING_CAPACITY) this.ringLength++;
	}

	stats(): PhaseStats {
		const n = this.ringLength;
		const sorted = new Float64Array(n);
		for (let i = 0; i < n; i++) sorted[i] = this.ring[i];
		sorted.sort();
		const p95 = n > 0 ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
		return {
			count: this.count,
			avgMs: round2(this.count > 0 ? this.totalMs / this.count : 0),
			p95Ms: round2(p95),
			maxMs: round2(this.maxMs),
		};
	}
}

/** Config echo captured with the auto-scroll samples (§十八). */
export interface AutoScrollConfigEcho {
	configuredSpeed: number;
	configuredTriggerArea: number;
	computedPreZone: number;
	computedStrongZone: number;
	hysteresisPx: number;
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
	/** §十八: auto-scroll session detail + config echo. */
	autoScroll: {
		stopReasons: Record<string, number>;
		avgTargetVelocity: number;
		avgAppliedVelocity: number;
		config: AutoScrollConfigEcho | null;
	};
	/** §十五: why full geometry rebuilds ran. */
	geometryRebuildReasons: Record<string, number>;
	/** §四.2: plugin RAF phase durations (count/avg/p95/max per phase). */
	pluginPhases: Record<PluginPhase, PhaseStats>;
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
	/** §十八: stop-reason / rebuild-reason histograms + velocity sums. */
	private stopReasons: Record<string, number> = {};
	private geometryRebuildReasons: Record<string, number> = {};
	private autoScrollTargetSum = 0;
	private autoScrollAppliedSum = 0;
	private autoScrollSampleCount = 0;
	private autoScrollConfig: AutoScrollConfigEcho | null = null;
	/** §四.2: per-phase duration accumulators (allocated on start). */
	private phases = new Map<PluginPhase, PhaseAccumulator>();

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
		this.stopReasons = {};
		this.geometryRebuildReasons = {};
		this.autoScrollTargetSum = 0;
		this.autoScrollAppliedSum = 0;
		this.autoScrollSampleCount = 0;
		this.autoScrollConfig = null;
		this.phases = new Map();
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

	/** §十八: histogram of why auto-scroll sessions ended. */
	countStopReason(reason: string): void {
		if (!this.active) return;
		this.stopReasons[reason] = (this.stopReasons[reason] ?? 0) + 1;
	}

	/** §十五: histogram of why full geometry rebuilds ran. */
	countRebuildReason(reason: string): void {
		if (!this.active) return;
		this.geometryRebuildReasons[reason] =
			(this.geometryRebuildReasons[reason] ?? 0) + 1;
	}

	/** §十八: per-frame target vs applied velocity (magnitudes, px/s). */
	addAutoScrollSample(targetVelocity: number, appliedVelocity: number): void {
		if (!this.active) return;
		this.autoScrollTargetSum += Math.abs(targetVelocity);
		this.autoScrollAppliedSum += Math.abs(appliedVelocity);
		this.autoScrollSampleCount++;
	}

	/** §十八: echo the effective auto-scroll configuration (last wins). */
	setAutoScrollConfig(config: AutoScrollConfigEcho): void {
		if (!this.active) return;
		this.autoScrollConfig = config;
	}

	/** §四.2: one plugin phase duration sample (ms). Ring-buffered. */
	addPhaseSample(phase: PluginPhase, durationMs: number): void {
		if (!this.active) return;
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		let acc = this.phases.get(phase);
		if (!acc) {
			acc = new PhaseAccumulator();
			this.phases.set(phase, acc);
		}
		acc.add(durationMs);
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
					this.counters.rendererLongTaskCount++;
					this.counters.rendererLongTaskTotalMs += entry.duration;
					if (entry.duration > this.counters.rendererLongTaskMaxMs) {
						this.counters.rendererLongTaskMaxMs = entry.duration;
					}
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
			autoScroll: {
				stopReasons: { ...this.stopReasons },
				avgTargetVelocity: round2(
					this.autoScrollSampleCount > 0
						? this.autoScrollTargetSum / this.autoScrollSampleCount
						: 0,
				),
				avgAppliedVelocity: round2(
					this.autoScrollSampleCount > 0
						? this.autoScrollAppliedSum / this.autoScrollSampleCount
						: 0,
				),
				config: this.autoScrollConfig ? { ...this.autoScrollConfig } : null,
			},
			geometryRebuildReasons: { ...this.geometryRebuildReasons },
			pluginPhases: this.buildPhaseStats(),
		};
	}

	/** §四.2: stats for every known phase (zeroes when never sampled). */
	private buildPhaseStats(): Record<PluginPhase, PhaseStats> {
		const empty: PhaseStats = { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
		const out = {} as Record<PluginPhase, PhaseStats>;
		for (const phase of PLUGIN_PHASES) {
			const acc = this.phases.get(phase);
			out[phase] = acc ? acc.stats() : { ...empty };
		}
		return out;
	}
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
