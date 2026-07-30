import { describe, expect, it } from "vitest";
import {
	clientYToContentY,
	contentRangeForViewport,
	contentYToClientY,
} from "../src/utils/contentCoords";
import type { ScrollViewportFrame } from "../src/utils/contentCoords";

/** A scroller whose top edge is 120 px down the window, 800 px tall. */
function frame(scrollTop: number): ScrollViewportFrame {
	return { viewportTop: 120, viewportBottom: 920, scrollTop };
}

describe("§六 content-coordinate conversions", () => {
	it("maps the scroller's top edge to exactly scrollTop", () => {
		expect(clientYToContentY(frame(0), 120)).toBe(0);
		expect(clientYToContentY(frame(450.25), 120)).toBe(450.25);
	});

	it("client→content and content→client are exact inverses", () => {
		const f = frame(1337.75);
		for (const clientY of [-40, 0, 120, 500.5, 920, 5000]) {
			expect(contentYToClientY(f, clientYToContentY(f, clientY))).toBeCloseTo(
				clientY,
				10,
			);
		}
	});

	it("a row's content center is scroll-INVARIANT (the whole point)", () => {
		// The same physical row, measured before and after a 300 px scroll:
		// its client center moved by −300, its content center did not move.
		const before = clientYToContentY(frame(0), 400);
		const after = clientYToContentY(frame(300), 100);
		expect(after).toBe(before);
	});

	it("scrolling moves the CONTENT WINDOW, not the content", () => {
		expect(contentRangeForViewport(frame(0))).toEqual({ top: 0, bottom: 800 });
		expect(contentRangeForViewport(frame(250))).toEqual({
			top: 250,
			bottom: 1050,
		});
	});

	it("a degenerate (zero/negative height) scroller yields an empty window", () => {
		const collapsed: ScrollViewportFrame = {
			viewportTop: 300,
			viewportBottom: 300,
			scrollTop: 40,
		};
		expect(contentRangeForViewport(collapsed)).toEqual({ top: 40, bottom: 40 });
		const inverted: ScrollViewportFrame = {
			viewportTop: 300,
			viewportBottom: 100,
			scrollTop: 40,
		};
		expect(contentRangeForViewport(inverted)).toEqual({ top: 40, bottom: 40 });
	});

	it("a pointer held still while the list scrolls moves in content space", () => {
		// Stationary pointer at client 500; the list scrolls 60 px down.
		// In content space the pointer advanced by exactly 60 — which is
		// why the cached anchor has to be re-resolved after a scroll.
		const a = clientYToContentY(frame(0), 500);
		const b = clientYToContentY(frame(60), 500);
		expect(b - a).toBe(60);
	});
});
