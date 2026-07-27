import { Plugin } from "obsidian";
import type { Editor, MarkdownView, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
	DEFAULT_SETTINGS,
	GlideOutlineSettingTab,
	normalizeSettings,
	normalizeSettingsInPlace,
} from "./settings";
import type { GlideOutlineSettings } from "./settings";
import { HeadingProvider } from "./core/HeadingProvider";
import { GlideOutlineController } from "./core/GlideOutlineController";
import { ViewLifecycleManager } from "./core/ViewLifecycleManager";
import {
	EditorUpdateBridge,
	summarizeViewUpdate,
} from "./core/EditorUpdateBridge";

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
	/** ONE workspace-wide CM update feed, fanned out per view (P0-2). */
	private readonly editorUpdates = new EditorUpdateBridge();

	override async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.provider = new HeadingProvider(this.app);
		this.addSettingTab(new GlideOutlineSettingTab(this.app, this));

		// P0-2: a single updateListener for every editor in the workspace.
		// Summaries flow through the bridge; controllers filter by identity.
		this.registerEditorExtension(
			EditorView.updateListener.of((update) => {
				this.editorUpdates.dispatch(summarizeViewUpdate(update));
			}),
		);

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

	/**
	 * UNIFIED settings pipeline. Every mutation — toggle, dropdown, slider,
	 * command — flows through exactly one sequence:
	 *
	 *   1. normalize IN PLACE (identity-preserving: settings-tab closures,
	 *      the controller's getter and the views all keep the same object)
	 *   2. apply to the mounted outline immediately (visual preview)
	 *   3. persist (immediately for applySettings, debounced for
	 *      previewSettings so slider drags do not hammer saveData)
	 *
	 * The old code did `this.settings = normalizeSettings(this.settings)`,
	 * which SWAPPED the object identity on the first change — every later
	 * onChange closure wrote into a dead copy, producing the classic
	 * "change it twice before it sticks" bug.
	 */
	async applySettings(): Promise<void> {
		this.applySettingsImmediately();
		await this.flushPendingSettingsSave();
	}

	/** Slider-friendly variant: immediate visuals, debounced persistence. */
	previewSettings(): void {
		this.applySettingsImmediately();
		this.schedulePersistSettings();
	}

	/** Steps 1 + 2: normalize in place and refresh the mounted outline. */
	private applySettingsImmediately(): void {
		normalizeSettingsInPlace(this.settings);
		this.refreshUi();
	}

	private schedulePersistSettings(): void {
		if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = 0;
			void this.saveData(this.settings);
		}, SAVE_DEBOUNCE_MS);
	}

	/** Cancel any debounce and write the current settings to disk now. */
	private async flushPendingSettingsSave(): Promise<void> {
		if (this.saveTimer !== 0) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = 0;
		}
		await this.saveData(this.settings);
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
			this.editorUpdates,
		);
	}

	private detachController(): void {
		this.controller?.dispose();
		this.controller = null;
	}
}
