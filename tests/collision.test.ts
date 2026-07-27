import { describe, expect, it } from "vitest";
import type { CollisionLayoutItem } from "../src/utils/geometry";
import { computeCollisionFreeMagnification } from "../src/utils/geometry";

const GAP = 4;

/** Rows of `height` stacked with rowHeight = height + GAP, starting at y0. */
function stack(heights: readonly number[], y0 = 100): CollisionLayoutItem[] {
	const items: CollisionLayoutItem[] = [];
	let top = y0;
	for (const height of heights) {
		const rowHeight = height + GAP;
		items.push({ center: top + rowHeight / 2, height });
		top += rowHeight;
	}
	return items;
}

/** Core invariant: adjacent final centers keep scaled half-heights + gap. */
function assertNoOverlap(
	items: readonly CollisionLayoutItem[],
	results: readonly { scale: number; translateY: number }[],
	gap = GAP,
): void {
	for (let i = 0; i + 1 < items.length; i++) {
		const a = items[i];
		const b = items[i + 1];
		const centerA = a.center + results[i].translateY;
		const centerB = b.center + results[i + 1].translateY;
		const required =
			(a.height * results[i].scale) / 2 +
			(b.height * results[i + 1].scale) / 2 +
			gap;
		expect(centerB - centerA).toBeGreaterThanOrEqual(required - 0.02);
	}
}

describe("computeCollisionFreeMagnification", () => {
	it("returns identity for an empty list", () => {
		expect(computeCollisionFreeMagnification(0, [], 1.25, 90, GAP)).toEqual([]);
	});

	it("keeps equal-height cards separated at every pointer position", () => {
		const items = stack(Array.from({ length: 20 }, () => 22));
		for (let y = 50; y <= 700; y += 13) {
			const results = computeCollisionFreeMagnification(y, items, 1.25, 90, GAP);
			assertNoOverlap(items, results);
		}
	});

	it("keeps mixed-height cards separated (H1 large, H6 small)", () => {
		const items = stack([34, 22, 22, 16, 28, 14, 40, 22, 18, 30]);
		for (let y = 80; y <= 500; y += 7) {
			const results = computeCollisionFreeMagnification(y, items, 1.5, 120, GAP);
			assertNoOverlap(items, results);
		}
	});

	it("is a no-op at maxScale 1", () => {
		const items = stack([22, 22, 22, 22]);
		const results = computeCollisionFreeMagnification(
			items[1].center,
			items,
			1,
			90,
			GAP,
		);
		for (const r of results) {
			expect(r.scale).toBe(1);
			expect(r.translateY).toBe(0);
		}
	});

	it.each([
		[1.25, 40],
		[1.25, 90],
		[1.25, 240],
		[1.75, 40],
		[1.75, 90],
		[1.75, 240],
	])("holds the invariant at maxScale %s / radius %s", (maxScale, radius) => {
		const items = stack([28, 22, 22, 18, 22, 35, 22, 14, 22, 22, 26, 22]);
		for (let y = 60; y <= 520; y += 9) {
			const results = computeCollisionFreeMagnification(
				y,
				items,
				maxScale,
				radius,
				GAP,
			);
			assertNoOverlap(items, results);
		}
	});

	it("anchors the item under the pointer at its original center", () => {
		const items = stack([22, 22, 22, 22, 22]);
		const results = computeCollisionFreeMagnification(
			items[2].center,
			items,
			1.75,
			90,
			GAP,
		);
		expect(results[2].translateY).toBe(0);
		expect(results[2].scale).toBeCloseTo(1.75, 2);
	});

	it("splits neighbours symmetrically when the pointer sits between two cards", () => {
		const items = stack([22, 22, 22, 22]);
		const midpoint = (items[1].center + items[2].center) / 2;
		const results = computeCollisionFreeMagnification(
			midpoint,
			items,
			1.5,
			90,
			GAP,
		);
		assertNoOverlap(items, results);
		expect(results[1].scale).toBeCloseTo(results[2].scale, 3);
	});

	it("does nothing when the pointer is outside the falloff radius", () => {
		const items = stack([22, 22, 22]);
		const results = computeCollisionFreeMagnification(
			items[2].center + 500,
			items,
			1.75,
			90,
			GAP,
		);
		for (const r of results) {
			expect(r.scale).toBe(1);
			expect(r.translateY).toBe(0);
		}
	});

	it("pushes the first item up (not down) when it magnifies", () => {
		const items = stack([22, 22, 22, 22, 22, 22]);
		const results = computeCollisionFreeMagnification(
			items[0].center,
			items,
			1.75,
			120,
			GAP,
		);
		assertNoOverlap(items, results);
		expect(results[0].translateY).toBe(0); // anchor holds its center
		expect(results[1].translateY).toBeGreaterThanOrEqual(0);
	});

	it("pushes the last item's neighbours upward at the bottom edge", () => {
		const items = stack([22, 22, 22, 22, 22, 22]);
		const last = items.length - 1;
		const results = computeCollisionFreeMagnification(
			items[last].center,
			items,
			1.75,
			120,
			GAP,
		);
		assertNoOverlap(items, results);
		expect(results[last].translateY).toBe(0);
		expect(results[last - 1].translateY).toBeLessThanOrEqual(0);
	});

	it("returns identity under reduced motion", () => {
		const items = stack([22, 22, 22]);
		const results = computeCollisionFreeMagnification(
			items[1].center,
			items,
			1.75,
			90,
			GAP,
			true,
		);
		for (const r of results) {
			expect(r.scale).toBe(1);
			expect(r.translateY).toBe(0);
		}
	});

	it("moves continuously as the pointer sweeps (no visible jumps)", () => {
		const items = stack(Array.from({ length: 15 }, () => 22));
		let previous: ReturnType<typeof computeCollisionFreeMagnification> | null =
			null;
		for (let y = 80; y <= 480; y += 2) {
			const results = computeCollisionFreeMagnification(y, items, 1.5, 90, GAP);
			if (previous) {
				for (let i = 0; i < results.length; i++) {
					// A 2px pointer step must never teleport an item.
					expect(
						Math.abs(results[i].translateY - previous[i].translateY),
					).toBeLessThan(6);
					expect(
						Math.abs(results[i].scale - previous[i].scale),
					).toBeLessThan(0.1);
				}
			}
			previous = results;
		}
	});

	it("never pulls items inward (only pushes apart)", () => {
		const items = stack([22, 22, 22, 22, 22]);
		const results = computeCollisionFreeMagnification(
			items[2].center,
			items,
			1.75,
			120,
			GAP,
		);
		// Above the anchor: only upward or zero; below: only downward or zero.
		expect(results[0].translateY).toBeLessThanOrEqual(0);
		expect(results[1].translateY).toBeLessThanOrEqual(0);
		expect(results[3].translateY).toBeGreaterThanOrEqual(0);
		expect(results[4].translateY).toBeGreaterThanOrEqual(0);
	});
});
