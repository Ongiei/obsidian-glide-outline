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

/** Breathing room above a jumped-to heading, in px (editor modes). */
const JUMP_Y_MARGIN = 12;

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

	constructor(
		private readonly view: MarkdownView,
		private readonly provider: HeadingProvider,
		private readonly getSettings: () => GlideOutlineSettings,
		editorUpdates?: EditorUpdateBridge,
	) {
		this.renderComponent.load();
		this.outlineView = new GlideOutlineView(view.contentEl, getSettings, {
			onJump: (item) => this.jumpTo(item),
			renderLabel: (labelEl, item) => this.renderLabel(labelEl, item),
			// Row geometry re-measured → magnification cache is stale.
			// Optional chaining: fires before `magnification` exists too.
			onMetricsChanged: () => this.magnification?.invalidate(),
		});
		this.magnification = new MagnificationController(
			this.outlineView,
			getSettings,
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
		this.unsubscribeEditorUpdates?.();
		this.unsubscribeEditorUpdates = null;
		this.tracker.dispose();
		this.magnification.dispose();
		this.outlineView.dispose();
		this.renderComponent.unload();
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
		const settings = this.getSettings();
		const reduced = this.prefersReducedMotion();
		const behavior: ScrollBehavior =
			settings.animationEnabled && !reduced ? "smooth" : "auto";

		// P0-2/P0-3: lock the target active for the duration of the scroll
		// so intermediate headings never flicker active mid-flight.
		this.tracker.beginJump(item.key);

		if (this.view.getMode() === "preview") {
			this.jumpInPreview(item, behavior);
			return;
		}
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
		const cm = (editor as unknown as { cm?: CmView }).cm;
		if (cm && typeof cm.dispatch === "function") {
			try {
				const offset = editor.posToOffset({ line, ch: 0 });
				if (behavior === "smooth" && cm.scrollDOM) {
					this.smoothScrollEditor(cm, offset);
				} else {
					cm.dispatch({ effects: this.scrollEffect(offset) });
				}
				return;
			} catch {
				// CM internals shifted — fall through to the public API.
			}
		}
		editor.scrollIntoView(
			{ from: { line, ch: 0 }, to: { line, ch: 0 } },
			true,
		);
	}

	private scrollEffect(offset: number): StateEffect<unknown> {
		return EditorView.scrollIntoView(offset, {
			y: "start",
			yMargin: JUMP_Y_MARGIN,
		});
	}

	/**
	 * Animate toward the estimated position, then correct exactly (P0-3).
	 * The final dispatch is a no-op when the estimate was already right;
	 * for drifted estimates it snaps the heading to the intended margin.
	 */
	private smoothScrollEditor(cm: CmView, offset: number): void {
		const scroller = cm.scrollDOM;
		const top = Math.max(0, cm.lineBlockAt(offset).top - JUMP_Y_MARGIN);
		scroller.scrollTo({ top, behavior: "smooth" });
		const correct = (): void => {
			if (this.disposed) return;
			try {
				cm.dispatch({ effects: this.scrollEffect(offset) });
			} catch {
				// View detached mid-scroll — nothing left to correct.
			}
		};
		// scrollend ships in every Chromium Obsidian runs on; the timeout
		// covers exotic embeds. Either way the correction runs exactly once.
		if ("onscrollend" in scroller) {
			scroller.addEventListener("scrollend", correct, { once: true });
		} else {
			this.view.contentEl.ownerDocument.defaultView?.setTimeout(
				correct,
				600,
			);
		}
	}

	/**
	 * Reading-Mode jump (P0-4). Try the rendered element first (source-line
	 * or occurrence-aware match — repeated titles land on the RIGHT copy).
	 * Virtualized targets fall back to Obsidian's own line scrolling, then
	 * re-query on the next frame to correct onto the real element once the
	 * renderer has produced it.
	 */
	private jumpInPreview(item: HeadingItem, behavior: ScrollBehavior): void {
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
		return true;
	}

	private prefersReducedMotion(): boolean {
		const win = this.view.contentEl.ownerDocument.defaultView;
		return win?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
	}
}
