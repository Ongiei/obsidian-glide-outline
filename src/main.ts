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

/**
 * Plugin entry point: settings, commands and module assembly only.
 * All behaviour lives in the core / ui modules.
 */
export default class GlideOutlinePlugin extends Plugin {
	override settings: GlideOutlineSettings = { ...DEFAULT_SETTINGS };
	private provider!: HeadingProvider;
	private lifecycle!: ViewLifecycleManager;
	private controller: GlideOutlineController | null = null;

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

		this.addCommand({
			id: "toggle",
			name: "Toggle Glide Outline",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.applySettings();
			},
		});
		this.addCommand({
			id: "move-to-opposite-side",
			name: "Move Glide Outline to opposite side",
			callback: async () => {
				this.settings.position =
					this.settings.position === "right" ? "left" : "right";
				await this.applySettings();
			},
		});

		this.app.workspace.onLayoutReady(() => this.lifecycle.start());
	}

	override onunload(): void {
		this.lifecycle.detach();
	}

	/** Persist settings and refresh the mounted outline immediately. */
	async applySettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
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
