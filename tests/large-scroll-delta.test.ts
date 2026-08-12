// @vitest-environment jsdom
/**
 * §十 (0.1.5): scroll deltas larger than the viewport height are the
 * "outline teleported" anomaly. They must be SNAPSHOTTED (never clamped,
 * never swallowed) into a bounded ring on Diagnostics, with a best-effort
 * source attribution: plugin writes are exact, programmatic reveals /
 * context switches / the initial mount leave short-lived notes, and
 * everything else is "external".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LargeScrollDeltaSnapshot } from "../src/core/Diagnostics";
import { Diagnostics } from "../src/core/Diagnostics";
import { PerfCapture } from "../src/core/PerfCapture";
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

const HEADINGS = Array.from({ length: 30 }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

const VIEWPORT_TOP = 100;
const VIEWPORT_BOTTOM = 500;
const SCROLL_HEIGHT = 1200;
const CLIENT_HEIGHT = VIEWPORT_BOTTOM - VIEWPORT_TOP;

function snapshot(over: Partial<LargeScrollDeltaSnapshot> = {}): LargeScrollDeltaSnapshot {
	return {
		previousScrollTop: 0,
		currentScrollTop: 500,
		delta: 500,
		clientHeight: CLIENT_HEIGHT,
		scrollHeight: SCROLL_HEIGHT,
		source: "external",
		fileChangePending: false,
		modeChangePending: false,
		instanceId: "1",
		...over,
	};
}

describe("Diagnostics large-scroll-delta ring (§十)", () => {
	it("keeps only the newest 10 snapshots, oldest first", () => {
		const diagnostics = new Diagnostics();
		for (let i = 0; i < 12; i++) {
			diagnostics.recordLargeScrollDelta(snapshot({ delta: 500 + i }));
		}
		expect(diagnostics.largeScrollDeltas).toHaveLength(10);
		expect(diagnostics.largeScrollDeltas[0]?.delta).toBe(502);
		expect(diagnostics.largeScrollDeltas[9]?.delta).toBe(511);
	});
});

describe("large scroll delta snapshots + source attribution (§十)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let controller: MagnificationController;
	let diagnostics: Diagnostics;
	let perf: PerfCapture;
	let rafQueue: FrameRequestCallback[];

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function pointer(type: string, clientY: number): void {
		view.hitZoneEl.dispatchEvent(
			new MouseEvent(type, { clientY, bubbles: true }),
		);
	}

	/** Run `n` frames so frame-counted attribution notes age out. */
	function settleFrames(n: number): void {
		for (let i = 0; i < n; i++) {
			vi.advanceTimersByTime(16);
			pointer("pointermove", 300);
			flushFrame();
		}
	}

	/** Jump the scroller by `to - scrollTop` and deliver the event. */
	function scrollTo(to: number): void {
		view.viewportEl.scrollTop = to;
		view.viewportEl.dispatchEvent(new Event("scroll"));
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
		// jsdom has no scrollIntoView; the reveal path only needs it to exist.
		Element.prototype.scrollIntoView = vi.fn();

		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);

		Object.defineProperty(view.viewportEl, "clientHeight", {
			configurable: true,
			value: CLIENT_HEIGHT,
		});
		Object.defineProperty(view.viewportEl, "scrollHeight", {
			configurable: true,
			value: SCROLL_HEIGHT,
		});
		Object.defineProperty(view.viewportEl, "scrollTop", {
			configurable: true,
			writable: true,
			value: 200,
		});
		view.viewportEl.getBoundingClientRect = () =>
			({
				top: VIEWPORT_TOP,
				bottom: VIEWPORT_BOTTOM,
				left: 0,
				right: 200,
				width: 200,
				height: CLIENT_HEIGHT,
				x: 0,
				y: VIEWPORT_TOP,
				toJSON: () => ({}),
			}) as DOMRect;
		view.updateOverflowState();

		diagnostics = new Diagnostics();
		perf = new PerfCapture();
		controller = new MagnificationController(
			view,
			() => settings,
			diagnostics,
			null,
			perf,
		);
		// Cache the viewport bounds (§十 compares against the CACHED height).
		pointer("pointerenter", 300);
		pointer("pointermove", 300);
		flushFrame();
	});

	afterEach(() => {
		controller.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		host.remove();
	});

	it("snapshots a delta beyond the viewport height — attributed to mount right after construction", () => {
		scrollTo(700); // |delta| = 500 > 400
		expect(diagnostics.largeScrollDeltas).toHaveLength(1);
		const snap = diagnostics.largeScrollDeltas[0]!;
		expect(snap.previousScrollTop).toBe(200);
		expect(snap.currentScrollTop).toBe(700);
		expect(snap.delta).toBe(500);
		expect(snap.clientHeight).toBe(CLIENT_HEIGHT);
		expect(snap.scrollHeight).toBe(SCROLL_HEIGHT);
		expect(snap.source).toBe("mount");
		expect(typeof snap.instanceId).toBe("string");
	});

	it("never snapshots an ordinary scroll delta", () => {
		scrollTo(300); // |delta| = 100 ≤ 400
		expect(diagnostics.largeScrollDeltas).toHaveLength(0);
	});

	it("never clamps or swallows the anomalous scroll itself", () => {
		scrollTo(900);
		expect(view.viewportEl.scrollTop).toBe(900);
		expect(diagnostics.largeScrollDeltas).toHaveLength(1);
	});

	it("attributes a large delta after a context switch to that switch", () => {
		settleFrames(4); // ages out the construction-time mount note
		controller.noteContextChange("file-change");
		scrollTo(800);
		const snap = diagnostics.largeScrollDeltas[0]!;
		expect(snap.source).toBe("file-change");
		expect(snap.fileChangePending).toBe(true);
		expect(snap.modeChangePending).toBe(false);
	});

	it("attributes a programmatic active-heading reveal as active-follow", () => {
		settleFrames(4);
		// §四: the collapsed reveal is a coalesced, purely numeric
		// scrollTop write. Restore the collapsed state (settleFrames'
		// pointermoves expanded it), give the active row a measured height
		// + a far offset, then let the follow frame run. The reveal leaves
		// its "active-follow" note before writing scrollTop.
		view.setInteractionState("collapsed");
		view.setFollowEnabled(true);
		const rec = view.getItemRecord(HEADINGS[25]!.key)!;
		Object.defineProperty(rec.rowEl, "offsetHeight", {
			configurable: true,
			value: 30,
		});
		Object.defineProperty(rec.rowEl, "offsetTop", {
			configurable: true,
			value: 30,
		});
		view.setActiveKey(HEADINGS[25]!.key);
		flushFrame(); // run the coalesced active-follow RAF
		scrollTo(850);
		expect(diagnostics.largeScrollDeltas[0]?.source).toBe("active-follow");
	});

	it("falls back to external once every note has expired", () => {
		settleFrames(4);
		scrollTo(750);
		const snap = diagnostics.largeScrollDeltas[0]!;
		expect(snap.source).toBe("external");
		expect(snap.fileChangePending).toBe(false);
		expect(snap.modeChangePending).toBe(false);
	});

	it("tallies per-source scroll-delta samples in the perf report", () => {
		perf.start(window);
		scrollTo(260);
		scrollTo(320);
		const report = perf.stop(window)!;
		const bySource = report.scrollPipeline.scrollDeltaBySource;
		const total = Object.values(bySource).reduce((a, b) => a + b, 0);
		expect(total).toBe(report.scrollPipeline.scrollEventCount);
		expect(total).toBe(2);
	});
});
