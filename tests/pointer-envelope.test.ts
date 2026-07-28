import { describe, expect, it } from "vitest";
import {
	bridgeRectFor,
	emptyRect,
	pointInEnvelope,
	pointInRect,
	unionRect,
} from "../src/utils/envelope";
import type { PointerEnvelope, Rect } from "../src/utils/envelope";

/**
 * Geometric Pointer Envelope (section 8): hover is maintained by the UNION
 * of each heading's actual marker / card / bridge rects — explicitly NOT
 * by one big bounding rectangle, so a long title can never widen a short
 * neighbour's hover range.
 */

function rect(left: number, top: number, right: number, bottom: number): Rect {
	return { left, top, right, bottom };
}

describe("rect primitives", () => {
	it("pointInRect is inclusive on all edges", () => {
		const r = rect(10, 20, 30, 40);
		expect(pointInRect(r, 10, 20)).toBe(true);
		expect(pointInRect(r, 30, 40)).toBe(true);
		expect(pointInRect(r, 9.99, 30)).toBe(false);
		expect(pointInRect(r, 20, 40.01)).toBe(false);
	});

	it("unionRect spans both inputs", () => {
		const u = unionRect(rect(0, 0, 10, 10), rect(20, 5, 40, 30));
		expect(u).toEqual(rect(0, 0, 40, 30));
	});
});

describe("bridgeRectFor", () => {
	it("spans ONLY the heading's own marker and card plus tolerance", () => {
		const marker = rect(300, 100, 310, 120);
		const card = rect(200, 102, 280, 118);
		const bridge = bridgeRectFor(marker, card, 9, 5);
		expect(bridge.left).toBe(200 - 9);
		expect(bridge.right).toBe(310 + 9);
		expect(bridge.top).toBe(100 - 5);
		expect(bridge.bottom).toBe(120 + 5);
	});

	it("horizontal tolerance stays within the 8–10px band, vertical within 4–6px", () => {
		// Guard: the tolerances the controller feeds in must stay in-spec.
		const marker = rect(0, 0, 10, 10);
		const card = rect(-50, 0, -10, 10);
		const b = bridgeRectFor(marker, card, 9, 5);
		expect(b.left).toBeGreaterThanOrEqual(-50 - 10);
		expect(b.left).toBeLessThanOrEqual(-50 - 8);
		expect(b.top).toBeGreaterThanOrEqual(0 - 6);
		expect(b.top).toBeLessThanOrEqual(0 - 4);
	});
});

describe("pointInEnvelope", () => {
	// Two headings on a right-side rail: markers at x≈500, cards to the
	// left. Heading A has a LONG card, heading B a SHORT one.
	const markerA = rect(500, 100, 510, 116);
	const cardA = rect(240, 98, 490, 118); // long title
	const markerB = rect(500, 140, 510, 156);
	const cardB = rect(430, 138, 490, 158); // short title
	const envelope: PointerEnvelope = {
		railRect: rect(495, 0, 523, 600),
		items: [
			{
				key: "a",
				markerRect: markerA,
				cardRect: cardA,
				bridgeRect: bridgeRectFor(markerA, cardA, 9, 5),
			},
			{
				key: "b",
				markerRect: markerB,
				cardRect: cardB,
				bridgeRect: bridgeRectFor(markerB, cardB, 9, 5),
			},
		],
	};

	it("contains the rail, markers and cards", () => {
		expect(pointInEnvelope(envelope, 500, 300)).toBe(true); // rail
		expect(pointInEnvelope(envelope, 505, 108)).toBe(true); // marker A
		expect(pointInEnvelope(envelope, 300, 108)).toBe(true); // card A
		expect(pointInEnvelope(envelope, 450, 148)).toBe(true); // card B
	});

	it("bridges the marker↔card gap for each heading", () => {
		// Between card A's right edge (490) and marker A's left edge (500).
		expect(pointInEnvelope(envelope, 494, 108)).toBe(true);
		// Same gap for heading B.
		expect(pointInEnvelope(envelope, 494, 148)).toBe(true);
	});

	it("a long neighbour does NOT widen a short heading's hover range", () => {
		// x=300 is inside card A's span but FAR left of card B. At B's row
		// (y≈148) the envelope must NOT contain it — a bounding-box
		// implementation would wrongly return true here.
		expect(pointInEnvelope(envelope, 300, 148)).toBe(false);
	});

	it("blank space above/below all headings is outside", () => {
		expect(pointInEnvelope(envelope, 300, 50)).toBe(false);
		expect(pointInEnvelope(envelope, 300, 500)).toBe(false);
	});

	it("an empty envelope contains nothing", () => {
		const empty: PointerEnvelope = { railRect: emptyRect(), items: [] };
		expect(pointInEnvelope(empty, 5, 5)).toBe(false);
	});
});
