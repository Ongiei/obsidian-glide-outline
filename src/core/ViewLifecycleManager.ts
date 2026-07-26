import { MarkdownView } from "obsidian";
import type { Plugin } from "obsidian";

export interface ViewLifecycleCallbacks {
	onAttach(view: MarkdownView): void;
	onDetach(view: MarkdownView): void;
}

/**
 * Tracks which MarkdownView the outline should live in.
 *
 * First version: the outline follows the *active* Markdown leaf only.
 * Switching to a non-Markdown leaf detaches immediately; switching between
 * Markdown leaves detaches the old instance before attaching the new one.
 */
export class ViewLifecycleManager {
	private current: MarkdownView | null = null;
	private started = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly callbacks: ViewLifecycleCallbacks,
	) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		const { workspace } = this.plugin.app;
		this.plugin.registerEvent(
			workspace.on("active-leaf-change", () => this.sync()),
		);
		this.plugin.registerEvent(workspace.on("layout-change", () => this.sync()));
		this.sync();
	}

	get currentView(): MarkdownView | null {
		return this.current;
	}

	sync(): void {
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView) ?? null;
		if (view === this.current) return;
		this.detach();
		this.current = view;
		if (view) this.callbacks.onAttach(view);
	}

	/** Force detach + reattach (used when settings toggle the outline). */
	refresh(): void {
		const view = this.current;
		this.detach();
		this.current =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView) ?? view;
		if (this.current) this.callbacks.onAttach(this.current);
	}

	detach(): void {
		if (this.current) {
			this.callbacks.onDetach(this.current);
			this.current = null;
		}
	}
}
