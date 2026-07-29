// @vitest-environment jsdom
/**
 * §三 Regression: collision-range boundary overlap (P0 animation bug).
 *
 * On 0.1.2 (2997bd3) the magnification solver runs over the MOTION range
 * only. Rows just OUTSIDE that range are forced to identity, but the
 * boundary row INSIDE the range is still displaced (scaled + shifted) by the
 * solver. When the pointer moves, the motion range slides and previously
 * displaced rows fall outside it while a new boundary row scales up — so the
 * scaled boundary row overlaps the identity/settling neighbour just outside.
 * This manifests as text overlap that propagates up/down like a Newton's
 * cradle.
 *
 * This test drives the REAL controller through a pointer sweep and asserts
 * that EVERY visible adjacent pair keeps its visual gap (>= cardGap) at
 * every interpolation frame. It must FAIL on 2997bd3 and PASS after the
 * collision-range split + dynamic boundary expansion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import { MagnificationController } from "../src/ui/MagnificationController";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const N = 126;
/** Mixed card heights (the spec requires mixed heights). */
const HEIGHTS = Array.from({ length: N }, (_, i) => [22, 40, 28, 36][i % 4]);
const LIST_TOP = 0;

interface Scenario {
	radius: number;
	maxScale: number;
	cardGap: number;
	dpr: number;
	pointerX: number;
}

const COMBOS: Scenario[] = [
	{ radius: 40, maxScale: 2.25, cardGap: 0, dpr: 1, pointerX: 10 },
	{ radius: 40, maxScale: 2.25, cardGap: 12, dpr: 2, pointerX: 10 },
	{ radius: 90, maxScale: 1.9, cardGap: 4, dpr: 1, pointerX: 10 },
	{ radius: 90, maxScale: 1.9, cardGap: 12, dpr: 2, pointerX: 10 },
	{ radius: 240, maxScale: 1.25, cardGap: 0, dpr: 1, pointerX: 10 },
	{ radius: 240, maxScale: 1.25, cardGap: 12, dpr: 2, pointerX: 10 },
	{ radius: 80, maxScale: 2.25, cardGap: 4, dpr: 1, pointerX: 10 },
	{ radius: 80, maxScale: 1.9, cardGap: 0, dpr: 2, pointerX: 10 },
	// Right-positioned pointer (spec: left/right positions).
	{ radius: 90, maxScale: 2.25, cardGap: 12, dpr: 1, pointerX: 190 },
	{ radius: 40, maxScale: 1.9, cardGap: 4, dpr: 2, pointerX: 190 },
];

describe("Collision continuity: no visible overlap across pointer sweep (§三)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let rafQueue: FrameRequestCallback[];
	let rows: HTMLElement[];
	let cardGap = 0;
	let viewportTop = 0;
	let viewportBottom = 0;
	/** Per-row base rects captured once per scenario. */
	let baseRects: { top: number; height: number }[] = [];

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function advance(frames: number): void {
		for (let i = 0; i < frames; i++) {
			vi.advanceTimersByTime(16);
			flushFrame();
			if (rafQueue.length === 0) break;
		}
	}

	function pointer(type: string, clientX: number, clientY: number): void {
		view.hitZoneEl.dispatchEvent(
			new MouseEvent(type, { clientX, clientY, bubbles: true }),
		);
	}

	/** Read the displayed visual box of row i from cache-derived DOM state. */
	function visualBox(i: number): { top: number; bottom: number } {
		const r = baseRects[i];
		const baseCenter = r.top + r.height / 2;
		const scale = Number.parseFloat(
			rows[i].style.getPropertyValue("--glide-scale") || "1",
		);
		const shift = Number.parseFloat(
			rows[i].style.getPropertyValue("--glide-shift-y") || "0",
		);
		const h = r.height * scale;
		const center = baseCenter + shift;
		return { top: center - h / 2, bottom: center + h / 2 };
	}

	/** Assert no visible adjacent pair overlaps beyond the allowed gap. */
	function assertNoOverlap(tolerance = 1): void {
		for (let i = 0; i + 1 < N; i++) {
			const a = visualBox(i);
			const b = visualBox(i + 1);
			// Only check pairs that are active (either row magnified/shifted)
			// OR within the visible viewport — distant identity rows are
			// structurally feasible and would only add noise.
			const aActive =
				Math.abs(Number.parseFloat(rows[i].style.getPropertyValue("--glide-scale") || "1") - 1) >
					0.001 ||
				Math.abs(
					Number.parseFloat(rows[i].style.getPropertyValue("--glide-shift-y") || "0"),
				) > 0.05;
			const bActive =
				Math.abs(
					Number.parseFloat(rows[i + 1].style.getPropertyValue("--glide-scale") || "1") - 1,
				) > 0.001 ||
				Math.abs(
					Number.parseFloat(rows[i + 1].style.getPropertyValue("--glide-shift-y") || "0"),
				) > 0.05;
			const aVisible =
				baseRects[i].top < viewportBottom && baseRects[i].top + baseRects[i].height > viewportTop;
			const bVisible =
				baseRects[i + 1].top < viewportBottom &&
				baseRects[i + 1].top + baseRects[i + 1].height > viewportTop;
			if (!aActive && !bActive && !aVisible && !bVisible) continue;
			expect(a.bottom + cardGap).toBeLessThanOrEqual(b.top + tolerance);
		}
	}

	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "performance"],
		});
		rafQueue = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		vi.stubGlobal(
			"matchMedia",
			() =>
				({
					matches: false,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				}) as unknown as MediaQueryList,
		);
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			},
		);
		host = document.createElement("div");
		document.body.appendChild(host);
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	function buildScenario(s: Scenario): void {
		settings = structuredClone(DEFAULT_SETTINGS);
		settings.radius = s.radius;
		settings.maxScale = s.maxScale;
		settings.cardGap = s.cardGap;
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		const HEADINGS = Array.from({ length: N }, (_, i) =>
			heading(2, `Section ${i}`, i * 4),
		);
		view.setItems(HEADINGS);
		cardGap = s.cardGap;
		// Viewport sized to fit ~20 rows; only visible rows matter.
		const viewportHeight = 600;
		viewportTop = 100;
		viewportBottom = viewportTop + viewportHeight;
		view.viewportEl.getBoundingClientRect = () =>
			({
				top: viewportTop,
				bottom: viewportBottom,
				left: 0,
				right: 200,
				width: 200,
				height: viewportHeight,
				x: 0,
				y: viewportTop,
				toJSON: () => ({}),
			}) as DOMRect;
		// Layout gap == cardGap so the base (unmagnified) layout is feasible;
		// the solver must preserve the same gap once magnified.
		let y = LIST_TOP;
		baseRects = [];
		rows = Array.from(view.listEl.children) as HTMLElement[];
		for (let i = 0; i < N; i++) {
			const h = HEIGHTS[i];
			baseRects.push({ top: y, height: h });
			y += h + cardGap;
		}
		rows.forEach((row, i) => {
			row.getBoundingClientRect = () =>
				({
					top: baseRects[i].top,
					bottom: baseRects[i].top + baseRects[i].height,
					left: 0,
					right: 200,
					width: 200,
					height: baseRects[i].height,
					x: 0,
					y: baseRects[i].top,
					toJSON: () => ({}),
				}) as DOMRect;
		});
		// No overflow → auto-scroll stays quiet; we focus on magnification.
		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: viewportHeight,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: viewportHeight,
		});
		view.updateOverflowState();
		controller = new MagnificationController(view, () => settings);
		// DPR for pixel-aligned shift writes (spec: dpr 1 / 2).
		Object.defineProperty(view.rootEl.ownerDocument.defaultView, "devicePixelRatio", {
			configurable: true,
			value: s.dpr,
		});
	}

	/**
	 * Sweep the pointer from the top of the list to the bottom in small
	 * steps, checking overlap on EVERY interpolation frame. Small steps keep
	 * the old and new motion ranges overlapping, which is exactly when the
	 * boundary overlap (and Newton's-cradle propagation) appears.
	 */
	function sweepAndCheck(s: Scenario): void {
		const firstY = baseRects[0].top + baseRects[0].height / 2;
		const lastY = baseRects[N - 1].top + baseRects[N - 1].height / 2;
		const step = 5;
		let first = true;
		for (let y = firstY; y <= lastY; y += step) {
			if (first) {
				pointer("pointerenter", s.pointerX, y);
				first = false;
			} else {
				pointer("pointermove", s.pointerX, y);
			}
			// Run several frames, asserting on each (catches mid-interp states).
			for (let f = 0; f < 8; f++) {
				vi.advanceTimersByTime(16);
				flushFrame();
				if (rafQueue.length === 0) break;
				assertNoOverlap(1);
			}
		}
	}

	for (const s of COMBOS) {
		it(`no overlap: radius=${s.radius} maxScale=${s.maxScale} gap=${s.cardGap} dpr=${s.dpr} x=${s.pointerX}`, () => {
			buildScenario(s);
			// Enter at the top first so the initial frame is valid.
			sweepAndCheck(s);
		});
	}

	// ---- Seven targeted boundary tests (§三, second list) ----------------

	it("motion-range upper boundary keeps settling neighbour apart", () => {
		buildScenario({ radius: 40, maxScale: 2.25, cardGap: 0, dpr: 1, pointerX: 10 });
		// Park the pointer low, let it settle, then jump it up so the old
		// low rows become settling just above the new range boundary.
		pointer("pointerenter", 10, baseRects[80].top + baseRects[80].height / 2);
		advance(20);
		pointer("pointermove", 10, baseRects[40].top + baseRects[40].height / 2);
		for (let f = 0; f < 12; f++) {
			vi.advanceTimersByTime(16);
			flushFrame();
			assertNoOverlap(1);
		}
	});

	it("motion-range lower boundary keeps settling neighbour apart", () => {
		buildScenario({ radius: 40, maxScale: 2.25, cardGap: 0, dpr: 1, pointerX: 10 });
		pointer("pointerenter", 10, baseRects[20].top + baseRects[20].height / 2);
		advance(20);
		pointer("pointermove", 10, baseRects[60].top + baseRects[60].height / 2);
		for (let f = 0; f < 12; f++) {
			vi.advanceTimersByTime(16);
			flushFrame();
			assertNoOverlap(1);
		}
	});

	it("range moving one row keeps feasibility", () => {
		buildScenario({ radius: 90, maxScale: 1.9, cardGap: 4, dpr: 2, pointerX: 10 });
		let y = baseRects[30].top + baseRects[30].height / 2;
		pointer("pointerenter", 10, y);
		advance(15);
		for (let k = 0; k < 10; k++) {
			y = baseRects[30 + k].top + baseRects[30 + k].height / 2;
			pointer("pointermove", 10, y);
			for (let f = 0; f < 6; f++) {
				vi.advanceTimersByTime(16);
				flushFrame();
				assertNoOverlap(1);
			}
		}
	});

	it("after scroll the range stays feasible (anchor refresh)", () => {
		buildScenario({ radius: 90, maxScale: 1.9, cardGap: 4, dpr: 1, pointerX: 10 });
		pointer("pointerenter", 10, baseRects[20].top + baseRects[20].height / 2);
		advance(15);
		// Simulate an outline scroll delta by moving the geometry down.
		const delta = 200;
		(view.viewportEl as unknown as { scrollTop: number }).scrollTop = delta;
		view.viewportEl.dispatchEvent(new Event("scroll"));
		pointer("pointermove", 10, baseRects[20].top + baseRects[20].height / 2);
		for (let f = 0; f < 12; f++) {
			vi.advanceTimersByTime(16);
			flushFrame();
			assertNoOverlap(1);
		}
	});

	it("range boundary toggling continuously stays feasible", () => {
		buildScenario({ radius: 40, maxScale: 2.25, cardGap: 0, dpr: 2, pointerX: 10 });
		for (let k = 0; k < 20; k++) {
			const y =
				k % 2 === 0
					? baseRects[50].top + baseRects[50].height / 2
					: baseRects[55].top + baseRects[55].height / 2;
			if (k === 0) pointer("pointerenter", 10, y);
			else pointer("pointermove", 10, y);
			for (let f = 0; f < 4; f++) {
				vi.advanceTimersByTime(16);
				flushFrame();
				assertNoOverlap(1);
			}
		}
	});

	it("highest scale + long title rows never overlap", () => {
		buildScenario({ radius: 40, maxScale: 2.25, cardGap: 12, dpr: 1, pointerX: 10 });
		// Magnify a tall row (height 40) at the worst-case radius.
		pointer("pointerenter", 10, baseRects[1].top + baseRects[1].height / 2);
		advance(20);
		assertNoOverlap(1);
	});

	it("mixed heights stay feasible across a full sweep", () => {
		buildScenario({ radius: 80, maxScale: 2.25, cardGap: 4, dpr: 1, pointerX: 10 });
		sweepAndCheck({ radius: 80, maxScale: 2.25, cardGap: 4, dpr: 1, pointerX: 10 });
	});
});
