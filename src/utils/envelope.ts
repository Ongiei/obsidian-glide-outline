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

/** Shift one rect vertically in place (scroll-delta geometry, section 8). */
export function shiftRect(rect: Rect, deltaY: number): void {
	rect.top -= deltaY;
	rect.bottom -= deltaY;
}

/**
 * Apply an outline-internal scroll delta to the cached envelope IN PLACE:
 * item rects move with the scrolled content; the rail hit zone is fixed
 * to the viewport and stays put. This replaces a full geometry rebuild
 * for pure vertical scrolling (user wheel AND pointer edge auto-scroll).
 */
export function shiftEnvelopeItems(
	envelope: PointerEnvelope,
	deltaY: number,
): void {
	if (!Number.isFinite(deltaY) || deltaY === 0) return;
	for (const item of envelope.items) {
		shiftRect(item.markerRect, deltaY);
		shiftRect(item.cardRect, deltaY);
		shiftRect(item.bridgeRect, deltaY);
	}
}

/**
 * True when (x, y) lies inside the rail hit zone OR any visible item's
 * marker / card / bridge rectangle. The envelope is the UNION of these
 * regions — it is explicitly NOT a single bounding rectangle of them all,
 * so a long title cannot enlarge the hover range of a short neighbour.
 */
export function pointInEnvelope(envelope: PointerEnvelope, x: number, y: number): boolean {
	if (pointInRect(envelope.railRect, x, y)) return true;
	for (const item of envelope.items) {
		if (
			pointInRect(item.markerRect, x, y) ||
			pointInRect(item.cardRect, x, y) ||
			pointInRect(item.bridgeRect, x, y)
		) {
			return true;
		}
	}
	return false;
}
