// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownView } from "obsidian";
import type { HeadingItem } from "../src/model/HeadingItem";
import {
	ActiveHeadingTracker,
	EDITOR_JUMP_GUARD_MS,
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
	mode: "source" | "preview";
}

function makeFakeView(state: FakeEditorState): {
	view: MarkdownView;
	scroller: { scrollTop: number; clientHeight: number };
	contentEl: HTMLElement;
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
	const contentEl = document.createElement("div");
	document.body.appendChild(contentEl);
	const view = {
		contentEl,
		getMode: () => state.mode,
		editor,
	} as unknown as MarkdownView;
	return { view, scroller, contentEl };
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
	let contentEl: HTMLElement;
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
		state = { cursorLine: 0, mode: "source" };
		const fake = makeFakeView(state);
		scroller = fake.scroller;
		contentEl = fake.contentEl;
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
		contentEl.remove();
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

	it("scrolling BEFORE any caret interaction follows the viewport", () => {
		expect(tracker.getSource()).toBe("viewport");
		// Scroll down: activation 400+20=420 → Gamma (top 20×20=400) wins.
		scroller.scrollTop = 400;
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		expect(tracker.getSource()).toBe("viewport");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("scrolling never demotes the cursor source (unified model)", () => {
		state.cursorLine = 25;
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		flushFrame();
		expect(tracker.getSource()).toBe("cursor");
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);

		// Manual scroll back to the top WITHOUT moving the caret: the
		// active heading must stay with the cursor, not the viewport.
		scroller.scrollTop = 0;
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		expect(tracker.getSource()).toBe("cursor");
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

	it("an editor jump settles into the cursor source (never viewport)", () => {
		// The jump moved the caret onto the heading line — after settling,
		// the cursor rule keeps the target active even through scrolls.
		tracker.beginJump(ITEMS[2].key);
		state.cursorLine = 20;
		flushFrame();
		scroller.scrollTop = 400;
		tracker.handleEditorUpdate(update({ viewportChanged: true }));
		flushFrame();
		// No further scroll updates → settle timer fires.
		vi.advanceTimersByTime(JUMP_SETTLE_MS + 10);
		expect(tracker.getSource()).toBe("cursor");
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

	// ------------------------------------------------------------------
	// Editor jumps move the caret: one-shot programmatic-cursor guard.
	// ------------------------------------------------------------------

	it("beginEditorJump swallows its own setCursor selectionSet", () => {
		tracker.beginEditorJump(ITEMS[2].key, 20);
		state.cursorLine = 20; // the controller's setCursor landed
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		// Guard consumed as our own dispatch — the jump lock holds.
		expect(tracker.getSource()).toBe("jump");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("a selectionSet on a DIFFERENT line during the guard is a real user move", () => {
		tracker.beginEditorJump(ITEMS[2].key, 20);
		state.cursorLine = 11; // user clicked into Beta's section instead
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		expect(tracker.getSource()).toBe("cursor");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[1].key);
	});

	it("the guard is one-shot: a SECOND selectionSet on the same line is the user", () => {
		tracker.beginEditorJump(ITEMS[2].key, 20);
		state.cursorLine = 20;
		tracker.handleEditorUpdate(update({ selectionSet: true })); // consumed
		expect(tracker.getSource()).toBe("jump");
		tracker.handleEditorUpdate(update({ selectionSet: true })); // real
		expect(tracker.getSource()).toBe("cursor");
	});

	it("the guard expires after its timeout", () => {
		tracker.beginEditorJump(ITEMS[2].key, 20);
		vi.advanceTimersByTime(EDITOR_JUMP_GUARD_MS + 10);
		state.cursorLine = 20; // matching line, but the guard is gone
		tracker.handleEditorUpdate(update({ selectionSet: true }));
		expect(tracker.getSource()).toBe("cursor");
	});
});

describe("ActiveHeadingTracker Reading-Mode focus hold (unified model)", () => {
	let rafQueue: FrameRequestCallback[];
	let state: FakeEditorState;
	let contentEl: HTMLElement;
	let tracker: ActiveHeadingTracker;
	let activeKeys: Array<string | null>;

	function flushFrame(): void {
		const queue = rafQueue;
		rafQueue = [];
		for (const cb of queue) cb(performance.now());
	}

	function settleJump(): void {
		vi.advanceTimersByTime(JUMP_SETTLE_MS + 10);
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		rafQueue = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		state = { cursorLine: 0, mode: "preview" };
		const fake = makeFakeView(state);
		contentEl = fake.contentEl;
		activeKeys = [];
		tracker = new ActiveHeadingTracker(fake.view, (key) =>
			activeKeys.push(key),
		);
		tracker.setItems(ITEMS);
		flushFrame();
		activeKeys.length = 0;
	});

	afterEach(() => {
		tracker.dispose();
		contentEl.remove();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("a settled preview jump holds the target via the focus source", () => {
		tracker.beginJump(ITEMS[2].key);
		settleJump();
		expect(tracker.getSource()).toBe("focus");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("programmatic scroll activity never clears the focus hold", () => {
		tracker.beginJump(ITEMS[2].key);
		settleJump();
		expect(tracker.getSource()).toBe("focus");
		// Corrector / ephemeral-state scrolls only produce scroll events —
		// the focus hold must survive them.
		const scrollTarget = document.createElement("div");
		scrollTarget.className = "markdown-preview-view";
		contentEl.appendChild(scrollTarget);
		scrollTarget.dispatchEvent(new Event("scroll", { bubbles: true }));
		expect(tracker.getSource()).toBe("focus");
		flushFrame();
		expect(activeKeys.at(-1)).toBe(ITEMS[2].key);
	});

	it("an explicit wheel in the preview body releases the focus", () => {
		tracker.beginJump(ITEMS[2].key);
		settleJump();
		contentEl.dispatchEvent(new Event("wheel", { bubbles: true }));
		expect(tracker.getSource()).toBe("viewport");
	});

	it("paging keys release the focus; other keys do not", () => {
		tracker.beginJump(ITEMS[2].key);
		settleJump();
		contentEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
		expect(tracker.getSource()).toBe("focus"); // not a paging key
		contentEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
		);
		expect(tracker.getSource()).toBe("viewport");
	});

	it("pointerdown INSIDE the outline root does not release the focus", () => {
		tracker.beginJump(ITEMS[2].key);
		settleJump();
		const root = document.createElement("div");
		root.className = "glide-outline-root";
		const card = document.createElement("div");
		root.appendChild(card);
		contentEl.appendChild(root);
		card.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(tracker.getSource()).toBe("focus"); // outline gesture
		contentEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(tracker.getSource()).toBe("viewport"); // body gesture
	});

	it("drops the focus hold when the focused heading disappears", () => {
		tracker.beginJump(ITEMS[2].key);
		settleJump();
		expect(tracker.getSource()).toBe("focus");
		tracker.setItems(ITEMS.slice(0, 2));
		expect(tracker.getSource()).toBe("viewport");
	});
});
