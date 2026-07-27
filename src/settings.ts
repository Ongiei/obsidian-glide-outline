import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type GlideOutlinePlugin from "./main";

export type OutlinePosition = "left" | "right";
export type MarkerStyle = "line" | "dot";

/**
 * Structured text shadow. Replaces the old `textShadow: boolean`; legacy
 * boolean values are migrated in `normalizeSettings` (enabled = oldBoolean,
 * every other field falls back to the defaults below).
 */
export interface TextShadowSettings {
	enabled: boolean;
	/** Hex color, `#rgb` or `#rrggbb`. Invalid values fall back to default. */
	color: string;
	/** Shadow alpha in percent, 0–100. */
	opacity: number;
	/** Blur radius in px. */
	blur: number;
	/** Horizontal offset in px (negative = left). */
	offsetX: number;
	/** Vertical offset in px (negative = up). */
	offsetY: number;
}

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
	/** Text shadow behind label text (readability on busy backgrounds). */
	textShadow: TextShadowSettings;
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
	 */
	levelIndent: number;
	/** Soft fade at the top/bottom edges when the list overflows. */
	edgeFadeEnabled: boolean;
	/** Fade size in px. */
	edgeFadeSize: number;
	/** Slowly scroll the list when the pointer dwells near an edge. */
	pointerAutoScroll: boolean;
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

export const DEFAULT_TEXT_SHADOW: TextShadowSettings = {
	enabled: false,
	color: "#000000",
	opacity: 55,
	blur: 4,
	offsetX: 0,
	offsetY: 1,
};

export const DEFAULT_CARD: LabelAppearanceSettings = {
	opacity: 78,
	border: false,
	radius: 4,
	shadow: false,
	paddingX: 7,
	paddingY: 1,
	textShadow: { ...DEFAULT_TEXT_SHADOW },
};

export const DEFAULT_SETTINGS: GlideOutlineSettings = {
	enabled: true,
	position: "right",
	verticalOffset: 0,
	horizontalOffset: 12,
	levelIndent: 3,
	edgeFadeEnabled: true,
	edgeFadeSize: 28,
	pointerAutoScroll: true,
	markerStyle: "line",
	maxScale: 1.25,
	radius: 90,
	baseFontSize: 12,
	maxLabelWidth: 240,
	cardGap: 4,
	showLevels: [true, true, true, true, true, true],
	animationEnabled: true,
	renderMarkdown: false,
	card: {
		...DEFAULT_CARD,
		textShadow: { ...DEFAULT_TEXT_SHADOW },
	},
};

export const RANGES = {
	verticalOffset: { min: -400, max: 400 },
	horizontalOffset: { min: 0, max: 64 },
	levelIndent: { min: 0, max: 8 },
	edgeFadeSize: { min: 12, max: 64 },
	maxScale: { min: 1, max: 1.75 },
	radius: { min: 40, max: 240 },
	baseFontSize: { min: 9, max: 18 },
	maxLabelWidth: { min: 140, max: 400 },
	cardGap: { min: 0, max: 16 },
	cardOpacity: { min: 0, max: 100 },
	cardRadius: { min: 0, max: 16 },
	cardPaddingX: { min: 0, max: 18 },
	cardPaddingY: { min: 0, max: 10 },
	textShadowOpacity: { min: 0, max: 100 },
	textShadowBlur: { min: 0, max: 12 },
	textShadowOffset: { min: -6, max: 6 },
} as const;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function hexColor(value: unknown, fallback: string): string {
	return typeof value === "string" && HEX_COLOR_RE.test(value)
		? value
		: fallback;
}

/**
 * Migrate + normalize the text shadow.
 * Legacy `data.json` stored `card.textShadow` as a boolean — that maps to
 * `enabled` and every other field takes the default.
 */
export function normalizeTextShadow(raw: unknown): TextShadowSettings {
	if (typeof raw === "boolean") {
		return { ...DEFAULT_TEXT_SHADOW, enabled: raw };
	}
	const data = (raw ?? {}) as Partial<TextShadowSettings>;
	return {
		enabled: bool(data.enabled, DEFAULT_TEXT_SHADOW.enabled),
		color: hexColor(data.color, DEFAULT_TEXT_SHADOW.color),
		opacity: clamp(
			data.opacity,
			RANGES.textShadowOpacity.min,
			RANGES.textShadowOpacity.max,
			DEFAULT_TEXT_SHADOW.opacity,
		),
		blur: clamp(
			data.blur,
			RANGES.textShadowBlur.min,
			RANGES.textShadowBlur.max,
			DEFAULT_TEXT_SHADOW.blur,
		),
		offsetX: clamp(
			data.offsetX,
			RANGES.textShadowOffset.min,
			RANGES.textShadowOffset.max,
			DEFAULT_TEXT_SHADOW.offsetX,
		),
		offsetY: clamp(
			data.offsetY,
			RANGES.textShadowOffset.min,
			RANGES.textShadowOffset.max,
			DEFAULT_TEXT_SHADOW.offsetY,
		),
	};
}

/**
 * Build the CSS `text-shadow` value written into `--glide-text-shadow`.
 * Returns "none" when disabled so the variable is always well-formed.
 */
export function textShadowCss(shadow: TextShadowSettings): string {
	if (!shadow.enabled) return "none";
	const hex = shadow.color.length === 4
		? `#${shadow.color[1]}${shadow.color[1]}${shadow.color[2]}${shadow.color[2]}${shadow.color[3]}${shadow.color[3]}`
		: shadow.color;
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	const alpha = Math.round((shadow.opacity / 100) * 1000) / 1000;
	return `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px rgba(${r}, ${g}, ${b}, ${alpha})`;
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
		textShadow: normalizeTextShadow(data.textShadow),
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
 * Deliberately preserved: enabled, position, vertical/horizontal offset,
 * pointer auto-scroll, shown levels and Markdown rendering — those encode
 * workflow and placement, not appearance.
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
		edgeFadeEnabled: DEFAULT_SETTINGS.edgeFadeEnabled,
		edgeFadeSize: DEFAULT_SETTINGS.edgeFadeSize,
		animationEnabled: DEFAULT_SETTINGS.animationEnabled,
		card: { ...DEFAULT_CARD, textShadow: { ...DEFAULT_TEXT_SHADOW } },
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
			.setName("Horizontal offset")
			.setDesc("Move the outline inward from the editor edge. Increase it on the right to leave space beside the editor scrollbar.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.horizontalOffset.min, RANGES.horizontalOffset.max, 1)
					.setValue(s.horizontalOffset)
					.setDynamicTooltip()
					.onChange((value) => {
						s.horizontalOffset = value;
						this.plugin.previewSettings();
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
			.setName("Level indentation")
			.setDesc("Pixels each deeper heading level steps toward the text body, forming a hierarchy staircase.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.levelIndent.min, RANGES.levelIndent.max, 1)
					.setValue(s.levelIndent)
					.setDynamicTooltip()
					.onChange((value) => {
						s.levelIndent = value;
						this.plugin.previewSettings();
					}),
			);

		// --- Text shadow
		new Setting(containerEl).setName("Text shadow").setHeading();

		new Setting(containerEl)
			.setName("Text shadow")
			.setDesc("Draw a configurable shadow behind label text for readability on busy backgrounds.")
			.addToggle((toggle) =>
				toggle.setValue(s.card.textShadow.enabled).onChange(async (value) => {
					s.card.textShadow.enabled = value;
					await this.plugin.applySettings();
					this.display();
				}),
			);

		if (s.card.textShadow.enabled) {
			new Setting(containerEl)
				.setName("Shadow color")
				.addColorPicker((picker) =>
					picker.setValue(s.card.textShadow.color).onChange((value) => {
						s.card.textShadow.color = value;
						this.plugin.previewSettings();
					}),
				);

			new Setting(containerEl)
				.setName("Shadow opacity")
				.addSlider((slider) =>
					slider
						.setLimits(
							RANGES.textShadowOpacity.min,
							RANGES.textShadowOpacity.max,
							5,
						)
						.setValue(s.card.textShadow.opacity)
						.setDynamicTooltip()
						.onChange((value) => {
							s.card.textShadow.opacity = value;
							this.plugin.previewSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Shadow blur")
				.addSlider((slider) =>
					slider
						.setLimits(
							RANGES.textShadowBlur.min,
							RANGES.textShadowBlur.max,
							1,
						)
						.setValue(s.card.textShadow.blur)
						.setDynamicTooltip()
						.onChange((value) => {
							s.card.textShadow.blur = value;
							this.plugin.previewSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Shadow horizontal offset")
				.addSlider((slider) =>
					slider
						.setLimits(
							RANGES.textShadowOffset.min,
							RANGES.textShadowOffset.max,
							1,
						)
						.setValue(s.card.textShadow.offsetX)
						.setDynamicTooltip()
						.onChange((value) => {
							s.card.textShadow.offsetX = value;
							this.plugin.previewSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Shadow vertical offset")
				.addSlider((slider) =>
					slider
						.setLimits(
							RANGES.textShadowOffset.min,
							RANGES.textShadowOffset.max,
							1,
						)
						.setValue(s.card.textShadow.offsetY)
						.setDynamicTooltip()
						.onChange((value) => {
							s.card.textShadow.offsetY = value;
							this.plugin.previewSettings();
						}),
				);
		}

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
				slider
					.setLimits(RANGES.edgeFadeSize.min, RANGES.edgeFadeSize.max, 2)
					.setValue(s.edgeFadeSize)
					.setDynamicTooltip()
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
