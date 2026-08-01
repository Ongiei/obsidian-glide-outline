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

/**
 * §三: capture depth.
 *
 * LIGHT is the default. It samples ONLY the mutually exclusive frame
 * segments — six `performance.now()` reads per frame — so a capture can be
 * left running during ordinary use without meaningfully distorting the very
 * frame budget it is measuring.
 *
 * DEEP additionally samples the fine-grained sub-phases (auto-scroll math,
 * scroll pipeline, anchor resolves). It exists to localise a cost once
 * LIGHT has shown that a cost exists, and is EXPECTED to be more expensive;
 * `capture.estimatedOverheadPerFrameMs` in the report quantifies how much.
 */
export type PerfCaptureMode = "light" | "deep";

/** Iterations used to calibrate the telemetry cost model once, on start. */
const CALIBRATION_ITERATIONS = 128;

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
	/**
	 * §六: how the envelope answered discrete pointer events. A gap
	 * crossing must NOT show up as a synchronous rebuild — that is a
	 * forced layout inside an input handler.
	 */
	envelopeEnterDirtyCount: number;
	envelopeEnterReusedCount: number;
	envelopeSyncRebuildCount: number;
	envelopeDerivedLeaveCount: number;
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
	/**
	 * §五.1: edge-fade overflow bookkeeping. The ratio that matters is
	 * `overflowMetricReadCount : overflowMetricRefreshCount` — reads are
	 * served from cache, refreshes force layout.
	 */
	overflowScrollEventCount: number;
	overflowMetricRefreshCount: number;
	overflowMetricReadCount: number;
	/** §五.2: fade-class toggles actually written vs. skipped as no-ops. */
	overflowClassMutationCount: number;
	overflowClassSkippedCount: number;
	/**
	 * §八: collapsed active-heading follow. `failedVisibility` is the one
	 * that matters — it counts rows that were STILL outside the safe band
	 * after the single allowed correction, i.e. the bug this section
	 * exists to catch.
	 */
	activeFollowScrollMutationCount: number;
	activeFollowNoMutationCount: number;
	activeFollowCorrectionCount: number;
	activeFollowFailedVisibilityCount: number;
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
	// --- §七 Compositor layer budget ---
	/**
	 * Rows holding a GPU layer hint, summed per frame. Divided by the
	 * layer sample count these become "how many standing layers does a
	 * moving outline cost", which is the number Windows actually pays.
	 */
	promotedShiftLayerRows: number;
	promotedScaleLayerRows: number;
	/** Layer-class toggles written vs. skipped as no-ops. */
	promotionClassMutationCount: number;
	promotionClassSkippedCount: number;
	// --- §九 Frame scheduling ---
	/** Frames actually requested from requestAnimationFrame. */
	scheduledRafCount: number;
	/** schedule() calls that found a frame already pending. */
	dedupedRafCount: number;
	/** schedule() calls refused because a heading is held. */
	suppressedRafCount: number;
	/** Frames that wrote neither a row style nor the scroller. */
	frameWithoutMotionOrIntentCount: number;
	/** Self-scheduled frames that did nothing and scheduled again. */
	idleRafCount: number;
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
	// --- §三 capture self-diagnostics (the observer effect, measured) ---
	/**
	 * `performance.now()` reads made ON BEHALF OF the capture. Every
	 * timestamp handed to `markPhase`/`endFrameAttribution` counts one.
	 * LIGHT must stay at ~6 per frame; DEEP is expected to be higher.
	 */
	performanceNowCallCount: number;
	/** Phase samples actually stored (LIGHT gates the deep ones out). */
	sampledPhaseCount: number;
	/** Phase marks whose slice was dropped because the phase is gated off. */
	skippedPhaseSampleCount: number;
	/** Auto-scroll config echoes written vs skipped as unchanged. */
	configEchoUpdateCount: number;
	configEchoSkippedCount: number;
	/** Pointer-follow gauge refreshes (in place — never an allocation). */
	pointerEchoUpdateCount: number;
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
		envelopeEnterDirtyCount: 0,
		envelopeEnterReusedCount: 0,
		envelopeSyncRebuildCount: 0,
		envelopeDerivedLeaveCount: 0,
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
		overflowScrollEventCount: 0,
		overflowMetricRefreshCount: 0,
		overflowMetricReadCount: 0,
		overflowClassMutationCount: 0,
		overflowClassSkippedCount: 0,
		activeFollowScrollMutationCount: 0,
		activeFollowNoMutationCount: 0,
		activeFollowCorrectionCount: 0,
		activeFollowFailedVisibilityCount: 0,
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
		promotedShiftLayerRows: 0,
		promotedScaleLayerRows: 0,
		promotionClassMutationCount: 0,
		promotionClassSkippedCount: 0,
		scheduledRafCount: 0,
		dedupedRafCount: 0,
		suppressedRafCount: 0,
		frameWithoutMotionOrIntentCount: 0,
		idleRafCount: 0,
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
		performanceNowCallCount: 0,
		sampledPhaseCount: 0,
		skippedPhaseSampleCount: 0,
		configEchoUpdateCount: 0,
		configEchoSkippedCount: 0,
		pointerEchoUpdateCount: 0,
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
	/**
	 * §四: pure math between the READ and WRITE phases minus the solver
	 * (anchor resolve, motion step inputs, the three ranges, the taper).
	 */
	| "pureCalc"
	/** §四: the collision solver call itself. */
	| "collisionSolve"
	| "styleWrite"
	| "envelopeMotionUpdate"
	/**
	 * Aggregate of the whole auto-scroll step. KEPT for one version so a
	 * 0.1.3 capture can still be compared against a 0.1.4 capture; the
	 * sub-phases below are what actually localise the cost.
	 */
	| "autoScroll"
	/**
	 * §四: `pluginFrameJs` minus the six exclusive segments. This is the
	 * glue — RAF entry, the capture's own bookkeeping, anything not yet
	 * attributed. A LIGHT capture should keep it small; if it grows, the
	 * segments no longer tile the frame and the model needs another mark.
	 */
	| "unattributedFrameJs"
	/**
	 * §三: MODELLED cost of the capture itself this frame (now() reads and
	 * stored samples × their calibrated unit costs). Not wall-clock — a
	 * measurement of the measurement cannot be free.
	 */
	| "telemetryBookkeeping"
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
	| "scrollFrameReschedule"
	/** §五.1: the view's own scroll listener (edge-fade bookkeeping). */
	| "viewOverflowHandler";

const PLUGIN_PHASES: readonly PluginPhase[] = [
	"pluginFrameJs",
	"read",
	"pureCalc",
	"collisionSolve",
	"styleWrite",
	"envelopeMotionUpdate",
	"autoScroll",
	"unattributedFrameJs",
	"telemetryBookkeeping",
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
	"viewOverflowHandler",
];

/**
 * §四: the segments that TILE one frame. Each wall-clock slice belongs to
 * exactly one of them, so `Σ exclusive + unattributedFrameJs === pluginFrameJs`
 * by construction. Deep sub-phases are NESTED inside these (they measure the
 * same wall clock again at finer grain) and therefore never join this sum.
 */
const EXCLUSIVE_PHASES: readonly PluginPhase[] = [
	"read",
	"pureCalc",
	"collisionSolve",
	"styleWrite",
	"envelopeMotionUpdate",
	"autoScroll",
];

/** Phases sampled in BOTH modes — the frame-level skeleton. */
const LIGHT_PHASES: ReadonlySet<PluginPhase> = new Set<PluginPhase>([
	...EXCLUSIVE_PHASES,
	"pluginFrameJs",
	"unattributedFrameJs",
	"telemetryBookkeeping",
]);

/** Phase → slot in the per-frame exclusive accumulator. */
const PHASE_SLOT: ReadonlyMap<PluginPhase, number> = new Map(
	PLUGIN_PHASES.map((phase, index) => [phase, index] as const),
);

/**
 * §3.2: the DEEP sub-phases, grouped by the hot path they live on.
 *
 * Instrumenting every sub-phase on every frame is what makes DEEP mode
 * expensive, and most of that cost buys nothing: a phase's avg/p95 does
 * not need EVERY frame, it needs enough frames. So only ONE group is
 * armed at a time and the armed group rotates, dividing the steady-state
 * DEEP instrumentation cost by the number of groups.
 *
 * A group is one HOT PATH — the sites that run together on the same
 * event — because a site cannot skip half a start/stop pair: it either
 * reads the clock or it does not.
 */
export type DeepPhaseGroup =
	/** Sub-phases inside the RAF frame's read/calc segments. */
	| "frameCalc"
	/** Sub-phases inside the auto-scroll intent math. */
	| "autoScrollIntent"
	/** Sub-phases around the scrollTop write. */
	| "scrollWrite"
	/** Sub-phases inside our own scroll listener. */
	| "scrollEvent";

const DEEP_PHASE_GROUPS: readonly DeepPhaseGroup[] = [
	"frameCalc",
	"autoScrollIntent",
	"scrollWrite",
	"scrollEvent",
];

const DEEP_GROUP_OF: ReadonlyMap<PluginPhase, DeepPhaseGroup> = new Map<
	PluginPhase,
	DeepPhaseGroup
>([
	["scrollAnchorResolve", "frameCalc"],
	["scrollEnvelopeUpdate", "frameCalc"],
	["scrollEligibility", "autoScrollIntent"],
	["edgeIntentMath", "autoScrollIntent"],
	["kineticIntentMath", "autoScrollIntent"],
	["scrollIntegrator", "autoScrollIntent"],
	["scrollTopWrite", "scrollWrite"],
	// Measured INSIDE the scroll listener (a write can dispatch it
	// synchronously), so it rotates with the listener, not with the write.
	["synchronousScrollDispatch", "scrollEvent"],
	["scrollEventHandler", "scrollEvent"],
	["scrollOffsetUpdate", "scrollEvent"],
	["scrollFrameReschedule", "scrollEvent"],
	// A different listener, but the SAME hot path: one scroll event runs
	// both, so they arm and go quiet together.
	["viewOverflowHandler", "scrollEvent"],
]);

/**
 * Frames one group stays armed, and — reused deliberately — the length of
 * the opening window in which ALL groups are armed.
 *
 * The warm-up matters: a capture short enough to be read frame by frame
 * (half a second) should be complete, not a lottery over which group
 * happened to be armed. Rotation only starts once the capture is long
 * enough that per-phase statistics, not individual frames, are the point.
 */
const DEEP_ROTATION_FRAMES = 30;

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

/**
 * §3.2: how DEEP time-shared its sub-phase instrumentation.
 *
 * `framesPerGroup` is the denominator for a rotated group's `count`: a
 * group armed for a third of the capture legitimately has a third of the
 * samples. Comparing a rotated count against a frame count without this
 * block will look like dropped data; it is not.
 */
export interface DeepRotationReport {
	enabled: boolean;
	/** Frames each group stays armed (also the warm-up length). */
	rotationFrames: number;
	groupCount: number;
	/** Frames observed while all groups were armed (opening window). */
	warmupFrames: number;
	/** Frames observed after rotation began. */
	rotatedFrames: number;
	/** Completed passes over every group. */
	completedCycles: number;
	/** Group armed when the capture stopped (null before rotation). */
	activeGroup: DeepPhaseGroup | null;
	/** Frames each group was armed for, warm-up included. */
	framesPerGroup: Record<DeepPhaseGroup, number>;
}

/**
 * §三: what the capture cost, in the capture's own words. Read this FIRST
 * when comparing two reports — a DEEP report is not comparable to a LIGHT
 * one until this block is accounted for.
 */
export interface CaptureOverheadReport {
	mode: PerfCaptureMode;
	/** True when the fine-grained sub-phases were sampled. */
	deepPhaseSampling: boolean;
	performanceNowCallCount: number;
	sampledPhaseCount: number;
	skippedPhaseSampleCount: number;
	configEchoUpdateCount: number;
	configEchoSkippedCount: number;
	pointerEchoUpdateCount: number;
	/** §3.2 rotation state — how the deep sub-phases were time-shared. */
	deepRotation: DeepRotationReport;
	/** now() reads per RAF frame — the headline light-vs-deep number. */
	nowCallsPerFrame: number;
	/** Modelled totals from the calibrated unit costs (see below). */
	estimatedOverheadMs: number;
	estimatedOverheadPerFrameMs: number;
	/** Unit costs measured once, at capture start (microseconds). */
	nowCallCostUs: number;
	phaseSampleCostUs: number;
}

export interface PerfReport {
	capturedAt: string;
	captureDurationMs: number;
	/** §三: the observer effect, measured. */
	capture: CaptureOverheadReport;
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
		/** §六: pointerenters served from cached envelope geometry. */
		envelopeEnterReuseShare: number;
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
	/**
	 * §七: compositor layer budget. The maxima must track the scale range,
	 * NOT the visible range — if they grow with the window height the
	 * promotion bound has regressed.
	 */
	layers: {
		avgPromotedShiftLayers: number;
		maxPromotedShiftLayers: number;
		avgPromotedScaleLayers: number;
		maxPromotedScaleLayers: number;
		classMutationCount: number;
		classSkippedCount: number;
		classSkippedShare: number;
	};
	/**
	 * §九: where frames come from. `idleRafCount` is the one that must be
	 * 0 — anything else is description, that one is a verdict.
	 */
	frameScheduling: {
		scheduledRafCount: number;
		scheduledRafByReason: Record<string, number>;
		dedupedRafCount: number;
		dedupedRafByReason: Record<string, number>;
		suppressedRafCount: number;
		frameWithoutMotionOrIntentCount: number;
		idleRafCount: number;
		idleFrameShare: number;
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
	/** §五.1: how often a scroll had to re-measure the scroll box. */
	overflow: {
		scrollEventCount: number;
		metricRefreshCount: number;
		metricReadCount: number;
		/** Share of overflow evaluations served without a layout read. */
		cachedMetricShare: number;
		classMutationCount: number;
		classSkippedCount: number;
		/** Share of evaluations that wrote no class at all. */
		classSkippedShare: number;
	};
	/**
	 * §八: collapsed active-heading follow. `failedVisibilityCount` must
	 * be 0 — anything else means a row stayed off-band after correction.
	 */
	activeFollow: {
		scrollMutationCount: number;
		noMutationCount: number;
		correctionCount: number;
		failedVisibilityCount: number;
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
	/**
	 * §三 hot-path guard for the FINE-GRAINED samples: `active && deep`,
	 * precomputed so a sub-phase site is one boolean read, not a string
	 * comparison. Sites that time a sub-phase MUST check this before they
	 * read `performance.now()` — that read is the cost being avoided.
	 */
	deepActive = false;
	/**
	 * §3.2 per-group hot-path guards. A sub-phase site MUST check the flag
	 * for ITS group (not `deepActive`) before reading the clock — that is
	 * where the rotation's saving actually happens. Plain fields, not a
	 * map lookup, because these are read on the hottest paths we have.
	 */
	deepFrameCalcActive = false;
	deepAutoScrollIntentActive = false;
	deepScrollWriteActive = false;
	deepScrollEventActive = false;
	private mode: PerfCaptureMode = "light";
	// --- §3.2 deep rotation cursor ------------------------------------
	/** Frames left in the current group's slot (or in the warm-up). */
	private deepRotationFramesLeft = 0;
	/** Index into DEEP_PHASE_GROUPS; -1 while every group is armed. */
	private deepRotationGroupIndex = -1;
	private deepWarmupFrames = 0;
	private deepRotatedFrames = 0;
	private deepGroupAdvanceCount = 0;
	private deepFramesPerGroup = new Float64Array(DEEP_PHASE_GROUPS.length);

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
	// --- §四 per-frame exclusive attribution cursor -------------------
	/** Start of the segment currently open (NaN outside a frame). */
	private segmentOpenAt = Number.NaN;
	/** Frame start, for the pluginFrameJs total. */
	private frameOpenAt = Number.NaN;
	/** Per-frame totals per phase slot — flushed once, at frame end. */
	private readonly frameTotals = new Float64Array(PLUGIN_PHASES.length);
	/** Slots touched this frame (avoids scanning all phases at flush). */
	private readonly frameTouched: number[] = [];
	/** §三 calibrated unit costs of the telemetry itself (ms). */
	private nowCallCostMs = 0;
	private phaseSampleCostMs = 0;
	/** Sink that keeps the calibration loop from being optimised away. */
	private calibrationSink = 0;
	/** §三 per-frame telemetry counts, for the modelled overhead phase. */
	private frameNowCalls = 0;
	private frameSamples = 0;

	/**
	 * Begin a capture; resets all previous data. Idempotent.
	 *
	 * `mode` defaults to LIGHT deliberately: the cheap capture is the one
	 * that should be reached for by default, and the expensive one has to
	 * be asked for by name.
	 */
	start(win: Window & typeof globalThis, mode: PerfCaptureMode = "light"): void {
		if (this.active) return;
		this.mode = mode;
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
		this.layerSampleCount = 0;
		this.maxPromotedShiftLayers = 0;
		this.maxPromotedScaleLayers = 0;
		this.scheduledRafByReason = {};
		this.dedupedRafByReason = {};
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
		this.segmentOpenAt = Number.NaN;
		this.frameOpenAt = Number.NaN;
		this.frameTotals.fill(0);
		this.frameTouched.length = 0;
		this.frameNowCalls = 0;
		this.frameSamples = 0;
		this.calibrateTelemetryCost(win);
		this.startedAt = win.performance.now();
		this.active = true;
		this.deepActive = mode === "deep";
		this.resetDeepRotation();
		this.observeLongTasks(win);
		this.observeSuspension(win);
	}

	/**
	 * §三: measure the two unit costs the overhead model is built on — one
	 * `performance.now()` read and one stored phase sample. Runs ONCE per
	 * capture, before `active` is set, so it can never contaminate a
	 * sample. On a clock without real resolution (test stubs) both costs
	 * come out 0 and the modelled overhead is simply 0.
	 */
	private calibrateTelemetryCost(win: Window & typeof globalThis): void {
		this.nowCallCostMs = 0;
		this.phaseSampleCostMs = 0;
		const clock = (win as { performance?: { now?: () => number } }).performance;
		if (typeof clock?.now !== "function") return;
		const now = clock.now.bind(clock);
		let sink = 0;
		const nowStart = now();
		for (let i = 0; i < CALIBRATION_ITERATIONS; i++) sink += now();
		const nowEnd = now();
		const probe = new PhaseAccumulator();
		const sampleStart = now();
		for (let i = 0; i < CALIBRATION_ITERATIONS; i++) probe.add(0.01);
		const sampleEnd = now();
		this.calibrationSink = sink + probe.totalMs;
		const nowCost = (nowEnd - nowStart) / CALIBRATION_ITERATIONS;
		const sampleCost = (sampleEnd - sampleStart) / CALIBRATION_ITERATIONS;
		if (Number.isFinite(nowCost) && nowCost > 0) this.nowCallCostMs = nowCost;
		if (Number.isFinite(sampleCost) && sampleCost > 0) {
			this.phaseSampleCostMs = sampleCost;
		}
	}

	/**
	 * §3.2: back to the opening window, where every group is armed. Called
	 * on start only — a rotation that reset mid-capture would bias the
	 * per-group frame counts the report is read against.
	 */
	private resetDeepRotation(): void {
		const deep = this.deepActive;
		this.deepRotationGroupIndex = -1;
		this.deepRotationFramesLeft = DEEP_ROTATION_FRAMES;
		this.deepWarmupFrames = 0;
		this.deepRotatedFrames = 0;
		this.deepGroupAdvanceCount = 0;
		this.deepFramesPerGroup.fill(0);
		this.deepFrameCalcActive = deep;
		this.deepAutoScrollIntentActive = deep;
		this.deepScrollWriteActive = deep;
		this.deepScrollEventActive = deep;
	}

	/**
	 * §3.2: charge this frame to whatever is armed, then advance when the
	 * slot runs out. Called once per frame from `beginFrameAttribution`,
	 * and only in DEEP — LIGHT never touches the rotation at all.
	 */
	private advanceDeepRotation(): void {
		if (this.deepRotationGroupIndex < 0) {
			this.deepWarmupFrames++;
			// Warm-up arms everything, so every group earns the frame.
			for (let i = 0; i < this.deepFramesPerGroup.length; i++) {
				this.deepFramesPerGroup[i]++;
			}
		} else {
			this.deepRotatedFrames++;
			this.deepFramesPerGroup[this.deepRotationGroupIndex]++;
		}
		this.deepRotationFramesLeft--;
		if (this.deepRotationFramesLeft > 0) return;
		this.deepRotationFramesLeft = DEEP_ROTATION_FRAMES;
		this.deepRotationGroupIndex =
			(this.deepRotationGroupIndex + 1) % DEEP_PHASE_GROUPS.length;
		this.deepGroupAdvanceCount++;
		this.armDeepGroup(DEEP_PHASE_GROUPS[this.deepRotationGroupIndex]);
	}

	/** §3.2: exactly one group armed; the other three go quiet. */
	private armDeepGroup(group: DeepPhaseGroup): void {
		this.deepFrameCalcActive = group === "frameCalc";
		this.deepAutoScrollIntentActive = group === "autoScrollIntent";
		this.deepScrollWriteActive = group === "scrollWrite";
		this.deepScrollEventActive = group === "scrollEvent";
	}

	private isDeepGroupArmed(group: DeepPhaseGroup): boolean {
		switch (group) {
			case "frameCalc":
				return this.deepFrameCalcActive;
			case "autoScrollIntent":
				return this.deepAutoScrollIntentActive;
			case "scrollWrite":
				return this.deepScrollWriteActive;
			case "scrollEvent":
				return this.deepScrollEventActive;
		}
	}

	private deepRotationReport(): DeepRotationReport {
		const framesPerGroup = {} as Record<DeepPhaseGroup, number>;
		DEEP_PHASE_GROUPS.forEach((group, index) => {
			framesPerGroup[group] = this.deepFramesPerGroup[index];
		});
		const rotating = this.deepRotationGroupIndex >= 0;
		return {
			enabled: this.mode === "deep",
			rotationFrames: DEEP_ROTATION_FRAMES,
			groupCount: DEEP_PHASE_GROUPS.length,
			warmupFrames: this.deepWarmupFrames,
			rotatedFrames: this.deepRotatedFrames,
			completedCycles: Math.floor(
				this.deepGroupAdvanceCount / DEEP_PHASE_GROUPS.length,
			),
			activeGroup: rotating
				? DEEP_PHASE_GROUPS[this.deepRotationGroupIndex]
				: null,
			framesPerGroup,
		};
	}

	/**
	 * Stop and build the report. The longtask observer AND the suspension
	 * listeners are ALWAYS removed here — sampling has zero standing cost
	 * afterwards.
	 */
	stop(win: Window & typeof globalThis): PerfReport | null {
		if (!this.active) return null;
		this.active = false;
		this.deepActive = false;
		this.deepFrameCalcActive = false;
		this.deepAutoScrollIntentActive = false;
		this.deepScrollWriteActive = false;
		this.deepScrollEventActive = false;
		this.longTaskObserver?.disconnect();
		this.longTaskObserver = null;
		this.removeSuspensionListeners?.();
		this.removeSuspensionListeners = null;
		const durationMs = win.performance.now() - this.startedAt;
		return this.buildReport(durationMs);
	}

	/**
	 * §七: abandon a running capture WITHOUT producing a report. Used when
	 * developer mode is switched off mid-capture — the longtask observer
	 * and the suspension listeners are torn down exactly like `stop()`,
	 * but no report is built or returned and the in-flight samples are
	 * discarded. Idempotent; a no-op when nothing is running.
	 */
	abort(): void {
		if (!this.active) return;
		this.active = false;
		this.deepActive = false;
		this.deepFrameCalcActive = false;
		this.deepAutoScrollIntentActive = false;
		this.deepScrollWriteActive = false;
		this.deepScrollEventActive = false;
		this.longTaskObserver?.disconnect();
		this.longTaskObserver = null;
		this.removeSuspensionListeners?.();
		this.removeSuspensionListeners = null;
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

	/**
	 * §十八/§三: echo the effective auto-scroll configuration.
	 *
	 * Primitive arguments on purpose — the caller runs this EVERY frame, and
	 * an object literal per frame is an allocation the capture would be
	 * inflicting on the very loop it measures. The values are compared
	 * field by field and only a real change is stored, so a steady capture
	 * writes this exactly once.
	 */
	setAutoScrollConfig(
		configuredSpeed: number,
		configuredTriggerArea: number,
		computedPreZone: number,
		computedStrongZone: number,
		hysteresisPx: number,
	): void {
		if (!this.active) return;
		const prev = this.autoScrollConfig;
		if (
			prev !== null &&
			prev.configuredSpeed === configuredSpeed &&
			prev.configuredTriggerArea === configuredTriggerArea &&
			prev.computedPreZone === computedPreZone &&
			prev.computedStrongZone === computedStrongZone &&
			prev.hysteresisPx === hysteresisPx
		) {
			this.counters.configEchoSkippedCount++;
			return;
		}
		this.autoScrollConfig = {
			configuredSpeed,
			configuredTriggerArea,
			computedPreZone,
			computedStrongZone,
			hysteresisPx,
		};
		this.counters.configEchoUpdateCount++;
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

	// --- §七 layer promotion sampling -------------------------------
	private layerSampleCount = 0;
	private maxPromotedShiftLayers = 0;
	private maxPromotedScaleLayers = 0;

	/**
	 * §七: how many rows hold a GPU layer hint at the end of this frame.
	 * The MAX is the interesting number — it is the peak the compositor
	 * had to keep resident, and the one that should now be bounded by the
	 * scale range rather than by how many rows happen to be visible.
	 */
	addLayerPromotionSample(shiftLayers: number, scaleLayers: number): void {
		if (!this.active) return;
		this.counters.promotedShiftLayerRows += shiftLayers;
		this.counters.promotedScaleLayerRows += scaleLayers;
		this.maxPromotedShiftLayers = Math.max(
			this.maxPromotedShiftLayers,
			shiftLayers,
		);
		this.maxPromotedScaleLayers = Math.max(
			this.maxPromotedScaleLayers,
			scaleLayers,
		);
		this.layerSampleCount++;
	}

	// --- §九 frame scheduling attribution ----------------------------
	private scheduledRafByReason: Record<string, number> = {};
	private dedupedRafByReason: Record<string, number> = {};

	/**
	 * §九: one schedule() call and what became of it. Refusals are
	 * recorded by reason too — knowing WHICH handler over-schedules is
	 * the difference between "the dedup is earning its keep" and "this
	 * handler should not be asking".
	 */
	noteSchedule(
		reason: string,
		outcome: "scheduled" | "deduped" | "suppressed",
	): void {
		if (!this.active) return;
		if (outcome === "scheduled") {
			this.counters.scheduledRafCount++;
			this.scheduledRafByReason[reason] =
				(this.scheduledRafByReason[reason] ?? 0) + 1;
			return;
		}
		if (outcome === "deduped") {
			this.counters.dedupedRafCount++;
			this.dedupedRafByReason[reason] =
				(this.dedupedRafByReason[reason] ?? 0) + 1;
			return;
		}
		this.counters.suppressedRafCount++;
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

	/**
	 * §十.1/§三: refresh the pointer-follow gauges (last write wins).
	 *
	 * Written IN PLACE into one object allocated on first use. The old
	 * signature took an object literal, so a running capture allocated a
	 * fresh record every frame inside the loop it was measuring — that
	 * allocation, not the seven field writes, was the actual cost.
	 *
	 * A time throttle was considered and rejected: once the allocation is
	 * gone the throttle's own branch costs about as much as the writes it
	 * skips, and it would make the reported gauges up to a throttle period
	 * stale — these values exist precisely to show the LAST state of a
	 * gesture on a machine we cannot debug interactively.
	 */
	setPointerFollowEcho(
		pointerFollowStrength: number,
		edgeMaxSpeed: number,
		kineticMaxSpeed: number,
		combinedMaxSpeed: number,
		currentPointerVelocityY: number,
		predictedPointerY: number,
		pointerSampleCount: number,
	): void {
		if (!this.active) return;
		const echo =
			this.pointerFollowEcho ??
			(this.pointerFollowEcho = {
				pointerFollowStrength: 0,
				edgeMaxSpeed: 0,
				kineticMaxSpeed: 0,
				combinedMaxSpeed: 0,
				currentPointerVelocityY: 0,
				predictedPointerY: 0,
				pointerSampleCount: 0,
			});
		echo.pointerFollowStrength = pointerFollowStrength;
		echo.edgeMaxSpeed = edgeMaxSpeed;
		echo.kineticMaxSpeed = kineticMaxSpeed;
		echo.combinedMaxSpeed = combinedMaxSpeed;
		echo.currentPointerVelocityY = currentPointerVelocityY;
		echo.predictedPointerY = predictedPointerY;
		echo.pointerSampleCount = pointerSampleCount;
		this.counters.pointerEchoUpdateCount++;
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

	/**
	 * §四.2: one plugin phase duration sample (ms). Ring-buffered.
	 *
	 * Used directly for NESTED (deep) samples, which deliberately re-measure
	 * wall clock already owned by an exclusive segment. Exclusive segments
	 * go through `markPhase` instead.
	 *
	 * CONTRACT: a nested sample comes from a dedicated start/stop clock
	 * pair, so calling this books TWO `performance.now()` reads against the
	 * capture's own overhead. That is the honest price of DEEP mode and the
	 * reason it is not the default.
	 */
	addPhaseSample(phase: PluginPhase, durationMs: number): void {
		if (!this.active) return;
		this.counters.performanceNowCallCount += 2;
		this.frameNowCalls += 2;
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		if (!this.shouldSample(phase)) {
			this.counters.skippedPhaseSampleCount++;
			return;
		}
		this.storeSample(phase, durationMs);
	}

	/**
	 * §三/§3.2: is this phase sampled right now? Two gates — the mode, and
	 * (in DEEP) whether the phase's group is the one currently armed.
	 *
	 * The group gate is defence in depth: a correctly written call site
	 * checks its own `deep*Active` flag and never gets here, which is what
	 * saves the clock reads. This catches the sites that forget.
	 */
	private shouldSample(phase: PluginPhase): boolean {
		if (this.mode !== "deep") return LIGHT_PHASES.has(phase);
		const group = DEEP_GROUP_OF.get(phase);
		return group === undefined || this.isDeepGroupArmed(group);
	}

	private storeSample(phase: PluginPhase, durationMs: number): void {
		let acc = this.phases.get(phase);
		if (!acc) {
			acc = new PhaseAccumulator();
			this.phases.set(phase, acc);
		}
		acc.add(durationMs);
		this.counters.sampledPhaseCount++;
		this.frameSamples++;
	}

	// --- §四 mutually exclusive frame attribution ---------------------

	/**
	 * §四: open a frame's attribution timeline. `now` is the RAF timestamp,
	 * which is free — the caller does NOT read the clock for this.
	 */
	beginFrameAttribution(now: number): void {
		if (!this.active) return;
		this.frameOpenAt = now;
		this.segmentOpenAt = now;
		this.counters.performanceNowCallCount++;
		this.frameNowCalls = 1;
		this.frameSamples = 0;
		// §3.2: the frame boundary is the rotation's only clock.
		if (this.deepActive) this.advanceDeepRotation();
	}

	/**
	 * §四: close the open segment at `now`, attribute it to `phase`, and
	 * open the next one. Exactly ONE clock read per boundary — n phases
	 * cost n+0 reads instead of the 2n a start/stop pair per phase needs.
	 *
	 * Repeated marks of the same phase within a frame accumulate; the
	 * per-frame total is stored once, by `endFrameAttribution`, so phase
	 * stats stay per-frame rather than per-segment.
	 *
	 * Marking `"unattributedFrameJs"` is the deliberate "this slice belongs
	 * to nobody" move (used for the capture's own diagnostic passes); the
	 * reconciliation still holds because the remainder is folded into the
	 * same bucket.
	 */
	markPhase(phase: PluginPhase, now: number): void {
		if (!this.active) return;
		this.counters.performanceNowCallCount++;
		this.frameNowCalls++;
		const openedAt = this.segmentOpenAt;
		this.segmentOpenAt = now;
		if (!Number.isFinite(openedAt)) return;
		const durationMs = now - openedAt;
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		if (!this.shouldSample(phase)) {
			this.counters.skippedPhaseSampleCount++;
			return;
		}
		const slot = PHASE_SLOT.get(phase);
		if (slot === undefined) return;
		if (this.frameTotals[slot] === 0) this.frameTouched.push(slot);
		this.frameTotals[slot] += durationMs;
	}

	/**
	 * §四: close the frame. Flushes the per-frame exclusive totals, records
	 * `pluginFrameJs`, and books the remainder as `unattributedFrameJs` so
	 * the two always reconcile. `now` must be the SAME timestamp used for
	 * the final `markPhase` — no extra clock read here.
	 */
	endFrameAttribution(now: number): void {
		if (!this.active) return;
		const openedAt = this.frameOpenAt;
		this.frameOpenAt = Number.NaN;
		this.segmentOpenAt = Number.NaN;
		let attributed = 0;
		for (const slot of this.frameTouched) attributed += this.frameTotals[slot];
		const totalMs = Number.isFinite(openedAt) ? now - openedAt : Number.NaN;
		const frameValid = Number.isFinite(totalMs) && totalMs >= 0;
		if (frameValid) {
			// Fold the remainder into the same bucket explicit "nobody's
			// slice" marks use, so the report never shows the phase twice.
			const remainder = totalMs - attributed;
			if (remainder > 0) {
				const slot = PHASE_SLOT.get("unattributedFrameJs");
				if (slot !== undefined) {
					if (this.frameTotals[slot] === 0) this.frameTouched.push(slot);
					this.frameTotals[slot] += remainder;
				}
			}
		}
		for (const slot of this.frameTouched) {
			const total = this.frameTotals[slot];
			this.frameTotals[slot] = 0;
			if (total > 0) this.storeSample(PLUGIN_PHASES[slot], total);
		}
		this.frameTouched.length = 0;
		if (frameValid) this.storeSample("pluginFrameJs", totalMs);
		// §三: model this frame's telemetry cost from the calibrated unit
		// costs. Counting the flush's own samples would need another clock
		// read, which is exactly the cost we refuse to pay.
		if (this.nowCallCostMs > 0 || this.phaseSampleCostMs > 0) {
			const modelled =
				this.frameNowCalls * this.nowCallCostMs +
				this.frameSamples * this.phaseSampleCostMs;
			if (modelled > 0) this.storeSample("telemetryBookkeeping", modelled);
		}
		this.frameNowCalls = 0;
		this.frameSamples = 0;
	}

	/**
	 * §四: abandon the open frame without flushing (early return before any
	 * segment was marked). Keeps a partial frame from leaking into the next.
	 */
	discardFrameAttribution(): void {
		if (!this.active) return;
		for (const slot of this.frameTouched) this.frameTotals[slot] = 0;
		this.frameTouched.length = 0;
		this.frameOpenAt = Number.NaN;
		this.segmentOpenAt = Number.NaN;
		this.frameNowCalls = 0;
		this.frameSamples = 0;
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
		const estimatedOverheadMs =
			c.performanceNowCallCount * this.nowCallCostMs +
			c.sampledPhaseCount * this.phaseSampleCostMs;
		return {
			capturedAt: new Date().toISOString(),
			captureDurationMs: round2(durationMs),
			capture: {
				mode: this.mode,
				deepPhaseSampling: this.mode === "deep",
				performanceNowCallCount: c.performanceNowCallCount,
				sampledPhaseCount: c.sampledPhaseCount,
				skippedPhaseSampleCount: c.skippedPhaseSampleCount,
				configEchoUpdateCount: c.configEchoUpdateCount,
				configEchoSkippedCount: c.configEchoSkippedCount,
				pointerEchoUpdateCount: c.pointerEchoUpdateCount,
				deepRotation: this.deepRotationReport(),
				nowCallsPerFrame: round2(c.performanceNowCallCount / frameDiv),
				estimatedOverheadMs: round4(estimatedOverheadMs),
				estimatedOverheadPerFrameMs: round4(estimatedOverheadMs / frameDiv),
				nowCallCostUs: round4(this.nowCallCostMs * 1000),
				phaseSampleCostUs: round4(this.phaseSampleCostMs * 1000),
			},
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
				/**
				 * §六: share of pointerenters that reused cached envelope
				 * geometry. A rail glide should sit near 1 — every miss is
				 * a forced layout queued inside an input handler.
				 */
				envelopeEnterReuseShare: round2(
					c.envelopeEnterReusedCount + c.envelopeEnterDirtyCount > 0
						? c.envelopeEnterReusedCount /
								(c.envelopeEnterReusedCount +
									c.envelopeEnterDirtyCount)
						: 0,
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
			layers: {
				avgPromotedShiftLayers: round2(
					this.layerSampleCount > 0
						? c.promotedShiftLayerRows / this.layerSampleCount
						: 0,
				),
				maxPromotedShiftLayers: this.maxPromotedShiftLayers,
				avgPromotedScaleLayers: round2(
					this.layerSampleCount > 0
						? c.promotedScaleLayerRows / this.layerSampleCount
						: 0,
				),
				maxPromotedScaleLayers: this.maxPromotedScaleLayers,
				classMutationCount: c.promotionClassMutationCount,
				classSkippedCount: c.promotionClassSkippedCount,
				classSkippedShare: round2(
					c.promotionClassMutationCount + c.promotionClassSkippedCount > 0
						? c.promotionClassSkippedCount /
								(c.promotionClassMutationCount +
									c.promotionClassSkippedCount)
						: 0,
				),
			},
			frameScheduling: {
				scheduledRafCount: c.scheduledRafCount,
				scheduledRafByReason: { ...this.scheduledRafByReason },
				dedupedRafCount: c.dedupedRafCount,
				dedupedRafByReason: { ...this.dedupedRafByReason },
				suppressedRafCount: c.suppressedRafCount,
				frameWithoutMotionOrIntentCount:
					c.frameWithoutMotionOrIntentCount,
				idleRafCount: c.idleRafCount,
				idleFrameShare: round2(
					c.frameWithoutMotionOrIntentCount / frameDiv,
				),
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
			overflow: {
				scrollEventCount: c.overflowScrollEventCount,
				metricRefreshCount: c.overflowMetricRefreshCount,
				metricReadCount: c.overflowMetricReadCount,
				cachedMetricShare: round2(
					c.overflowMetricReadCount + c.overflowMetricRefreshCount > 0
						? c.overflowMetricReadCount /
								(c.overflowMetricReadCount +
									c.overflowMetricRefreshCount)
						: 0,
				),
				classMutationCount: c.overflowClassMutationCount,
				classSkippedCount: c.overflowClassSkippedCount,
				classSkippedShare: round2(
					c.overflowClassSkippedCount + c.overflowClassMutationCount > 0
						? c.overflowClassSkippedCount /
								(c.overflowClassSkippedCount +
									c.overflowClassMutationCount)
						: 0,
				),
			},
			activeFollow: {
				scrollMutationCount: c.activeFollowScrollMutationCount,
				noMutationCount: c.activeFollowNoMutationCount,
				correctionCount: c.activeFollowCorrectionCount,
				failedVisibilityCount: c.activeFollowFailedVisibilityCount,
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

/** Sub-microsecond values (telemetry unit costs) need more digits. */
function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}
