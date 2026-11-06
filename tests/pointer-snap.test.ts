import { describe, expect, it } from "vitest";
import { PointerSnap } from "../src/utils/pointerSnap";

describe("pointer aiming snap", () => {
	it("locks immediately and tolerates small hand jitter", () => {
		const snap = new PointerSnap();
		expect(snap.update("a", 100, 200, 0)).toBe(0);
		expect(snap.locked).toBe(true);
		snap.update("a", 102, 202, 100);
		expect(snap.locked).toBe(true);
		snap.update("a", 108, 204, 120);
		expect(snap.locked).toBe(true);
	});
	it("keeps the original target through micro-moves and releases beyond the deadband", () => {
		const snap = new PointerSnap();
		snap.update("a", 0, 0, 0);
		snap.update("a", 0, 0, 100);
		snap.update("b", 0, 13, 110);
		expect(snap.locked).toBe(true);
		expect(snap.targetKey).toBe("a");
		snap.update(null, 0, 15, 115);
		expect(snap.locked).toBe(true);
		snap.update("b", 0, 19, 120);
		expect(snap.targetKey).toBe("b");
		snap.update("b", 0, 19, 220);
		expect(snap.locked).toBe(true);
		expect(snap.targetKey).toBe("b");
	});
	it("speed never cancels a lock while the pointer is inside the acquired card", () => {
		const snap = new PointerSnap();
		snap.update("a", 100, 100, 0, { left: 0, right: 400, top: 80, bottom: 120 });
		for (let i = 0; i < 20; i++) {
			snap.update("b", 100 + i * 12, 110, i);
			expect(snap.locked).toBe(true);
			expect(snap.targetKey).toBe("a");
		}
	});
	it("clears on exit, wheel/reset, and non-finite input", () => {
		const snap = new PointerSnap();
		for (const clear of [() => snap.update(null, 0, 30, 120), () => snap.clear(), () => snap.update("a", NaN, 0, 120)]) {
			snap.update("a", 0, 0, 0);
			snap.update("a", 0, 0, 100);
			clear();
			expect(snap.locked).toBe(false);
		}
	});
});
