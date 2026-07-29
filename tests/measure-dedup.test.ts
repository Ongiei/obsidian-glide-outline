// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import { PerfCapture } from "../src/core/PerfCapture";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: 8 }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

describe("GlideOutlineView.measureRows dedup (§八)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;
	let perf: PerfCapture;
	let rafQueue: FrameRequestCallback[];

	function flushRaf(): void {
		// Drain including callbacks scheduled while flushing.
		for (let guard = 0; guard < 10 && rafQueue.length > 0; guard++) {
			const batch = rafQueue.splice(0, rafQueue.length);
			for (const cb of batch) cb(performance.now());
		}
	}

	/** jsdom has no layout — give every card a deterministic offsetHeight. */
	function setCardHeights(px: number): void {
		for (const card of view.listEl.querySelectorAll<HTMLElement>(
			".glide-outline-card",
		)) {
			Object.defineProperty(card, "offsetHeight", {
				configurable: true,
				value: px,
			});
		}
	}

	beforeEach(() => {
		rafQueue = [];
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback): number => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
		);
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		perf = new PerfCapture();
		perf.start(window as Window & typeof globalThis);
		view = new GlideOutlineView(
			host,
			() => settings,
			{ onJump: () => undefined },
			perf,
		);
		view.setItems(HEADINGS);
		setCardHeights(22);
		flushRaf(); // first measure pass — establishes the baseline
	});

	afterEach(() => {
		perf.stop(window as Window & typeof globalThis);
		view.dispose();
		host.remove();
		vi.unstubAllGlobals();
	});

	it("first pass writes every row height; a repeat pass writes none", () => {
		const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
		view.applySettings(); // schedules another measure, heights unchanged
		flushRaf();
		const rowWrites = spy.mock.calls.filter(
			([prop]) => prop === "--glide-row-height",
		);
		const padWrites = spy.mock.calls.filter(
			([prop]) => prop === "--glide-viewport-pad",
		);
		expect(rowWrites).toHaveLength(0);
		expect(padWrites).toHaveLength(0);
		spy.mockRestore();
	});

	it("a changed card height writes exactly the changed rows again", () => {
		setCardHeights(30);
		const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
		view.applySettings();
		flushRaf();
		const rowWrites = spy.mock.calls.filter(
			([prop]) => prop === "--glide-row-height",
		);
		expect(rowWrites).toHaveLength(HEADINGS.length);
		spy.mockRestore();
	});

	it("tracks run/read/write/skip counters for the perf report", () => {
		view.applySettings(); // second, fully-skipped pass
		flushRaf();
		const report = perf.stop(window as Window & typeof globalThis)!;
		const c = report.counters;
		expect(c.measureRowsRunCount).toBeGreaterThanOrEqual(2);
		expect(c.measureRowsReadCount).toBeGreaterThanOrEqual(
			HEADINGS.length * 2,
		);
		expect(c.measureRowsWriteCount).toBeGreaterThanOrEqual(HEADINGS.length);
		expect(c.measureRowsSkippedWriteCount).toBeGreaterThanOrEqual(
			HEADINGS.length,
		);
		// Restart so afterEach's stop() has an active capture to close.
		perf.start(window as Window & typeof globalThis);
	});
});
