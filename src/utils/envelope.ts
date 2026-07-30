/**
 * Geometric Pointer Envelope — maintains hover without a giant transparent
 * DOM plane (which the longest title used to stretch across every other
 * heading's hover range).
 *
 * The envelope is the UNION of small, per-heading rectangles:
 *   - the rail hit zone
 *   - each visible heading's actual marker rect
 *   - each visible heading's actual (scaled, translated) card rect
 *   - each heading's own bridge rect — the tight box spanning ONLY that
 *     heading's marker and card, plus a few px of tolerance.
 *
 * The bridge connects a heading to its own card; it never grows to the
 * longest-title width and never covers another heading's blank space. All
 * functions here are pure so they can be unit-tested without a layout engine.
 */

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export function emptyRect(): Rect {
	return { left: 0, top: 0, right: 0, bottom: 0 };
}

/** Axis-aligned point-in-rect test (inclusive on all edges). */
export function pointInRect(rect: Rect, x: number, y: number): boolean {
	return (
		x >= rect.left &&
		x <= rect.right &&
		y >= rect.top &&
		y <= rect.bottom
	);
}

export function unionRect(a: Rect, b: Rect): Rect {
	return {
		left: Math.min(a.left, b.left),
		top: Math.min(a.top, b.top),
		right: Math.max(a.right, b.right),
		bottom: Math.max(a.bottom, b.bottom),
	};
}

export interface PointerEnvelopeItem {
	key: string;
	markerRect: Rect;
	cardRect: Rect;
	bridgeRect: Rect;
}

export interface PointerEnvelope {
	railRect: Rect;
	items: PointerEnvelopeItem[];
}

/**
 * Bridge connects ONLY one heading's own marker and card. A small tolerance
 * keeps the hit area comfortable without ever stretching it to the longest
 * title or over another heading's whitespace.
 *
 * @param hTolerance horizontal slack in px (8–10)
 * @param vTolerance vertical slack in px (4–6)
 */
export function bridgeRectFor(
	markerRect: Rect,
	cardRect: Rect,
	hTolerance: number,
	vTolerance: number,
): Rect {
	const box = unionRect(markerRect, cardRect);
	return {
		left: box.left - hTolerance,
		top: box.top - vTolerance,
		right: box.right + hTolerance,
		bottom: box.bottom + vTolerance,
	};
}

/** Translate one rect vertically in place by +deltaY. */
export function translateRectY(rect: Rect, deltaY: number): void {
	rect.top += deltaY;
	rect.bottom += deltaY;
}

/**
 * §七 Translate the ITEM rects vertically in place by +deltaY. The rail hit
 * zone is deliberately untouched: it is viewport-fixed, while item rects are
 * stored in CONTENT coordinates (scroll-independent) so an outline scroll
 * costs nothing at all — no per-scroll rewrite of the cached envelope.
 *
 * Used exactly once per envelope rebuild, to convert the freshly measured
 * client rects into content space.
 */
export function translateEnvelopeItemsY(
	envelope: PointerEnvelope,
	deltaY: number,
): void {
	if (!Number.isFinite(deltaY) || deltaY === 0) return;
	for (const item of envelope.items) {
		translateRectY(item.markerRect, deltaY);
		translateRectY(item.cardRect, deltaY);
		translateRectY(item.bridgeRect, deltaY);
	}
}

/**
 * True when the point lies inside the rail hit zone OR any visible item's
 * marker / card / bridge rectangle. The envelope is the UNION of these
 * regions — it is explicitly NOT a single bounding rectangle of them all,
 * so a long title cannot enlarge the hover range of a short neighbour.
 *
 * §七 two vertical coordinates: `railY` is the pointer in CLIENT space (the
 * rail is viewport-fixed) and `itemY` is the same pointer in the item rects'
 * space. Callers holding a content-space envelope pass the content Y for
 * `itemY`; callers with a plain client-space envelope omit it.
 */
export function pointInEnvelope(
	envelope: PointerEnvelope,
	x: number,
	railY: number,
	itemY: number = railY,
): boolean {
	if (pointInRect(envelope.railRect, x, railY)) return true;
	for (const item of envelope.items) {
		if (
			pointInRect(item.markerRect, x, itemY) ||
			pointInRect(item.cardRect, x, itemY) ||
			pointInRect(item.bridgeRect, x, itemY)
		) {
			return true;
		}
	}
	return false;
}
