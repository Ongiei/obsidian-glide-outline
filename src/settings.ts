import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type GlideOutlinePlugin from "./main";
import { OWNER_ATTR, OWNER_VALUE } from "./ui/mount";

export type OutlinePosition = "left" | "right";
export type MarkerStyle = "line" | "dot";
/**
 * How heading depth is displayed next to the label.
 * Structured as an enum (not a boolean) so future styles — numbers,
 * ticks, roman numerals — can be added without another migration.
 */
export type LevelIndicatorStyle = "none" | "badge";

/**
 * Visual style of the label card behind each heading.
 * The former `textEffect` (halo) member was removed for the first
 * release: persisted `textEffect` / `textShadow` fields of any
 * generation are silently ignored by `normalizeCard`.
 */
export interface LabelAppearanceSettings {
	/** Card background opacity in percent (0 = pure text mode). */
	opacity: number;
	/** Draw a subtle border around the card. */
	border: boolean;
	/** Corner radius in px. */
	radius: number;
	/** Drop shadow under the card. */
	shadow: boolean;
	/** Horizontal padding in px. */
	paddingX: number;
	/** Vertical padding in px. */
	paddingY: number;
}

export interface GlideOutlineSettings {
	enabled: boolean;
	position: OutlinePosition;
	/** px, shifts the rail down (positive) or up (negative). */
	verticalOffset: number;
	/**
	 * px, distance between the outline rail and the pane edge it is
	 * anchored to. On the right this keeps the rail clear of the editor
	 * scrollbar.
	 */
	horizontalOffset: number;
	/**
	 * px added toward the text body per heading depth step:
	 * H1 = 0, H2 = 1×, … H6 = 5× levelIndent.
	 * LEGACY / advanced: superseded by the edge level badge as the primary
	 * hierarchy cue — the default is now 0 (off). Kept functional so
	 * existing vaults that liked the staircase keep it.
	 */
	levelIndent: number;
	/** Primary hierarchy cue: H1…H6 badge on the rail-facing card edge. */
	levelIndicatorStyle: LevelIndicatorStyle;
	/** Soft fade at the top/bottom edges when the list overflows. */
	edgeFadeEnabled: boolean;
	/** Fade size in px. */
	edgeFadeSize: number;
	/** Slowly scroll the list when the pointer dwells near an edge. */
	pointerAutoScroll: boolean;
	/**
	 * §十八: pre-scroll the outline in the direction of quick vertical
	 * pointer movement, before the pointer reaches an edge. Independent of
	 * the edge dwell/latch — fast flicks proactively bring headings toward
	 * the pointer. Scaled by `pointerFollowStrength` (not edge speed).
	 */
	pointerFollowEnabled: boolean;
	/**
	 * §十一 strength multiplier for Pointer movement assist. 1 = tuned
	 * default; 0.5 = gentle; 2.5 = aggressive. Independent of
	 * `pointerAutoScrollSpeed` so the two mechanisms can be tuned apart.
	 */
	pointerFollowStrength: number;
	/**
	 * Multiplier on the EDGE auto-scroll speed/acceleration.
	 * 1 = the tuned default feel; 0.25 = very gentle; 4 = brisk.
	 * Renamed from the legacy `pointerAutoScrollStrength` field, which
	 * is migrated on load and then silently ignored.
	 */
	pointerAutoScrollSpeed: number;
	/**
	 * Height in px of the edge trigger area for pointer auto-scroll,
	 * measured from each list edge. The effective pre-zone is capped at
	 * half the viewport height so short panes never overlap zones.
	 */
	pointerAutoScrollZone: number;
	markerStyle: MarkerStyle;
	/** Peak scale at pointer distance 0. */
	maxScale: number;
	/** Magnification falloff radius in px. */
	radius: number;
	/** Label font size in px (before magnification). */
	baseFontSize: number;
	/** Max label TEXT width in px; longer headings get an ellipsis. */
	maxLabelWidth: number;
	/**
	 * Minimum vertical space kept between neighbouring label cards, px.
	 * Enforced both at rest and during magnification (collision solver).
	 */
	cardGap: number;
	/** showLevels[level - 1] — whether H(level) is rendered. */
	showLevels: [boolean, boolean, boolean, boolean, boolean, boolean];
	/** Render inline Markdown (bold, code, links…) inside labels. */
	renderMarkdown: boolean;
	card: LabelAppearanceSettings;
	/**
	 * §六: reveal the performance-capture and cold-start diagnostic
	 * commands in the command palette. Off by default — these tools exist
	 * to triage a specific machine, not for everyday use, and their
	 * commands only add noise to the palette when they cannot help.
	 */
	developerMode: boolean;
	/**
	 * §八: one-shot latch for cold-start tracing. The "arm cold-start
	 * capture" command sets it; the NEXT onload consumes it (builds a
	 * ColdStartTrace at t0) and clears it again, so a cold start is traced
	 * exactly once per arm. NOT a user-facing toggle — armed by command,
	 * never rendered in the settings UI.
	 */
	coldStartCaptureArmed: boolean;
}

export const DEFAULT_CARD: LabelAppearanceSettings = {
	opacity: 78,
	border: false,
	radius: 4,
	shadow: false,
	paddingX: 7,
	paddingY: 1,
};

export const DEFAULT_SETTINGS: GlideOutlineSettings = {
	enabled: true,
	position: "right",
	verticalOffset: 0,
	horizontalOffset: 12,
	// The badge replaced the staircase as the default hierarchy cue.
	levelIndent: 0,
	levelIndicatorStyle: "badge",
	edgeFadeEnabled: true,
	edgeFadeSize: 28,
	pointerAutoScroll: true,
	pointerFollowEnabled: true,
	pointerFollowStrength: 1,
	pointerAutoScrollSpeed: 1,
	pointerAutoScrollZone: 120,
	markerStyle: "line",
	maxScale: 1.25,
	radius: 90,
	baseFontSize: 12,
	maxLabelWidth: 240,
	cardGap: 4,
	showLevels: [true, true, true, true, true, true],
	renderMarkdown: false,
	card: { ...DEFAULT_CARD },
	developerMode: false,
	coldStartCaptureArmed: false,
};

export const RANGES = {
	verticalOffset: { min: -400, max: 400 },
	horizontalOffset: { min: 0, max: 64 },
	levelIndent: { min: 0, max: 8 },
	edgeFadeSize: { min: 12, max: 120 },
	pointerAutoScrollSpeed: { min: 0.25, max: 4 },
	pointerFollowStrength: { min: 0.5, max: 2.5 },
	pointerAutoScrollZone: { min: 40, max: 220 },
	// 2.25 (P1-1): the collision solver keeps neighbours readable even at
	// high peaks, so the old 1.75 cap was purely conservative.
	maxScale: { min: 1, max: 2.25 },
	radius: { min: 40, max: 240 },
	baseFontSize: { min: 9, max: 18 },
	maxLabelWidth: { min: 140, max: 400 },
	cardGap: { min: 0, max: 16 },
	cardOpacity: { min: 0, max: 100 },
	cardRadius: { min: 0, max: 16 },
	cardPaddingX: { min: 0, max: 18 },
	cardPaddingY: { min: 0, max: 10 },
} as const;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeCard(raw: unknown): LabelAppearanceSettings {
	// Legacy persisted fields `textEffect` / `textShadow` (halo, any
	// generation) are silently ignored: the text effect feature was
	// removed entirely before the first release.
	const data = (raw ?? {}) as Partial<LabelAppearanceSettings>;
	return {
		opacity: clamp(
			data.opacity,
			RANGES.cardOpacity.min,
			RANGES.cardOpacity.max,
			DEFAULT_CARD.opacity,
		),
		border: bool(data.border, DEFAULT_CARD.border),
		radius: clamp(
			data.radius,
			RANGES.cardRadius.min,
			RANGES.cardRadius.max,
			DEFAULT_CARD.radius,
		),
		shadow: bool(data.shadow, DEFAULT_CARD.shadow),
		paddingX: clamp(
			data.paddingX,
			RANGES.cardPaddingX.min,
			RANGES.cardPaddingX.max,
			DEFAULT_CARD.paddingX,
		),
		paddingY: clamp(
			data.paddingY,
			RANGES.cardPaddingY.min,
			RANGES.cardPaddingY.max,
			DEFAULT_CARD.paddingY,
		),
	};
}

/** Merge persisted data with defaults and clamp everything into valid ranges. */
export function normalizeSettings(raw: unknown): GlideOutlineSettings {
	const data = (raw ?? {}) as Partial<GlideOutlineSettings> & {
		/** Legacy field renamed to `pointerAutoScrollSpeed`; migrated on load. */
		pointerAutoScrollStrength?: unknown;
	};
	const levels = Array.isArray(data.showLevels) ? data.showLevels : [];
	return {
		enabled: bool(data.enabled, DEFAULT_SETTINGS.enabled),
		position: data.position === "left" || data.position === "right"
			? data.position
			: DEFAULT_SETTINGS.position,
		verticalOffset: clamp(
			data.verticalOffset,
			RANGES.verticalOffset.min,
			RANGES.verticalOffset.max,
			DEFAULT_SETTINGS.verticalOffset,
		),
		horizontalOffset: clamp(
			data.horizontalOffset,
			RANGES.horizontalOffset.min,
			RANGES.horizontalOffset.max,
			DEFAULT_SETTINGS.horizontalOffset,
		),
		levelIndent: clamp(
			data.levelIndent,
			RANGES.levelIndent.min,
			RANGES.levelIndent.max,
			DEFAULT_SETTINGS.levelIndent,
		),
		levelIndicatorStyle:
			data.levelIndicatorStyle === "none" ||
			data.levelIndicatorStyle === "badge"
				? data.levelIndicatorStyle
				: DEFAULT_SETTINGS.levelIndicatorStyle,
		edgeFadeEnabled: bool(
			data.edgeFadeEnabled,
			DEFAULT_SETTINGS.edgeFadeEnabled,
		),
		edgeFadeSize: clamp(
			data.edgeFadeSize,
			RANGES.edgeFadeSize.min,
			RANGES.edgeFadeSize.max,
			DEFAULT_SETTINGS.edgeFadeSize,
		),
		pointerAutoScroll: bool(
			data.pointerAutoScroll,
			DEFAULT_SETTINGS.pointerAutoScroll,
		),
		pointerFollowEnabled: bool(
			data.pointerFollowEnabled,
			DEFAULT_SETTINGS.pointerFollowEnabled,
		),
		pointerFollowStrength: clamp(
			data.pointerFollowStrength,
			RANGES.pointerFollowStrength.min,
			RANGES.pointerFollowStrength.max,
			DEFAULT_SETTINGS.pointerFollowStrength,
		),
		// Current field wins; otherwise migrate the legacy
		// `pointerAutoScrollStrength` value (same unit and range).
		pointerAutoScrollSpeed: clamp(
			data.pointerAutoScrollSpeed ?? data.pointerAutoScrollStrength,
			RANGES.pointerAutoScrollSpeed.min,
			RANGES.pointerAutoScrollSpeed.max,
			DEFAULT_SETTINGS.pointerAutoScrollSpeed,
		),
		pointerAutoScrollZone: clamp(
			data.pointerAutoScrollZone,
			RANGES.pointerAutoScrollZone.min,
			RANGES.pointerAutoScrollZone.max,
			DEFAULT_SETTINGS.pointerAutoScrollZone,
		),
		markerStyle: data.markerStyle === "dot" || data.markerStyle === "line"
			? data.markerStyle
			: DEFAULT_SETTINGS.markerStyle,
		maxScale: clamp(data.maxScale, RANGES.maxScale.min, RANGES.maxScale.max, DEFAULT_SETTINGS.maxScale),
		radius: clamp(data.radius, RANGES.radius.min, RANGES.radius.max, DEFAULT_SETTINGS.radius),
		baseFontSize: clamp(
			data.baseFontSize,
			RANGES.baseFontSize.min,
			RANGES.baseFontSize.max,
			DEFAULT_SETTINGS.baseFontSize,
		),
		maxLabelWidth: clamp(
			data.maxLabelWidth,
			RANGES.maxLabelWidth.min,
			RANGES.maxLabelWidth.max,
			DEFAULT_SETTINGS.maxLabelWidth,
		),
		cardGap: clamp(
			data.cardGap,
			RANGES.cardGap.min,
			RANGES.cardGap.max,
			DEFAULT_SETTINGS.cardGap,
		),
		showLevels: [0, 1, 2, 3, 4, 5].map((i) =>
			typeof levels[i] === "boolean" ? (levels[i] as boolean) : true,
		) as GlideOutlineSettings["showLevels"],
		renderMarkdown: bool(data.renderMarkdown, DEFAULT_SETTINGS.renderMarkdown),
		developerMode: bool(data.developerMode, DEFAULT_SETTINGS.developerMode),
		coldStartCaptureArmed: bool(
			data.coldStartCaptureArmed,
			DEFAULT_SETTINGS.coldStartCaptureArmed,
		),
		// Legacy persisted fields `motionMode`, `animationEnabled`,
		// `pointerAutoScrollStrength` (migrated above) and
		// `card.textEffect` / `card.textShadow` are silently ignored.
		card: normalizeCard(data.card),
	};
}

/**
 * Normalize WITHOUT replacing the settings object (identity-preserving).
 *
 * Root cause of the "change a setting twice before it sticks" bug: the
 * plugin used to do `this.settings = normalizeSettings(this.settings)` on
 * every apply, which swapped the object identity. The settings tab's
 * `display()` closures kept writing into the OLD object — the first
 * change landed (same object), every later change went into a dead copy
 * until the tab was re-rendered. Mutating in place keeps every closure,
 * the plugin and the outline views pointed at one live object.
 */
export function normalizeSettingsInPlace(
	target: GlideOutlineSettings,
): GlideOutlineSettings {
	const clean = normalizeSettings(target);
	Object.assign(target, clean, {
		// Nested objects must also keep their identity (`s.card` is
		// captured by settings-tab closures too).
		card: Object.assign(target.card ?? {}, clean.card),
		showLevels: clean.showLevels,
	});
	return target;
}

/**
 * Restore appearance-related values to their defaults.
 * Deliberately preserved: enabled, position, vertical/horizontal offset,
 * pointer auto-scroll (and its speed / trigger area), shown levels and
 * Markdown rendering — those encode workflow and placement, not
 * appearance.
 */
export function resetAppearance(s: GlideOutlineSettings): GlideOutlineSettings {
	return {
		...s,
		markerStyle: DEFAULT_SETTINGS.markerStyle,
		maxScale: DEFAULT_SETTINGS.maxScale,
		radius: DEFAULT_SETTINGS.radius,
		baseFontSize: DEFAULT_SETTINGS.baseFontSize,
		maxLabelWidth: DEFAULT_SETTINGS.maxLabelWidth,
		cardGap: DEFAULT_SETTINGS.cardGap,
		levelIndent: DEFAULT_SETTINGS.levelIndent,
		levelIndicatorStyle: DEFAULT_SETTINGS.levelIndicatorStyle,
		edgeFadeEnabled: DEFAULT_SETTINGS.edgeFadeEnabled,
		edgeFadeSize: DEFAULT_SETTINGS.edgeFadeSize,
		card: { ...DEFAULT_CARD },
	};
}

/**
 * Identity-preserving reset (P1-6). The settings tab MUST use this: the
 * old `plugin.settings = resetAppearance(plugin.settings)` swapped the
 * object identity, which is exactly the pattern that caused the historic
 * "change it twice before it sticks" bug (see normalizeSettingsInPlace).
 */
export function resetAppearanceInPlace(
	target: GlideOutlineSettings,
): GlideOutlineSettings {
	const clean = resetAppearance(target);
	Object.assign(target, clean, {
		card: Object.assign(target.card ?? {}, clean.card),
	});
	return target;
}

/** Settings-tab sections (P1-5). */
export type SettingsTabId = "general" | "appearance" | "motion" | "advanced";

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
	{ id: "general", label: "General" },
	{ id: "appearance", label: "Appearance" },
	{ id: "motion", label: "Motion" },
	{ id: "advanced", label: "Advanced" },
];

/** Minimal shape of Obsidian's SliderComponent that we depend on. */
interface SliderLike {
	sliderEl: HTMLInputElement;
	setValue(value: number): SliderLike;
}

/**
 * Replace Obsidian's dynamic slider tooltip with a value that is simply
 * always visible.
 *
 * `setDynamicTooltip()` renders a hover bubble — a tooltip, and this plugin
 * ships none. A permanent readout is also strictly better: the number is
 * there while you drag, without hovering, and it never covers the track.
 *
 * `setValue` is wrapped (on this instance only) so the readout repaints when
 * the builder chain seeds the initial value, which happens after this call.
 * The span is `aria-hidden` because the range input already announces its
 * own value — a screen reader must not hear it twice.
 */
function withValueReadout<T extends SliderLike>(
	slider: T,
	format: (value: number) => string = (value) => String(value),
): T {
	const el = slider.sliderEl;
	const readout = el.ownerDocument.createElement("span");
	readout.className = "glide-settings-value";
	readout.setAttribute("aria-hidden", "true");
	const paint = (): void => {
		readout.textContent = format(Number(el.value));
	};
	const setValue = slider.setValue.bind(slider);
	slider.setValue = (value: number): T => {
		setValue(value);
		paint();
		return slider;
	};
	el.addEventListener("input", paint);
	el.insertAdjacentElement("afterend", readout);
	paint();
	return slider;
}

/**
 * Tabbed settings page (P1-5): General / Appearance / Motion / Advanced.
 *
 * a11y contract: `role=tablist/tab/tabpanel`, `aria-selected`,
 * `aria-controls`/`aria-labelledby` pairing, roving tabindex with
 * Arrow/Home/End keyboard support. Native Obsidian `Setting` rows only —
 * no framework. Styling rides on Obsidian theme variables (styles.css).
 */
export class GlideOutlineSettingTab extends PluginSettingTab {
	private activeTab: SettingsTabId = "general";
	private panelEl: HTMLElement | null = null;
	private tabButtons = new Map<SettingsTabId, HTMLElement>();

	constructor(app: App, private readonly plugin: GlideOutlinePlugin) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.tabButtons.clear();

		// Everything the plugin renders into Obsidian's settings container
		// hangs off one owned node, tagged the same way the outline mount is
		// — so the stylesheet can stay scoped to DOM we actually own.
		const root = containerEl.createDiv({ cls: "glide-settings-root" });
		root.setAttribute(OWNER_ATTR, OWNER_VALUE);

		const tablist = root.createDiv({
			cls: "glide-settings-tablist",
		});
		tablist.setAttribute("role", "tablist");
		// Accessible name via a hidden span rather than `aria-label`, which
		// Obsidian would render as a hover tooltip.
		const tablistLabel = tablist.createSpan({
			cls: "glide-outline-a11y-label",
			text: "Glide Outline settings sections",
		});
		tablistLabel.id = "glide-settings-tablist-label";
		tablist.setAttribute("aria-labelledby", tablistLabel.id);

		for (const tab of SETTINGS_TABS) {
			const button = tablist.createEl("button", {
				text: tab.label,
				cls: "glide-settings-tab",
			});
			button.setAttribute("type", "button");
			button.setAttribute("role", "tab");
			button.id = `glide-settings-tab-${tab.id}`;
			button.setAttribute("aria-controls", "glide-settings-panel");
			button.addEventListener("click", () => this.selectTab(tab.id));
			button.addEventListener("keydown", (event) =>
				this.handleTabKeydown(event, tab.id),
			);
			this.tabButtons.set(tab.id, button);
		}

		const panel = root.createDiv({ cls: "glide-settings-tabpanel" });
		panel.id = "glide-settings-panel";
		panel.setAttribute("role", "tabpanel");
		this.panelEl = panel;

		this.syncTabState();
		this.renderActivePanel();
	}

	override hide(): void {
		this.panelEl = null;
		this.tabButtons.clear();
	}

	private selectTab(id: SettingsTabId): void {
		if (this.activeTab === id) return;
		this.activeTab = id;
		this.syncTabState();
		this.renderActivePanel();
	}

	/** Roving tabindex: ←/→ wrap around, Home/End jump (P1-5 a11y). */
	private handleTabKeydown(event: KeyboardEvent, current: SettingsTabId): void {
		const ids = SETTINGS_TABS.map((tab) => tab.id);
		const index = ids.indexOf(current);
		let next: SettingsTabId | null = null;
		if (event.key === "ArrowRight") {
			next = ids[(index + 1) % ids.length];
		} else if (event.key === "ArrowLeft") {
			next = ids[(index + ids.length - 1) % ids.length];
		} else if (event.key === "Home") {
			next = ids[0];
		} else if (event.key === "End") {
			next = ids[ids.length - 1];
		}
		if (!next) return;
		event.preventDefault();
		this.selectTab(next);
		this.tabButtons.get(next)?.focus();
	}

	private syncTabState(): void {
		for (const [id, button] of this.tabButtons) {
			const active = id === this.activeTab;
			button.classList.toggle("is-active", active);
			button.setAttribute("aria-selected", active ? "true" : "false");
			button.setAttribute("tabindex", active ? "0" : "-1");
		}
		this.panelEl?.setAttribute(
			"aria-labelledby",
			`glide-settings-tab-${this.activeTab}`,
		);
	}

	private renderActivePanel(): void {
		const panel = this.panelEl;
		if (!panel) return;
		panel.empty();
		switch (this.activeTab) {
			case "general":
				this.renderGeneral(panel);
				break;
			case "appearance":
				this.renderAppearance(panel);
				break;
			case "motion":
				this.renderMotion(panel);
				break;
			case "advanced":
				this.renderAdvanced(panel);
				break;
		}
	}

	// --- General: on/off, placement -----------------------------------

	private renderGeneral(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Enable outline")
			.setDesc("Show the outline rail in the margin of the active Markdown editor.")
			.addToggle((toggle) =>
				toggle.setValue(s.enabled).onChange(async (value) => {
					s.enabled = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Position")
			.setDesc("Which editor margin the rail sits in.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("right", "Right")
					.addOption("left", "Left")
					.setValue(s.position)
					.onChange(async (value) => {
						s.position = value === "left" ? "left" : "right";
						await this.plugin.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("Horizontal offset")
			.setDesc("Move the outline inward from the editor edge. Increase it on the right to leave space beside the editor scrollbar.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.horizontalOffset.min, RANGES.horizontalOffset.max, 1)
					.setValue(s.horizontalOffset)
					.onChange((value) => {
						s.horizontalOffset = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vertical offset")
			.setDesc("Shift the rail down (positive) or up (negative), in pixels.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.verticalOffset.min, RANGES.verticalOffset.max, 10)
					.setValue(s.verticalOffset)
					.onChange((value) => {
						s.verticalOffset = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl).setName("Show heading levels").setHeading();
		for (let level = 1; level <= 6; level++) {
			new Setting(containerEl).setName(`H${level}`).addToggle((toggle) =>
				toggle.setValue(s.showLevels[level - 1]).onChange(async (value) => {
					s.showLevels[level - 1] = value;
					await this.plugin.applySettings();
				}),
			);
		}
	}

	// --- Appearance: marker, typography, card, hierarchy ---------------

	private renderAppearance(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Marker style")
			.setDesc("Line length or dot size encodes the heading level.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("line", "Line")
					.addOption("dot", "Dot")
					.setValue(s.markerStyle)
					.onChange(async (value) => {
						s.markerStyle = value === "dot" ? "dot" : "line";
						await this.plugin.applySettings();
					}),
			);

		// --- Typography
		new Setting(containerEl).setName("Typography").setHeading();

		new Setting(containerEl)
			.setName("Base font size")
			.setDesc("Label font size in pixels, before magnification.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.baseFontSize.min, RANGES.baseFontSize.max, 1)
					.setValue(s.baseFontSize)
					.onChange((value) => {
						s.baseFontSize = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum label width")
			.setDesc("Longer headings are truncated with an ellipsis.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.maxLabelWidth.min, RANGES.maxLabelWidth.max, 10)
					.setValue(s.maxLabelWidth)
					.onChange((value) => {
						s.maxLabelWidth = value;
						this.plugin.previewSettings();
					}),
			);

		// --- Label card
		new Setting(containerEl).setName("Label card").setHeading();

		new Setting(containerEl)
			.setName("Background opacity")
			.setDesc("0 turns the card into pure text.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.cardOpacity.min, RANGES.cardOpacity.max, 2)
					.setValue(s.card.opacity)
					.onChange((value) => {
						s.card.opacity = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Border")
			.addToggle((toggle) =>
				toggle.setValue(s.card.border).onChange(async (value) => {
					s.card.border = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Corner radius")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.cardRadius.min, RANGES.cardRadius.max, 1)
					.setValue(s.card.radius)
					.onChange((value) => {
						s.card.radius = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Shadow")
			.addToggle((toggle) =>
				toggle.setValue(s.card.shadow).onChange(async (value) => {
					s.card.shadow = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Horizontal padding")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.cardPaddingX.min, RANGES.cardPaddingX.max, 1)
					.setValue(s.card.paddingX)
					.onChange((value) => {
						s.card.paddingX = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vertical padding")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.cardPaddingY.min, RANGES.cardPaddingY.max, 1)
					.setValue(s.card.paddingY)
					.onChange((value) => {
						s.card.paddingY = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum card gap")
			.setDesc("Minimum vertical space maintained between neighbouring label cards, including during magnification.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.cardGap.min, RANGES.cardGap.max, 1)
					.setValue(s.cardGap)
					.onChange((value) => {
						s.cardGap = value;
						this.plugin.previewSettings();
					}),
			);

		// --- Hierarchy
		new Setting(containerEl).setName("Hierarchy").setHeading();

		new Setting(containerEl)
			.setName("Level badge")
			.setDesc("Show a small H1–H6 tag on the edge-facing side of each label. The primary hierarchy cue, together with per-level typography.")
			.addToggle((toggle) =>
				toggle
					.setValue(s.levelIndicatorStyle === "badge")
					.onChange((value) => {
						s.levelIndicatorStyle = value ? "badge" : "none";
						this.plugin.previewSettings();
					}),
			);

		// --- Rendering
		new Setting(containerEl).setName("Rendering").setHeading();

		new Setting(containerEl)
			.setName("Render Markdown in labels")
			.setDesc("Show inline formatting such as bold, code and links in heading labels.")
			.addToggle((toggle) =>
				toggle.setValue(s.renderMarkdown).onChange(async (value) => {
					s.renderMarkdown = value;
					await this.plugin.applySettings();
				}),
			);
	}

	// --- Motion: magnification, edges, auto-scroll ---------------------

	private renderMotion(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Maximum magnification")
			.setDesc("Peak scale of the heading nearest the pointer.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.maxScale.min, RANGES.maxScale.max, 0.05)
					.setValue(s.maxScale)
					.onChange((value) => {
						s.maxScale = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Magnification radius")
			.setDesc("Distance in pixels over which magnification decays to normal size.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.radius.min, RANGES.radius.max, 5)
					.setValue(s.radius)
					.onChange((value) => {
						s.radius = value;
						this.plugin.previewSettings();
					}),
			);

		// --- Overflow
		new Setting(containerEl).setName("Overflow").setHeading();

		new Setting(containerEl)
			.setName("Edge fade")
			.setDesc("Softly fade the top and bottom of the list when more headings are hidden beyond the edge.")
			.addToggle((toggle) =>
				toggle.setValue(s.edgeFadeEnabled).onChange(async (value) => {
					s.edgeFadeEnabled = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Edge fade size")
			.setDesc("Height of the fade zone, in pixels.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.edgeFadeSize.min, RANGES.edgeFadeSize.max, 2)
					.setValue(s.edgeFadeSize)
					.onChange((value) => {
						s.edgeFadeSize = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Pointer edge auto-scroll")
			.setDesc("Slowly scroll the list when the pointer dwells near its top or bottom edge, bringing hidden headings into reach.")
			.addToggle((toggle) =>
				toggle.setValue(s.pointerAutoScroll).onChange(async (value) => {
					s.pointerAutoScroll = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Pointer movement assist")
			.setDesc("Pre-scroll the list in the direction of quick vertical pointer movement, before the pointer reaches an edge. Strength is set independently below.")
			.addToggle((toggle) =>
				toggle.setValue(s.pointerFollowEnabled).onChange(async (value) => {
					s.pointerFollowEnabled = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Edge auto-scroll speed")
			.setDesc("Speed multiplier for pointer EDGE auto-scroll only. 1 is the tuned default; lower is gentler, higher is brisker. Does not affect Pointer movement assist.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(
						RANGES.pointerAutoScrollSpeed.min,
						RANGES.pointerAutoScrollSpeed.max,
						0.1,
					)
					.setValue(s.pointerAutoScrollSpeed)
					.onChange((value) => {
						s.pointerAutoScrollSpeed = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Pointer movement assist strength")
			.setDesc("How strongly quick vertical pointer movements pre-scroll the outline. 1 is the tuned default; 0.5 is gentle; 2.5 is aggressive. Independent of edge auto-scroll speed.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(
						RANGES.pointerFollowStrength.min,
						RANGES.pointerFollowStrength.max,
						0.1,
					)
					.setValue(s.pointerFollowStrength)
					.onChange((value) => {
						s.pointerFollowStrength = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-scroll trigger area")
			.setDesc("Height of the edge zone that starts auto-scroll, in pixels from each list edge. Capped at half the list height on short panes.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(
						RANGES.pointerAutoScrollZone.min,
						RANGES.pointerAutoScrollZone.max,
						10,
					)
					.setValue(s.pointerAutoScrollZone)
					.onChange((value) => {
						s.pointerAutoScrollZone = value;
						this.plugin.previewSettings();
					}),
			);
	}

	// --- Advanced: legacy knobs and destructive actions ----------------

	private renderAdvanced(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Developer mode")
			.setDesc(
				"Reveal the performance-capture and cold-start tracing commands in the command palette. Leave off for everyday use; turning it off also stops and discards any capture already running.",
			)
			.addToggle((toggle) =>
				toggle.setValue(s.developerMode).onChange(async (value) => {
					s.developerMode = value;
					await this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("Level indentation (legacy)")
			.setDesc("Pixels each deeper level steps toward the text body. Superseded by the level badge; kept for vaults that prefer the staircase. 0 = off.")
			.addSlider((slider) =>
				withValueReadout(slider)
					.setLimits(RANGES.levelIndent.min, RANGES.levelIndent.max, 1)
					.setValue(s.levelIndent)
					.onChange((value) => {
						s.levelIndent = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Restore default appearance")
			.setDesc("Reset marker, typography and label card settings. Position, shown levels and Markdown rendering are kept.")
			.addButton((button) =>
				button.setButtonText("Restore defaults").onClick(async () => {
					// P1-6: reset IN PLACE — swapping the settings object
					// identity is exactly what caused the historic
					// "change it twice" bug.
					resetAppearanceInPlace(this.plugin.settings);
					await this.plugin.applySettings();
					this.display();
				}),
			);
	}
}
