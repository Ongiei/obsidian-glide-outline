import { describe, expect, it } from "vitest";
import {
	MANUAL_WHEEL_COOLDOWN_MS,
	WHEEL_LINE_HEIGHT_PX,
	WHEEL_PAGE_FALLBACK_PX,
	normalizeWheelDelta,
	resolveWheelRoute,
} from "../src/utils/wheelRouting";
import type { WheelRouteInput } from "../src/utils/wheelRouting";

/** Fully-scrollable expanded outline, pointer over it — the happy path. */
function base(overrides: Partial<WheelRouteInput> = {}): WheelRouteInput {
	return {
		expanded: true,
		pressed: false,
		hasOverflow: true,
		canScrollUp: true,
		canScrollDown: true,
		deltaY: 40,
		deltaX: 0,
		deltaMode: 0,
		ctrlKey: false,
		metaKey: false,
		targetInOutline: true,
		insideEnvelope: true,
		viewportHeight: 500,
		...overrides,
	};
}

describe("normalizeWheelDelta (§十.3)", () => {
	it("passes pixel deltas (mode 0) through unchanged", () => {
		expect(normalizeWheelDelta(53, 0, 500)).toBe(53);
		expect(normalizeWheelDelta(-12.5, 0, 500)).toBe(-12.5);
	});

	it("converts line deltas (mode 1) at the fixed line height", () => {
		expect(normalizeWheelDelta(3, 1, 500)).toBe(3 * WHEEL_LINE_HEIGHT_PX);
		expect(normalizeWheelDelta(-2, 1, 500)).toBe(-2 * WHEEL_LINE_HEIGHT_PX);
	});

	it("converts page deltas (mode 2) using the viewport height", () => {
		expect(normalizeWheelDelta(1, 2, 320)).toBe(320);
		expect(normalizeWheelDelta(-1, 2, 320)).toBe(-320);
	});

	it("falls back to the page constant when the viewport is unknown", () => {
		expect(normalizeWheelDelta(1, 2, 0)).toBe(WHEEL_PAGE_FALLBACK_PX);
		expect(normalizeWheelDelta(1, 2, Number.NaN)).toBe(
			WHEEL_PAGE_FALLBACK_PX,
		);
	});

	it("returns 0 for a non-finite delta (never NaN downstream)", () => {
		expect(normalizeWheelDelta(Number.NaN, 0, 500)).toBe(0);
		expect(normalizeWheelDelta(Number.POSITIVE_INFINITY, 1, 500)).toBe(0);
	});
});

describe("resolveWheelRoute (§十/§十二)", () => {
	it("outline owns a downward wheel over the outline with overflow", () => {
		const d = resolveWheelRoute(base());
		expect(d).toEqual({ action: "outline", deltaPx: 40, reason: null });
	});

	it("outline owns an upward wheel when it can scroll up", () => {
		const d = resolveWheelRoute(base({ deltaY: -40 }));
		expect(d.action).toBe("outline");
		expect(d.deltaPx).toBe(-40);
	});

	it("collapsed outline never takes the wheel", () => {
		const d = resolveWheelRoute(base({ expanded: false }));
		expect(d).toEqual({ action: "ignore", deltaPx: 0, reason: "collapsed" });
	});

	it("a held heading (pressed) blocks wheel scrolling", () => {
		const d = resolveWheelRoute(base({ pressed: true }));
		expect(d).toEqual({ action: "ignore", deltaPx: 0, reason: "pressed" });
	});

	it("Ctrl+wheel is a zoom gesture — never intercepted", () => {
		const d = resolveWheelRoute(base({ ctrlKey: true }));
		expect(d).toEqual({
			action: "ignore",
			deltaPx: 0,
			reason: "zoom-gesture",
		});
	});

	it("Meta+wheel is a zoom gesture — never intercepted", () => {
		const d = resolveWheelRoute(base({ metaKey: true }));
		expect(d.reason).toBe("zoom-gesture");
	});

	it("dominantly horizontal wheel is ignored", () => {
		const d = resolveWheelRoute(base({ deltaX: 80, deltaY: 20 }));
		expect(d).toEqual({ action: "ignore", deltaPx: 0, reason: "horizontal" });
	});

	it("vertical-dominant diagonal wheel is still owned by the outline", () => {
		const d = resolveWheelRoute(base({ deltaX: 10, deltaY: 40 }));
		expect(d.action).toBe("outline");
		expect(d.deltaPx).toBe(40);
	});

	it("zero delta is ignored (no-op wheels never lock cooldown)", () => {
		const d = resolveWheelRoute(base({ deltaY: 0 }));
		expect(d).toEqual({ action: "ignore", deltaPx: 0, reason: "zero-delta" });
	});

	it("outside the outline AND outside the envelope → not ours", () => {
		const d = resolveWheelRoute(
			base({ targetInOutline: false, insideEnvelope: false }),
		);
		expect(d).toEqual({ action: "ignore", deltaPx: 0, reason: "outside" });
	});

	it("inside the geometric envelope counts as outline ground", () => {
		const d = resolveWheelRoute(
			base({ targetInOutline: false, insideEnvelope: true }),
		);
		expect(d.action).toBe("outline");
	});

	it("over an outline element but outside the envelope still owns it", () => {
		const d = resolveWheelRoute(
			base({ targetInOutline: true, insideEnvelope: false }),
		);
		expect(d.action).toBe("outline");
	});

	it("no overflow → editor handoff (native scrolling preserved)", () => {
		const d = resolveWheelRoute(base({ hasOverflow: false }));
		expect(d).toEqual({ action: "editor", deltaPx: 0, reason: "no-overflow" });
	});

	it("wheeling up at the top boundary hands off to the editor", () => {
		const d = resolveWheelRoute(base({ deltaY: -40, canScrollUp: false }));
		expect(d).toEqual({ action: "editor", deltaPx: 0, reason: "boundary" });
	});

	it("wheeling down at the bottom boundary hands off to the editor", () => {
		const d = resolveWheelRoute(base({ deltaY: 40, canScrollDown: false }));
		expect(d).toEqual({ action: "editor", deltaPx: 0, reason: "boundary" });
	});

	it("boundary handoff is directional: up blocked, down still ours", () => {
		const d = resolveWheelRoute(base({ deltaY: 40, canScrollUp: false }));
		expect(d.action).toBe("outline");
	});

	it("normalizes line-mode deltas before applying (Firefox)", () => {
		const d = resolveWheelRoute(base({ deltaY: 3, deltaMode: 1 }));
		expect(d.action).toBe("outline");
		expect(d.deltaPx).toBe(3 * WHEEL_LINE_HEIGHT_PX);
	});

	it("normalizes page-mode deltas via the viewport height", () => {
		const d = resolveWheelRoute(
			base({ deltaY: 1, deltaMode: 2, viewportHeight: 240 }),
		);
		expect(d.deltaPx).toBe(240);
	});

	it("guard priority: collapsed wins over every other reason", () => {
		const d = resolveWheelRoute(
			base({
				expanded: false,
				pressed: true,
				ctrlKey: true,
				deltaX: 100,
				hasOverflow: false,
			}),
		);
		expect(d.reason).toBe("collapsed");
	});

	it("guard priority: zoom gesture wins over horizontal/ownership", () => {
		const d = resolveWheelRoute(
			base({ ctrlKey: true, deltaX: 100, targetInOutline: false }),
		);
		expect(d.reason).toBe("zoom-gesture");
	});

	it("ignored and editor decisions never carry a scroll delta", () => {
		for (const input of [
			base({ expanded: false }),
			base({ hasOverflow: false }),
			base({ deltaY: -40, canScrollUp: false }),
			base({ targetInOutline: false, insideEnvelope: false }),
		]) {
			expect(resolveWheelRoute(input).deltaPx).toBe(0);
		}
	});

	it("cooldown constant matches the §十.5 spec (160 ms)", () => {
		expect(MANUAL_WHEEL_COOLDOWN_MS).toBe(160);
	});
});
