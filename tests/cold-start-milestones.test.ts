// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ColdStartTrace,
	markColdStart,
	noteColdStartInteraction,
	setActiveColdStartTrace,
} from "../src/core/ColdStartTrace";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";

/**
 * §十三 / §十七: the first-use milestones are fired from the view's hot
 * paths through module-level ambient hooks, so the view never has to take
 * (and keep forever) a trace parameter.
 *
 * Two properties matter and neither is visible from the trace's own unit
 * tests: the hooks are genuinely wired into the real code paths, and they
 * are a true no-op when no trace is armed — which is every session but
 * the one after the arm command.
 */
function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: 12 }, (_, i) =>
	heading(2, `Section ${i}`, i * 3),
);

const ROW_H = 24;
const CLIENT_H = 120;

function defineNumber(el: HTMLElement, prop: string, value: number): void {
	Object.defineProperty(el, prop, { configurable: true, value });
}

describe("cold-start milestone wiring (§十三)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let trace: ColdStartTrace | null;
	let rafQueue: FrameRequestCallback[];
	let clock: number;

	/**
	 * §八 / §十七: the centre-follow session is a real RAF animation now, so
	 * the milestones only fire if the clock actually advances. A fake clock
	 * keeps that deterministic — 100 ms per frame converges (or trips the
	 * 700 ms ceiling) well inside the guard.
	 */
	function flushRaf(frames = 16, dt = 100): void {
		for (let guard = 0; guard < frames && rafQueue.length > 0; guard++) {
			const batch = rafQueue.splice(0, rafQueue.length);
			clock += dt;
			for (const cb of batch) cb(clock);
		}
	}

	function mockLayout(): void {
		defineNumber(view.viewportEl, "clientHeight", CLIENT_H);
		defineNumber(view.viewportEl, "scrollHeight", HEADINGS.length * ROW_H);
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			writable: true,
			value: 0,
		});
		const rows = [
			...view.listEl.querySelectorAll<HTMLElement>(".glide-outline-row"),
		];
		rows.forEach((row, i) => {
			defineNumber(row, "offsetTop", i * ROW_H);
			defineNumber(row, "offsetHeight", ROW_H);
			Object.defineProperty(row, "offsetParent", {
				configurable: true,
				value: view.listEl,
			});
		});
		defineNumber(view.listEl, "offsetTop", 0);
		Object.defineProperty(view.listEl, "offsetParent", {
			configurable: true,
			value: view.viewportEl,
		});
	}

	function milestoneNames(): string[] {
		return (trace?.buildReport().milestones ?? []).map((m) => m.name);
	}

	function buildView(): void {
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
	}

	beforeEach(() => {
		rafQueue = [];
		clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback): number => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
		);
		vi.stubGlobal("cancelAnimationFrame", (): void => undefined);
		trace = null;
	});

	afterEach(() => {
		view.dispose();
		host.remove();
		trace?.dispose();
		setActiveColdStartTrace(null);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("records the outline's first commit and first follow", () => {
		trace = new ColdStartTrace(window, 0);
		setActiveColdStartTrace(trace);
		buildView();

		view.setItems(HEADINGS);
		mockLayout();
		view.setActiveKey(HEADINGS[10].key);
		flushRaf();

		const names = milestoneNames();
		expect(names).toContain("firstItemsSet");
		expect(names).toContain("firstOutlineDomCommit");
		expect(names).toContain("firstMeasureRowsStart");
		expect(names).toContain("firstMeasureRowsEnd");
		expect(names).toContain("firstActiveFollowRequest");
		expect(names).toContain("firstCenterFollowAligned");
	});

	it("keeps the milestones in the order the plugin reached them", () => {
		trace = new ColdStartTrace(window, 0);
		setActiveColdStartTrace(trace);
		buildView();

		view.setItems(HEADINGS);
		mockLayout();
		view.setActiveKey(HEADINGS[10].key);
		flushRaf();

		const names = milestoneNames();
		const at = (name: string): number => names.indexOf(name);
		expect(at("firstItemsSet")).toBeLessThan(at("firstOutlineDomCommit"));
		expect(at("firstOutlineDomCommit")).toBeLessThan(
			at("firstActiveFollowRequest"),
		);
		expect(at("firstActiveFollowRequest")).toBeLessThan(
			at("firstCenterFollowAligned"),
		);
		const report = trace.buildReport();
		for (const milestone of report.milestones) {
			expect(milestone.atMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("records each first-use milestone exactly once", () => {
		trace = new ColdStartTrace(window, 0);
		setActiveColdStartTrace(trace);
		buildView();

		view.setItems(HEADINGS);
		mockLayout();
		view.setActiveKey(HEADINGS[10].key);
		flushRaf();
		// Everything happens a second time — a *first*-use milestone that
		// moved would silently rewrite the startup timeline.
		view.setItems(HEADINGS.slice(0, 8));
		view.setActiveKey(HEADINGS[2].key);
		flushRaf();

		const names = milestoneNames();
		const counts = new Map<string, number>();
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
		for (const [name, count] of counts) {
			expect(`${name}:${count}`).toBe(`${name}:1`);
		}
	});

	it("routes ambient interactions into the trace's observation phase", () => {
		trace = new ColdStartTrace(window, 0);
		setActiveColdStartTrace(trace);
		buildView();
		trace.beginSettleWatch();

		noteColdStartInteraction("firstPointerEnter");
		noteColdStartInteraction("firstExpand"); // the first one wins

		const report = trace.buildReport();
		expect(report.settle.firstInteraction).toBe("firstPointerEnter");
		expect(report.settle.firstInteractionAt).not.toBeNull();
	});

	it("is a complete no-op when no trace is armed", () => {
		buildView();
		// No `setActiveColdStartTrace` — this is every ordinary session.
		expect(() => {
			markColdStart("firstItemsSet");
			noteColdStartInteraction("firstPointerEnter");
			view.setItems(HEADINGS);
			mockLayout();
			view.setActiveKey(HEADINGS[10].key);
			flushRaf();
		}).not.toThrow();
		expect(view.getActiveFollowDiagnostics().alignedCount).toBe(1);
	});

	it("stops recording once the trace is unpublished", () => {
		trace = new ColdStartTrace(window, 0);
		setActiveColdStartTrace(trace);
		buildView();

		view.setItems(HEADINGS);
		const before = milestoneNames().length;
		expect(before).toBeGreaterThan(0);

		setActiveColdStartTrace(null); // developer mode switched off
		mockLayout();
		view.setActiveKey(HEADINGS[10].key);
		flushRaf();

		expect(milestoneNames()).toHaveLength(before);
		expect(milestoneNames()).not.toContain("firstCenterFollowAligned");
	});
});
