import { describe, expect, it } from "vitest";
import {
	computeAutoScrollZones,
	computeOverflowState,
	computePointerAutoScroll,
	computePointerAutoScrollVelocity,
} from "../src/utils/overflow";

describe("computeOverflowState", () => {
	it("reports no overflow when content fits", () => {
		expect(
			computeOverflowState({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 }),
		).toEqual({ hasOverflow: false, canScrollUp: false, canScrollDown: false });
	});

	it("treats sub-tolerance residue as fitting (rounding slack)", () => {
		expect(
			computeOverflowState({
				scrollTop: 0,
				clientHeight: 400,
				scrollHeight: 400.5,
			}).hasOverflow,
		).toBe(false);
	});

	it("at the top only the bottom can scroll", () => {
		expect(
			computeOverflowState({ scrollTop: 0, clientHeight: 400, scrollHeight: 900 }),
		).toEqual({ hasOverflow: true, canScrollUp: false, canScrollDown: true });
	});

	it("in the middle both directions can scroll", () => {
		expect(
			computeOverflowState({
				scrollTop: 250,
				clientHeight: 400,
				scrollHeight: 900,
			}),
		).toEqual({ hasOverflow: true, canScrollUp: true, canScrollDown: true });
	});

	it("at the bottom only the top can scroll", () => {
		expect(
			computeOverflowState({
				scrollTop: 500,
				clientHeight: 400,
				scrollHeight: 900,
			}),
		).toEqual({ hasOverflow: true, canScrollUp: true, canScrollDown: false });
	});

	it("tolerates fractional scroll positions near the bottom", () => {
		expect(
			computeOverflowState({
				scrollTop: 499.4,
				clientHeight: 400,
				scrollHeight: 900,
			}).canScrollDown,
		).toBe(false);
	});

	it("survives non-finite input without throwing", () => {
		expect(
			computeOverflowState({
				scrollTop: Number.NaN,
				clientHeight: Number.POSITIVE_INFINITY,
				scrollHeight: Number.NaN,
			}),
		).toEqual({ hasOverflow: false, canScrollUp: false, canScrollDown: false });
	});
});

describe("computePointerAutoScrollVelocity", () => {
	// Viewport 100–500 (height 400), default triggerZone 120 px →
	// pre-scroll zone min(200, 120) = 120 px, strong zone min(120, 54) = 54 px.
	// Dead zone is therefore [220, 380] (the center 160 px).
	const BASE = {
		pointerVelocityY: 0,
		viewportTop: 100,
		viewportBottom: 500,
		maxSpeed: 320,
		canScrollUp: true,
		canScrollDown: true,
		enabled: true,
		reducedMotion: false,
	};

	it("returns 0 across the whole dead zone", () => {
		// Dead zone is [220, 380] for the default 120 px trigger area.
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 300 })).toBe(0);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 250 })).toBe(0);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 350 })).toBe(0);
	});

	it("scrolls up (negative) inside the top pre-scroll zone", () => {
		const v = computePointerAutoScrollVelocity({ ...BASE, pointerY: 150 });
		expect(v).toBeLessThan(0);
	});

	it("scrolls down (positive) inside the bottom pre-scroll zone", () => {
		const v = computePointerAutoScrollVelocity({ ...BASE, pointerY: 450 });
		expect(v).toBeGreaterThan(0);
	});

	it("ramps speed continuously with penetration depth", () => {
		const pre = computePointerAutoScrollVelocity({ ...BASE, pointerY: 430 });
		const edge = computePointerAutoScrollVelocity({ ...BASE, pointerY: 480 });
		const deep = computePointerAutoScrollVelocity({ ...BASE, pointerY: 495 });
		expect(edge).toBeGreaterThan(pre);
		expect(deep).toBeGreaterThan(edge);
		// Quadratic curve: the pre-scroll entrance is gentle.
		const entrance = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 500 - 99.9,
		});
		expect(entrance).toBeLessThan(320 * 0.01);
	});

	it("keeps the pre-scroll zone below its speed share", () => {
		// Just outside the edge zone (distance 51 px) only the pre-scroll
		// ramp contributes → strictly below 35% of maxSpeed.
		const v = computePointerAutoScrollVelocity({ ...BASE, pointerY: 449 });
		expect(v).toBeGreaterThan(0);
		expect(v).toBeLessThan(320 * 0.35);
	});

	it("uses the configured trigger zone as the pre-scroll depth", () => {
		// Height 400, default triggerZone 120: pre-scroll = min(200, 120) = 120 px.
		// 405 (distance 95) is INSIDE the pre-scroll zone → must scroll down.
		expect(
			computePointerAutoScrollVelocity({ ...BASE, pointerY: 405 }),
		).toBeGreaterThan(0);
		// Symmetric at the top.
		expect(
			computePointerAutoScrollVelocity({ ...BASE, pointerY: 195 }),
		).toBeLessThan(0);
		// 445 (distance 55) is in the gentle part of the pre-scroll ramp,
		// below the 35% strong-zone share.
		const between = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 445,
		});
		expect(between).toBeGreaterThan(0);
		expect(between).toBeLessThan(320 * 0.35);
	});

	it("hits max speed exactly at the physical edges", () => {
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 500 })).toBe(320);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 100 })).toBe(-320);
	});

	it("is position-only: pointer velocity does not change the edge intent", () => {
		// §八: the edge mechanism must NOT read pointer velocity — any
		// velocity assist belongs to the kinetic (pointer-follow) path.
		const idle = computePointerAutoScrollVelocity({ ...BASE, pointerY: 470 });
		const flick = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 470,
			pointerVelocityY: 900,
		});
		expect(flick).toBe(idle);

		const idleUp = computePointerAutoScrollVelocity({ ...BASE, pointerY: 130 });
		const flickUp = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 130,
			pointerVelocityY: -900,
		});
		expect(flickUp).toBe(idleUp);
	});

	it("does not pre-scroll from a dead-zone flick (kinetic path only)", () => {
		// §八/§九: pointerY 380 is inside the dead zone (base 0). The EDGE
		// mechanism is position-only, so velocity does NOT move it — the
		// flick pre-scroll is the kinetic (pointer-follow) path's job.
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 380 })).toBe(0);
		const v = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 380,
			pointerVelocityY: 800,
		});
		expect(v).toBe(0);
	});

	it("ignores velocity pointing away from the near edge", () => {
		// §八: moving up while hovering in the lower half must not affect
		// the position-only edge intent.
		const v = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 380,
			pointerVelocityY: -2000,
		});
		expect(v).toBe(0);
	});

	it("adds no assist at the exact center regardless of velocity", () => {
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 300,
				pointerVelocityY: 5000,
			}),
		).toBe(0);
	});

	it("clamps the total speed to maxSpeed even with a huge assist", () => {
		const v = computePointerAutoScrollVelocity({
			...BASE,
			pointerY: 500,
			pointerVelocityY: 100000,
		});
		expect(v).toBe(320);
	});

	it("stops at dead ends (cannot scroll further)", () => {
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 105,
				canScrollUp: false,
			}),
		).toBe(0);
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				canScrollDown: false,
			}),
		).toBe(0);
	});

	it("returns 0 when disabled or under reduced motion", () => {
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				enabled: false,
			}),
		).toBe(0);
		expect(
			computePointerAutoScrollVelocity({
				...BASE,
				pointerY: 495,
				reducedMotion: true,
			}),
		).toBe(0);
	});

	it("returns 0 outside the viewport band", () => {
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 50 })).toBe(0);
		expect(computePointerAutoScrollVelocity({ ...BASE, pointerY: 600 })).toBe(0);
	});

	it("keeps a calm center in a short viewport (no zone tug-of-war)", () => {
		// Height 60 → pre-scroll clamped to half-height 30 px (strong zone
		// collapses to the same 30 px since the floor 54 > 30); the exact
		// middle stays 0, the edges scroll.
		const short = { ...BASE, viewportTop: 100, viewportBottom: 160 };
		expect(computePointerAutoScrollVelocity({ ...short, pointerY: 130 })).toBe(0);
		expect(
			computePointerAutoScrollVelocity({ ...short, pointerY: 101 }),
		).toBeLessThan(0);
		expect(
			computePointerAutoScrollVelocity({ ...short, pointerY: 159 }),
		).toBeGreaterThan(0);
	});

	it("never returns NaN or Infinity", () => {
		const weird = [
			{ ...BASE, pointerY: Number.NaN },
			{ ...BASE, pointerY: 495, pointerVelocityY: Number.NaN },
			{ ...BASE, pointerY: 495, viewportTop: Number.NaN },
			{ ...BASE, pointerY: 495, viewportBottom: Number.POSITIVE_INFINITY },
			{ ...BASE, pointerY: 495, maxSpeed: -10 },
			{ ...BASE, pointerY: 495, viewportTop: 500, viewportBottom: 100 },
		];
		for (const input of weird) {
			const v = computePointerAutoScrollVelocity(input);
			expect(Number.isFinite(v)).toBe(true);
		}
	});
});

describe("computeAutoScrollZones (§十)", () => {
	it("falls back to the default 120 px trigger area", () => {
		// No zone supplied → DEFAULT_TRIGGER_ZONE_PX = 120.
		// Height 400 → preZone = min(200, 120) = 120, strongZone = min(120, 54) = 54.
		expect(computeAutoScrollZones(400)).toEqual({ preZone: 120, strongZone: 54 });
	});

	it("clamps the pre-scroll zone to half the viewport height", () => {
		// Tall viewport: zone 120 is smaller than half-height → unchanged.
		expect(computeAutoScrollZones(1000).preZone).toBe(120);
		// Short viewport: half-height (30) caps the pre-scroll zone.
		const short = computeAutoScrollZones(60);
		expect(short.preZone).toBe(30);
		// Strong zone collapses to the same 30 px (floor 54 > 30).
		expect(short.strongZone).toBe(30);
	});

	it("honours a small custom zone down to its px floor", () => {
		// zone 40 → preZone 40, strongZone = min(40, max(20, 18)) = 20.
		expect(computeAutoScrollZones(400, 40)).toEqual({
			preZone: 40,
			strongZone: 20,
		});
	});

	it("honours a large custom zone and scales the strong band", () => {
		// zone 220 → preZone = min(200, 220) = 200, strongZone = min(200, 99) = 99.
		expect(computeAutoScrollZones(400, 220)).toEqual({
			preZone: 200,
			strongZone: 99,
		});
	});

	it("recovers from a zero / invalid zone", () => {
		expect(computeAutoScrollZones(400, 0)).toEqual({ preZone: 120, strongZone: 54 });
		expect(computeAutoScrollZones(400, Number.NaN)).toEqual({
			preZone: 120,
			strongZone: 54,
		});
	});
});

describe("computePointerAutoScroll stop reasons (§十/§十一)", () => {
	const INPUT = {
		pointerY: 300,
		pointerVelocityY: 0,
		viewportTop: 100,
		viewportBottom: 500,
		maxSpeed: 320,
		canScrollUp: true,
		canScrollDown: true,
		enabled: true,
		reducedMotion: false,
	};

	it("reports 'disabled' when the feature is off", () => {
		const r = computePointerAutoScroll({ ...INPUT, enabled: false });
		expect(r.velocity).toBe(0);
		expect(r.stopReason).toBe("disabled");
	});

	it("reports 'reduced-motion' under prefers-reduced-motion", () => {
		const r = computePointerAutoScroll({ ...INPUT, reducedMotion: true });
		expect(r.velocity).toBe(0);
		expect(r.stopReason).toBe("reduced-motion");
	});

	it("reports 'outside-band' when the pointer leaves the viewport", () => {
		const r = computePointerAutoScroll({ ...INPUT, pointerY: 50 });
		expect(r.velocity).toBe(0);
		expect(r.stopReason).toBe("outside-band");
	});

	it("reports 'dead-zone' at the calm center", () => {
		const r = computePointerAutoScroll({ ...INPUT, pointerY: 300 });
		expect(r.velocity).toBe(0);
		expect(r.stopReason).toBe("dead-zone");
	});

	it("reports 'dead-end' at a blocked edge", () => {
		expect(
			computePointerAutoScroll({
				...INPUT,
				pointerY: 110,
				canScrollUp: false,
			}).stopReason,
		).toBe("dead-end");
		expect(
			computePointerAutoScroll({
				...INPUT,
				pointerY: 490,
				canScrollDown: false,
			}).stopReason,
		).toBe("dead-end");
	});

	it("returns null (actively scrolling) inside a band", () => {
		const r = computePointerAutoScroll({ ...INPUT, pointerY: 470 });
		expect(r.velocity).toBeGreaterThan(0);
		expect(r.stopReason).toBeNull();
	});

	it("applies the configured trigger zone (default = 120 px)", () => {
		// With the default zone the dead zone spans [220, 380]. pointerY 200
		// is inside the pre-scroll band → scrolling (stopReason null).
		const r = computePointerAutoScroll({ ...INPUT, pointerY: 200 });
		expect(r.velocity).toBeLessThan(0);
		expect(r.stopReason).toBeNull();
	});
});
