/**
 * §六 Content-coordinate model for the outline list.
 *
 * Two vertical spaces are in play:
 *
 *   • CLIENT space — what `getBoundingClientRect` and pointer events speak.
 *     Origin is the top of the window. A scroll MOVES every row in it.
 *   • CONTENT space — measured from the top of the scrollable content.
 *     Origin is the content itself. A scroll moves NOTHING in it; it only
 *     slides the viewport window over it.
 *
 * The magnification cache used to live in client space, which forced a full
 * O(n) rewrite of every cached center, layout entry and envelope rect on
 * every single scroll event — the dominant cost of the auto-scroll path.
 * Storing the cache in content space turns that into an O(1) update of one
 * number (`scrollTop`), with these three conversions applied to the two
 * genuinely moving inputs (the pointer, the visible window) once per frame.
 *
 * All functions are pure so the conversion algebra can be unit-tested
 * without a layout engine.
 */

/** Where the scroller sits and how far it is scrolled. */
export interface ScrollViewportFrame {
	/** Client Y of the scroller's top edge (its own client rect). */
	viewportTop: number;
	/** Client Y of the scroller's bottom edge. */
	viewportBottom: number;
	/** The scroller's current `scrollTop`. */
	scrollTop: number;
}

/** A vertical window, in content coordinates. */
export interface ContentRange {
	top: number;
	bottom: number;
}

/**
 * Viewport CLIENT y → CONTENT y.
 *
 * The content origin sits `scrollTop` px above the scroller's client top,
 * so the conversion is a single subtraction plus a single addition — and,
 * crucially, both operands are cached numbers (no layout read).
 */
export function clientYToContentY(
	frame: ScrollViewportFrame,
	clientY: number,
): number {
	return clientY - frame.viewportTop + frame.scrollTop;
}

/** CONTENT y → viewport CLIENT y (exact inverse of `clientYToContentY`). */
export function contentYToClientY(
	frame: ScrollViewportFrame,
	contentY: number,
): number {
	return contentY + frame.viewportTop - frame.scrollTop;
}

/**
 * The currently visible window, in CONTENT coordinates. Equivalent to
 * converting both viewport edges, but stated directly because the top edge
 * always converts to exactly `scrollTop`.
 */
export function contentRangeForViewport(
	frame: ScrollViewportFrame,
): ContentRange {
	const height = frame.viewportBottom - frame.viewportTop;
	return {
		top: frame.scrollTop,
		bottom: frame.scrollTop + (height > 0 ? height : 0),
	};
}
