/**
 * On-demand performance sampling (section 3). NEVER always-on: every hot
 * path guards with `perf.active` (a plain boolean read) and records only
 * while a capture is running. All storage is a fixed-length ring buffer —
 * a runaway capture can never grow memory. Nothing here prints to the
 * console per frame; the report is produced once, on stop.
 */

import type { ScrollDeltaSource } from "./Diagnostics";

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
	// --- §四/§十四 Range statistics (collision continuity hotfix) ---
	scaleRangeRows: number;
	collisionRangeRows: number;
	writeRangeRows: number;
	collisionRangeExpansionCount: number;
	collisionRangeExpansionRows: number;
	boundarySafetyRetryCount: number;
	// --- §六/§十四 Correctness diagnostics ---
	visibleOverlapViolationCount: number;
	maxVisibleOverlapPx: number;
	staleAnchorResetCount: number;
	cachedAnchorResolveCount: number;
	gapAnchorResolveCount: number;
	// --- §七–§十二 Scroll-intent split statistics ---
	edgeIntentFrameCount: number;
	edgeIntentActivationCount: number;
	kineticIntentFrameCount: number;
	kineticIntentActivationCount: number;
	manualWheelCooldownCount: number;
	// --- §四.2 Scroll pipeline mode + mutation statistics ---
	/** Frames where ONLY the edge mechanism produced velocity. */
	edgeOnlyFrameCount: number;
	/** Frames where ONLY pointer-follow (kinetic) produced velocity. */
	kineticOnlyFrameCount: number;
	/** Frames where both mechanisms contributed (clamped together). */
	combinedIntentFrameCount: number;
	/** Times we actually wrote scroller.scrollTop. */
	scrollTopMutationCount: number;
	/** "scroll" events observed on the outline scroller. */
	scrollEventCount: number;
	/** Scroll events that fired while we were still inside our own write. */
	scrollEventReentrantCount: number;
	/** Scroll events whose delta rounded to zero (pure noise). */
	zeroDeltaScrollEventCount: number;
	/** Writes clamped by the scroll range (top/bottom boundary reached). */
	scrollBoundaryClampCount: number;
	/** Scroll-delta sampling (avg = total / sampleCount). */
	scrollDeltaSampleCount: number;
	scrollDeltaTotalPx: number;
	maxScrollDeltaPx: number;
	// --- §八 Pointer-anchor resolve strategy statistics ---
	/** Anchor found within ±LOCAL_WINDOW of the previous index. */
	anchorLocalHitCount: number;
	/** Anchor found by binary search over sorted content centers. */
	anchorBinaryHitCount: number;
	/** Pointer sat in a transparent gap — no owning row. */
	anchorGapCount: number;
	/** Anchor required the O(n) linear fallback scan. MUST reach 0. */
	anchorFallbackScanCount: number;
	/** Rows actually examined during resolves (avg = /resolve count). */
	anchorResolveCandidateRows: number;
	// --- §九 Sparse dirty-row statistics ---
	dirtyRowsSampleCount: number;
	dirtyRowsTotal: number;
	maxDirtyRows: number;
	/** Rows skipped because their transform was already identity. */
	identityRowsSkipped: number;
	dirtyRowsAdded: number;
	dirtyRowsRemoved: number;
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
		scaleRangeRows: 0,
		collisionRangeRows: 0,
		writeRangeRows: 0,
		collisionRangeExpansionCount: 0,
		collisionRangeExpansionRows: 0,
		boundarySafetyRetryCount: 0,
		visibleOverlapViolationCount: 0,
		maxVisibleOverlapPx: 0,
		staleAnchorResetCount: 0,
		cachedAnchorResolveCount: 0,
		gapAnchorResolveCount: 0,
		edgeIntentFrameCount: 0,
		edgeIntentActivationCount: 0,
		kineticIntentFrameCount: 0,
		kineticIntentActivationCount: 0,
		manualWheelCooldownCount: 0,
		edgeOnlyFrameCount: 0,
		kineticOnlyFrameCount: 0,
		combinedIntentFrameCount: 0,
		scrollTopMutationCount: 0,
		scrollEventCount: 0,
		scrollEventReentrantCount: 0,
		zeroDeltaScrollEventCount: 0,
		scrollBoundaryClampCount: 0,
		scrollDeltaSampleCount: 0,
		scrollDeltaTotalPx: 0,
		maxScrollDeltaPx: 0,
		anchorLocalHitCount: 0,
		anchorBinaryHitCount: 0,
		anchorGapCount: 0,
		anchorFallbackScanCount: 0,
		anchorResolveCandidateRows: 0,
		dirtyRowsSampleCount: 0,
		dirtyRowsTotal: 0,
		maxDirtyRows: 0,
		identityRowsSkipped: 0,
		dirtyRowsAdded: 0,
		dirtyRowsRemoved: 0,
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
	/**
	 * Aggregate of the whole auto-scroll step. KEPT for one version so a
	 * 0.1.3 capture can still be compared against a 0.1.4 capture; the
	 * sub-phases below are what actually localise the cost.
	 */
	| "autoScroll"
	// --- §四.1 auto-scroll sub-phases ---
	/** Deciding whether this frame is allowed to auto-scroll at all. */
	| "scrollEligibility"
	/** Edge-zone intent velocity math. */
	| "edgeIntentMath"
	/** Pointer-follow (kinetic) intent velocity math. */
	| "kineticIntentMath"
	/** Damping/clamping the intent into an applied velocity. */
	| "scrollIntegrator"
	/** The scrollTop write itself. */
	| "scrollTopWrite"
	/** Scroll events dispatched synchronously by that write. */
	| "synchronousScrollDispatch"
	/** Our own "scroll" listener body. */
	| "scrollEventHandler"
	/** Applying the scroll delta to the cached content offset. */
	| "scrollOffsetUpdate"
	/** Re-resolving the pointer anchor after the offset moved. */
	| "scrollAnchorResolve"
	/** Envelope geometry update caused by the scroll. */
	| "scrollEnvelopeUpdate"
	/** Scheduling the next frame from inside the scroll path. */
	| "scrollFrameReschedule";

const PLUGIN_PHASES: readonly PluginPhase[] = [
	"pluginFrameJs",
	"read",
	"styleWrite",
	"envelopeMotionUpdate",
	"autoScroll",
	"scrollEligibility",
	"edgeIntentMath",
	"kineticIntentMath",
	"scrollIntegrator",
	"scrollTopWrite",
	"synchronousScrollDispatch",
	"scrollEventHandler",
	"scrollOffsetUpdate",
	"scrollAnchorResolve",
	"scrollEnvelopeUpdate",
	"scrollFrameReschedule",
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

/**
 * §十.1: pointer-follow gauges. Unlike counters these are *last observed
 * values*, not sums — they answer "what was the tuning and what was the
 * pointer actually doing" when a capture is read back from a machine we
 * cannot debug interactively.
 */
export interface PointerFollowEcho {
	pointerFollowStrength: number;
	edgeMaxSpeed: number;
	kineticMaxSpeed: number;
	combinedMaxSpeed: number;
	currentPointerVelocityY: number;
	predictedPointerY: number;
	pointerSampleCount: number;
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
	/** §四/§十四: row-range windows used by the collision solver. */
	ranges: {
		avgScaleRangeRows: number;
		maxScaleRangeRows: number;
		avgCollisionRangeRows: number;
		maxCollisionRangeRows: number;
		avgWriteRangeRows: number;
		maxWriteRangeRows: number;
		collisionRangeExpansionCount: number;
		collisionRangeExpansionRows: number;
		boundarySafetyRetryCount: number;
	};
	/** §六/§十四: overlap + scroll-anchor correctness diagnostics. */
	correctness: {
		visibleOverlapViolationCount: number;
		maxVisibleOverlapPx: number;
		staleAnchorResetCount: number;
		cachedAnchorResolveCount: number;
		gapAnchorResolveCount: number;
	};
	/** §七–§十二: edge vs kinetic scroll-intent split statistics. */
	scrollIntent: {
		edgeFrameCount: number;
		edgeActivationCount: number;
		edgeStopReasons: Record<string, number>;
		avgEdgeIntentVelocity: number;
		maxEdgeIntentVelocity: number;
		kineticFrameCount: number;
		kineticActivationCount: number;
		kineticStopReasons: Record<string, number>;
		avgKineticIntentVelocity: number;
		maxKineticIntentVelocity: number;
		combinedIntentVelocityAvg: number;
		appliedVelocityAvg: number;
		manualWheelCooldownCount: number;
	};
	/** §四.2: scroll-pipeline mode split + scrollTop mutation behaviour. */
	scrollPipeline: {
		edgeOnlyFrameCount: number;
		kineticOnlyFrameCount: number;
		combinedIntentFrameCount: number;
		scrollTopMutationCount: number;
		scrollEventCount: number;
		scrollEventReentrantCount: number;
		zeroDeltaScrollEventCount: number;
		scrollBoundaryClampCount: number;
		avgScrollDeltaPx: number;
		maxScrollDeltaPx: number;
		/** §十: sample count per attributed scroll source. */
		scrollDeltaBySource: Record<string, number>;
	};
	/** §八: how pointer anchors were resolved (fallbackScanCount must be 0). */
	anchorResolve: {
		localHitCount: number;
		binaryHitCount: number;
		gapCount: number;
		fallbackScanCount: number;
		avgCandidateRows: number;
	};
	/** §九: sparse dirty-row write set behaviour. */
	dirtyRows: {
		avgDirtyRows: number;
		maxDirtyRows: number;
		identityRowsSkipped: number;
		dirtyRowsAdded: number;
		dirtyRowsRemoved: number;
	};
	/** §十.1: pointer-follow tuning + live pointer gauges (null if unused). */
	pointerFollow: PointerFollowEcho | null;
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
	/** §十: scroll-delta sample count per attributed source. */
	private scrollDeltaBySource: Record<string, number> = {};
	private autoScrollTargetSum = 0;
	private autoScrollAppliedSum = 0;
	private autoScrollSampleCount = 0;
	private autoScrollConfig: AutoScrollConfigEcho | null = null;
	/** §十.1: last-observed pointer-follow gauges. */
	private pointerFollowEcho: PointerFollowEcho | null = null;
	/** §八: resolves counted for the candidate-rows average. */
	private anchorResolveCount = 0;
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
		this.scrollDeltaBySource = {};
		this.autoScrollTargetSum = 0;
		this.autoScrollAppliedSum = 0;
		this.autoScrollSampleCount = 0;
		this.autoScrollConfig = null;
		this.rangeSampleCount = 0;
		this.maxScaleRangeRows = 0;
		this.maxCollisionRangeRows = 0;
		this.maxWriteRangeRows = 0;
		this.edgeStopReasons = {};
		this.kineticStopReasons = {};
		this.edgeSampleSum = 0;
		this.edgeSampleMax = 0;
		this.edgeSampleCount = 0;
		this.kineticSampleSum = 0;
		this.kineticSampleMax = 0;
		this.kineticSampleCount = 0;
		this.combinedSampleSum = 0;
		this.combinedSampleMax = 0;
		this.combinedSampleCount = 0;
		this.appliedSampleSum = 0;
		this.appliedSampleMax = 0;
		this.appliedSampleCount = 0;
		this.pointerFollowEcho = null;
		this.anchorResolveCount = 0;
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

	// --- §四/§十四 range sampling ------------------------------------
	private rangeSampleCount = 0;
	private maxScaleRangeRows = 0;
	private maxCollisionRangeRows = 0;
	private maxWriteRangeRows = 0;

	/** §十四: per-frame row counts of the three ranges. */
	addRangeSample(
		scaleRows: number,
		collisionRows: number,
		writeRows: number,
	): void {
		if (!this.active) return;
		this.counters.scaleRangeRows += scaleRows;
		this.counters.collisionRangeRows += collisionRows;
		this.counters.writeRangeRows += writeRows;
		this.maxScaleRangeRows = Math.max(this.maxScaleRangeRows, scaleRows);
		this.maxCollisionRangeRows = Math.max(
			this.maxCollisionRangeRows,
			collisionRows,
		);
		this.maxWriteRangeRows = Math.max(this.maxWriteRangeRows, writeRows);
		this.rangeSampleCount++;
	}

	/** §四: one dynamic collision-boundary expansion (extra rows pulled in). */
	addCollisionExpansionSample(extraRows: number): void {
		if (!this.active) return;
		this.counters.collisionRangeExpansionCount++;
		this.counters.collisionRangeExpansionRows += extraRows;
	}

	// --- §七–§十二 scroll-intent split sampling + histograms ----------
	private edgeStopReasons: Record<string, number> = {};
	private kineticStopReasons: Record<string, number> = {};
	private edgeSampleSum = 0;
	private edgeSampleMax = 0;
	private edgeSampleCount = 0;
	private kineticSampleSum = 0;
	private kineticSampleMax = 0;
	private kineticSampleCount = 0;
	private combinedSampleSum = 0;
	private combinedSampleMax = 0;
	private combinedSampleCount = 0;
	private appliedSampleSum = 0;
	private appliedSampleMax = 0;
	private appliedSampleCount = 0;

	/** §十四: one edge-intent velocity sample (magnitude, px/s). */
	addEdgeIntentSample(velocity: number): void {
		if (!this.active) return;
		this.edgeSampleSum += Math.abs(velocity);
		this.edgeSampleMax = Math.max(this.edgeSampleMax, Math.abs(velocity));
		this.edgeSampleCount++;
	}

	/** §十四: one kinetic-intent velocity sample (magnitude, px/s). */
	addKineticIntentSample(velocity: number): void {
		if (!this.active) return;
		this.kineticSampleSum += Math.abs(velocity);
		this.kineticSampleMax = Math.max(this.kineticSampleMax, Math.abs(velocity));
		this.kineticSampleCount++;
	}

	/** §十四: combined (clamped) intent velocity sample. */
	addCombinedIntentSample(velocity: number): void {
		if (!this.active) return;
		this.combinedSampleSum += Math.abs(velocity);
		this.combinedSampleMax = Math.max(this.combinedSampleMax, Math.abs(velocity));
		this.combinedSampleCount++;
	}

	/** §十四: applied (damped) scroll velocity sample. */
	addAppliedVelocitySample(velocity: number): void {
		if (!this.active) return;
		this.appliedSampleSum += Math.abs(velocity);
		this.appliedSampleMax = Math.max(this.appliedSampleMax, Math.abs(velocity));
		this.appliedSampleCount++;
	}

	/** §十二: histogram of why an EDGE session ended. */
	countEdgeStopReason(reason: string): void {
		if (!this.active) return;
		this.edgeStopReasons[reason] = (this.edgeStopReasons[reason] ?? 0) + 1;
	}

	/** §十二: histogram of why a KINETIC session ended. */
	countKineticStopReason(reason: string): void {
		if (!this.active) return;
		this.kineticStopReasons[reason] = (this.kineticStopReasons[reason] ?? 0) + 1;
	}

	/**
	 * §六/§十四: record a visible-adjacent overlap (px) when it exceeds the
	 * allowed tolerance. Only ever called from a diagnostic pass, never a
	 * standing hot path. Tracks the worst overlap seen.
	 */
	recordOverlap(px: number, tolerance: number): void {
		if (!this.active) return;
		if (Number.isFinite(px) && px > tolerance) {
			this.counters.visibleOverlapViolationCount++;
			if (px > this.counters.maxVisibleOverlapPx) {
				this.counters.maxVisibleOverlapPx = px;
			}
		}
	}

	/** §六: the cached scroll anchor was invalidated by an outline scroll. */
	markStaleAnchorReset(): void {
		this.count("staleAnchorResetCount");
	}

	/** §六: a scroll anchor was re-resolved from cached visual geometry. */
	markCachedAnchorResolve(): void {
		this.count("cachedAnchorResolveCount");
	}

	/** §六: the pointer was over a gap → no anchor, continuous interpolation. */
	markGapAnchorResolve(): void {
		this.count("gapAnchorResolveCount");
	}

	/** §十.1: overwrite the pointer-follow gauges (last write wins). */
	setPointerFollowEcho(echo: PointerFollowEcho): void {
		if (!this.active) return;
		this.pointerFollowEcho = echo;
	}

	/**
	 * §四.2: one applied scroll delta (px, signed input — magnitude kept).
	 * A zero delta is still a sample: it is exactly the "we wrote scrollTop
	 * but nothing moved" case worth seeing in a capture.
	 */
	addScrollDeltaSample(deltaPx: number, source?: ScrollDeltaSource): void {
		if (!this.active) return;
		if (!Number.isFinite(deltaPx)) return;
		if (source) {
			this.scrollDeltaBySource[source] =
				(this.scrollDeltaBySource[source] ?? 0) + 1;
		}
		const magnitude = Math.abs(deltaPx);
		this.counters.scrollDeltaSampleCount++;
		this.counters.scrollDeltaTotalPx += magnitude;
		if (magnitude > this.counters.maxScrollDeltaPx) {
			this.counters.maxScrollDeltaPx = magnitude;
		}
	}

	/**
	 * §八: one pointer-anchor resolve. `strategy` records HOW the row was
	 * found; `candidateRows` is how many rows had to be examined, which is
	 * the number that must stay O(log n) rather than O(n).
	 */
	addAnchorResolveSample(
		strategy: "local" | "binary" | "gap" | "fallback",
		candidateRows: number,
	): void {
		if (!this.active) return;
		switch (strategy) {
			case "local":
				this.counters.anchorLocalHitCount++;
				break;
			case "binary":
				this.counters.anchorBinaryHitCount++;
				break;
			case "gap":
				this.counters.anchorGapCount++;
				break;
			case "fallback":
				this.counters.anchorFallbackScanCount++;
				break;
		}
		if (Number.isFinite(candidateRows) && candidateRows > 0) {
			this.counters.anchorResolveCandidateRows += candidateRows;
		}
		this.anchorResolveCount++;
	}

	/**
	 * §九: one frame's sparse dirty-row set. `identitySkipped` counts rows
	 * we deliberately did NOT write because their transform was already
	 * identity — the whole point of the sparse set.
	 */
	addDirtyRowsSample(dirtyRows: number, identitySkipped = 0): void {
		if (!this.active) return;
		this.counters.dirtyRowsSampleCount++;
		this.counters.dirtyRowsTotal += dirtyRows;
		if (dirtyRows > this.counters.maxDirtyRows) {
			this.counters.maxDirtyRows = dirtyRows;
		}
		this.counters.identityRowsSkipped += identitySkipped;
	}

	/** §九: churn of the dirty set (rows entering / leaving settling). */
	addDirtyRowChurn(added: number, removed: number): void {
		if (!this.active) return;
		this.counters.dirtyRowsAdded += added;
		this.counters.dirtyRowsRemoved += removed;
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
			ranges: {
				avgScaleRangeRows: round2(
					this.rangeSampleCount > 0
						? c.scaleRangeRows / this.rangeSampleCount
						: 0,
				),
				maxScaleRangeRows: this.maxScaleRangeRows,
				avgCollisionRangeRows: round2(
					this.rangeSampleCount > 0
						? c.collisionRangeRows / this.rangeSampleCount
						: 0,
				),
				maxCollisionRangeRows: this.maxCollisionRangeRows,
				avgWriteRangeRows: round2(
					this.rangeSampleCount > 0
						? c.writeRangeRows / this.rangeSampleCount
						: 0,
				),
				maxWriteRangeRows: this.maxWriteRangeRows,
				collisionRangeExpansionCount: c.collisionRangeExpansionCount,
				collisionRangeExpansionRows: c.collisionRangeExpansionRows,
				boundarySafetyRetryCount: c.boundarySafetyRetryCount,
			},
			correctness: {
				visibleOverlapViolationCount: c.visibleOverlapViolationCount,
				maxVisibleOverlapPx: round2(c.maxVisibleOverlapPx),
				staleAnchorResetCount: c.staleAnchorResetCount,
				cachedAnchorResolveCount: c.cachedAnchorResolveCount,
				gapAnchorResolveCount: c.gapAnchorResolveCount,
			},
			scrollIntent: {
				edgeFrameCount: c.edgeIntentFrameCount,
				edgeActivationCount: c.edgeIntentActivationCount,
				edgeStopReasons: { ...this.edgeStopReasons },
				avgEdgeIntentVelocity: round2(
					this.edgeSampleCount > 0
						? this.edgeSampleSum / this.edgeSampleCount
						: 0,
				),
				maxEdgeIntentVelocity: round2(this.edgeSampleMax),
				kineticFrameCount: c.kineticIntentFrameCount,
				kineticActivationCount: c.kineticIntentActivationCount,
				kineticStopReasons: { ...this.kineticStopReasons },
				avgKineticIntentVelocity: round2(
					this.kineticSampleCount > 0
						? this.kineticSampleSum / this.kineticSampleCount
						: 0,
				),
				maxKineticIntentVelocity: round2(this.kineticSampleMax),
				combinedIntentVelocityAvg: round2(
					this.combinedSampleCount > 0
						? this.combinedSampleSum / this.combinedSampleCount
						: 0,
				),
				appliedVelocityAvg: round2(
					this.appliedSampleCount > 0
						? this.appliedSampleSum / this.appliedSampleCount
						: 0,
				),
				manualWheelCooldownCount: c.manualWheelCooldownCount,
			},
			scrollPipeline: {
				edgeOnlyFrameCount: c.edgeOnlyFrameCount,
				kineticOnlyFrameCount: c.kineticOnlyFrameCount,
				combinedIntentFrameCount: c.combinedIntentFrameCount,
				scrollTopMutationCount: c.scrollTopMutationCount,
				scrollEventCount: c.scrollEventCount,
				scrollEventReentrantCount: c.scrollEventReentrantCount,
				zeroDeltaScrollEventCount: c.zeroDeltaScrollEventCount,
				scrollBoundaryClampCount: c.scrollBoundaryClampCount,
				avgScrollDeltaPx: round2(
					c.scrollDeltaSampleCount > 0
						? c.scrollDeltaTotalPx / c.scrollDeltaSampleCount
						: 0,
				),
				maxScrollDeltaPx: round2(c.maxScrollDeltaPx),
				scrollDeltaBySource: { ...this.scrollDeltaBySource },
			},
			anchorResolve: {
				localHitCount: c.anchorLocalHitCount,
				binaryHitCount: c.anchorBinaryHitCount,
				gapCount: c.anchorGapCount,
				fallbackScanCount: c.anchorFallbackScanCount,
				avgCandidateRows: round2(
					this.anchorResolveCount > 0
						? c.anchorResolveCandidateRows / this.anchorResolveCount
						: 0,
				),
			},
			dirtyRows: {
				avgDirtyRows: round2(
					c.dirtyRowsSampleCount > 0
						? c.dirtyRowsTotal / c.dirtyRowsSampleCount
						: 0,
				),
				maxDirtyRows: c.maxDirtyRows,
				identityRowsSkipped: c.identityRowsSkipped,
				dirtyRowsAdded: c.dirtyRowsAdded,
				dirtyRowsRemoved: c.dirtyRowsRemoved,
			},
			pointerFollow: this.pointerFollowEcho
				? { ...this.pointerFollowEcho }
				: null,
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
