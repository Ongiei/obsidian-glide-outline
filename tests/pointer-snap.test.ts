import { describe, expect, it } from "vitest";
import { PointerSnap } from "../src/utils/pointerSnap";

describe("pointer aiming snap", () => {
	it("locks after a short dwell and tolerates small hand jitter", () => {
		const snap = new PointerSnap();
		expect(snap.update("a", 100, 200, 0)).toBe(100);
		snap.update("a", 102, 202, 100);
		expect(snap.locked).toBe(true);
		snap.update("a", 108, 204, 120);
		expect(snap.locked).toBe(true);
	});
	it("releases on deliberate movement or another heading", () => {
		const snap = new PointerSnap();
		snap.update("a", 0, 0, 0);
		snap.update("a", 0, 0, 100);
		snap.update("a", 0, 13, 110);
		expect(snap.locked).toBe(false);
		snap.update("a", 0, 13, 210);
		expect(snap.locked).toBe(true);
		snap.update("b", 0, 13, 220);
		expect(snap.locked).toBe(false);
	});
	it("a fast sweep never acquires a lock", () => {
		const snap = new PointerSnap();
		for (let i = 0; i < 20; i++) {
			snap.update("a", 0, i * 8, i * 16);
			expect(snap.locked).toBe(false);
		}
	});
	it("clears on exit, wheel/reset, and non-finite input", () => {
		const snap = new PointerSnap();
		for (const clear of [() => snap.update(null, 0, 0, 120), () => snap.clear(), () => snap.update("a", NaN, 0, 120)]) {
			snap.update("a", 0, 0, 0);
			snap.update("a", 0, 0, 100);
			clear();
			expect(snap.locked).toBe(false);
		}
	});
});
