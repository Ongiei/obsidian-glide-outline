import type { MarkdownView } from "obsidian";
import type { HeadingItem } from "../model/HeadingItem";
import { selectActiveIndex } from "../utils/geometry";
import { matchPreviewHeadings } from "../utils/previewHeadings";
import { DisposableStore } from "../utils/disposable";
import { EditorPositionAdapter } from "./EditorPositionAdapter";
import type { CmViewLike } from "./EditorPositionAdapter";
import type { EditorUpdateSummary } from "./EditorUpdateBridge";
import { OWNED_SELECTOR } from "../ui/mount";

/** Activation line sits at 20% of the viewport height. */
export const ACTIVATION_RATIO = 0.2;

/**
 * How the active heading was last determined (P0-2, hybrid model —
 * "the latest EXPLICIT user intent wins"):
 *  - "cursor":   the user moved the caret / clicked into the body / typed,
 *                or an editor jump settled (the caret now sits on the
 *                target heading). In editor modes a bare scroll does NOT
 *                demote it — only an EXPLICIT user scroll gesture (wheel,
 *                touch, paging keys, scrollbar / middle-button drag),
 *                consumed by the scroll it triggers, flips it to
 *                "viewport". Programmatic scrolls never do.
 *  - "viewport": scroll-following. Reading Mode's default; in editor modes
 *                before the first caret interaction, or after an explicit
 *                user scroll gesture takes over from the cursor.
 *  - "jump":     an outline heading was clicked; the target stays active
 *                while the jump scroll is in flight. A real caret move or
 *                an explicit user scroll gesture interrupts it.
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

/**
 * How long an armed viewport intent stays live waiting to be consumed by
 * the scroll it triggered (section §三). Long enough to bridge the
 * gesture→scroll gap (wheel/touch → scroll can lag a frame or two), short
 * enough that a gesture that never actually scrolled (e.g. a wheel at the
 * scroll edge) cannot later mis-attribute an unrelated programmatic scroll.
 */
export const VIEWPORT_INTENT_TTL_MS = 400;

/** Keys that count as explicit reading navigation (clear a preview focus). */
const READING_INTENT_KEYS = new Set([
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);

/**
 * An explicit user scroll intent, armed by a gesture and consumed by the
 * NEXT scroll / viewportChanged it produces (section §三). Only a consumed
 * intent may flip the editor source cursor→viewport; a bare scroll with no
 * armed intent (Outline jump, ScrollCorrector, setEphemeralState, editor
 * auto-reveal, mode/file switch, layout shift) never does.
 */
export type ViewportIntentKind =
	| "wheel"
	| "touch"
	| "paging-key"
	| "scrollbar"
	| "pointer-scroll";

interface PendingViewportIntent {
	kind: ViewportIntentKind;
	armedAt: number;
	expiresAt: number;
}

/**
 * Hybrid active-heading model (P0-2) — "the latest EXPLICIT user intent
 * wins". Priority when resolving the editor source (section §3.2):
 *   1. a new caret / selection change  → source "cursor"
 *   2. an outline jump lock            → source "jump"
 *   3. an EXPLICIT user viewport intent→ source "viewport"
 *   4. otherwise, keep the current source
 *   5. initial fallback (no interaction yet) → "viewport"
 *
 * Editor modes combine the sources like this:
 *   caret movement (CM `selectionSet`)         → source "cursor"
 *   scrolling BEFORE any caret interaction     → source "viewport"
 *   an EXPLICIT user scroll gesture (wheel /    → arms a viewport intent;
 *     touch / paging key / scrollbar /            the next scroll consumes
 *     middle-button drag) while on "cursor"       it → source "viewport"
 *   clicking an outline heading                → source "jump" (locked),
 *                                                settling into "cursor"
 *                                                (the jump moved the caret)
 * A bare scroll that consumes NO armed intent is treated as programmatic
 * (Outline jump, ScrollCorrector, setEphemeralState, editor auto-reveal,
 * mode/file switch, layout shift) and never changes the active heading:
 * this is why manual scrolling must be "armed" by a real gesture first.
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
	/** Armed explicit user scroll intent (section §三), or null. */
	private pendingViewportIntent: PendingViewportIntent | null = null;
	private viewportIntentTimer = 0;
	/** Lightweight source-attribution counters for diagnostics (§十六). */
	private readonly intentDiag = {
		armedCount: 0,
		consumedCount: 0,
		cursorToViewportCount: 0,
		jumpInterruptedCount: 0,
	};
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

		// Explicit user gestures. Two jobs (section §三):
		//   1. In EDITOR modes they arm a "viewport intent" that the next
		//      scroll consumes — the only way a bare scroll may flip the
		//      source cursor→viewport. Our own smooth jump / correction /
		//      ephemeral-state scrolls fire scroll events too, so scrolls
		//      alone can never be trusted as user intent.
		//   2. In READING mode they clear a post-jump focus hold.
		// All listeners are passive/capture and cheap no-ops otherwise.
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
		listen("wheel", (event) => this.onUserScrollGesture(event, "wheel"));
		listen("touchstart", (event) =>
			this.onUserScrollGesture(event, "touch"),
		);
		listen("touchmove", (event) =>
			this.onUserScrollGesture(event, "touch"),
		);
		listen("pointerdown", (event) => {
			// A body click that places the caret is NOT a scroll intent —
			// the cursor rule owns it. Only a scrollbar-gutter hit or a
			// middle-button autoscroll counts as an explicit scroll gesture.
			const kind = this.classifyPointerScroll(event as PointerEvent);
			if (kind) this.armViewportIntent(kind);
			this.onUserReadingIntent(event);
		});
		listen("keydown", (event) => {
			const key = (event as KeyboardEvent).key;
			if (!READING_INTENT_KEYS.has(key)) return;
			this.onUserScrollGesture(event, "paging-key");
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
		if (update.viewportChanged) {
			// A real scroll: may consume an armed viewport intent.
			this.noteScrollActivity();
			return;
		}
		if (update.geometryChanged) {
			// Layout shift / re-measure ONLY (no scroll): recompute under
			// the CURRENT source. It must never be treated as a user scroll
			// — no intent consumption, no cursor→viewport flip (section §三).
			this.schedule();
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
		this.clearViewportIntent();
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
	 * Hybrid model (P0-2, section §三): a scroll only ever flips the source
	 * when it CONSUMES an armed explicit user intent — a bare scroll with
	 * no armed intent is treated as programmatic (auto-reveal, corrector,
	 * ephemeral state, mode/file switch) and never steals the active state.
	 *   jump    → our own jump scroll re-arms the settle; an explicit user
	 *             scroll (armed intent) interrupts the jump → viewport.
	 *   focus   → Reading-Mode hold; cleared only by onUserReadingIntent
	 *             (which fires on the gesture itself, before this scroll).
	 *   cursor  → an armed intent flips it to viewport; otherwise sticky.
	 *   viewport→ keep following the viewport.
	 */
	private noteScrollActivity(): void {
		const intent = this.takeUserViewportIntent();
		if (this.source === "jump") {
			if (intent) {
				// An explicit user scroll during a jump means the user took
				// over navigation — break the lock and follow the viewport.
				this.intentDiag.jumpInterruptedCount++;
				this.breakToViewport();
				return;
			}
			// Our own jump scroll — keep the lock, just re-arm the settle.
			this.armJumpSettle();
			return;
		}
		if (this.source === "focus") {
			// Reading-Mode focus hold: released only by an explicit reading
			// interaction (handled synchronously on the gesture), never by
			// a scroll event — even one that happened to carry an intent.
			return;
		}
		if (this.source === "cursor") {
			if (intent) {
				// Latest explicit intent wins: the user scrolled the editor
				// without moving the caret → follow the viewport from here.
				this.intentDiag.cursorToViewportCount++;
				this.source = "viewport";
				this.schedule();
			}
			// No armed intent → programmatic scroll: sticky cursor.
			return;
		}
		// Already viewport-following.
		this.schedule();
	}

	/**
	 * Explicit user scroll gesture (section §三). In editor modes it arms a
	 * viewport intent that the next scroll consumes; in Reading Mode it also
	 * releases a post-jump focus hold. Gestures ON the outline rail are
	 * outline navigation, not scrolling, and never arm an intent.
	 */
	private onUserScrollGesture(event: Event, kind: ViewportIntentKind): void {
		if (this.disposed) return;
		const target = event.target as Partial<Element> | null;
		if (target?.closest?.(OWNED_SELECTOR)) return;
		this.armViewportIntent(kind);
		this.onUserReadingIntent(event);
	}

	/**
	 * Classify a pointerdown as a scroll gesture, or null when it is a
	 * caret placement / other interaction. Only a scrollbar-gutter hit or a
	 * middle-button (autoscroll) press counts — a primary-button body click
	 * is owned by the cursor rule and must NOT arm a viewport intent.
	 */
	private classifyPointerScroll(
		event: PointerEvent,
	): ViewportIntentKind | null {
		const target = event.target as Partial<Element> | null;
		if (target?.closest?.(OWNED_SELECTOR)) return null;
		if (event.button === 1) return "pointer-scroll";
		const el = event.target;
		if (el instanceof this.win.HTMLElement) {
			const scroller = el.closest<HTMLElement>(
				".cm-scroller, .markdown-preview-view",
			);
			if (scroller) {
				const rect = scroller.getBoundingClientRect();
				const onVScrollbar =
					event.clientX > rect.left + scroller.clientWidth;
				const onHScrollbar =
					event.clientY > rect.top + scroller.clientHeight;
				if (onVScrollbar || onHScrollbar) return "scrollbar";
			}
		}
		return null;
	}

	/** Arm an explicit viewport intent; auto-disarms after the TTL. */
	private armViewportIntent(kind: ViewportIntentKind): void {
		if (this.disposed) return;
		const now = this.nowMs();
		this.pendingViewportIntent = {
			kind,
			armedAt: now,
			expiresAt: now + VIEWPORT_INTENT_TTL_MS,
		};
		this.intentDiag.armedCount++;
		if (this.viewportIntentTimer !== 0) {
			this.win.clearTimeout(this.viewportIntentTimer);
		}
		this.viewportIntentTimer = this.win.setTimeout(() => {
			this.viewportIntentTimer = 0;
			this.pendingViewportIntent = null;
		}, VIEWPORT_INTENT_TTL_MS);
	}

	/** Consume the armed intent (if any), disarming it. */
	private takeUserViewportIntent(): PendingViewportIntent | null {
		const intent = this.pendingViewportIntent;
		if (!intent) return null;
		this.clearViewportIntent();
		this.intentDiag.consumedCount++;
		return intent;
	}

	private clearViewportIntent(): void {
		if (this.viewportIntentTimer !== 0) {
			this.win.clearTimeout(this.viewportIntentTimer);
			this.viewportIntentTimer = 0;
		}
		this.pendingViewportIntent = null;
	}

	/** Break any jump/focus lock and follow the viewport (section §三). */
	private breakToViewport(): void {
		this.clearJumpTimers();
		this.clearCursorGuard();
		this.jumpKey = null;
		this.focusKey = null;
		this.source = "viewport";
		this.schedule();
	}

	private nowMs(): number {
		const perf = this.win.performance;
		return perf && typeof perf.now === "function"
			? perf.now()
			: Date.now();
	}

	/** Snapshot of source-attribution counters for diagnostics (§十六). */
	getIntentDiagnostics(): {
		source: ActiveHeadingSource;
		pendingKind: ViewportIntentKind | null;
		armedCount: number;
		consumedCount: number;
		cursorToViewportCount: number;
		jumpInterruptedCount: number;
	} {
		return {
			source: this.source,
			pendingKind: this.pendingViewportIntent?.kind ?? null,
			armedCount: this.intentDiag.armedCount,
			consumedCount: this.intentDiag.consumedCount,
			cursorToViewportCount: this.intentDiag.cursorToViewportCount,
			jumpInterruptedCount: this.intentDiag.jumpInterruptedCount,
		};
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
		// Addressed by ownership attribute, not class name: a foreign node
		// carrying our class must not silence a real reading intent, and our
		// own nodes stay recognisable no matter how a theme re-skins them.
		const target = event.target as Partial<Element> | null;
		if (target?.closest?.(OWNED_SELECTOR)) return;
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
		// A real caret move is the highest-priority intent — disarm any
		// pending scroll intent so it cannot later flip to viewport.
		this.clearViewportIntent();
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
		this.clearViewportIntent();
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
