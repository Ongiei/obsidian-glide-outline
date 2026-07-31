import { Notice, Plugin } from "obsidian";
import type { Editor, MarkdownView, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { Diagnostics } from "./core/Diagnostics";
import { PerfCapture } from "./core/PerfCapture";
import { ColdStartTrace } from "./core/ColdStartTrace";
import { FULL_MOTION_STATE } from "./utils/motion";
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
	/** Shared interaction diagnostics (pointer activation + jump landing). */
	private readonly diagnostics = new Diagnostics();
	/** On-demand performance capture (section 3) — zero cost while off. */
	private readonly perf = new PerfCapture();
	/**
	 * §八/§九: one-shot cold-start trace. Non-null only for the single
	 * reload after the arm command ran; null (and therefore zero cost)
	 * otherwise.
	 */
	private coldStart: ColdStartTrace | null = null;

	override async onload(): Promise<void> {
		// §八: t0 — the FIRST thing onload does, before any await, so the
		// milestones are measured from the real start of the plugin's load.
		const coldStartAt = window.performance.now();
		this.settings = normalizeSettings(await this.loadData());
		this.maybeArmColdStart(coldStartAt);
		this.provider = new HeadingProvider(this.app);
		this.coldStart?.mark("providerReady");
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
				this.controller?.handleContextChange("file-change");
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.controller?.handleContextChange("mode-change");
			}),
		);
		this.coldStart?.mark("eventsRegistered");

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
		// Section 3: one-click Windows/macOS motion triage. Captures the OS
		// reduced-motion report, the chosen mode, the RESOLVED motion state
		// and the last pointer/jump interactions — enough to tell "motion
		// disabled by the OS" from "wrong heading" from "wrong drop point".
		this.addCommand({
			id: "copy-diagnostics",
			name: "Copy Glide Outline diagnostics",
			callback: async () => {
				await this.copyDiagnostics();
			},
		});
		// On-demand performance capture (perf spec section 3). Sampling is
		// NEVER always-on: hot paths check a plain boolean and every buffer
		// is a fixed-size ring. Start → interact → Stop copies the report.
		//
		// §三 two depths. LIGHT is the everyday capture — six clock reads a
		// frame, safe to leave running while judging smoothness. DEEP adds
		// the sub-phase breakdown and is only worth its own cost once LIGHT
		// has shown WHERE to look; every report states which mode produced
		// it and what that mode cost.
		// §七: the performance-capture and cold-start commands are gated
		// behind developer mode via checkCallback — hidden from the palette
		// entirely when the setting is off. `copy-diagnostics` above stays
		// ungated: it is end-user triage, not a developer tool.
		this.addCommand({
			id: "perf-capture-start",
			name: "Start Glide Outline performance capture (light)",
			checkCallback: (checking: boolean): boolean => {
				if (!this.settings.developerMode) return false;
				if (checking) return true;
				if (this.perf.active) {
					new Notice("Glide Outline: capture already running.");
					return true;
				}
				this.perf.start(window, "light");
				new Notice(
					"Glide Outline: light performance capture started. " +
						"Interact with the outline, then run the stop command.",
				);
				return true;
			},
		});
		this.addCommand({
			id: "perf-capture-start-deep",
			name: "Start Glide Outline performance capture (deep)",
			checkCallback: (checking: boolean): boolean => {
				if (!this.settings.developerMode) return false;
				if (checking) return true;
				if (this.perf.active) {
					new Notice("Glide Outline: capture already running.");
					return true;
				}
				this.perf.start(window, "deep");
				new Notice(
					"Glide Outline: DEEP performance capture started. " +
						"It samples every sub-phase and costs more per " +
						"frame — use it to localise, not to judge smoothness.",
				);
				return true;
			},
		});
		this.addCommand({
			id: "perf-capture-stop",
			name: "Stop and copy Glide Outline performance capture",
			checkCallback: (checking: boolean): boolean => {
				if (!this.settings.developerMode) return false;
				if (checking) return true;
				void this.stopAndCopyCapture();
				return true;
			},
		});
		// §八/§九: one-shot cold-start tracing. Arming persists a latch that
		// the next onload consumes; the copy command reads back whatever the
		// last consumed trace recorded.
		this.addCommand({
			id: "cold-start-arm",
			name: "Arm cold-start performance capture for next reload",
			checkCallback: (checking: boolean): boolean => {
				if (!this.settings.developerMode) return false;
				if (checking) return true;
				void this.armColdStartCapture();
				return true;
			},
		});
		this.addCommand({
			id: "cold-start-copy",
			name: "Copy latest cold-start performance report",
			checkCallback: (checking: boolean): boolean => {
				if (!this.settings.developerMode) return false;
				if (checking) return true;
				void this.copyColdStartReport();
				return true;
			},
		});
		this.coldStart?.mark("commandsRegistered");

		this.app.workspace.onLayoutReady(() => {
			this.coldStart?.mark("layoutReady");
			this.lifecycle.start();
			// Begin the post-load frame watch only once the outline has had
			// its first chance to mount.
			this.coldStart?.beginSettleWatch();
		});
		this.coldStart?.mark("onloadEnd");
	}

	override onunload(): void {
		// Never leave a longtask observer behind (section 3).
		if (this.perf.active) this.perf.stop(window);
		// §八: never leave the cold-start frame watch running.
		this.coldStart?.dispose();
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
		this.enforceDeveloperModeGate();
		this.refreshUi();
	}

	/**
	 * §七: developer mode gates the performance-capture machinery. Turning
	 * it off must not leave a capture — and its longtask observer — running
	 * in the background: any in-flight capture is abandoned and its samples
	 * discarded (never copied), because the user just asked for the tooling
	 * to go away. A no-op when developer mode is on or nothing is running.
	 */
	private enforceDeveloperModeGate(): void {
		if (this.settings.developerMode) return;
		if (this.perf.active) {
			this.perf.abort();
			new Notice(
				"Glide Outline: developer mode off — performance capture " +
					"stopped and discarded.",
			);
		}
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
			this.diagnostics,
			this.perf,
		);
	}

	/** §七: stop a running capture and copy its report to the clipboard. */
	private async stopAndCopyCapture(): Promise<void> {
		const report = this.perf.stop(window);
		if (!report) {
			new Notice("Glide Outline: no capture is running.");
			return;
		}
		await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
		new Notice("Glide Outline: performance report copied to clipboard.");
	}

	/**
	 * §八: consume the one-shot cold-start latch. If the previous session
	 * armed it, build the trace at the captured t0, record the first
	 * milestone and clear the latch immediately (persisting the clear) so
	 * the trace fires exactly once per arm — even if this onload throws
	 * later. When the latch is unset this does nothing and `coldStart`
	 * stays null, so an un-armed reload pays zero cost.
	 */
	private maybeArmColdStart(coldStartAt: number): void {
		if (!this.settings.coldStartCaptureArmed) return;
		this.coldStart = new ColdStartTrace(window, coldStartAt);
		this.coldStart.mark("settingsLoaded");
		this.settings.coldStartCaptureArmed = false;
		void this.saveData(this.settings);
	}

	/** §八: arm the one-shot cold-start latch and persist it immediately. */
	private async armColdStartCapture(): Promise<void> {
		this.settings.coldStartCaptureArmed = true;
		await this.saveData(this.settings);
		new Notice(
			"Glide Outline: cold-start capture armed. Reload Obsidian (or " +
				"toggle the plugin off and on) to record the next startup, " +
				"then run the copy command.",
		);
	}

	/** §九: copy the latest consumed cold-start trace to the clipboard. */
	private async copyColdStartReport(): Promise<void> {
		if (!this.coldStart) {
			new Notice(
				"Glide Outline: no cold-start report. Arm the capture and " +
					"reload first.",
			);
			return;
		}
		const report = this.coldStart.buildReport();
		await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
		new Notice("Glide Outline: cold-start report copied to clipboard.");
	}

	/**
	 * Build and copy the diagnostics JSON (section 3). Runs even when no
	 * outline is mounted — the OS motion report and settings alone already
	 * answer "why is nothing animating on Windows".
	 */
	private async copyDiagnostics(): Promise<void> {
		const systemReduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const s = this.settings;
		const payload = {
			timestamp: new Date().toISOString(),
			pluginVersion: this.manifest.version,
			platform: navigator.platform,
			userAgent: navigator.userAgent,
			systemPrefersReducedMotion: systemReduced,
			resolvedMotion: FULL_MOTION_STATE,
			settings: {
				enabled: s.enabled,
				position: s.position,
				markerStyle: s.markerStyle,
				maxScale: s.maxScale,
				radius: s.radius,
				cardGap: s.cardGap,
				pointerAutoScroll: s.pointerAutoScroll,
				pointerAutoScrollSpeed: s.pointerAutoScrollSpeed,
				pointerAutoScrollZone: s.pointerAutoScrollZone,
				pointerFollowEnabled: s.pointerFollowEnabled,
				edgeFadeEnabled: s.edgeFadeEnabled,
				edgeFadeSize: s.edgeFadeSize,
				showLevels: s.showLevels,
				renderMarkdown: s.renderMarkdown,
				developerMode: s.developerMode,
			},
			outline: this.controller?.getDiagnosticsSnapshot() ?? null,
			lastPointerActivation: this.diagnostics.lastPointerActivation,
			lastJump: this.diagnostics.lastJump,
			// §十: bounded ring of anomalous (> viewport height) scroll deltas.
			largeScrollDeltas: this.diagnostics.largeScrollDeltas,
		};
		await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
		new Notice("Glide Outline diagnostics copied to clipboard.");
	}

	private detachController(): void {
		this.controller?.dispose();
		this.controller = null;
	}
}
