import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type GlideOutlinePlugin from "./main";

export type OutlinePosition = "left" | "right";
export type MarkerStyle = "line" | "dot";

/** Visual style of the label card behind each heading. */
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
	/** Text shadow for readability in pure text mode. */
	textShadow: boolean;
}

export interface GlideOutlineSettings {
	enabled: boolean;
	position: OutlinePosition;
	/** px, shifts the rail down (positive) or up (negative). */
	verticalOffset: number;
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
	animationEnabled: boolean;
	/** Render inline Markdown (bold, code, links…) inside labels. */
	renderMarkdown: boolean;
	card: LabelAppearanceSettings;
}

export const DEFAULT_CARD: LabelAppearanceSettings = {
	opacity: 78,
	border: false,
	radius: 4,
	shadow: false,
	paddingX: 7,
	paddingY: 1,
	textShadow: false,
};

export const DEFAULT_SETTINGS: GlideOutlineSettings = {
	enabled: true,
	position: "right",
	verticalOffset: 0,
	markerStyle: "line",
	maxScale: 1.25,
	radius: 90,
	baseFontSize: 12,
	maxLabelWidth: 240,
	cardGap: 4,
	showLevels: [true, true, true, true, true, true],
	animationEnabled: true,
	renderMarkdown: false,
	card: { ...DEFAULT_CARD },
};

export const RANGES = {
	verticalOffset: { min: -400, max: 400 },
	maxScale: { min: 1, max: 1.75 },
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
		textShadow: bool(data.textShadow, DEFAULT_CARD.textShadow),
	};
}

/** Merge persisted data with defaults and clamp everything into valid ranges. */
export function normalizeSettings(raw: unknown): GlideOutlineSettings {
	const data = (raw ?? {}) as Partial<GlideOutlineSettings>;
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
		animationEnabled: bool(
			data.animationEnabled,
			DEFAULT_SETTINGS.animationEnabled,
		),
		renderMarkdown: bool(data.renderMarkdown, DEFAULT_SETTINGS.renderMarkdown),
		card: normalizeCard(data.card),
	};
}

/**
 * Restore appearance-related values to their defaults.
 * Deliberately preserved: enabled, position, vertical offset, shown levels
 * and Markdown rendering — those encode workflow, not appearance.
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
		animationEnabled: DEFAULT_SETTINGS.animationEnabled,
		card: { ...DEFAULT_CARD },
	};
}

export class GlideOutlineSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GlideOutlinePlugin) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// --- General (no heading for the first group, per Obsidian guidelines)
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
			.setName("Vertical offset")
			.setDesc("Shift the rail down (positive) or up (negative), in pixels.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.verticalOffset.min, RANGES.verticalOffset.max, 10)
					.setValue(s.verticalOffset)
					.setDynamicTooltip()
					.onChange((value) => {
						s.verticalOffset = value;
						this.plugin.previewSettings();
					}),
			);

		// --- Marker
		new Setting(containerEl).setName("Marker").setHeading();

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

		// --- Motion
		new Setting(containerEl).setName("Motion").setHeading();

		new Setting(containerEl)
			.setName("Maximum magnification")
			.setDesc("Peak scale of the heading nearest the pointer.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.maxScale.min, RANGES.maxScale.max, 0.05)
					.setValue(s.maxScale)
					.setDynamicTooltip()
					.onChange((value) => {
						s.maxScale = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Magnification radius")
			.setDesc("Distance in pixels over which magnification decays to normal size.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.radius.min, RANGES.radius.max, 5)
					.setValue(s.radius)
					.setDynamicTooltip()
					.onChange((value) => {
						s.radius = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Animation")
			.setDesc("Disable for instant reveal without motion.")
			.addToggle((toggle) =>
				toggle.setValue(s.animationEnabled).onChange(async (value) => {
					s.animationEnabled = value;
					await this.plugin.applySettings();
				}),
			);

		// --- Typography
		new Setting(containerEl).setName("Typography").setHeading();

		new Setting(containerEl)
			.setName("Base font size")
			.setDesc("Label font size in pixels, before magnification.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.baseFontSize.min, RANGES.baseFontSize.max, 1)
					.setValue(s.baseFontSize)
					.setDynamicTooltip()
					.onChange((value) => {
						s.baseFontSize = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum label width")
			.setDesc("Longer headings are truncated with an ellipsis.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.maxLabelWidth.min, RANGES.maxLabelWidth.max, 10)
					.setValue(s.maxLabelWidth)
					.setDynamicTooltip()
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
				slider
					.setLimits(RANGES.cardOpacity.min, RANGES.cardOpacity.max, 2)
					.setValue(s.card.opacity)
					.setDynamicTooltip()
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
				slider
					.setLimits(RANGES.cardRadius.min, RANGES.cardRadius.max, 1)
					.setValue(s.card.radius)
					.setDynamicTooltip()
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
				slider
					.setLimits(RANGES.cardPaddingX.min, RANGES.cardPaddingX.max, 1)
					.setValue(s.card.paddingX)
					.setDynamicTooltip()
					.onChange((value) => {
						s.card.paddingX = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vertical padding")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.cardPaddingY.min, RANGES.cardPaddingY.max, 1)
					.setValue(s.card.paddingY)
					.setDynamicTooltip()
					.onChange((value) => {
						s.card.paddingY = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Minimum card gap")
			.setDesc("Minimum vertical space maintained between neighbouring label cards, including during magnification.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.cardGap.min, RANGES.cardGap.max, 1)
					.setValue(s.cardGap)
					.setDynamicTooltip()
					.onChange((value) => {
						s.cardGap = value;
						this.plugin.previewSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Text shadow")
			.setDesc("Improves readability in pure text mode.")
			.addToggle((toggle) =>
				toggle.setValue(s.card.textShadow).onChange(async (value) => {
					s.card.textShadow = value;
					await this.plugin.applySettings();
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

		new Setting(containerEl).setName("Show heading levels").setHeading();
		for (let level = 1; level <= 6; level++) {
			new Setting(containerEl).setName(`H${level}`).addToggle((toggle) =>
				toggle.setValue(s.showLevels[level - 1]).onChange(async (value) => {
					s.showLevels[level - 1] = value;
					await this.plugin.applySettings();
				}),
			);
		}

		// --- Reset
		new Setting(containerEl)
			.setName("Restore default appearance")
			.setDesc("Reset marker, motion, typography and label card settings. Position, shown levels and Markdown rendering are kept.")
			.addButton((button) =>
				button.setButtonText("Restore defaults").onClick(async () => {
					this.plugin.settings = resetAppearance(this.plugin.settings);
					await this.plugin.applySettings();
					this.display();
				}),
			);
	}
}
