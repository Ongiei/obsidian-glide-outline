import { describe, expect, it } from "vitest";
import {
	computeCollisionFreeMagnification,
	mapVisualPointerToBase,
} from "../src/utils/geometry";
import type { CollisionLayoutItem } from "../src/utils/geometry";

/** Three rows, base centers 100/140/180, uniform height. */
const BASE_CENTERS = [100, 140, 180] as const;
const ITEMS: CollisionLayoutItem[] = BASE_CENTERS.map((center) => ({
	center,
	height: 20,
}));

describe("mapVisualPointerToBase (P0-5)", () => {
	it("is the identity when nothing is shifted", () => {
		expect(mapVisualPointerToBase(140, BASE_CENTERS, [0, 0, 0])).toBe(140);
		expect(mapVisualPointerToBase(115, BASE_CENTERS, [0, 0, 0])).toBe(115);
	});

	it("subtracts exactly the anchored row's shift (DOM hit wins)", () => {
		// Row 1 is displaced +12 → its card visually sits at 152. A pointer
		// on that card (152) must map back to the BASE center 140.
		const shifts = [4, 12, -6];
		expect(mapVisualPointerToBase(152, BASE_CENTERS, shifts, 1)).toBe(140);
		// Anchor also wins when the raw y is numerically closer to another
		// row's base center — the user points at what they SEE.
		expect(mapVisualPointerToBase(148, BASE_CENTERS, shifts, 1)).toBe(136);
	});

	it("interpolates between bracketing visual centers on blank space", () => {
		// Visual centers: 100+10=110, 140-10=130. Pointer at their midpoint
		// (120) → interpolated shift 0 → base 120.
		const shifts = [10, -10, 0];
		expect(mapVisualPointerToBase(120, BASE_CENTERS, shifts)).toBe(120);
		// At a visual center itself the mapping returns that base center.
		expect(mapVisualPointerToBase(110, BASE_CENTERS, shifts)).toBe(100);
		expect(mapVisualPointerToBase(130, BASE_CENTERS, shifts)).toBe(140);
	});

	it("clamps to the edge shifts outside the list", () => {
		const shifts = [8, 0, -8];
		// Above the first visual center: subtract the FIRST row's shift.
		expect(mapVisualPointerToBase(50, BASE_CENTERS, shifts)).toBe(42);
		// Below the last visual center: subtract the LAST row's shift.
		expect(mapVisualPointerToBase(250, BASE_CENTERS, shifts)).toBe(258);
	});

	it("is continuous in pointerY (no teleports while sweeping)", () => {
		const shifts = [14, -3, -14];
		let previous = mapVisualPointerToBase(60, BASE_CENTERS, shifts);
		for (let y = 61; y <= 220; y++) {
			const mapped = mapVisualPointerToBase(y, BASE_CENTERS, shifts);
			// A 1px pointer step never moves the mapped point by more than
			// a few px — the displacement field has |gradient| < 1.
			expect(Math.abs(mapped - previous)).toBeLessThanOrEqual(3);
			previous = mapped;
		}
	});

	it("falls back to the identity on malformed input", () => {
		expect(mapVisualPointerToBase(120, BASE_CENTERS, [0, 0])).toBe(120);
		expect(mapVisualPointerToBase(Number.NaN, BASE_CENTERS, [0, 0, 0])).toBe(
			Number.NaN,
		);
		expect(mapVisualPointerToBase(120, [], [])).toBe(120);
	});
});

describe("computeCollisionFreeMagnification with visual mapping (P0-5)", () => {
	it("gives the anchored row the peak scale even when displaced", () => {
		// Frame 1 (no shifts yet): pointer exactly on row 1's base center.
		const first = computeCollisionFreeMagnification(
			140,
			ITEMS,
			1.75,
			90,
			4,
			false,
		);
		const shifts = first.map((r) => r.translateY);
		// Row 1 was magnified in place; neighbours were pushed apart.
		expect(first[1].scale).toBe(1.75);

		// Frame 2: the pointer FOLLOWS row 1's visually displaced card.
		const visualY = 140 + shifts[1];
		const second = computeCollisionFreeMagnification(
			visualY,
			ITEMS,
			1.75,
			90,
			4,
			false,
			{ currentShifts: shifts, preferredAnchorIndex: 1 },
		);
		// The anchor maps the pointer back to base 140 → row 1 keeps the
		// exact peak scale instead of drifting toward a neighbour.
		expect(second[1].scale).toBe(1.75);
		expect(second[1].scale).toBeGreaterThan(second[0].scale);
		expect(second[1].scale).toBeGreaterThan(second[2].scale);
	});

	it("converges across frames (shift feedback is stable)", () => {
		let shifts = [0, 0, 0];
		const pointerOnRow = (i: number): number => ITEMS[i].center + shifts[i];
		let last: number[] = shifts;
		for (let frame = 0; frame < 10; frame++) {
			const results = computeCollisionFreeMagnification(
				pointerOnRow(1),
				ITEMS,
				2.25,
				90,
				4,
				false,
				{ currentShifts: shifts, preferredAnchorIndex: 1 },
			);
			last = shifts;
			shifts = results.map((r) => r.translateY);
		}
		// After a few frames the shifts stop changing (fixed point).
		for (let i = 0; i < shifts.length; i++) {
			expect(Math.abs(shifts[i] - last[i])).toBeLessThan(0.01);
		}
	});

	it("keeps the reduced-motion bail-out untouched", () => {
		const results = computeCollisionFreeMagnification(
			140,
			ITEMS,
			2,
			90,
			4,
			true,
			{ currentShifts: [5, 5, 5], preferredAnchorIndex: 1 },
		);
		for (const r of results) {
			expect(r.scale).toBe(1);
			expect(r.translateY).toBe(0);
		}
	});
});
