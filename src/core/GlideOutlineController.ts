import { Component, MarkdownRenderer } from "obsidian";
import type { Editor, MarkdownView, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import type { StateEffect } from "@codemirror/state";
import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";
import { HeadingProvider } from "./HeadingProvider";
import { ActiveHeadingTracker } from "./ActiveHeadingTracker";
import type { EditorUpdateBridge } from "./EditorUpdateBridge";
import { GlideOutlineView } from "../ui/GlideOutlineView";
import { MagnificationController } from "../ui/MagnificationController";
import { sameHeadingKeys } from "../utils/headingIdentity";
import { matchPreviewHeadings } from "../utils/previewHeadings";
import { FULL_MOTION_STATE } from "../utils/motion";
import { ScrollCorrector } from "./ScrollCorrector";
import type { Diagnostics } from "./Diagnostics";
import type { PerfCapture } from "./PerfCapture";

/** Breathing room above a jumped-to heading, in px (editor modes). */
const JUMP_Y_MARGIN = 12;
/** Acceptable final landing error after a jump, px (section 12: 2–4). */
const JUMP_TOLERANCE_PX = 3;
/** Max correction passes per jump — never loops on pathological layouts. */
const JUMP_MAX_CORRECTIONS = 3;
/** Settle-timeout fallback when `scrollend` never fires (600–800 ms). */
const JUMP_SETTLE_TIMEOUT_MS = 700;

/** Minimal CM surface for jump scrolling (accessed defensively). */
interface CmView {
	scrollDOM: HTMLElement;
	lineBlockAt(pos: number): { top: number; height: number };
	dispatch(spec: { effects: StateEffect<unknown> }): void;
}

/**
 * Per-MarkdownView orchestrator. Wires heading data (dual channel),
 * active-heading tracking, the margin rail view and magnification together.
 * The instance lives exactly as long as the outline is mounted in one view.
 */
export class GlideOutlineController {
	private readonly outlineView: GlideOutlineView;
	private readonly tracker: ActiveHeadingTracker;
	private readonly magnification: MagnificationController;
	/** Owns the lifecycle of rendered Markdown labels (Phase 7). */
	private readonly renderComponent = new Component();
	private items: HeadingItem[] = [];
	private disposed = false;
	private unsubscribeEditorUpdates: (() => void) | null = null;
	/** In-flight editor jump correction; a new jump cancels the old one. */
	private corrector: ScrollCorrector | null = null;

	constructor(
		private readonly view: MarkdownView,
		private readonly provider: HeadingProvider,
		private readonly getSettings: () => GlideOutlineSettings,
		editorUpdates?: EditorUpdateBridge,
		private readonly diagnostics: Diagnostics | null = null,
		/** On-demand perf capture (section 3); shared with magnification. */
		private readonly perf: PerfCapture | null = null,
	) {
		this.renderComponent.load();
		this.outlineView = new GlideOutlineView(view.contentEl, getSettings, {
			// Keyboard activation (Enter / Space, event.detail === 0).
			onJump: (item) => this.jumpTo(item),
			renderLabel: (labelEl, item) => this.renderLabel(labelEl, item),
			// Row geometry re-measured → magnification cache is stale.
			// Optional chaining: fires before `magnification` exists too.
			onMetricsChanged: () => this.magnification?.invalidate(),
		});
		this.magnification = new MagnificationController(
			this.outlineView,
			getSettings,
			this.diagnostics,
			// Pointer activation (pointerup lock, section 9/10).
			(item) => this.jumpTo(item),
			this.perf,
		);
		this.tracker = new ActiveHeadingTracker(view, (key) =>
			this.outlineView.setActiveKey(key),
		);
		// P0-2: consume the workspace-wide CM update feed, but only the
		// updates that belong to THIS view's editor (identity check).
		if (editorUpdates) {
			this.unsubscribeEditorUpdates = editorUpdates.subscribe((update) => {
				if (this.disposed) return;
				const cm = (this.view.editor as unknown as { cm?: unknown }).cm;
				if (!cm || update.view !== cm) return;
				this.tracker.handleEditorUpdate(update);
			});
		}
		this.refreshFromCache();
	}

	/** Authoritative channel: metadata cache. */
	refreshFromCache(): void {
		if (this.disposed) return;
		const file = this.view.file;
		if (!file) {
			this.setItems([]);
			return;
		}
		this.setItems(this.provider.fromCache(file));
	}

	/** Live channel: parse the current editor text immediately. */
	refreshFromEditor(): void {
		if (this.disposed) return;
		this.setItems(this.provider.fromText(this.view.editor.getValue()));
	}

	handleEditorChange(editor: Editor, info: unknown): void {
		if (this.disposed) return;
		if (info !== this.view && editor !== this.view.editor) return;
		this.refreshFromEditor();
	}

	handleMetadataChanged(file: TFile): void {
		if (this.disposed) return;
		if (file.path !== this.view.file?.path) return;
		this.refreshFromCache();
	}

	/** Same view, different file (file-open) or mode switch (layout-change). */
	handleContextChange(): void {
		if (this.disposed) return;
		this.refreshFromCache();
		this.tracker.schedule();
	}

	applySettings(): void {
		if (this.disposed) return;
		this.outlineView.applySettings();
		// Level filter may have changed — re-render from the full model.
		this.outlineView.setItems(this.items);
		this.magnification.invalidate();
		this.tracker.setItems(this.outlineView.getItems());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.corrector?.dispose();
		this.corrector = null;
		this.unsubscribeEditorUpdates?.();
		this.unsubscribeEditorUpdates = null;
		this.tracker.dispose();
		this.magnification.dispose();
		this.outlineView.dispose();
		this.renderComponent.unload();
	}

	/** Live snapshot for the "Copy Glide Outline diagnostics" command. */
	getDiagnosticsSnapshot(): Record<string, unknown> {
		return {
			viewMode: this.view.getMode(),
			filePath: this.view.file?.path ?? null,
			headingCount: this.items.length,
			visibleHeadingCount: this.outlineView.getItems().length,
			systemPrefersReducedMotion: this.prefersReducedMotion(),
			resolvedMotion: FULL_MOTION_STATE,
			rootClasses: this.outlineView.getRootClassList(),
			outlineViewport: this.outlineView.getViewportMetrics(),
			overflow: this.outlineView.getOverflowState(),
		};
	}

	/**
	 * Render inline Markdown into a label element (Phase 7).
	 * Falls back to plain text when rendering fails for any reason.
	 */
	private renderLabel(labelEl: HTMLElement, item: HeadingItem): void {
		const sourcePath = this.view.file?.path ?? "";
		MarkdownRenderer.render(
			this.view.app,
			item.displaySource,
			labelEl,
			sourcePath,
			this.renderComponent,
		).catch(() => {
			labelEl.textContent = item.text;
		});
	}

	private setItems(items: HeadingItem[]): void {
		const keysChanged = !sameHeadingKeys(items, this.items);
		this.items = items;
		// Always push to the view: even when identities are unchanged, line
		// numbers may have shifted (view stores them for jumps via the model).
		this.outlineView.setItems(items);
		this.tracker.setItems(this.outlineView.getItems());
		if (keysChanged) this.magnification.invalidate();
	}

	private jumpTo(item: HeadingItem): void {
		if (this.disposed) return;
		// Motion is always full — smooth jumps everywhere.
		const behavior: ScrollBehavior = FULL_MOTION_STATE.smoothJump
			? "smooth"
			: "auto";

		if (this.view.getMode() === "preview") {
			// P0-2/P0-3: lock the target active for the duration of the
			// scroll so intermediate headings never flicker active.
			this.tracker.beginJump(item.key);
			this.jumpInPreview(item, behavior);
			return;
		}
		// Editor modes: the jump moves the cursor too, so the tracker arms a
		// one-shot cursor guard (the programmatic selectionSet must not be
		// mistaken for a user cursor move). Armed inside jumpInEditor where
		// the clamped target line is known.
		this.jumpInEditor(item, behavior);
	}

	/**
	 * Editor-mode jump (P0-3). The CM6 `scrollIntoView` effect is the only
	 * primitive that is EXACT for virtualized documents: positions below
	 * the measured viewport are estimates, and CM resolves the effect
	 * inside its own measure cycle. `scrollDOM.scrollTo` on a raw
	 * `lineBlockAt().top` (the old code) can land hundreds of px off in
	 * long documents.
	 *
	 * Smooth mode animates toward the current estimate first, then
	 * dispatches the exact effect once the animation settles.
	 */
	private jumpInEditor(item: HeadingItem, behavior: ScrollBehavior): void {
		const editor = this.view.editor;
		const line = Math.min(item.line, Math.max(0, editor.lineCount() - 1));
		// Section 5/6: clicking an outline item moves the cursor to the
		// heading line and focuses the editor. The jump lock + cursor guard
		// are armed FIRST so the resulting selectionSet is recognized as
		// programmatic and does not interrupt the jump.
		this.tracker.beginEditorJump(item.key, line);
		try {
			editor.setCursor({ line, ch: 0 });
			editor.focus();
		} catch {
			// Editor detached mid-jump — scrolling below is still safe.
		}
		const cm = (editor as unknown as { cm?: CmView }).cm;
		if (cm && typeof cm.dispatch === "function" && cm.scrollDOM) {
			try {
				const offset = editor.posToOffset({ line, ch: 0 });
				this.startEditorCorrection(item, cm, offset, behavior);
				return;
			} catch {
				// CM internals shifted — fall through to the public API.
			}
		}
		editor.scrollIntoView(
			{ from: { line, ch: 0 }, to: { line, ch: 0 } },
			true,
		);
		this.diagnostics?.recordJump({
			headingKey: item.key,
			headingText: item.text,
			expectedLine: line,
			mode: "editor",
			behavior: behavior === "smooth" ? "smooth" : "auto",
			correctionCount: 0,
		});
	}

	private scrollEffect(offset: number): StateEffect<unknown> {
		return EditorView.scrollIntoView(offset, {
			y: "start",
			yMargin: JUMP_Y_MARGIN,
		});
	}

	/**
	 * Corrected editor jump (section 12). Smooth mode animates toward the
	 * current estimate first; auto mode dispatches the exact effect right
	 * away. Either way a ScrollCorrector verifies the landing position
	 * after the scroll settles (scrollend AND a 600–800 ms timeout
	 * fallback — whichever fires first), re-corrects while the error
	 * exceeds the tolerance, and stops at the correction cap. The final
	 * error and pass count are recorded for the diagnostics command, which
	 * is how a "wrong drop point" is told apart from a "wrong heading".
	 */
	private startEditorCorrection(
		item: HeadingItem,
		cm: CmView,
		offset: number,
		behavior: ScrollBehavior,
	): void {
		this.corrector?.dispose();
		this.corrector = null;
		const scroller = cm.scrollDOM;
		const win = this.view.contentEl.ownerDocument.defaultView as
			| (Window & typeof globalThis)
			| null;
		const smooth = behavior === "smooth";
		if (!win) {
			// Detached document — no timers available; jump uncorrected.
			cm.dispatch({ effects: this.scrollEffect(offset) });
			return;
		}
		if (smooth) {
			// Animate toward the current estimate; the corrector waits for
			// the animation to settle before dispatching the exact effect,
			// so the animation is never cancelled mid-flight.
			const top = Math.max(0, cm.lineBlockAt(offset).top - JUMP_Y_MARGIN);
			scroller.scrollTo({ top, behavior: "smooth" });
		}
		const corrector = new ScrollCorrector({
			tolerance: JUMP_TOLERANCE_PX,
			maxCorrections: JUMP_MAX_CORRECTIONS,
			timeoutMs: JUMP_SETTLE_TIMEOUT_MS,
			// Signed landing error, clamped to the reachable scroll range so
			// a heading near the document bottom is not a false failure.
			measureError: () => {
				try {
					const desired = Math.max(
						0,
						Math.min(
							cm.lineBlockAt(offset).top - JUMP_Y_MARGIN,
							scroller.scrollHeight - scroller.clientHeight,
						),
					);
					return scroller.scrollTop - desired;
				} catch {
					return 0; // view detached — report "landed"
				}
			},
			apply: () => {
				if (this.disposed) return;
				try {
					cm.dispatch({ effects: this.scrollEffect(offset) });
				} catch {
					// View detached mid-scroll — nothing left to correct.
				}
			},
			done: (finalErrorPx, correctionCount) => {
				if (this.corrector === corrector) this.corrector = null;
				this.diagnostics?.recordJump({
					headingKey: item.key,
					headingText: item.text,
					expectedLine: item.line,
					mode: "editor",
					behavior: smooth ? "smooth" : "auto",
					finalErrorPx,
					correctionCount,
				});
			},
			win,
			scroller,
			smoothFirst: smooth,
		});
		this.corrector = corrector;
		corrector.start();
	}

	/**
	 * Reading-Mode jump (P0-4). Try the rendered element first (source-line
	 * or occurrence-aware match — repeated titles land on the RIGHT copy).
	 * Virtualized targets fall back to Obsidian's own line scrolling, then
	 * re-query on the next frame to correct onto the real element once the
	 * renderer has produced it.
	 */
	private jumpInPreview(item: HeadingItem, behavior: ScrollBehavior): void {
		this.diagnostics?.recordJump({
			headingKey: item.key,
			headingText: item.text,
			expectedLine: item.line,
			mode: "preview",
			behavior: behavior === "smooth" ? "smooth" : "auto",
			correctionCount: 0,
		});
		if (this.scrollPreviewToItem(item, behavior)) return;
		this.view.setEphemeralState({ line: item.line });
		const win = this.view.contentEl.ownerDocument.defaultView;
		win?.requestAnimationFrame(() => {
			if (this.disposed) return;
			this.scrollPreviewToItem(item, "auto");
		});
	}

	/** @returns true when the heading's element existed and was scrolled to. */
	private scrollPreviewToItem(
		item: HeadingItem,
		behavior: ScrollBehavior,
	): boolean {
		const previewEl = this.view.contentEl.querySelector<HTMLElement>(
			".markdown-preview-view",
		);
		if (!previewEl) return false;
		const modelIndex = this.items.indexOf(item);
		if (modelIndex < 0) return false;
		const match = matchPreviewHeadings(previewEl, this.items).find(
			(entry) => entry.modelIndex === modelIndex,
		);
		if (!match) return false;
		match.element.scrollIntoView({ behavior, block: "start" });
		this.focusPreviewHeading(match.element);
		return true;
	}

	/**
	 * Section 7: after a Reading-Mode jump the heading element receives
	 * real DOM focus (screen readers / keyboard users get a sensible
	 * position). Headings are not focusable by default, so a temporary
	 * `tabindex="-1"` is added and restored on blur — the tab order is
	 * never permanently altered. `preventScroll` keeps the smooth scroll
	 * already in flight untouched.
	 */
	private focusPreviewHeading(element: HTMLElement): void {
		const hadTabindex = element.hasAttribute("tabindex");
		if (!hadTabindex) element.setAttribute("tabindex", "-1");
		try {
			element.focus({ preventScroll: true });
		} catch {
			// Older environments without options support — best effort.
			try {
				element.focus();
			} catch {
				/* detached element — ignore */
			}
		}
		if (!hadTabindex) {
			element.addEventListener(
				"blur",
				() => element.removeAttribute("tabindex"),
				{ once: true },
			);
		}
	}

	private prefersReducedMotion(): boolean {
		const win = this.view.contentEl.ownerDocument.defaultView;
		return win?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
	}
}
