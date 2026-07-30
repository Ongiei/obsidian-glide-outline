// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollCorrector } from "../src/core/ScrollCorrector";
import type {
	JumpCorrectionSummary,
	JumpLandingEvaluation,
} from "../src/core/ScrollCorrector";
import { evaluateJumpLanding } from "../src/core/jumpLanding";

/**
 * §七: editor jump correction — 20 scenarios that verify the CALL
 * SEQUENCE, not just the final scrollTop. The invariant of 0.1.5 is that
 * every scroll of a jump goes through the SMOOTH primitive
 * (`requestScroll`); the only non-smooth escape is the explicitly gated
 * `instant-fallback`, reached solely when the landing produces no
 * measurable target at all.
 *
 * The world model reproduces the real Obsidian geometry that broke
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

interface ScrollCall {
	kind: "smooth" | "instant";
	top: number | null;
	mode: string | null;
}

describe("ScrollCorrector (§四 consistently-smooth FSM)", () => {
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
		calls: ScrollCall[];
		smoothCalls(): ScrollCall[];
		instantCalls(): ScrollCall[];
		scrollTop(): number;
		setScrollTop(v: number): void;
	}

	/**
	 * @param opts.rendered  whether coordsAtPos resolves (false → the
	 *                       document-space fallback path).
	 * @param opts.renderAfterScrolls  target becomes rendered once this
	 *                       many scrolls have been issued (virtualized
	 *                       document that materializes the line).
	 * @param opts.measurable  false → strategy "none": no coords AND no
	 *                       document estimate (instant-fallback gate).
	 * @param opts.frozen    ignore scroll requests (layout that never
	 *                       converges) so the cap can be exercised.
	 * @param opts.smoothLandingBias  px the smooth animation undershoots
	 *                       by (simulates a real smooth scroll landing
	 *                       slightly off, forcing a correction round).
	 */
	function makeWorld(
		opts: {
			startScrollTop?: number;
			maxCorrections?: number;
			rendered?: boolean;
			renderAfterScrolls?: number;
			measurable?: boolean;
			frozen?: boolean;
			scrollHeight?: number;
			documentTop?: number;
			contentOrigin?: number;
			smoothLandingBias?: number;
			withInstantFallback?: boolean;
			instantFallbackLandsAt?: number;
		} = {},
	): World {
		const renderAfter = opts.renderAfterScrolls ?? null;
		const measurable = opts.measurable ?? true;
		const frozen = opts.frozen ?? false;
		const scrollHeight = opts.scrollHeight ?? SCROLL_HEIGHT;
		const documentTop = opts.documentTop ?? DOCUMENT_TOP;
		const contentOrigin = opts.contentOrigin ?? CONTENT_ORIGIN;
		const bias = opts.smoothLandingBias ?? 0;
		let scrollTop = opts.startScrollTop ?? 0;
		let scrollsIssued = 0;
		const calls: ScrollCall[] = [];
		const summaries: JumpCorrectionSummary[] = [];

		const isRendered = (): boolean => {
			if (renderAfter !== null) return scrollsIssued >= renderAfter;
			return opts.rendered ?? true;
		};

		const evaluate = (): JumpLandingEvaluation => {
			// Where the heading really renders for the current scrollTop.
			const clientTop = contentOrigin + documentTop - scrollTop;
			const rendered = measurable && isRendered();
			return {
				scrollTop,
				scrollHeight,
				clientHeight: CLIENT_HEIGHT,
				targetClientTop: rendered ? clientTop : null,
				desiredClientTop: MARGIN,
				result: evaluateJumpLanding({
					targetClientTop: rendered ? clientTop : null,
					targetClientBottom: rendered ? clientTop + 28 : null,
					scrollerClientTop: 0,
					scrollerClientHeight: CLIENT_HEIGHT,
					scrollTop,
					scrollHeight,
					documentTop: measurable ? documentTop : null,
					contentOriginOffset: measurable ? contentOrigin : null,
					marginPx: MARGIN,
					tolerancePx: TOLERANCE,
				}),
			};
		};

		const corrector = new ScrollCorrector({
			maxCorrections: opts.maxCorrections ?? 3,
			timeoutMs: 700,
			evaluate,
			requestScroll: (top, mode) => {
				calls.push({ kind: "smooth", top, mode });
				scrollsIssued += 1;
				if (!frozen) {
					// The bias simulates the FIRST smooth animation landing
					// short (fonts/embeds settling); corrections land true.
					const miss = scrollsIssued === 1 ? bias : 0;
					const max = Math.max(0, scrollHeight - CLIENT_HEIGHT);
					scrollTop = Math.min(max, Math.max(0, top + miss));
				}
			},
			...(opts.withInstantFallback === false
				? {}
				: {
						requestInstantFallback: () => {
							calls.push({
								kind: "instant",
								top: null,
								mode: "instant-fallback",
							});
							scrollsIssued += 1;
							if (
								!frozen &&
								opts.instantFallbackLandsAt !== undefined
							) {
								scrollTop = opts.instantFallbackLandsAt;
							}
						},
					}),
			done: (summary) => summaries.push(summary),
			win,
			scroller,
		});

		return {
			corrector,
			summaries,
			calls,
			smoothCalls: () => calls.filter((c) => c.kind === "smooth"),
			instantCalls: () => calls.filter((c) => c.kind === "instant"),
			scrollTop: () => scrollTop,
			setScrollTop: (v) => {
				scrollTop = v;
			},
		};
	}

	/** scrollend fires, then the two layout-flush rAFs run (§四). */
	function settleViaScrollend(): void {
		scroller.dispatchEvent(new Event("scrollend"));
		vi.advanceTimersByTime(48); // two chained rAFs (16 ms each) + slack
	}

	/** The scrollend never fires; the timeout fallback settles the round. */
	function settleViaTimeout(): void {
		vi.advanceTimersByTime(700);
		vi.advanceTimersByTime(48);
	}

	// ── 1–5: the core smooth invariant ────────────────────────────────

	it("1. a rendered mid-document jump issues exactly one smooth scroll and no instant call", () => {
		const world = makeWorld();
		world.corrector.start();
		settleViaScrollend();

		expect(world.calls.map((c) => c.kind)).toEqual(["smooth"]);
		expect(world.smoothCalls()[0].mode).toBe("smooth-estimate");
		expect(world.instantCalls().length).toBe(0);
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].finalErrorPx).toBeLessThanOrEqual(TOLERANCE);
	});

	it("2. lands the heading exactly marginPx below the scroller top", () => {
		const world = makeWorld();
		world.corrector.start();
		settleViaScrollend();

		expect(world.scrollTop()).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
		expect(world.summaries[0].landingReason).toBe("desired-position");
	});

	it("3. does not repeat the 0.1.3 coordinate-space error", () => {
		// Start exactly where 0.1.3 stopped and called it a success.
		const world = makeWorld({ startScrollTop: DOCUMENT_TOP - MARGIN });
		world.corrector.start();
		settleViaScrollend();

		const summary = world.summaries[0];
		expect(summary.correctionCount).toBe(1);
		expect(summary.finalErrorPx).toBeLessThanOrEqual(TOLERANCE);
		expect(summary.settledBy).toBe("within-tolerance");
		// The attempt recorded the real 416px error it had to fix.
		expect(summary.attempts[0].previousScrollTop).toBe(
			DOCUMENT_TOP - MARGIN,
		);
		expect(summary.attempts[0].requestedScrollTop).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
	});

	it("4. an off-landing smooth estimate is corrected by a SMOOTH client correction (call sequence)", () => {
		// The smooth animation undershoots by 40 px; the follow-up round
		// must be another smooth request — 0.1.4 wrote scrollTop here.
		const world = makeWorld({ smoothLandingBias: -40 });
		world.corrector.start();
		settleViaScrollend(); // round 1 settles 40 px short
		settleViaScrollend(); // round 2 corrects

		const modes = world.calls.map((c) => `${c.kind}:${c.mode}`);
		expect(modes[0]).toBe("smooth:smooth-estimate");
		expect(modes[1]).toBe("smooth:smooth-client-correction");
		expect(world.instantCalls().length).toBe(0);
		expect(world.summaries[0].animationConsistent).toBe(true);
		expect(world.summaries[0].usedInstantFallback).toBe(false);
	});

	it("5. every scroll of a multi-round jump is smooth — no raw scrollTop write path exists", () => {
		const world = makeWorld({ smoothLandingBias: -25 });
		world.corrector.start();
		settleViaScrollend();
		settleViaScrollend();

		for (const call of world.calls) expect(call.kind).toBe("smooth");
		const summary = world.summaries[0];
		expect(summary.usedInstantFallback).toBe(false);
		for (const attempt of summary.attempts) {
			expect(attempt.usedInstantFallback).toBe(false);
		}
	});

	// ── 6–10: settle detection & bounded correction ───────────────────

	it("6. falls back to the timeout when scrollend never fires and still verifies", () => {
		const world = makeWorld();
		world.corrector.start();
		expect(world.summaries.length).toBe(0);
		settleViaTimeout();
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].attempts[0].settledBy).toBe("timeout");
		expect(world.summaries[0].settledBy).toBe("within-tolerance");
	});

	it("7. caps the number of corrections (never loops forever)", () => {
		const world = makeWorld({ frozen: true });
		world.corrector.start();
		settleViaScrollend();
		settleViaScrollend();
		settleViaScrollend();

		expect(world.smoothCalls().length).toBe(3);
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].correctionCount).toBe(3);
		expect(world.summaries[0].settledBy).toBe("max-corrections");
		expect(world.summaries[0].attempts.length).toBe(3);
		expect(world.summaries[0].landingReason).toBe("failed");
	});

	it("8. reports 'timeout' when the scroll never settled on its own", () => {
		const world = makeWorld({ frozen: true });
		world.corrector.start();
		settleViaTimeout();
		settleViaTimeout();
		settleViaTimeout();

		expect(world.summaries[0].settledBy).toBe("timeout");
		expect(world.summaries[0].landingReason).toBe("failed");
	});

	it("9. records the full §四 attempt payload for every round", () => {
		const world = makeWorld({ startScrollTop: DOCUMENT_TOP - MARGIN });
		world.corrector.start();
		settleViaScrollend();

		const [attempt] = world.summaries[0].attempts;
		expect(attempt.attempt).toBe(1);
		expect(attempt.mode).toBe("smooth-estimate");
		expect(attempt.trigger).toBe("initial");
		expect(attempt.targetRendered).toBe(true);
		expect(attempt.previousScrollTop).toBe(DOCUMENT_TOP - MARGIN);
		expect(attempt.requestedScrollTop).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
		expect(attempt.resultingScrollTop).toBeCloseTo(
			attempt.requestedScrollTop,
			6,
		);
		expect(attempt.scrollHeight).toBe(SCROLL_HEIGHT);
		expect(attempt.clientHeight).toBe(CLIENT_HEIGHT);
		expect(attempt.atTopBoundary).toBe(false);
		expect(attempt.atBottomBoundary).toBe(false);
		expect(attempt.settledBy).toBe("scrollend");
		expect(attempt.usedInstantFallback).toBe(false);
		expect(Math.abs(attempt.errorPx ?? 999)).toBeLessThanOrEqual(
			TOLERANCE,
		);
	});

	it("10. scrollend and timeout never double-fire a verification", () => {
		const world = makeWorld();
		world.corrector.start();
		settleViaScrollend();
		vi.advanceTimersByTime(1400);
		expect(world.summaries.length).toBe(1);
	});

	// ── 11–13: boundary landings (§六) ────────────────────────────────

	it("11. accepts a fully visible heading pinned at the bottom boundary", () => {
		// Short document: the target can never reach the margin because
		// the scroller runs out of range, but it IS fully visible.
		const world = makeWorld({
			scrollHeight: CLIENT_HEIGHT + 100, // maxScrollTop === 100
			startScrollTop: 100, // already pinned at the bottom
			documentTop: 400,
			contentOrigin: 0, // renders ~300px down — visible, unreachable
		});
		world.corrector.start();

		const summary = world.summaries[0];
		expect(summary.acceptedAsVisibleBoundaryLanding).toBe(true);
		expect(summary.settledBy).toBe("scroll-boundary");
		expect(summary.landingReason).toBe("bottom-boundary-visible");
		expect(world.calls.length).toBe(0); // nothing to scroll
	});

	it("12. accepts a fully visible heading pinned at the top boundary", () => {
		// Heading above the margin line at scrollTop 0 — cannot scroll up.
		const world = makeWorld({
			startScrollTop: 0,
			documentTop: 5,
			contentOrigin: 0, // renders 5 px down; desired is -7 → clamp 0
		});
		world.corrector.start();

		const summary = world.summaries[0];
		expect(summary.acceptedAsVisibleBoundaryLanding).toBe(true);
		expect(summary.landingReason).toBe("top-boundary-visible");
		expect(world.calls.length).toBe(0);
	});

	it("13. a round that ends pinned-but-visible is recorded as boundary-accepted", () => {
		// Starts far away; the smooth estimate is clamped to the bottom
		// boundary where the target IS fully visible.
		const world = makeWorld({
			scrollHeight: CLIENT_HEIGHT + 200, // maxScrollTop === 200
			startScrollTop: 0,
			documentTop: 700,
			contentOrigin: 0, // at max scroll renders 500px down — visible
		});
		world.corrector.start();
		settleViaScrollend();

		const summary = world.summaries[0];
		expect(summary.settledBy).toBe("scroll-boundary");
		expect(summary.attempts[0].mode).toBe("boundary-accepted");
		expect(summary.attempts[0].atBottomBoundary).toBe(true);
		expect(summary.landingReason).toBe("bottom-boundary-visible");
		expect(world.instantCalls().length).toBe(0);
	});

	// ── 14–17: virtualized / unrendered targets ───────────────────────

	it("14. an unrendered target gets a SMOOTH document-space estimate (with content origin)", () => {
		const world = makeWorld({ rendered: false, renderAfterScrolls: 1 });
		world.corrector.start();
		settleViaScrollend();

		expect(world.calls[0].kind).toBe("smooth");
		expect(world.calls[0].mode).toBe("smooth-estimate");
		// The fallback still includes the content origin offset (§五).
		expect(world.calls[0].top).toBeCloseTo(
			CONTENT_ORIGIN + DOCUMENT_TOP - MARGIN,
			6,
		);
		expect(world.summaries[0].usedInstantFallback).toBe(false);
	});

	it("15. estimate → render → smooth client correction (unrendered call sequence)", () => {
		// The smooth estimate lands 60 px off; once the line materializes
		// the follow-up is a smooth-client-correction, never instant.
		const world = makeWorld({
			rendered: false,
			renderAfterScrolls: 1,
			smoothLandingBias: -60,
		});
		world.corrector.start();
		settleViaScrollend();
		settleViaScrollend();

		const modes = world.calls.map((c) => `${c.kind}:${c.mode}`);
		expect(modes).toEqual([
			"smooth:smooth-estimate",
			"smooth:smooth-client-correction",
		]);
		expect(world.summaries[0].animationConsistent).toBe(true);
		expect(world.summaries[0].finalErrorPx).toBeLessThanOrEqual(
			TOLERANCE,
		);
	});

	it("16. instant fallback fires ONLY for a wholly unmeasurable landing and is recorded", () => {
		const world = makeWorld({
			measurable: false,
			instantFallbackLandsAt: 1234,
		});
		world.corrector.start();
		settleViaScrollend();

		expect(world.instantCalls().length).toBe(1);
		const summary = world.summaries[0];
		expect(summary.usedInstantFallback).toBe(true);
		expect(summary.animationConsistent).toBe(false);
		expect(summary.attempts[0].mode).toBe("instant-fallback");
		expect(summary.attempts[0].usedInstantFallback).toBe(true);
	});

	it("17. an unmeasurable landing without a fallback hook finishes as target-not-rendered", () => {
		const world = makeWorld({
			measurable: false,
			withInstantFallback: false,
		});
		world.corrector.start();

		expect(world.calls.length).toBe(0);
		expect(world.summaries[0].settledBy).toBe("target-not-rendered");
		expect(world.summaries[0].landingReason).toBe("failed");
		expect(world.summaries[0].usedInstantFallback).toBe(false);
	});

	it("18. the gated fallback never spins: still unmeasurable after one shot → stop", () => {
		const world = makeWorld({ measurable: false });
		world.corrector.start();
		settleViaScrollend();
		settleViaScrollend();
		vi.advanceTimersByTime(3000);

		expect(world.instantCalls().length).toBe(1);
		expect(world.summaries.length).toBe(1);
		expect(world.summaries[0].settledBy).toBe("target-not-rendered");
	});

	// ── 19–20: lifecycle ──────────────────────────────────────────────

	it("19. walks the §四 FSM states in order for a two-round jump", () => {
		const world = makeWorld({ smoothLandingBias: -40 });
		expect(world.corrector.state).toBe("idle");
		world.corrector.start();
		expect(world.corrector.state).toBe("smooth-scrolling");
		scroller.dispatchEvent(new Event("scrollend"));
		expect(world.corrector.state).toBe("waiting-layout");
		vi.advanceTimersByTime(48); // verify → smooth-correcting → round 2
		expect(world.corrector.state).toBe("smooth-scrolling");
		settleViaScrollend();
		expect(world.corrector.state).toBe("complete");
		expect(world.summaries.length).toBe(1);
	});

	it("20. dispose cancels everything without reporting (new jump cancels old)", () => {
		const world = makeWorld();
		world.corrector.start();
		world.corrector.dispose();
		const callsAtDispose = world.calls.length;
		settleViaScrollend();
		vi.advanceTimersByTime(3000);
		expect(world.summaries.length).toBe(0);
		expect(world.calls.length).toBe(callsAtDispose);
		expect(world.corrector.state).toBe("complete");
	});
});
