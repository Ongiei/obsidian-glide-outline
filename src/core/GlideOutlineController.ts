import { Component, MarkdownRenderer } from "obsidian";
import type { Editor, MarkdownView, TFile } from "obsidian";
import type { HeadingItem } from "../model/HeadingItem";
import type { GlideOutlineSettings } from "../settings";
import { HeadingProvider } from "./HeadingProvider";
import { ActiveHeadingTracker } from "./ActiveHeadingTracker";
import { GlideOutlineView } from "../ui/GlideOutlineView";
import { MagnificationController } from "../ui/MagnificationController";
import { sameHeadingKeys } from "../utils/headingIdentity";
import { matchPreviewHeadings } from "../utils/previewHeadings";

/** Minimal CM surface for smooth jump scrolling (accessed defensively). */
interface CmView {
	scrollDOM: HTMLElement;
	lineBlockAt(pos: number): { top: number; height: number };
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

	constructor(
		private readonly view: MarkdownView,
		private readonly provider: HeadingProvider,
		private readonly getSettings: () => GlideOutlineSettings,
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

		if (this.view.getMode() === "preview") {
			this.jumpInPreview(item, behavior);
			return;
		}
		this.jumpInEditor(item, behavior);
	}

	private jumpInEditor(item: HeadingItem, behavior: ScrollBehavior): void {
		const editor = this.view.editor;
		const line = Math.min(item.line, Math.max(0, editor.lineCount() - 1));
		const cm = (editor as unknown as { cm?: CmView }).cm;
		if (cm?.scrollDOM) {
			try {
				const offset = editor.posToOffset({ line, ch: 0 });
				const top = cm.lineBlockAt(offset).top;
				cm.scrollDOM.scrollTo({ top: Math.max(0, top - 12), behavior });
				return;
			} catch {
				// fall through to the public API
			}
		}
		editor.scrollIntoView(
			{ from: { line, ch: 0 }, to: { line, ch: 0 } },
			true,
		);
	}

	private jumpInPreview(item: HeadingItem, behavior: ScrollBehavior): void {
		const previewEl = this.view.contentEl.querySelector<HTMLElement>(
			".markdown-preview-view",
		);
		if (previewEl) {
			const matches = matchPreviewHeadings(previewEl, this.items);
			const modelIndex = this.items.indexOf(item);
			const match = matches.find((entry) => entry.modelIndex === modelIndex);
			if (match) {
				match.element.scrollIntoView({ behavior, block: "start" });
				return;
			}
		}
		// Element not rendered (virtualized) — let Obsidian scroll by line.
		this.view.setEphemeralState({ line: item.line });
	}

	private prefersReducedMotion(): boolean {
		const win = this.view.contentEl.ownerDocument.defaultView;
		return win?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
	}
}
