import { Plugin } from "obsidian";
import type { Editor, MarkdownView, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	GlideOutlineSettingTab,
	normalizeSettings,
} from "./settings";
import type { GlideOutlineSettings } from "./settings";
import { HeadingProvider } from "./core/HeadingProvider";
import { GlideOutlineController } from "./core/GlideOutlineController";
import { ViewLifecycleManager } from "./core/ViewLifecycleManager";

/** Debounce for slider-driven settings persistence (Phase 8). */
const SAVE_DEBOUNCE_MS = 250;

/**
 * Plugin entry point: settings, commands and module assembly only.
 * All behaviour lives in the core / ui modules.
 */
export default class GlideOutlinePlugin extends Plugin {
	override settings: GlideOutlineSettings = { ...DEFAULT_SETTINGS };
	private provider!: HeadingProvider;
	private lifecycle!: ViewLifecycleManager;
	private controller: GlideOutlineController | null = null;
	private saveTimer = 0;

	override async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.provider = new HeadingProvider(this.app);
		this.addSettingTab(new GlideOutlineSettingTab(this.app, this));

		this.lifecycle = new ViewLifecycleManager(this, {
			onAttach: (view) => this.attachTo(view),
			onDetach: () => this.detachController(),
		});

		this.registerEvent(
			this.app.workspace.on("editor-change", (editor: Editor, info) => {
				this.controller?.handleEditorChange(editor, info);
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file: TFile) => {
				this.controller?.handleMetadataChanged(file);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.controller?.handleContextChange();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.controller?.handleContextChange();
			}),
		);

		// Command names deliberately avoid the plugin name and the word
		// "command" — Obsidian already prefixes them with "Glide Outline:".
		this.addCommand({
			id: "toggle",
			name: "Toggle outline",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.applySettings();
			},
		});
		this.addCommand({
			id: "move-to-opposite-side",
			name: "Move outline to opposite side",
			callback: async () => {
				this.settings.position =
					this.settings.position === "right" ? "left" : "right";
				await this.applySettings();
			},
		});

		this.app.workspace.onLayoutReady(() => this.lifecycle.start());
	}

	override onunload(): void {
		if (this.saveTimer !== 0) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = 0;
			// Flush a pending debounced save so slider changes are not lost.
			void this.saveData(normalizeSettings(this.settings));
		}
		this.lifecycle.detach();
	}

	/** Persist settings immediately and refresh the mounted outline. */
	async applySettings(): Promise<void> {
		if (this.saveTimer !== 0) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = 0;
		}
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
		this.refreshUi();
	}

	/**
	 * Slider-friendly variant (Phase 8): the UI updates on every tick while
	 * disk writes are debounced, so dragging a slider does not hammer
	 * `saveData` dozens of times per second.
	 */
	previewSettings(): void {
		this.settings = normalizeSettings(this.settings);
		this.refreshUi();
		if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = 0;
			void this.saveData(this.settings);
		}, SAVE_DEBOUNCE_MS);
	}

	private refreshUi(): void {
		if (!this.settings.enabled) {
			this.lifecycle.detach();
			return;
		}
		if (this.controller) {
			this.controller.applySettings();
		} else {
			this.lifecycle.refresh();
		}
	}

	private attachTo(view: MarkdownView): void {
		if (!this.settings.enabled) return;
		this.detachController();
		this.controller = new GlideOutlineController(
			view,
			this.provider,
			() => this.settings,
		);
	}

	private detachController(): void {
		this.controller?.dispose();
		this.controller = null;
	}
}
