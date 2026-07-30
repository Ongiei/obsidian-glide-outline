import { describe, expect, it } from "vitest";
import { evaluateJumpLanding } from "../src/core/jumpLanding";
import type { JumpLandingInput } from "../src/core/jumpLanding";

/**
 * §五: regression coverage for the coordinate-space bug that produced
 * `finalErrorPx = 416.65625` on the Windows 0.1.3 baseline.
 *
 * The Obsidian editor scroller contains the inline title and the
 * properties block ABOVE the CodeMirror content, so document space
 * (`lineBlockAt().top`) starts ~417 px below scroll space (`scrollTop`).
 * The old corrector subtracted one from the other and "converged" on a
 * scroll position that was off by exactly that offset.
 */

/** The measured Windows offset from the 0.1.3 baseline capture. */
const CONTENT_ORIGIN_OFFSET = 416.65625;
const MARGIN = 12;
const SCROLLER_CLIENT_TOP = 80;
const SCROLLER_CLIENT_HEIGHT = 900;
const SCROLL_HEIGHT = 20000;
/** Document-space top of the heading we are jumping to. */
const DOCUMENT_TOP = 5000;

/** Where the line really renders for a given scrollTop. */
function renderedClientTop(scrollTop: number): number {
	return SCROLLER_CLIENT_TOP + CONTENT_ORIGIN_OFFSET + DOCUMENT_TOP - scrollTop;
}

function inputAt(scrollTop: number, over: Partial<JumpLandingInput> = {}) {
	const top = renderedClientTop(scrollTop);
	return {
		targetClientTop: top,
		targetClientBottom: top + 28,
		scrollerClientTop: SCROLLER_CLIENT_TOP,
		scrollerClientHeight: SCROLLER_CLIENT_HEIGHT,
		scrollTop,
		scrollHeight: SCROLL_HEIGHT,
		documentTop: DOCUMENT_TOP,
		contentOriginOffset: CONTENT_ORIGIN_OFFSET,
		marginPx: MARGIN,
		tolerancePx: 3,
		...over,
	} satisfies JumpLandingInput;
}

describe("evaluateJumpLanding — 0.1.3 coordinate-space regression", () => {
	it("reports the full 416px error at the position the old corrector accepted", () => {
		// The 0.1.3 corrector stopped here: scrollTop === lineBlockAt.top - margin,
		// i.e. it believed the error was 0.
		const oldAcceptedScrollTop = DOCUMENT_TOP - MARGIN;
		const result = evaluateJumpLanding(inputAt(oldAcceptedScrollTop));

		expect(result.strategy).toBe("coords");
		expect(result.targetRendered).toBe(true);
		expect(result.viewportErrorPx).toBeCloseTo(CONTENT_ORIGIN_OFFSET, 4);
		expect(result.settled).toBe(false);
	});

	it("converges in one correction from the bad landing", () => {
		const first = evaluateJumpLanding(inputAt(DOCUMENT_TOP - MARGIN));
		const corrected = evaluateJumpLanding(inputAt(first.desiredScrollTop));

		expect(corrected.viewportErrorPx).toBeCloseTo(0, 6);
		expect(corrected.settled).toBe(true);
		expect(corrected.acceptedAsVisibleBoundaryLanding).toBe(false);
	});

	it("lands the heading exactly marginPx below the scroller top", () => {
		const target = evaluateJumpLanding(
			inputAt(DOCUMENT_TOP - MARGIN),
		).desiredScrollTop;
		expect(renderedClientTop(target) - SCROLLER_CLIENT_TOP).toBeCloseTo(
			MARGIN,
			6,
		);
	});

	it("accepts a landing already within tolerance without moving", () => {
		const settledScrollTop = CONTENT_ORIGIN_OFFSET + DOCUMENT_TOP - MARGIN;
		const result = evaluateJumpLanding(inputAt(settledScrollTop + 2));
		expect(result.settled).toBe(true);
		expect(Math.abs(result.deltaPx)).toBeLessThanOrEqual(3);
	});
});

describe("evaluateJumpLanding — scroll boundary handling", () => {
	it("accepts a fully visible end-of-document heading pinned at the bottom", () => {
		const maxScrollTop = SCROLL_HEIGHT - SCROLLER_CLIENT_HEIGHT;
		// Heading renders 400px down the viewport and cannot be raised:
		// the scroller is already at its maximum.
		const result = evaluateJumpLanding({
			targetClientTop: SCROLLER_CLIENT_TOP + 400,
			targetClientBottom: SCROLLER_CLIENT_TOP + 428,
			scrollerClientTop: SCROLLER_CLIENT_TOP,
			scrollerClientHeight: SCROLLER_CLIENT_HEIGHT,
			scrollTop: maxScrollTop,
			scrollHeight: SCROLL_HEIGHT,
			documentTop: null,
			contentOriginOffset: null,
			marginPx: MARGIN,
			tolerancePx: 3,
		});

		expect(result.clampedAtBoundary).toBe(true);
		expect(result.deltaPx).toBe(0);
		expect(result.acceptedAsVisibleBoundaryLanding).toBe(true);
		expect(result.settled).toBe(true);
		// The real error is still reported honestly for diagnostics.
		expect(result.viewportErrorPx).toBeCloseTo(388, 6);
	});

	it("does NOT accept a boundary landing when the target is off-screen", () => {
		const maxScrollTop = SCROLL_HEIGHT - SCROLLER_CLIENT_HEIGHT;
		const belowViewport =
			SCROLLER_CLIENT_TOP + SCROLLER_CLIENT_HEIGHT + 120;
		const result = evaluateJumpLanding({
			targetClientTop: belowViewport,
			targetClientBottom: belowViewport + 28,
			scrollerClientTop: SCROLLER_CLIENT_TOP,
			scrollerClientHeight: SCROLLER_CLIENT_HEIGHT,
			scrollTop: maxScrollTop,
			scrollHeight: SCROLL_HEIGHT,
			documentTop: null,
			contentOriginOffset: null,
			marginPx: MARGIN,
			tolerancePx: 3,
		});

		expect(result.acceptedAsVisibleBoundaryLanding).toBe(false);
		expect(result.settled).toBe(false);
	});

	it("clamps a negative desired position to zero", () => {
		const result = evaluateJumpLanding({
			targetClientTop: SCROLLER_CLIENT_TOP + 4,
			targetClientBottom: SCROLLER_CLIENT_TOP + 32,
			scrollerClientTop: SCROLLER_CLIENT_TOP,
			scrollerClientHeight: SCROLLER_CLIENT_HEIGHT,
			scrollTop: 0,
			scrollHeight: SCROLL_HEIGHT,
			documentTop: null,
			contentOriginOffset: null,
			marginPx: MARGIN,
			tolerancePx: 3,
		});
		expect(result.desiredScrollTop).toBe(0);
		expect(result.deltaPx).toBe(0);
	});
});

describe("evaluateJumpLanding — unrendered target fallback", () => {
	it("converts document space to scroll space instead of mixing axes", () => {
		const result = evaluateJumpLanding(
			inputAt(0, { targetClientTop: null, targetClientBottom: null }),
		);
		expect(result.strategy).toBe("document-fallback");
		expect(result.targetRendered).toBe(false);
		expect(result.viewportErrorPx).toBeNull();
		// The offset the 0.1.3 math dropped is included here.
		expect(result.desiredScrollTop).toBeCloseTo(
			CONTENT_ORIGIN_OFFSET + DOCUMENT_TOP - MARGIN,
			6,
		);
		expect(result.settled).toBe(false);
	});

	it("reports 'none' when nothing can be measured", () => {
		const result = evaluateJumpLanding(
			inputAt(1234, {
				targetClientTop: null,
				targetClientBottom: null,
				documentTop: null,
				contentOriginOffset: null,
			}),
		);
		expect(result.strategy).toBe("none");
		expect(result.deltaPx).toBe(0);
		expect(result.settled).toBe(false);
	});
});
