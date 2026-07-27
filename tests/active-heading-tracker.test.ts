// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownView } from "obsidian";
import type { HeadingItem } from "../src/model/HeadingItem";
import {
	ActiveHeadingTracker,
	JUMP_MAX_LOCK_MS,
	JUMP_SETTLE_MS,
} from "../src/core/ActiveHeadingTracker";
import type { EditorUpdateSummary } from "../src/core/EditorUpdateBridge";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::0`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const ITEMS = [
	heading(1, "Alpha", 0),
	heading(2, "Beta", 10),
	heading(2, "Gamma", 20),
];

/** 20px per line in the fake CM document. */
const LINE_HEIGHT = 20;

interface FakeEditorState {
	cursorLine: number;
}

function makeFakeView(state: FakeEditorState): {
	view: MarkdownView;
	scroller: { scrollTop: number; clientHeight: number };
} {
	const scroller = { scrollTop: 0, clientHeight: 100 };
	const cm = {
		scrollDOM: scroller as unknown as HTMLElement,
		lineBlockAt: (pos: number) => ({
			top: pos * LINE_HEIGHT,
			height: LINE_HEIGHT,
		}),
		dispatch: () => undefined,
	};
	const editor = {
		cm,
		getCursor: () => ({ line: state.cursorLine, ch: 0 }),
		lineCount: () => 30,
		posToOffset: ({ line }: { line: number }) => line,
	};
	const view = {
		contentEl: document.createElement("div"),
		getMode: () => "source",
		editor,
	} as unknown as MarkdownView;
	return { view, scroller };
}

function update(partial: Partial<EditorUpdateSummary>): EditorUpdateSummary {
	return {
		view: null,
		selectionSet: false,
		viewportChanged: false,
		geometryChanged: false,
		docChanged: false,
		...partial,
	};
}

describe("ActiveHeadingTracker hybrid model (P0-2)", () => {
	let rafQueue: FrameRequestCallback[];
	let state: FakeEditorState;
	let scroller: { scrollTop: number; clientHeight: number };
	let tracker: ActiveHeadingTracker;
	let activeKeys: Array<string | null>;

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		rafQueue = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		state = { cursorLine: 0 };
		const fake = makeFakeView(state);
		scroller = fake.scroller;
		activeKeys = [];
		tracker = new ActiveHeadingTracker(fake.view, (key) =>
			activeKeys.push(key),
		);
		tracker.setItems(ITEMS);
		flushFrame(); // initial compute
		activeKeys.length = 0;
	});

	afterEach(() => {
		tracker.dispose();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("starts in the viewport source", () => {
		expect(tracker.getSource()).toBe("viewport");
	});

	it("a caret move switches to the cursor source and uses the head line", () => {
		state.cursorLine = 12; // inside Beta's section (10 ≤ 12 < 20)
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		expect(tracker.getSource()).toBe("cursor");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[1].key);
	});

	it("caret before the first heading activates the first heading", () => {
		// Move active AWAY from Alpha first so the change is observable.
		state.cursorLine = 25;
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
		// Now a caret above line 0 — selectActiveIndex falls back to #0.
		state.cursorLine = 0;
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[0].key);
	});

	it("a scroll without caret movement switches to the viewport source", () => {
		state.cursorLine = 25;
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		flushFrame();
		expect(tracker.getSource()).toBe("cursor");

		// Scroll to the top: activation line = 0 + 100×0.2 = 20 document px
		// → only Alpha (top 0) is at/above it.
		scroller.scrollTop = 0;
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		expect(tracker.getSource()).toBe("viewport");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[0].key);

		// Scroll down: activation 400+20=420 → Gamma (top 20×20=400) wins.
		scroller.scrollTop = 400;
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("beginJump locks the target while scroll updates stream in", () => {
		tracker.beginJump(ITEMS[2].key);
		expect(tracker.getSource()).toBe("jump");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);

		// The smooth scroll produces viewport updates — the lock holds and
		// intermediate headings never flicker active.
		scroller.scrollTop = 100; // would normally activate Alpha
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		expect(tracker.getSource()).toBe("jump");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("the jump releases after the settle delay and viewport takes over", () => {
		tracker.beginJump(ITEMS[2].key);
		flushFrame();
		scroller.scrollTop = 400;
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		flushFrame();
		// No further scroll updates → settle timer fires.
		vi.advanceTimersByTime(JUMP_SETTLE_MS + 10);
		expect(tracker.getSource()).toBe("viewport");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("scroll updates re-arm the settle, but the max lock caps it", () => {
		tracker.beginJump(ITEMS[1].key);
		// Keep "scrolling" every 100ms — settle never fires…
		const steps = Math.ceil(JUMP_MAX_LOCK_MS / 100) + 2;
		for (let i = 0; i < steps; i++) {
			tracker.handleEditorUpdate(update({ viewportChanged: true }));
			vi.advanceTimersByTime(100);
		}
		// …but the hard cap released the lock anyway.
		expect(tracker.getSource()).not.toBe("jump");
	});

	it("a caret move during a jump releases the lock immediately", () => {
		tracker.beginJump(ITEMS[2].key);
		expect(tracker.getSource()).toBe("jump");
		state.cursorLine = 11;
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		expect(tracker.getSource()).toBe("cursor");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[1].key);
	});

	it("releases a jump whose target disappears from the items", () => {
		tracker.beginJump(ITEMS[2].key);
		tracker.setItems(ITEMS.slice(0, 2));
		expect(tracker.getSource()).not.toBe("jump");
	});

	it("docChanged without caret/scroll recomputes under the same source", () => {
		state.cursorLine = 25;
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		flushFrame();
		expect(tracker.getSource()).toBe("cursor");
		tracker.handleEditorUpdate(update({ docChanged: true }));
		expect(tracker.getSource()).toBe("cursor");
	});
});
