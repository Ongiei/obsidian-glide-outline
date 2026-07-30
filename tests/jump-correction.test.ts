// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollCorrector } from "../src/core/ScrollCorrector";
import type {
	JumpCorrectionSummary,
	JumpLandingEvaluation,
} from "../src/core/ScrollCorrector";
import { evaluateJumpLanding } from "../src/core/jumpLanding";

/**
 * Editor jump correction (section 12 + §五). Settle detection must arm
 * BOTH `scrollend` AND the timeout fallback; correction is re-applied
 * only while the measured landing is off, capped by maxCorrections; the
 * summary always reports the final error, the number of passes, and one
 * record per attempt.
 *
 * The world model below reproduces the real Obsidian geometry that broke
 * 0.1.3: the CM content origin sits `CONTENT_ORIGIN` px below the
 * scroller origin, so any correction that confuses the two axes settles
 * exactly that far off target.
 */

const CONTENT_ORIGIN = 416.65625;
const DOCUMENT_TOP = 5000;
const MARGIN = 12;
const CLIENT_HEIGHT = 900;
const SCROLL_HEIGHT = 20000;
const TOLERANCE = 3;

describe("ScrollCorrector", () => {
	let scroller: HTMLElement;
	let win: Window & typeof globalThis;

	beforeEach(() => {
		vi.useFakeTimers();
		scroller = document.createElement("div");
		document.body.appendChild(scroller);
		win = window as Window & typeof globalThis;
	});

	afterEach(() => {
		vi.useRealTimers();
		scroller.remove();
	});

	interface World {
		corrector: ScrollCorrector;
		summaries: JumpCorrectionSummary[];
		applies: number[];
		scrollTop(): number;
		setScrollTop(v: number): void;
	}

	/**
	 * @param opts.rendered  whether coordsAtPos resolves (false → the
	 *                       document-space fallback path).
	 * @param opts.frozen    ignore corrections (simulates a layout that
	 *                       never converges) so the cap can be exercised.
	 */
	function makeWorld(
		opts: {
			startScrollTop?: number;
			smoothFirst?: boolean;
			maxCorrections?: number;
			rendered?: boolean;
			frozen?: boolean;
			scrollHeight?: number;
			documentTop?: number;
		} = {},
	): World {
		const rendered = opts.rendered ?? true;
		const frozen = opts.frozen ?? false;
		const scrollHeight = opts.scrollHeight ?? SCROLL_HEIGHT;
		const documentTop = opts.documentTop ?? DOCUMENT_TOP;
		let scrollTop = opts.startScrollTop ?? 0;
		const applies: number[] = [];
		const summaries: JumpCorrectionSummary[] = [];

		const evaluate = (): JumpLandingEvaluation => {
			// Where the heading really renders for the current scrollTop.
			const clientTop = CONTENT_ORIGIN + documentTop - scrollTop;
			return {
				scrollTop,
				result: evaluateJumpLanding({
					targetClientTop: rendered ? clientTop : null,
					targetClientBottom: rendered ? clientTop + 28 : null,
					scrollerClientTop: 0,
					scrollerClientHeight: CLIENT_HEIGHT,
					scrollTop,
					scrollHeight,
					documentTop,
					contentOriginOffset: CONTENT_ORIGIN,
					marginPx: MARGIN,
					tolerancePx: TOLERANCE,
				}),
			};
		};

		const corrector = new ScrollCorrector({
			maxCorrections: opts.maxCorrections ?? 3,
			timeoutMs: 700,
			evaluate,
			apply: (result) => {
				applies.push(result.desiredScrollTop);
				if (!frozen) scrollTop = result.desiredScrollTop;
			},
			done: (summary) => summaries.push(summary),
			win,
			scroller,
			...(opts.smoothFirst ? { smoothFirst: true } : {}),
		});

		return {
			corrector,
			summaries,
			applies,
			scrollTop: () => scrollTop,
			setScrollTop: (v) => {
				scrollTop = v;
			},
		};
	}

	function settleViaScrollend(): void {
		scroller.dispatchEvent(new Event("scrollend"));
	}

	it("lands the heading exactly marginPx below the scroller top", () => {
		const world = makeWorld();
		world.corrector.start();
		settleViaScrollend();

		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].finalErrorPx).toBeLessThanOrEqual(TOLERANCE);
		expect(world.scrollTop()).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
	});

	it("does not repeat the 0.1.3 coordinate-space error", () => {
		// Start exactly where 0.1.3 stopped and called it a success.
		const world = makeWorld({ startScrollTop: DOCUMENT_TOP - MARGIN });
		world.corrector.start();
		settleViaScrollend();

		const summary = world.summaries[0];
		expect(summary.correctionCount).toBe(1);
		expect(summary.finalErrorPx).toBeLessThanOrEqual(TOLERANCE);
		expect(summary.settledBy).toBe("within-tolerance");
		// The first attempt recorded the real 416px error it had to fix.
		expect(summary.attempts[0].scrollTopBefore).toBe(DOCUMENT_TOP - MARGIN);
		expect(summary.attempts[0].desiredScrollTop).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
	});

	it("finishes without correcting when the landing is already good", () => {
		const world = makeWorld({
			startScrollTop: CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
		});
		world.corrector.start();

		expect(world.applies.length).toBe(0);
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].correctionCount).toBe(0);
		expect(world.summaries[0].settledBy).toBe("within-tolerance");
	});

	it("falls back to the timeout when scrollend never fires", () => {
		const world = makeWorld();
		world.corrector.start();
		expect(world.summaries.length).toBe(0);
		vi.advanceTimersByTime(700);
		expect(world.summaries.length).toBe(1);
	});

	it("caps the number of corrections (never loops forever)", () => {
		const world = makeWorld({ frozen: true });
		world.corrector.start();
		settleViaScrollend();
		settleViaScrollend();
		settleViaScrollend();

		expect(world.applies.length).toBe(3);
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].correctionCount).toBe(3);
		expect(world.summaries[0].settledBy).toBe("max-corrections");
		expect(world.summaries[0].attempts.length).toBe(3);
	});

	it("reports 'timeout' when the scroll never settled on its own", () => {
		const world = makeWorld({ frozen: true });
		world.corrector.start();
		vi.advanceTimersByTime(700);
		vi.advanceTimersByTime(700);
		vi.advanceTimersByTime(700);

		expect(world.summaries[0].settledBy).toBe("timeout");
	});

	it("records one attempt per correction with before/after positions", () => {
		const world = makeWorld({ startScrollTop: DOCUMENT_TOP - MARGIN });
		world.corrector.start();
		settleViaScrollend();

		const [attempt] = world.summaries[0].attempts;
		expect(attempt.attempt).toBe(1);
		expect(attempt.targetRendered).toBe(true);
		expect(attempt.scrollErrorPx).toBeCloseTo(0, 6);
		expect(Math.abs(attempt.viewportErrorPx ?? 999)).toBeLessThanOrEqual(
			TOLERANCE,
		);
	});

	it("scrollend and timeout never double-fire a verification", () => {
		const world = makeWorld();
		world.corrector.start();
		settleViaScrollend();
		vi.advanceTimersByTime(1000);
		expect(world.summaries.length).toBe(1);
	});

	it("smoothFirst waits for the in-flight scroll before the first exact pass", () => {
		const world = makeWorld({
			smoothFirst: true,
			startScrollTop: DOCUMENT_TOP - MARGIN,
		});
		world.corrector.start();
		expect(world.applies.length).toBe(0); // animation still running

		settleViaScrollend();
		expect(world.applies.length).toBe(1);

		settleViaScrollend();
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].correctionCount).toBe(1);
	});

	it("accepts a fully visible heading pinned at the scroll boundary", () => {
		// Short document: the target can never reach the margin because the
		// scroller runs out of range, but it IS fully visible.
		const world = makeWorld({
			scrollHeight: CLIENT_HEIGHT + 100, // maxScrollTop === 100
			startScrollTop: 100, // already pinned at the bottom
			documentTop: 400, // renders ~717px down — visible, unreachable
		});
		world.corrector.start();
		settleViaScrollend();

		const summary = world.summaries[0];
		expect(summary.reachedScrollBoundary).toBe(true);
		expect(summary.acceptedAsVisibleBoundaryLanding).toBe(true);
		expect(summary.settledBy).toBe("scroll-boundary");
	});

	it("uses the document-space fallback when the target is not rendered", () => {
		const world = makeWorld({ rendered: false });
		world.corrector.start();
		settleViaScrollend();

		// The fallback still includes the content origin offset.
		expect(world.applies[0]).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
		expect(world.summaries[0].targetRenderedAtFinish).toBe(false);
	});

	it("dispose cancels everything without reporting", () => {
		const world = makeWorld();
		world.corrector.start();
		world.corrector.dispose();
		settleViaScrollend();
		vi.advanceTimersByTime(1000);
		expect(world.summaries.length).toBe(0);
		expect(world.corrector.state).toBe("complete");
	});
});
