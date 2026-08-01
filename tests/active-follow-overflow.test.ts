// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
	activeFollowMarginPx,
	getOffsetWithinScrollContent,
	GlideOutlineView,
} from "../src/ui/GlideOutlineView";

/**
 * §九 / §十七: the collapsed outline must reliably scroll the highlighted
 * dot into view in a list far taller than the rail.
 *
 * The bug this suite pins down had two halves:
 *   §五  the offset was read as `rowEl.offsetTop`, which measures from
 *        whatever happens to be the offsetParent (the <nav>, a padded
 *        card box) rather than from the scroll viewport;
 *   §三  a follow requested while the rail was expanded / pressed /
 *        paused was thrown away, so nothing ever asked again and the
 *        outline stayed parked on a stale row.
 *
 * jsdom has no layout engine, so every geometry read the view performs is
 * mocked explicitly and deterministically:
 *   126 rows × 24 px  = 3024 px of content
 *   viewport          =  400 px tall  → maxScrollTop = 2624
 *   safe-band margin  = min(48, 400 × 0.15) = 48 px
 */
const ROW_COUNT = 126;
const ROW_H = 24;
const CLIENT_H = 400;
const CONTENT_H = ROW_COUNT * ROW_H; // 3024
const MAX_SCROLL_TOP = CONTENT_H - CLIENT_H; // 2624
const MARGIN = 48;

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: ROW_COUNT }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

const keyAt = (index: number): string => HEADINGS[index].key;

/** Centred scrollTop for a row at `index`, clamped to the scroll range. */
function centeredTarget(index: number, rowTopBase = 0): number {
	const desired = rowTopBase + index * ROW_H + ROW_H / 2 - CLIENT_H / 2;
	return Math.max(0, Math.min(MAX_SCROLL_TOP, desired));
}

function defineNumber(el: HTMLElement, prop: string, value: number): void {
	Object.defineProperty(el, prop, { configurable: true, value });
}

describe("active-follow in a 126-row overflowing outline (§九)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let rafQueue: FrameRequestCallback[];

	function flushRaf(): void {
		// Drain, including callbacks scheduled while draining (retry /
		// correction passes schedule themselves).
		for (let guard = 0; guard < 12 && rafQueue.length > 0; guard++) {
			const batch = rafQueue.splice(0, rafQueue.length);
			for (const cb of batch) cb(performance.now());
		}
	}

	/** Scroll-box metrics: the three values `measureActiveRow` reads. */
	function mockViewport(scrollTop: number, scrollHeight = CONTENT_H): void {
		const el = view.viewportEl;
		defineNumber(el, "clientHeight", CLIENT_H);
		defineNumber(el, "scrollHeight", scrollHeight);
		Object.defineProperty(el, "scrollTop", {
			configurable: true,
			writable: true,
			value: scrollTop,
		});
	}

	/**
	 * Lay the rows out as a real browser would: every row is positioned by
	 * the <nav>, and the <nav> is positioned by the viewport. That is the
	 * nesting that makes a bare `rowEl.offsetTop` wrong — the chain walk
	 * has to add the list's own offset back in.
	 */
	function mockRowLayout(rowHeight = ROW_H, listOffsetTop = 0): void {
		const rows = [
			...view.listEl.querySelectorAll<HTMLElement>(".glide-outline-row"),
		];
		rows.forEach((row, i) => {
			defineNumber(row, "offsetTop", i * rowHeight);
			defineNumber(row, "offsetHeight", rowHeight);
			Object.defineProperty(row, "offsetParent", {
				configurable: true,
				value: view.listEl,
			});
		});
		defineNumber(view.listEl, "offsetTop", listOffsetTop);
		Object.defineProperty(view.listEl, "offsetParent", {
			configurable: true,
			value: view.viewportEl,
		});
	}

	beforeEach(() => {
		rafQueue = [];
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback): number => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
		);
		vi.stubGlobal("cancelAnimationFrame", (): void => undefined);
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);
		mockViewport(0);
		mockRowLayout();
		flushRaf(); // drain the measure pass queued by setItems
	});

	afterEach(() => {
		view.dispose();
		host.remove();
		vi.unstubAllGlobals();
	});

	it("centres a far-offscreen active row on the collapsed rail", () => {
		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100)); // 2212
		expect(d.lastResult).toBe("centered");
		expect(d.centeredCount).toBe(1);
		expect(d.appliedCount).toBe(1);
		expect(d.scrollMutationCount).toBe(1);
		expect(d.lastMarginPx).toBe(MARGIN);
		expect(d.failedAfterCorrectionCount).toBe(0);
		expect(view.getPendingActiveFollow()).toBeNull();
	});

	it("accumulates the offsetParent chain instead of trusting offsetTop", () => {
		// A padded card box pushes the whole list down by 60 px. The raw
		// `rowEl.offsetTop` still reads 2400 — only the chain sees 2460.
		mockRowLayout(ROW_H, 60);
		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.lastMeasureSource).toBe("offset-chain");
		expect(d.offsetChainCount).toBeGreaterThan(0);
		expect(d.rectFallbackCount).toBe(0);
		expect(d.lastRowTop).toBe(100 * ROW_H + 60);
		expect(d.maxOffsetChainDepth).toBe(2); // row → nav → viewport
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100, 60)); // 2272
	});

	it("falls back to rectangles when the chain misses the viewport", () => {
		// A `position: fixed` ancestor (or a detached subtree) breaks the
		// walk. Only the ONE active row pays for the two rect reads.
		const record = view.getItemRecord(keyAt(100));
		expect(record).toBeDefined();
		const rowEl = record?.rowEl as HTMLElement;
		Object.defineProperty(rowEl, "offsetParent", {
			configurable: true,
			value: null,
		});
		// Rectangles are viewport-relative: they move as the box scrolls,
		// exactly as a real browser reports them. A static mock would make
		// the verification pass read a different row position than the
		// first pass and mask the behaviour under test.
		rowEl.getBoundingClientRect = () =>
			({
				top: 900 - view.viewportEl.scrollTop,
				height: ROW_H,
			}) as DOMRect;
		view.viewportEl.getBoundingClientRect = () =>
			({ top: 100, height: CLIENT_H }) as DOMRect;

		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.lastMeasureSource).toBe("rect");
		expect(d.offsetChainCount).toBe(0);
		// One read for the placement pass, one for the verification pass —
		// and never a sweep over the other 125 rows.
		expect(d.rectFallbackCount).toBe(2);
		expect(d.lastRowTop).toBe(800); // 900 − 100 − clientTop(0) + scrollTop(0)
		expect(view.viewportEl.scrollTop).toBe(800 + ROW_H / 2 - CLIENT_H / 2);
		expect(d.correctionCount).toBe(0);
	});

	it("leaves the scroll alone when the row already sits in the safe band", () => {
		mockViewport(2200); // safe band 2248 … 2552; row 100 spans 2400 … 2424
		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.lastResult).toBe("already-visible");
		expect(d.alreadyVisibleCount).toBe(1);
		expect(d.noMutationCount).toBe(1);
		expect(d.scrollMutationCount).toBe(0);
		expect(view.viewportEl.scrollTop).toBe(2200);
	});

	it("treats a row inside the viewport but under the top inset as off-band", () => {
		// Row 100 starts half an inset below the viewport top — visible, but
		// inside the band's margin, which is exactly the "highlighted dot is
		// squashed against the edge" case the safe band exists to fix.
		mockViewport(100 * ROW_H - MARGIN / 2);
		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.alreadyVisibleCount).toBe(0);
		expect(d.lastResult).toBe("centered");
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
	});

	it("clamps to the top of the range for the first row", () => {
		mockViewport(1000);
		view.setActiveKey(keyAt(0));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.lastResult).toBe("top-boundary");
		expect(d.topBoundaryCount).toBe(1);
		expect(view.viewportEl.scrollTop).toBe(0);
		// The first row can never be inset by 48 px — the scroll range ends
		// there. That is the best position available, so the verification
		// pass must not report it as a correction or a failure.
		expect(d.correctionCount).toBe(0);
		expect(d.failedAfterCorrectionCount).toBe(0);
	});

	it("clamps to the bottom of the range for the last row", () => {
		view.setActiveKey(keyAt(ROW_COUNT - 1));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.lastResult).toBe("bottom-boundary");
		expect(d.bottomBoundaryCount).toBe(1);
		expect(view.viewportEl.scrollTop).toBe(MAX_SCROLL_TOP);
		expect(d.correctionCount).toBe(0);
		expect(d.failedAfterCorrectionCount).toBe(0);
	});

	it("defers instead of scrolling to 0 while the row has no height", () => {
		mockRowLayout(0); // never laid out yet
		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.lastResult).toBe("deferred-no-layout");
		expect(d.appliedCount).toBe(0);
		expect(d.scrollMutationCount).toBe(0);
		expect(view.viewportEl.scrollTop).toBe(0);
		// The retry budget is spent, but the target is NOT forgotten.
		expect(d.deferredCount).toBe(4); // first pass + 3 retries
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));
	});

	it("applies the deferred target once geometry arrives and the gate re-opens", () => {
		mockRowLayout(0);
		view.setActiveKey(keyAt(100));
		flushRaf(); // budget exhausted, target retained

		mockRowLayout(); // layout finally happened
		view.setInteractionState("expanded-pointer");
		view.setInteractionState("collapsed"); // re-opening flushes + re-arms
		flushRaf();

		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
		expect(view.getActiveFollowDiagnostics().appliedCount).toBe(1);
	});
});

describe("pending active-follow retention (§三/§四)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let rafQueue: FrameRequestCallback[];

	function flushRaf(): void {
		for (let guard = 0; guard < 12 && rafQueue.length > 0; guard++) {
			const batch = rafQueue.splice(0, rafQueue.length);
			for (const cb of batch) cb(performance.now());
		}
	}

	beforeEach(() => {
		rafQueue = [];
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback): number => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
		);
		vi.stubGlobal("cancelAnimationFrame", (): void => undefined);
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);

		defineNumber(view.viewportEl, "clientHeight", CLIENT_H);
		defineNumber(view.viewportEl, "scrollHeight", CONTENT_H);
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			writable: true,
			value: 0,
		});
		const rows = [
			...view.listEl.querySelectorAll<HTMLElement>(".glide-outline-row"),
		];
		rows.forEach((row, i) => {
			defineNumber(row, "offsetTop", i * ROW_H);
			defineNumber(row, "offsetHeight", ROW_H);
			Object.defineProperty(row, "offsetParent", {
				configurable: true,
				value: view.listEl,
			});
		});
		defineNumber(view.listEl, "offsetTop", 0);
		Object.defineProperty(view.listEl, "offsetParent", {
			configurable: true,
			value: view.viewportEl,
		});
		flushRaf();
	});

	afterEach(() => {
		view.dispose();
		host.remove();
		vi.unstubAllGlobals();
	});

	it("retains a target requested while expanded and flushes it on collapse", () => {
		view.setInteractionState("expanded-pointer");
		view.setActiveKey(keyAt(100));

		let d = view.getActiveFollowDiagnostics();
		expect(d.suppressedCount).toBe(1);
		expect(d.pendingRetainedCount).toBe(1);
		expect(d.lastResult).toBe("suppressed-expanded");
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));
		expect(view.getPendingActiveFollow()?.reason).toBe("active-change");

		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(0); // the user is not fought

		view.setInteractionState("collapsed");
		d = view.getActiveFollowDiagnostics();
		expect(d.flushCount).toBe(1);

		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
		expect(view.getPendingActiveFollow()).toBeNull();
		expect(view.getActiveFollowDiagnostics().appliedCount).toBe(1);
	});

	it("keeps only the newest target when several arrive behind a shut gate", () => {
		view.setInteractionState("pressed");
		view.setActiveKey(keyAt(20));
		view.setActiveKey(keyAt(60));
		view.setActiveKey(keyAt(100));

		const d = view.getActiveFollowDiagnostics();
		expect(d.supersededCount).toBe(2);
		expect(d.pendingRetainedCount).toBe(3);
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));

		view.setInteractionState("collapsed");
		flushRaf();
		// One scroll, straight to the newest heading — no intermediate hops.
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
		expect(view.getActiveFollowDiagnostics().scrollMutationCount).toBe(1);
	});

	it("retains a target while follow is paused and resumes on re-enable", () => {
		view.setFollowEnabled(false);
		view.setActiveKey(keyAt(100));

		expect(view.getActiveFollowDiagnostics().suppressedCount).toBe(1);
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));
		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(0);

		view.setFollowEnabled(true);
		expect(view.getActiveFollowDiagnostics().flushCount).toBe(1);
		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
	});

	it("does not flush while the other gate is still shut", () => {
		view.setFollowEnabled(false);
		view.setInteractionState("expanded-pointer");
		view.setActiveKey(keyAt(100));

		view.setInteractionState("collapsed"); // one gate reopened only
		expect(view.getActiveFollowDiagnostics().flushCount).toBe(0);
		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(0);
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));

		view.setFollowEnabled(true); // now both are open
		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
	});

	it("retains the target when the gate closes between request and frame", () => {
		view.setActiveKey(keyAt(100)); // requested while collapsed
		view.setInteractionState("expanded-pointer"); // user grabbed the rail
		flushRaf(); // the queued frame runs into a shut gate

		const d = view.getActiveFollowDiagnostics();
		expect(d.suppressedCount).toBe(1);
		expect(d.pendingRetainedCount).toBe(1);
		expect(view.viewportEl.scrollTop).toBe(0);
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));

		view.setInteractionState("collapsed");
		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
	});

	it("drops the pending target when the active heading disappears", () => {
		view.setInteractionState("expanded-pointer");
		view.setActiveKey(keyAt(100));
		view.setActiveKey(null);
		expect(view.getPendingActiveFollow()?.key).toBe(keyAt(100));

		view.setInteractionState("collapsed");
		flushRaf();
		expect(view.getPendingActiveFollow()).toBeNull();
		expect(view.getActiveFollowDiagnostics().staleRetargetCount).toBe(0);
		expect(view.viewportEl.scrollTop).toBe(0);
	});

	it("coalesces several reasons in one frame into a single pass", () => {
		view.setActiveKey(keyAt(100));
		view.requestActiveFollow("resize");
		view.requestActiveFollow("metrics-change");

		const before = view.getActiveFollowDiagnostics();
		expect(before.coalescedCount).toBe(2);

		flushRaf();
		// The extra reasons cause one re-run against fresh geometry; the
		// second pass finds the row already in the band, so exactly one
		// scroll write is issued.
		expect(view.getActiveFollowDiagnostics().scrollMutationCount).toBe(1);
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100));
	});

	it("forgets everything on dispose", () => {
		view.setInteractionState("expanded-pointer");
		view.setActiveKey(keyAt(100));
		expect(view.getPendingActiveFollow()).not.toBeNull();

		view.dispose();
		expect(view.getPendingActiveFollow()).toBeNull();
		view.setInteractionState("collapsed");
		flushRaf();
		expect(view.viewportEl.scrollTop).toBe(0);
	});

	it("exposes the whole diagnostics schema", () => {
		view.setActiveKey(keyAt(100));
		flushRaf();
		const d = view.getActiveFollowDiagnostics();
		expect(Object.keys(d).sort()).toEqual(
			[
				"activeKey",
				"alreadyVisibleCount",
				"appliedCount",
				"bottomBoundaryCount",
				"centeredCount",
				"coalescedCount",
				"correctionCount",
				"deferredCount",
				"failedAfterCorrectionCount",
				"followEnabled",
				"flushCount",
				"interactionState",
				"lastAppliedGeneration",
				"lastClientHeight",
				"lastKey",
				"lastLatencyMs",
				"lastMarginPx",
				"lastMeasureSource",
				"lastReason",
				"lastResult",
				"lastRowHeight",
				"lastRowTop",
				"lastScrollTopAfter",
				"lastScrollTopBefore",
				"lastTargetScrollTop",
				"maxOffsetChainDepth",
				"noMutationCount",
				"offsetChainCount",
				"pendingAgeMs",
				"pendingGeneration",
				"pendingKey",
				"pendingReason",
				"pendingRetainedCount",
				"rectFallbackCount",
				"requestCount",
				"scrollMutationCount",
				"staleRetargetCount",
				"supersededCount",
				"suppressedCount",
				"topBoundaryCount",
			].sort(),
		);
		expect(d.activeKey).toBe(keyAt(100));
		expect(d.interactionState).toBe("collapsed");
		expect(d.followEnabled).toBe(true);
		expect(d.lastAppliedGeneration).toBe(d.pendingGeneration);
		expect(Number.isNaN(d.pendingAgeMs)).toBe(true);
	});
});

describe("safe-band verification pass (§六)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let rafQueue: FrameRequestCallback[];

	function flushRaf(): void {
		for (let guard = 0; guard < 12 && rafQueue.length > 0; guard++) {
			const batch = rafQueue.splice(0, rafQueue.length);
			for (const cb of batch) cb(performance.now());
		}
	}

	function rowEls(): HTMLElement[] {
		return [...view.listEl.querySelectorAll<HTMLElement>(".glide-outline-row")];
	}

	beforeEach(() => {
		rafQueue = [];
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback): number => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
		);
		vi.stubGlobal("cancelAnimationFrame", (): void => undefined);
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);
		defineNumber(view.viewportEl, "clientHeight", CLIENT_H);
		defineNumber(view.viewportEl, "scrollHeight", CONTENT_H);
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			writable: true,
			value: 0,
		});
		rowEls().forEach((row, i) => {
			defineNumber(row, "offsetTop", i * ROW_H);
			defineNumber(row, "offsetHeight", ROW_H);
			Object.defineProperty(row, "offsetParent", {
				configurable: true,
				value: view.listEl,
			});
		});
		defineNumber(view.listEl, "offsetTop", 0);
		Object.defineProperty(view.listEl, "offsetParent", {
			configurable: true,
			value: view.viewportEl,
		});
		flushRaf();
	});

	afterEach(() => {
		view.dispose();
		host.remove();
		vi.unstubAllGlobals();
	});

	it("issues exactly one corrective write when the layout moved", () => {
		view.setActiveKey(keyAt(100));
		// Run only the follow frame; the correction is queued behind it.
		const first = rafQueue.splice(0, rafQueue.length);
		for (const cb of first) cb(performance.now());
		expect(view.viewportEl.scrollTop).toBe(centeredTarget(100)); // 2212

		// A late row-height change slides the active row down 200 px.
		rowEls().forEach((row, i) => {
			defineNumber(row, "offsetTop", i * ROW_H + (i >= 100 ? 200 : 0));
		});
		flushRaf(); // verification frame

		const d = view.getActiveFollowDiagnostics();
		expect(d.correctionCount).toBe(1);
		expect(d.lastResult).toBe("corrected");
		expect(d.failedAfterCorrectionCount).toBe(0);
		expect(view.viewportEl.scrollTop).toBe(2600 + ROW_H / 2 - CLIENT_H / 2);
	});

	it("records a failure instead of looping when the row cannot land", () => {
		// A viewport that refuses to scroll past 500 px — a pathological
		// layout must never turn the verification pass into a scroll loop.
		let stored = 0;
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			get: () => stored,
			set: (value: number) => {
				stored = Math.min(500, value);
			},
		});

		view.setActiveKey(keyAt(100));
		flushRaf();

		const d = view.getActiveFollowDiagnostics();
		expect(d.correctionCount).toBe(1);
		expect(d.failedAfterCorrectionCount).toBe(1);
		expect(d.lastResult).toBe("failed-after-correction");
		expect(view.viewportEl.scrollTop).toBe(500);
		// Nothing rescheduled itself: the queue drained to empty.
		expect(rafQueue).toHaveLength(0);
	});
});

describe("safe-band geometry helpers (§五/§六)", () => {
	it("insets the band by 15 % of the viewport, clamped to 16 … 48 px", () => {
		expect(activeFollowMarginPx(0)).toBe(16);
		expect(activeFollowMarginPx(80)).toBe(16); // 12 → clamped up
		expect(activeFollowMarginPx(200)).toBe(30);
		expect(activeFollowMarginPx(400)).toBe(48); // 60 → clamped down
		expect(activeFollowMarginPx(2000)).toBe(48);
	});

	it("stops the offsetParent walk at the viewport and reports the depth", () => {
		const viewport = document.createElement("div");
		const nav = document.createElement("div");
		const row = document.createElement("div");
		defineNumber(row, "offsetTop", 240);
		defineNumber(row, "offsetLeft", 4);
		Object.defineProperty(row, "offsetParent", {
			configurable: true,
			value: nav,
		});
		defineNumber(nav, "offsetTop", 12);
		defineNumber(nav, "offsetLeft", 6);
		Object.defineProperty(nav, "offsetParent", {
			configurable: true,
			value: viewport,
		});

		expect(getOffsetWithinScrollContent(row, viewport)).toEqual({
			top: 252,
			left: 10,
			depth: 2,
			resolved: true,
		});
	});

	it("reports resolved:false when the chain leaves the viewport behind", () => {
		const viewport = document.createElement("div");
		const row = document.createElement("div");
		defineNumber(row, "offsetTop", 240);
		Object.defineProperty(row, "offsetParent", {
			configurable: true,
			value: null,
		});
		const result = getOffsetWithinScrollContent(row, viewport);
		expect(result.resolved).toBe(false);
		expect(result.top).toBe(240);
	});

	it("bails out of a cyclic offsetParent chain", () => {
		const viewport = document.createElement("div");
		const a = document.createElement("div");
		const b = document.createElement("div");
		defineNumber(a, "offsetTop", 1);
		defineNumber(b, "offsetTop", 1);
		Object.defineProperty(a, "offsetParent", { configurable: true, value: b });
		Object.defineProperty(b, "offsetParent", { configurable: true, value: a });

		const result = getOffsetWithinScrollContent(a, viewport);
		expect(result.resolved).toBe(false);
		expect(result.depth).toBe(32); // OFFSET_CHAIN_MAX_DEPTH guard
	});
});
