import type { MarkdownView } from "obsidian";
import type { HeadingItem } from "../model/HeadingItem";
import { selectActiveIndex } from "../utils/geometry";
import { matchPreviewHeadings } from "../utils/previewHeadings";
import { DisposableStore } from "../utils/disposable";
import { EditorPositionAdapter } from "./EditorPositionAdapter";
import type { CmViewLike } from "./EditorPositionAdapter";
import type { EditorUpdateSummary } from "./EditorUpdateBridge";

/** Activation line sits at 20% of the viewport height. */
export const ACTIVATION_RATIO = 0.2;

/**
 * How the active heading was last determined (P0-2):
 *  - "cursor":   the user moved the caret / clicked into the body / typed
 *  - "viewport": the user scrolled without moving the caret
 *  - "jump":     the user clicked an outline heading; the target stays
 *                active while the jump scroll is in flight
 */
export type ActiveHeadingSource = "cursor" | "viewport" | "jump";

/** Hard cap: a jump lock never outlives this, even if updates keep coming. */
export const JUMP_MAX_LOCK_MS = 1500;
/** A jump releases this long after the last scroll-driven update. */
export const JUMP_SETTLE_MS = 250;

/**
 * Hybrid active-heading model (P0-2).
 *
 * Editor modes combine THREE sources with explicit priority:
 *   cursor movement (CM `selectionSet`)      → source "cursor"
 *   scrolling without caret movement          → source "viewport"
 *   clicking an outline heading               → source "jump" (locked)
 *
 * Cursor rules (editor modes):
 *   caret on a heading line       → that heading
 *   caret in a body section       → nearest heading ABOVE
 *   caret before the first heading→ the first heading
 *   multi-line selection          → the selection HEAD line decides
 * Level filtering only affects which items are handed in — the rules
 * themselves are agnostic.
 *
 * Viewport rule: the heading whose top is the last one at or above the
 * activation line (viewport top + 20% height) wins. Reading Mode has no
 * caret, so it always uses the viewport rule (plus jump locks).
 *
 * CM updates arrive OUTSIDE this class: the plugin registers ONE
 * `EditorView.updateListener` via `registerEditorExtension`, fans updates
 * through the EditorUpdateBridge, and the controller feeds the ones for
 * this view into `handleEditorUpdate` — no polling anywhere.
 */
export class ActiveHeadingTracker {
	private readonly disposables = new DisposableStore();
	private readonly win: Window & typeof globalThis;
	private items: readonly HeadingItem[] = [];
	private activeKey: string | null = null;
	private source: ActiveHeadingSource = "viewport";
	private jumpKey: string | null = null;
	private jumpSettleTimer = 0;
	private jumpMaxTimer = 0;
	private rafId = 0;
	private disposed = false;

	constructor(
		private readonly view: MarkdownView,
		private readonly onChange: (key: string | null) => void,
	) {
		const win = view.contentEl.ownerDocument.defaultView as
			| (Window & typeof globalThis)
			| null;
		if (!win) throw new Error("glide-outline: detached document");
		this.win = win;

		// DOM scroll still matters: Reading Mode has no CM updates at all,
		// and this also covers CM builds whose viewport does not change on
		// tiny scrolls. Capture phase, passive.
		const onScroll = (event: Event): void => {
			const target = event.target;
			// Pop-out safe: use the owner window's constructor (P1-1).
			if (!(target instanceof this.win.HTMLElement)) return;
			if (
				!target.classList.contains("cm-scroller") &&
				!target.classList.contains("markdown-preview-view")
			) {
				return;
			}
			this.noteScrollActivity();
		};
		view.contentEl.addEventListener("scroll", onScroll, {
			capture: true,
			passive: true,
		});
		this.disposables.add(() =>
			view.contentEl.removeEventListener("scroll", onScroll, {
				capture: true,
			}),
		);
	}

	setItems(items: readonly HeadingItem[]): void {
		this.items = items;
		if (this.jumpKey && !items.some((item) => item.key === this.jumpKey)) {
			this.releaseJump();
		}
		this.schedule();
	}

	getSource(): ActiveHeadingSource {
		return this.source;
	}

	/**
	 * CM update feed (P0-2). Priority: an explicit caret move beats a
	 * scroll; a scroll (without caret movement) beats the previous state;
	 * a jump in flight ignores its own scroll updates and is released by
	 * any caret move.
	 */
	handleEditorUpdate(update: EditorUpdateSummary): void {
		if (this.disposed) return;
		if (update.selectionSet) {
			// User moved the caret (click, keys, typing) — even during a
			// jump this is a new explicit interaction and wins immediately.
			this.releaseJump();
			this.source = "cursor";
			this.schedule();
			return;
		}
		if (update.viewportChanged || update.geometryChanged) {
			this.noteScrollActivity();
			return;
		}
		if (update.docChanged) {
			// Document changed without a caret move (rare: external edits)
			// — recompute under the current source.
			this.schedule();
		}
	}

	/**
	 * An outline heading was clicked (P0-2/P0-3): lock the target as
	 * active so the smooth scroll never flickers other headings active
	 * while passing them. Released on settle, timeout or any caret move.
	 */
	beginJump(key: string): void {
		if (this.disposed) return;
		this.clearJumpTimers();
		this.jumpKey = key;
		this.source = "jump";
		this.jumpMaxTimer = this.win.setTimeout(() => {
			this.jumpMaxTimer = 0;
			this.releaseJump();
			this.schedule();
		}, JUMP_MAX_LOCK_MS);
		this.armJumpSettle();
		this.schedule();
	}

	/** Scroll-ish activity from either the DOM listener or CM updates. */
	private noteScrollActivity(): void {
		if (this.source === "jump") {
			// Our own jump scroll — keep the lock, just re-arm the settle.
			this.armJumpSettle();
			return;
		}
		this.source = "viewport";
		this.schedule();
	}

	private armJumpSettle(): void {
		if (this.jumpSettleTimer !== 0) {
			this.win.clearTimeout(this.jumpSettleTimer);
		}
		this.jumpSettleTimer = this.win.setTimeout(() => {
			this.jumpSettleTimer = 0;
			this.releaseJump();
			this.schedule();
		}, JUMP_SETTLE_MS);
	}

	/** Back to a passive source; the viewport now shows the jump target. */
	private releaseJump(): void {
		this.clearJumpTimers();
		if (this.source === "jump") this.source = "viewport";
		this.jumpKey = null;
	}

	private clearJumpTimers(): void {
		if (this.jumpSettleTimer !== 0) {
			this.win.clearTimeout(this.jumpSettleTimer);
			this.jumpSettleTimer = 0;
		}
		if (this.jumpMaxTimer !== 0) {
			this.win.clearTimeout(this.jumpMaxTimer);
			this.jumpMaxTimer = 0;
		}
	}

	/** Request a recomputation on the next animation frame. */
	schedule(): void {
		if (this.disposed || this.rafId !== 0) return;
		this.rafId = this.win.requestAnimationFrame(() => {
			this.rafId = 0;
			this.compute();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.clearJumpTimers();
		if (this.rafId !== 0) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.disposables.dispose();
	}

	private compute(): void {
		if (this.disposed) return;
		const key = this.computeKey();
		if (key !== this.activeKey) {
			this.activeKey = key;
			this.onChange(key);
		}
	}

	private computeKey(): string | null {
		if (this.items.length === 0) return null;
		if (this.source === "jump" && this.jumpKey) return this.jumpKey;
		const index =
			this.view.getMode() === "preview"
				? this.computePreviewIndex()
				: this.source === "cursor"
					? this.computeCursorIndex()
					: this.computeEditorIndex();
		return index >= 0 && index < this.items.length
			? this.items[index].key
			: null;
	}

	/**
	 * Cursor rule: the selection HEAD line decides; the last heading at or
	 * above that line wins; before the first heading, the first heading is
	 * used (`selectActiveIndex` implements exactly this over line numbers).
	 */
	private computeCursorIndex(): number {
		try {
			const cursor = this.view.editor.getCursor("head");
			return selectActiveIndex(
				this.items.map((item) => item.line),
				cursor.line,
			);
		} catch {
			return this.computeEditorIndex();
		}
	}

	private computeEditorIndex(): number {
		const editor = this.view.editor;
		const cm = (editor as unknown as { cm?: CmViewLike }).cm;
		if (cm?.scrollDOM) {
			try {
				// All values in DOCUMENT space via the adapter — the
				// activation line and the heading tops must never mix
				// coordinate systems (P0-2).
				const adapter = new EditorPositionAdapter(cm);
				const activationY = adapter.activationLineDocument(ACTIVATION_RATIO);
				const lastLine = Math.max(0, editor.lineCount() - 1);
				const tops = this.items.map((item) => {
					const line = Math.min(item.line, lastLine);
					const offset = editor.posToOffset({ line, ch: 0 });
					return adapter.documentTopOfOffset(offset);
				});
				return selectActiveIndex(tops, activationY);
			} catch {
				// CM internals shifted — fall through to the line approximation.
			}
		}
		// Fallback: approximate with line numbers against the visible range.
		const scrollInfo = (
			editor as unknown as {
				getScrollInfo?: () => { top: number; clientHeight?: number };
			}
		).getScrollInfo?.();
		if (!scrollInfo) return 0;
		const lineHeightGuess = 24;
		const activationY =
			scrollInfo.top + (scrollInfo.clientHeight ?? 400) * ACTIVATION_RATIO;
		const tops = this.items.map((item) => item.line * lineHeightGuess);
		return selectActiveIndex(tops, activationY);
	}

	private computePreviewIndex(): number {
		const previewEl = this.view.contentEl.querySelector<HTMLElement>(
			".markdown-preview-view",
		);
		if (!previewEl) return 0;
		const rect = previewEl.getBoundingClientRect();
		const activationY = rect.top + previewEl.clientHeight * ACTIVATION_RATIO;
		const matches = matchPreviewHeadings(previewEl, this.items);
		if (matches.length === 0) return 0;
		let active = -1;
		for (const match of matches) {
			if (match.element.getBoundingClientRect().top <= activationY) {
				active = match.modelIndex;
			} else {
				break;
			}
		}
		return active === -1 ? matches[0].modelIndex : active;
	}
}
