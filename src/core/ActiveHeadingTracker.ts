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
 * How the active heading was last determined (P0-2, unified model):
 *  - "cursor":   the user moved the caret / clicked into the body / typed,
 *                or an editor jump settled (the caret now sits on the
 *                target heading). In editor modes this is the PRIMARY
 *                source — scrolling alone never steals the active state.
 *  - "viewport": scroll-following. Reading Mode's default; editor modes
 *                only before the first caret interaction.
 *  - "jump":     an outline heading was clicked; the target stays active
 *                while the jump scroll is in flight.
 *  - "focus":    Reading Mode after a jump settled — the jumped-to heading
 *                stays active until an EXPLICIT user reading interaction
 *                (wheel, touch, pointerdown in the body, paging keys).
 *                Programmatic smooth scrolls never clear it.
 */
export type ActiveHeadingSource = "cursor" | "viewport" | "jump" | "focus";

/** Hard cap: a jump lock never outlives this, even if updates keep coming. */
export const JUMP_MAX_LOCK_MS = 1500;
/** A jump releases this long after the last scroll-driven update. */
export const JUMP_SETTLE_MS = 250;
/**
 * One-shot programmatic-cursor guard lifetime (section: editor jumps move
 * the caret). The guard is normally consumed by the very next
 * `selectionSet` (setCursor is dispatched synchronously right after the
 * jump starts); the timeout is only a safety net so a jump whose setCursor
 * never landed cannot leave a stale guard that later swallows a REAL user
 * caret move onto the same line.
 */
export const EDITOR_JUMP_GUARD_MS = 600;

/** Keys that count as explicit reading navigation (clear a preview focus). */
const READING_INTENT_KEYS = new Set([
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);

/**
 * Hybrid active-heading model (P0-2, unified).
 *
 * Editor modes combine the sources with explicit priority:
 *   caret movement (CM `selectionSet`)         → source "cursor"
 *   scrolling BEFORE any caret interaction     → source "viewport"
 *   clicking an outline heading                → source "jump" (locked),
 *                                                settling into "cursor"
 *                                                (the jump moved the caret)
 * Once the source is "cursor", `viewportChanged` / `geometryChanged` (and
 * DOM scrolls) do NOT flip it back to "viewport": manual scrolling without
 * a caret move never changes the active heading.
 *
 * Editor jumps move the caret programmatically. `beginEditorJump` arms a
 * ONE-SHOT selection guard with the expected line: the resulting
 * `selectionSet` whose caret line matches is consumed as our own dispatch
 * (jump lock stays); any other `selectionSet` is a real user interruption
 * and wins immediately. The guard is one-shot, expires on a short timeout,
 * is replaced by a newer jump and is cleaned up on release/dispose.
 *
 * Cursor rules (editor modes):
 *   caret on a heading line       → that heading
 *   caret in a body section       → nearest heading ABOVE
 *   caret before the first heading→ the first heading
 *   multi-line selection          → the selection HEAD line decides
 *
 * Reading Mode has no caret: it uses the viewport rule, jump locks, and a
 * post-jump "focus" hold — the jumped-to heading stays active after the
 * smooth scroll settles until the user explicitly reads elsewhere (wheel,
 * touch, pointerdown in the preview body, PageUp/PageDown/Home/End/Space).
 * Programmatic scrolls (smooth jump, ScrollCorrector, setEphemeralState)
 * never clear the focus.
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
	/** One-shot programmatic-cursor guard (editor jumps). */
	private cursorGuardLine: number | null = null;
	private cursorGuardTimer = 0;
	/** Reading-Mode focus hold: the heading a settled jump landed on. */
	private focusKey: string | null = null;
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

		// Explicit reading interactions (Reading Mode): these — and ONLY
		// these — clear a post-jump focus hold. Scroll events cannot be
		// used for that: our own smooth jump and correction scrolls fire
		// them too. All listeners are passive/capture and cheap no-ops
		// outside the focus/jump states.
		const listen = (
			type: string,
			handler: (event: Event) => void,
		): void => {
			view.contentEl.addEventListener(type, handler, {
				capture: true,
				passive: true,
			});
			this.disposables.add(() =>
				view.contentEl.removeEventListener(type, handler, {
					capture: true,
				}),
			);
		};
		listen("wheel", this.onUserReadingIntent);
		listen("touchstart", this.onUserReadingIntent);
		listen("touchmove", this.onUserReadingIntent);
		listen("pointerdown", this.onUserReadingIntent);
		listen("keydown", (event) => {
			const key = (event as KeyboardEvent).key;
			if (READING_INTENT_KEYS.has(key)) this.onUserReadingIntent(event);
		});
	}

	setItems(items: readonly HeadingItem[]): void {
		this.items = items;
		if (this.jumpKey && !items.some((item) => item.key === this.jumpKey)) {
			this.releaseJump();
		}
		// A held focus target that no longer exists cannot stay active.
		if (
			this.focusKey &&
			!items.some((item) => item.key === this.focusKey)
		) {
			this.focusKey = null;
			if (this.source === "focus") this.source = "viewport";
		}
		this.schedule();
	}

	getSource(): ActiveHeadingSource {
		return this.source;
	}

	/**
	 * CM update feed (P0-2). Priority: an explicit caret move beats a
	 * scroll; a scroll (without caret movement) never demotes "cursor";
	 * a jump in flight ignores its own scroll updates and its own
	 * programmatic setCursor (one-shot guard), and is released by any
	 * REAL caret move.
	 */
	handleEditorUpdate(update: EditorUpdateSummary): void {
		if (this.disposed) return;
		if (update.selectionSet) {
			if (this.cursorGuardLine !== null) {
				const line = this.currentCursorLine();
				const expected = this.cursorGuardLine;
				// One-shot: armed exactly once per editor jump, consumed
				// (or discarded) by the first selectionSet that arrives.
				this.clearCursorGuard();
				if (line !== null && line === expected) {
					// Our own setCursor dispatch — NOT a user interruption.
					// Keep the jump lock; the target stays active.
					if (this.source === "jump") this.armJumpSettle();
					return;
				}
			}
			// User moved the caret (click, keys, typing) — even during a
			// jump this is a new explicit interaction and wins immediately.
			this.interruptWithUserCursor();
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
		this.clearCursorGuard();
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

	/**
	 * Editor-mode jump: same lock as `beginJump`, plus a ONE-SHOT
	 * selection guard for the programmatic `setCursor({line, ch: 0})` the
	 * controller dispatches right after. A newer jump replaces any armed
	 * guard; a short timeout disarms a guard whose setCursor never landed.
	 */
	beginEditorJump(key: string, expectedLine: number): void {
		if (this.disposed) return;
		this.beginJump(key);
		this.cursorGuardLine = expectedLine;
		this.cursorGuardTimer = this.win.setTimeout(() => {
			this.cursorGuardTimer = 0;
			this.cursorGuardLine = null;
		}, EDITOR_JUMP_GUARD_MS);
	}

	/** Selection HEAD line, or null when the editor is unavailable. */
	private currentCursorLine(): number | null {
		try {
			return this.view.editor.getCursor("head").line;
		} catch {
			return null;
		}
	}

	/**
	 * Scroll-ish activity from either the DOM listener or CM updates.
	 * Unified model (P0-2):
	 *   jump    → our own scroll; keep the lock, re-arm the settle.
	 *   focus   → programmatic post-jump scroll (corrector, ephemeral
	 *             state); the hold is only cleared by EXPLICIT reading
	 *             interactions, never by scroll events.
	 *   cursor  → manual scrolling without a caret move never changes the
	 *             active heading in editor modes.
	 *   viewport→ keep following the viewport.
	 */
	private noteScrollActivity(): void {
		if (this.source === "jump") {
			// Our own jump scroll — keep the lock, just re-arm the settle.
			this.armJumpSettle();
			return;
		}
		if (this.source === "focus" || this.source === "cursor") return;
		this.schedule();
	}

	/**
	 * Explicit user reading interaction (wheel / touch / pointerdown /
	 * paging keys) inside the view content, but OUTSIDE the outline rail.
	 * In Reading Mode this releases a focus hold (or an in-flight jump)
	 * back to viewport-following — the only sanctioned way to do so.
	 */
	private onUserReadingIntent = (event: Event): void => {
		if (this.disposed) return;
		if (this.source !== "focus" && this.source !== "jump") return;
		if (this.view.getMode() !== "preview") return;
		// Interactions with the outline itself (e.g. pointerdown on a
		// heading card) are outline gestures, not reading — they begin a
		// new jump instead of demoting the current one.
		const target = event.target as Partial<Element> | null;
		if (target?.closest?.(".glide-outline-root")) return;
		this.clearJumpTimers();
		this.clearCursorGuard();
		this.jumpKey = null;
		this.focusKey = null;
		this.source = "viewport";
		this.schedule();
	};

	/** A real user caret move: clears jump lock, guard and focus hold. */
	private interruptWithUserCursor(): void {
		this.clearJumpTimers();
		this.clearCursorGuard();
		this.jumpKey = null;
		this.focusKey = null;
		this.source = "cursor";
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

	/**
	 * Jump settled (or its target vanished). Where the source lands is
	 * mode-dependent (unified model):
	 *   Reading Mode → "focus": the target holds until an explicit user
	 *                  reading interaction.
	 *   Editor modes → "cursor": the jump moved the caret onto the
	 *                  heading line, so the cursor rule keeps the target
	 *                  active. NEVER "viewport" — a settled jump must not
	 *                  hand the active state to scroll-following.
	 */
	private releaseJump(): void {
		this.clearJumpTimers();
		this.clearCursorGuard();
		if (this.source === "jump") {
			if (this.view.getMode() === "preview" && this.jumpKey) {
				this.focusKey = this.jumpKey;
				this.source = "focus";
			} else {
				this.source = "cursor";
			}
		}
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

	private clearCursorGuard(): void {
		if (this.cursorGuardTimer !== 0) {
			this.win.clearTimeout(this.cursorGuardTimer);
			this.cursorGuardTimer = 0;
		}
		this.cursorGuardLine = null;
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
		this.clearCursorGuard();
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
		if (this.source === "focus" && this.focusKey) return this.focusKey;
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
