// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollCorrector } from "../src/core/ScrollCorrector";
import type { ScrollCorrectorOptions } from "../src/core/ScrollCorrector";

/**
 * Editor jump correction (section 12): settle detection must arm BOTH
 * `scrollend` AND the timeout fallback; correction is re-applied only
 * while the measured error exceeds the tolerance, capped by
 * maxCorrections; `done` always reports the final error and the number
 * of corrective passes.
 */
describe("ScrollCorrector", () => {
	let scroller: HTMLElement;
	let win: Window & typeof globalThis;

	beforeEach(() => {
		vi.useFakeTimers();
		scroller = document.createElement("div");
		document.body.appendChild(scroller);
		win = window as Window & typeof globalThis;
	});

	afterEach(() => {
		vi.useRealTimers();
		scroller.remove();
	});

	function make(
		overrides: Partial<ScrollCorrectorOptions> & {
			errors: number[];
		},
	): {
		corrector: ScrollCorrector;
		applied: number[];
		doneCalls: [number, number][];
	} {
		const applied: number[] = [];
		const doneCalls: [number, number][] = [];
		let i = 0;
		const corrector = new ScrollCorrector({
			tolerance: 3,
			maxCorrections: 3,
			timeoutMs: 700,
			measureError: () =>
				overrides.errors[Math.min(i++, overrides.errors.length - 1)],
			apply: () => {
				applied.push(i);
			},
			done: (err, count) => {
				doneCalls.push([err, count]);
			},
			win,
			scroller,
			...("smoothFirst" in overrides
				? { smoothFirst: overrides.smoothFirst }
				: {}),
		});
		return { corrector, applied, doneCalls };
	}

	function settleViaScrollend(): void {
		scroller.dispatchEvent(new Event("scrollend"));
	}

	it("applies once and finishes when the landing is within tolerance (scrollend path)", () => {
		const { corrector, applied, doneCalls } = make({ errors: [2] });
		corrector.start();
		expect(applied.length).toBe(1);
		settleViaScrollend();
		expect(doneCalls).toEqual([[2, 1]]);
	});

	it("falls back to the timeout when scrollend never fires", () => {
		const { corrector, doneCalls } = make({ errors: [1] });
		corrector.start();
		expect(doneCalls.length).toBe(0);
		vi.advanceTimersByTime(700);
		expect(doneCalls).toEqual([[1, 1]]);
	});

	it("corrects again while the error exceeds tolerance", () => {
		// 1st settle: 20px off → correct again; 2nd settle: 1px → done.
		const { corrector, applied, doneCalls } = make({ errors: [20, 1] });
		corrector.start();
		settleViaScrollend();
		expect(applied.length).toBe(2);
		settleViaScrollend();
		expect(doneCalls).toEqual([[1, 2]]);
	});

	it("caps the number of corrections (never loops forever)", () => {
		const { corrector, applied, doneCalls } = make({
			errors: [50, 50, 50, 50, 50],
		});
		corrector.start();
		settleViaScrollend();
		settleViaScrollend();
		settleViaScrollend();
		// 3 passes max — the 3rd settle finishes even though 50 > tolerance.
		expect(applied.length).toBe(3);
		expect(doneCalls.length).toBe(1);
		expect(doneCalls[0][0]).toBe(50);
		expect(doneCalls[0][1]).toBe(3);
	});

	it("scrollend and timeout never double-fire a verification", () => {
		const { corrector, doneCalls } = make({ errors: [0] });
		corrector.start();
		settleViaScrollend(); // finishes
		vi.advanceTimersByTime(1000); // stale timeout must be inert
		expect(doneCalls.length).toBe(1);
	});

	it("smoothFirst waits for the in-flight scroll before the first exact pass", () => {
		// 1st settle: 30px off → NOW dispatch the exact correction (pass 1);
		// 2nd settle: 0 → done with exactly one corrective apply.
		const { corrector, applied, doneCalls } = make({
			errors: [30, 0],
			smoothFirst: true,
		});
		corrector.start();
		expect(applied.length).toBe(0); // smooth scroll still animating
		settleViaScrollend();
		expect(applied.length).toBe(1);
		settleViaScrollend();
		expect(doneCalls).toEqual([[0, 1]]);
	});

	it("dispose cancels everything without calling done", () => {
		const { corrector, doneCalls } = make({ errors: [10] });
		corrector.start();
		corrector.dispose();
		settleViaScrollend();
		vi.advanceTimersByTime(1000);
		expect(doneCalls.length).toBe(0);
	});
});
