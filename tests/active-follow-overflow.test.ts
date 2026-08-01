// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
	getOffsetWithinScrollContent,
	GlideOutlineView,
} from "../src/ui/GlideOutlineView";

/**
 * §五–§十四: the collapsed outline positions the active heading against a
 * FIXED CENTER PLAYHEAD. The playhead never moves; the marker list slides
 * underneath it until the active row's content centre sits on it.
 *
 * This replaces the old safe-band model, where a row that happened to be
 * anywhere inside a generous inset counted as "already visible" and the
 * outline simply refused to scroll. That produced the exact inconsistency
 * the user reported: sometimes centred, sometimes not, and after an
 * interrupted smooth scroll sometimes not even on screen.
 *
 * The fixture below is a 126-row list in a 400 px viewport:
 *
 *   126 rows × 24 px       = 3024 px of rows
 *   top / bottom spacers   = 400/2 − 24/2 = 188 px each  (§六)
 *   scroll content         = 188 + 3024 + 188 = 3400 px
 *   maxScrollTop           = 3400 − 400 = 3000 px
 *   playheadY              = 400 / 2 = 200 px
 *
 * With the spacers in place row 0 centres at scrollTop 0 and row 125
 * centres at scrollTop 3000 — both reachable, which is the whole point of
 * §六. jsdom has no layout engine, so every geometry read is mocked
 * explicitly: the spacers are modelled by the list's own offsetTop, and
 * scrollHeight is stated directly.
 */

const ROW_COUNT = 126;
const ROW_H = 24;
const CLIENT_H = 400;
const PLAYHEAD_Y = CLIENT_H / 2; // 200
/** §六: the spacer a uniform-height list produces at both ends. */
const SPACER = CLIENT_H / 2 - ROW_H / 2; // 188
const CONTENT_H = SPACER + ROW_COUNT * ROW_H + SPACER; // 3400
const MAX_SCROLL_TOP = CONTENT_H - CLIENT_H; // 3000
/** §四: the only success criterion left. */
const TOLERANCE = 0.75;

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: ROW_COUNT }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

const keyAt = (index: number): string => HEADINGS[index].key;

/** §九: the scrollTop that puts row `index`'s centre on the playhead. */
function centeredTarget(index: number, listTop = SPACER, rowH = ROW_H): number {
	const rowCentre = listTop + index * rowH + rowH / 2;
	return Math.max(0, Math.min(MAX_SCROLL_TOP, rowCentre - PLAYHEAD_Y));
}

function defineNumber(el: HTMLElement, prop: string, value: number): void {
	Object.defineProperty(el, prop, { configurable: true, value });
}

describe("center-playhead active follow in a 126-row outline (§五–§十四)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let rafQueue: FrameRequestCallback[];
	/** Shared fake clock: RAF timestamps and performance.now() agree. */
	let clock: number;

	/**
	 * Drain the RAF queue, advancing the shared clock by `dt` per frame.
	 * The follow session reschedules itself, so callbacks queued while
	 * draining are picked up on the next iteration — bounded by `frames`
	 * so a runaway session fails the test instead of hanging it.
	 */
	function flushRaf(frames = 200, dt = 16): number {
		let ran = 0;
		for (let i = 0; i < frames && rafQueue.length > 0; i++) {
			const batch = rafQueue.splice(0, rafQueue.length);
			clock += dt;
			for (const cb of batch) {
				ran++;
				cb(clock);
			}
		}
		return ran;
	}

	/** §九: the three viewport values every measurement reads. */
	function mockViewport(scrollTop: number, scrollHeight = CONTENT_H): void {
		const el = view.viewportEl;
		defineNumber(el, "clientHeight", CLIENT_H);
		defineNumber(el, "scrollHeight", scrollHeight);
		Object.defineProperty(el, "scrollTop", {
			configurable: true,
			writable: true,
			value: scrollTop,
		});
	}

	/**
	 * §五: lay the rows out the way a browser would — each row is
	 * positioned by the <nav>, and the <nav> by the viewport. `listOffset`
	 * stands in for the top center spacer, which in a real browser pushes
	 * the list down inside the scroll content.
	 */
	function mockRowLayout(rowHeight = ROW_H, listOffset = SPACER): void {
		const rows = [
			...view.listEl.querySelectorAll<HTMLElement>(".glide-outline-row"),
		];
		rows.forEach((row, i) => {
			defineNumber(row, "offsetTop", i * rowHeight);
			defineNumber(row, "offsetHeight", rowHeight);
			Object.defineProperty(row, "offsetParent", {
				configurable: true,
				value: view.listEl,
			});
		});
		defineNumber(view.listEl, "offsetTop", listOffset);
		Object.defineProperty(view.listEl, "offsetParent", {
			configurable: true,
			value: view.viewportEl,
		});
	}

	/** Run one follow to completion and report where it landed. */
	function followTo(index: number): number {
		view.setActiveKey(keyAt(index));
		flushRaf();
		return view.viewportEl.scrollTop;
	}

	beforeEach(() => {
		rafQueue = [];
		clock = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback): number => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
		);
		vi.stubGlobal("cancelAnimationFrame", (): void => undefined);
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);
		mockViewport(0);
		mockRowLayout();
		flushRaf(); // drain the measure pass queued by setItems
	});

	afterEach(() => {
		view.dispose();
		host.remove();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// ── §九 / §六: centre geometry ──────────────────────────────────

	describe("centre geometry (§六 / §九)", () => {
		it("centres row 0 at scrollTop 0 thanks to the top spacer", () => {
			mockViewport(2000);
			expect(followTo(0)).toBeCloseTo(centeredTarget(0), 1);
			expect(centeredTarget(0)).toBe(0);
		});

		it("centres a mid-list row on the playhead", () => {
			expect(followTo(60)).toBeCloseTo(centeredTarget(60), 1);
			// 188 + 60*24 + 12 − 200 = 1440
			expect(centeredTarget(60)).toBe(1440);
		});

		it("centres the last row at maxScrollTop thanks to the bottom spacer", () => {
			expect(followTo(ROW_COUNT - 1)).toBeCloseTo(
				centeredTarget(ROW_COUNT - 1),
				1,
			);
			expect(centeredTarget(ROW_COUNT - 1)).toBe(MAX_SCROLL_TOP);
		});

		it("reports the row centre and playhead used for the decision", () => {
			followTo(60);
			const d = view.getActiveFollowDiagnostics();
			expect(d.lastPlayheadY).toBe(PLAYHEAD_Y);
			expect(d.lastRowContentCenter).toBe(SPACER + 60 * ROW_H + ROW_H / 2);
			expect(d.lastCoordinateSource).toBe("offset-chain");
		});

		it("measures through the offset chain, not a bare offsetTop", () => {
			// The row's own offsetTop is 1440; the list adds 188 more.
			const rowEl = view.listEl.querySelectorAll<HTMLElement>(
				".glide-outline-row",
			)[60];
			expect(rowEl.offsetTop).toBe(60 * ROW_H);
			const chain = getOffsetWithinScrollContent(rowEl, view.viewportEl);
			expect(chain.resolved).toBe(true);
			expect(chain.top).toBe(SPACER + 60 * ROW_H);
		});

		it("honours a taller row height when centring", () => {
			const TALL = 40;
			mockRowLayout(TALL, SPACER);
			view.setActiveKey(keyAt(30));
			flushRaf();
			const expected = Math.max(
				0,
				Math.min(
					MAX_SCROLL_TOP,
					SPACER + 30 * TALL + TALL / 2 - PLAYHEAD_Y,
				),
			);
			expect(view.viewportEl.scrollTop).toBeCloseTo(expected, 1);
		});

		it("recomputes the spacers from the live viewport height", () => {
			// Spacers are derived from clientHeight / 2 − rowHeight / 2.
			const d = view.getActiveFollowDiagnostics();
			expect(d.topCenterSpacerPx).toBe(SPACER);
			expect(d.bottomCenterSpacerPx).toBe(SPACER);
		});

		it("re-measures the spacers when the viewport is resized", () => {
			const TALLER = 600;
			defineNumber(view.viewportEl, "clientHeight", TALLER);
			view.applySettings();
			flushRaf();
			const d = view.getActiveFollowDiagnostics();
			expect(d.topCenterSpacerPx).toBe(TALLER / 2 - ROW_H / 2);
			expect(d.bottomCenterSpacerPx).toBe(TALLER / 2 - ROW_H / 2);
		});

		it("clamps the spacers to zero when a row is taller than the viewport", () => {
			mockRowLayout(CLIENT_H * 2, SPACER);
			view.applySettings();
			flushRaf();
			const d = view.getActiveFollowDiagnostics();
			expect(d.topCenterSpacerPx).toBe(0);
			expect(d.bottomCenterSpacerPx).toBe(0);
		});

		it("survives a level filter that removes the first and last rows", () => {
			view.setItems(HEADINGS.slice(10, 100));
			mockViewport(0);
			mockRowLayout();
			flushRaf();
			const key = HEADINGS[55].key;
			view.setActiveKey(key);
			flushRaf();
			// index 45 within the filtered list
			expect(view.viewportEl.scrollTop).toBeCloseTo(centeredTarget(45), 1);
		});

		it("centres identically on the right-hand rail", () => {
			settings.position = "right";
			view.applySettings();
			mockViewport(0);
			mockRowLayout();
			flushRaf();
			expect(followTo(60)).toBeCloseTo(centeredTarget(60), 1);
		});
	});

	// ── §七 / §八: the single follow session ────────────────────────

	describe("single follow session (§七 / §八)", () => {
		it("starts a session and reports it while it runs", () => {
			view.setActiveKey(keyAt(100));
			const mid = view.getActiveFollowDiagnostics();
			expect(mid.sessionState).not.toBe("idle");
			expect(mid.sessionTargetKey).toBe(keyAt(100));
			flushRaf();
			const done = view.getActiveFollowDiagnostics();
			expect(done.sessionState).toBe("idle"); // cleared on alignment
			expect(done.alignedCount).toBe(1);
		});

		it("aligns within the 0.75 px tolerance", () => {
			followTo(60);
			const d = view.getActiveFollowDiagnostics();
			expect(Math.abs(d.lastAlignmentErrorPx)).toBeLessThanOrEqual(
				TOLERANCE,
			);
		});

		it("retargets in place: 10 → 60 → 110 keeps only the last target", () => {
			view.setActiveKey(keyAt(10));
			flushRaf(2); // let the session get moving
			view.setActiveKey(keyAt(60));
			view.setActiveKey(keyAt(110));
			flushRaf();
			expect(view.viewportEl.scrollTop).toBeCloseTo(
				centeredTarget(110),
				1,
			);
			const d = view.getActiveFollowDiagnostics();
			expect(d.retargetCount).toBeGreaterThanOrEqual(2);
			// One session, one alignment — not three animations.
			expect(d.alignedCount).toBe(1);
		});

		it("never runs two RAF callbacks for one session", () => {
			view.setActiveKey(keyAt(10));
			view.setActiveKey(keyAt(60));
			view.setActiveKey(keyAt(110));
			// Three requests, but only ever one frame queued.
			expect(rafQueue.length).toBe(1);
			for (let i = 0; i < 10 && rafQueue.length > 0; i++) {
				const batch = rafQueue.splice(0, rafQueue.length);
				clock += 16;
				for (const cb of batch) cb(clock);
				expect(rafQueue.length).toBeLessThanOrEqual(1);
			}
		});

		it("does not overshoot the target", () => {
			const target = centeredTarget(110);
			view.setActiveKey(keyAt(110));
			for (let i = 0; i < 200 && rafQueue.length > 0; i++) {
				const batch = rafQueue.splice(0, rafQueue.length);
				clock += 16;
				for (const cb of batch) cb(clock);
				// Approaching from below: never past the target.
				expect(view.viewportEl.scrollTop).toBeLessThanOrEqual(
					target + TOLERANCE,
				);
			}
		});

		it("is frame-rate independent: 30 / 60 / 120 Hz land together", () => {
			const landed: number[] = [];
			for (const dt of [33, 16, 8]) {
				view.dispose();
				host.remove();
				rafQueue = [];
				clock = 1000;
				host = document.createElement("div");
				document.body.appendChild(host);
				view = new GlideOutlineView(host, () => settings, {
					onJump: () => undefined,
				});
				view.setItems(HEADINGS);
				mockViewport(0);
				mockRowLayout();
				flushRaf(200, dt);
				const startedAt = clock;
				view.setActiveKey(keyAt(60));
				flushRaf(400, dt);
				landed.push(view.viewportEl.scrollTop);
				// Wall-clock duration must be comparable across rates.
				expect(clock - startedAt).toBeLessThanOrEqual(
					800 + dt * 2,
				);
			}
			for (const value of landed) {
				expect(value).toBeCloseTo(centeredTarget(60), 1);
			}
		});

		it("snaps once the hard duration ceiling is reached", () => {
			// One enormous frame blows straight past the 700 ms ceiling.
			view.setActiveKey(keyAt(125));
			const batch = rafQueue.splice(0, rafQueue.length);
			clock += 1200;
			for (const cb of batch) cb(clock);
			const d = view.getActiveFollowDiagnostics();
			expect(d.timeoutCount).toBe(1);
			expect(view.viewportEl.scrollTop).toBeCloseTo(
				centeredTarget(125),
				1,
			);
			expect(d.sessionState).toBe("idle");
		});

		it("keeps pending until the session actually aligns", () => {
			view.setActiveKey(keyAt(110));
			expect(view.getPendingActiveFollow()?.key).toBe(keyAt(110));
			flushRaf(2);
			// Still mid-flight: the target must survive.
			expect(view.getPendingActiveFollow()).not.toBeNull();
			flushRaf();
			expect(view.getPendingActiveFollow()).toBeNull();
			expect(view.getActiveFollowDiagnostics().sessionState).toBe("idle");
		});

		it("writes scrollTop at most once per frame", () => {
			view.setActiveKey(keyAt(110));
			let previous = view.getActiveFollowDiagnostics().scrollMutationCount;
			for (let i = 0; i < 20 && rafQueue.length > 0; i++) {
				const batch = rafQueue.splice(0, rafQueue.length);
				clock += 16;
				for (const cb of batch) cb(clock);
				const now =
					view.getActiveFollowDiagnostics().scrollMutationCount;
				expect(now - previous).toBeLessThanOrEqual(1);
				previous = now;
			}
		});

		it("stops writing scrollTop once the session is cancelled", () => {
			view.setActiveKey(keyAt(110));
			flushRaf(2);
			const parked = view.viewportEl.scrollTop;
			view.setInteractionState("pressed"); // cancels the session
			const queued = rafQueue.splice(0, rafQueue.length);
			clock += 16;
			for (const cb of queued) cb(clock);
			expect(view.viewportEl.scrollTop).toBe(parked);
		});

		it("drops the session and the queue on dispose", () => {
			view.setActiveKey(keyAt(110));
			flushRaf(2);
			view.dispose();
			const parked = view.viewportEl.scrollTop;
			const queued = rafQueue.splice(0, rafQueue.length);
			clock += 16;
			for (const cb of queued) cb(clock);
			expect(view.viewportEl.scrollTop).toBe(parked);
			expect(view.getPendingActiveFollow()).toBeNull();
		});
	});

	// ── §十一: pointer enter snaps before expansion ─────────────────

	describe("pointer enter (§十一)", () => {
		it("snaps the in-flight follow straight to the newest target", () => {
			view.setActiveKey(keyAt(110));
			flushRaf(2); // still far from the target
			expect(view.viewportEl.scrollTop).toBeLessThan(
				centeredTarget(110) - 100,
			);
			view.finishActiveFollowImmediately();
			expect(view.viewportEl.scrollTop).toBeCloseTo(
				centeredTarget(110),
				1,
			);
			expect(view.getActiveFollowDiagnostics().snapCount).toBe(1);
		});

		it("leaves no frame queued behind the snap", () => {
			view.setActiveKey(keyAt(110));
			flushRaf(2);
			view.finishActiveFollowImmediately();
			const before = view.viewportEl.scrollTop;
			const queued = rafQueue.splice(0, rafQueue.length);
			clock += 16;
			for (const cb of queued) cb(clock);
			expect(view.viewportEl.scrollTop).toBe(before);
		});

		it("clears pending and reports aligned after the snap", () => {
			view.setActiveKey(keyAt(110));
			flushRaf(2);
			view.finishActiveFollowImmediately();
			expect(view.getPendingActiveFollow()).toBeNull();
			const d = view.getActiveFollowDiagnostics();
			expect(d.sessionState).toBe("idle");
			expect(Math.abs(d.lastAlignmentErrorPx)).toBeLessThanOrEqual(
				TOLERANCE,
			);
		});

		it("expanding centres the active row before the rail opens", () => {
			view.setActiveKey(keyAt(110));
			flushRaf(2);
			view.setInteractionState("expanded-pointer");
			expect(view.viewportEl.scrollTop).toBeCloseTo(
				centeredTarget(110),
				1,
			);
		});

		it("expands without scrolling when there is no active heading", () => {
			view.setActiveKey(null);
			mockViewport(777);
			view.finishActiveFollowImmediately();
			expect(view.viewportEl.scrollTop).toBe(777);
		});
	});

	// ── §十二: expanded / collapsed behaviour ───────────────────────

	describe("interaction states (§十二)", () => {
		it("does not auto-scroll while expanded under the pointer", () => {
			view.setInteractionState("expanded-pointer");
			mockViewport(500);
			view.setActiveKey(keyAt(110));
			flushRaf();
			expect(view.viewportEl.scrollTop).toBe(500);
			expect(view.getActiveFollowDiagnostics().suppressedCount).toBe(1);
		});

		it("does not auto-scroll while expanded by the keyboard", () => {
			view.setInteractionState("expanded-keyboard");
			mockViewport(500);
			view.setActiveKey(keyAt(110));
			flushRaf();
			expect(view.viewportEl.scrollTop).toBe(500);
		});

		it("freezes completely while pressed", () => {
			view.setInteractionState("pressed");
			mockViewport(500);
			view.setActiveKey(keyAt(110));
			flushRaf();
			expect(view.viewportEl.scrollTop).toBe(500);
		});

		it("retains the newest target across an expanded interval", () => {
			view.setInteractionState("expanded-pointer");
			view.setActiveKey(keyAt(40));
			view.setActiveKey(keyAt(110));
			expect(view.getPendingActiveFollow()?.key).toBe(keyAt(110));
		});

		it("collapsing follows the newest active key, not the stale one", () => {
			view.setInteractionState("expanded-pointer");
			view.setActiveKey(keyAt(40));
			view.setActiveKey(keyAt(110));
			mockViewport(0);
			view.setInteractionState("collapsed");
			flushRaf();
			expect(view.viewportEl.scrollTop).toBeCloseTo(
				centeredTarget(110),
				1,
			);
			expect(
				view.getActiveFollowDiagnostics().flushCount,
			).toBeGreaterThanOrEqual(1);
		});

		it("re-enabling follow consumes the retained target", () => {
			view.setFollowEnabled(false);
			view.setActiveKey(keyAt(110));
			expect(view.viewportEl.scrollTop).toBe(0);
			view.setFollowEnabled(true);
			flushRaf();
			expect(view.viewportEl.scrollTop).toBeCloseTo(
				centeredTarget(110),
				1,
			);
		});
	});

	// ── §五: the fixed playhead ─────────────────────────────────────

	describe("fixed centre playhead (§五)", () => {
		function playhead(): HTMLElement | null {
			return host.querySelector<HTMLElement>(".glide-outline-playhead");
		}

		it("mounts inside the plugin's own owned subtree", () => {
			const el = playhead();
			expect(el).not.toBeNull();
			expect(el?.closest("[data-glide-outline-owner]")).not.toBeNull();
		});

		it("carries a marker child for the dot / line rendering", () => {
			expect(
				playhead()?.querySelector(".glide-outline-playhead-marker"),
			).not.toBeNull();
		});

		it("is visible while collapsed and hidden while expanded", () => {
			expect(view.getActiveFollowDiagnostics().playheadVisible).toBe(true);
			view.setInteractionState("expanded-pointer");
			expect(view.getActiveFollowDiagnostics().playheadVisible).toBe(
				false,
			);
			view.setInteractionState("collapsed");
			expect(view.getActiveFollowDiagnostics().playheadVisible).toBe(true);
		});

		it("is hidden from assistive tech and never announced", () => {
			expect(playhead()?.getAttribute("aria-hidden")).toBe("true");
			expect(playhead()?.hasAttribute("aria-label")).toBe(false);
			expect(playhead()?.hasAttribute("title")).toBe(false);
		});

		it("lives outside the scroll viewport so it cannot drift", () => {
			expect(view.viewportEl.contains(playhead())).toBe(false);
		});

		it("is not a heading row and never enters the item records", () => {
			expect(
				playhead()?.classList.contains("glide-outline-row"),
			).toBeFalsy();
			expect(
				view.listEl.querySelectorAll(".glide-outline-row").length,
			).toBe(ROW_COUNT);
		});
	});

	// ── §六: the centre spacers ─────────────────────────────────────

	describe("centre spacers (§六)", () => {
		function spacers(): HTMLElement[] {
			return [
				...host.querySelectorAll<HTMLElement>(
					".glide-outline-center-spacer",
				),
			];
		}

		it("adds exactly one spacer at each end of the scroll content", () => {
			expect(spacers()).toHaveLength(2);
			for (const el of spacers()) {
				expect(view.viewportEl.contains(el)).toBe(true);
			}
		});

		it("is hidden from assistive tech and carries no label", () => {
			for (const el of spacers()) {
				expect(el.getAttribute("aria-hidden")).toBe("true");
				expect(el.hasAttribute("aria-label")).toBe(false);
				expect(el.hasAttribute("title")).toBe(false);
			}
		});

		it("never adds a clickable row or a marker", () => {
			for (const el of spacers()) {
				expect(el.querySelector("button")).toBeNull();
				expect(el.querySelector(".glide-outline-marker")).toBeNull();
			}
		});

		it("writes the computed heights onto the elements", () => {
			const [top, bottom] = spacers();
			expect(top.style.height).toBe(`${SPACER}px`);
			expect(bottom.style.height).toBe(`${SPACER}px`);
		});

		it("reports the geometry it sized itself from", () => {
			// §六: the spacer maths must be auditable from the report alone —
			// half the viewport minus half the row, for each end.
			const d = view.getActiveFollowDiagnostics();
			expect(d.playheadClientY).toBe(CLIENT_H / 2);
			expect(d.firstRowHeight).toBe(ROW_H);
			expect(d.lastRowHeight).toBe(ROW_H);
			expect(d.topCenterSpacerPx).toBe(CLIENT_H / 2 - ROW_H / 2);
			expect(d.bottomCenterSpacerPx).toBe(CLIENT_H / 2 - ROW_H / 2);
			expect(d.centerSpacerRefreshCount).toBeGreaterThan(0);
		});

		it("re-measures when the viewport is resized", () => {
			const before =
				view.getActiveFollowDiagnostics().centerSpacerRefreshCount;
			defineNumber(view.viewportEl, "clientHeight", 600);
			view.applySettings();
			const after = view.getActiveFollowDiagnostics();
			expect(after.centerSpacerRefreshCount).toBeGreaterThan(before);
			expect(after.playheadClientY).toBe(300);
			expect(after.topCenterSpacerPx).toBe(300 - ROW_H / 2);
		});
	});

	// ── §十四: ancestor safety ──────────────────────────────────────

	describe("ancestor safety (§十四)", () => {
		it("scrolls the outline viewport and nothing else", () => {
			const ancestor = host.parentElement as HTMLElement;
			Object.defineProperty(ancestor, "scrollTop", {
				configurable: true,
				writable: true,
				value: 0,
			});
			followTo(110);
			expect(ancestor.scrollTop).toBe(0);
		});

		it("never calls scrollIntoView", () => {
			const spy = vi.fn();
			for (const row of view.listEl.querySelectorAll<HTMLElement>(
				".glide-outline-row",
			)) {
				row.scrollIntoView = spy;
			}
			followTo(110);
			expect(spy).not.toHaveBeenCalled();
		});
	});
});
