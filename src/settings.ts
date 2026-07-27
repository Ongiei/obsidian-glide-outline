import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type GlideOutlinePlugin from "./main";

export type OutlinePosition = "left" | "right";
export type MarkerStyle = "line" | "dot";
/**
 * How heading depth is displayed next to the label.
 * Structured as an enum (not a boolean) so future styles — numbers,
 * ticks, roman numerals — can be added without another migration.
 */
export type LevelIndicatorStyle = "none" | "badge";
/**
 * Label text enhancement for readability over busy backgrounds.
 * - "none":   plain text (default — no dirty edges, ever)
 * - "halo":   soft omnidirectional glow (multi-layer, no offset)
 * - "stroke": hairline outline via -webkit-text-stroke
 * A directional drop shadow is deliberately NOT offered any more: it read
 * as smudged edges, especially with bold CJK glyphs.
 */
export type TextEffectMode = "none" | "halo" | "stroke";

/**
 * Structured text effect. Replaces both the legacy `textShadow: boolean`
 * and the interim `TextShadowSettings` object; `normalizeTextEffect`
 * migrates each older shape (boolean → none/halo, structured shadow →
 * carries color/opacity/blur over).
 */
export interface TextEffectSettings {
	mode: TextEffectMode;
	/** Halo / stroke color; hex `#rgb` or `#rrggbb`. */
	color: string;
	/** Effect alpha in percent, 0–100. */
	opacity: number;
	/** Halo radius in px — drives all three glow layers. */
	blur: number;
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
	/** Label text enhancement (halo / stroke) for busy backgrounds. */
	textEffect: TextEffectSettings;
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

export const DEFAULT_TEXT_EFFECT: TextEffectSettings = {
	mode: "none",
	color: "#000000",
	opacity: 45,
	blur: 3,
};

export const DEFAULT_CARD: LabelAppearanceSettings = {
	opacity: 78,
	border: false,
	radius: 4,
	shadow: false,
	paddingX: 7,
	paddingY: 1,
	textEffect: { ...DEFAULT_TEXT_EFFECT },
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
		textEffect: { ...DEFAULT_TEXT_EFFECT },
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
	textEffectOpacity: { min: 0, max: 100 },
	textEffectBlur: { min: 1, max: 8 },
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

function hexToRgb(color: string): { r: number; g: number; b: number } {
	const hex = color.length === 4
		? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
		: color;
	return {
		r: parseInt(hex.slice(1, 3), 16),
		g: parseInt(hex.slice(3, 5), 16),
		b: parseInt(hex.slice(5, 7), 16),
	};
}

function rgba(color: string, alpha: number): string {
	const { r, g, b } = hexToRgb(color);
	const a = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Migrate + normalize the text effect. Three persisted generations:
 *   1. boolean `textShadow`         → mode "halo"/"none"
 *   2. structured `textShadow` obj  → mode from `enabled`, carries
 *      color/opacity/blur (offsets are dropped — directional shadows are
 *      exactly what the redesign removes)
 *   3. current `textEffect` object  → validated field by field
 */
export function normalizeTextEffect(raw: unknown): TextEffectSettings {
	if (typeof raw === "boolean") {
		return { ...DEFAULT_TEXT_EFFECT, mode: raw ? "halo" : "none" };
	}
	const data = (raw ?? {}) as Record<string, unknown>;
	const mode: TextEffectMode =
		data.mode === "halo" || data.mode === "stroke" || data.mode === "none"
			? data.mode
			: typeof data.enabled === "boolean"
				? data.enabled
					? "halo"
					: "none"
				: DEFAULT_TEXT_EFFECT.mode;
	return {
		mode,
		color: hexColor(data.color, DEFAULT_TEXT_EFFECT.color),
		opacity: clamp(
			data.opacity,
			RANGES.textEffectOpacity.min,
			RANGES.textEffectOpacity.max,
			DEFAULT_TEXT_EFFECT.opacity,
		),
		blur: clamp(
			data.blur,
			RANGES.textEffectBlur.min,
			RANGES.textEffectBlur.max,
			DEFAULT_TEXT_EFFECT.blur,
		),
	};
}

/**
 * Halo `text-shadow` value for `--glide-text-halo`.
 *
 * NOT a directional drop shadow: three concentric zero-offset layers make
 * a soft underlay that stays symmetric around every glyph — the old
 * `0 1px 2px` look smudged bold CJK strokes downward. Layer alphas taper
 * (1 / 0.8 / 0.5) so the outer ring never reads as a dark border.
 * Returns "none" for every non-halo mode so the variable stays valid.
 */
export function textEffectHaloCss(effect: TextEffectSettings): string {
	if (effect.mode !== "halo") return "none";
	const alpha = effect.opacity / 100;
	const core = rgba(effect.color, alpha);
	const mid = rgba(effect.color, alpha * 0.8);
	const outer = rgba(effect.color, alpha * 0.5);
	return [
		`0 0 1px ${core}`,
		`0 0 ${effect.blur}px ${mid}`,
		`0 0 ${effect.blur * 2}px ${outer}`,
	].join(", ");
}

/**
 * Hairline stroke value for `--glide-text-stroke`
 * (`-webkit-text-stroke`). Fixed at 0.5px — anything thicker eats thin
 * Latin glyphs. "0" (not "none": invalid there) for non-stroke modes.
 */
export function textEffectStrokeCss(effect: TextEffectSettings): string {
	if (effect.mode !== "stroke") return "0";
	return `0.5px ${rgba(effect.color, effect.opacity / 100)}`;
}

function normalizeCard(raw: unknown): LabelAppearanceSettings {
	const data = (raw ?? {}) as Partial<LabelAppearanceSettings> & {
		/** Legacy persisted field (boolean or structured shadow object). */
		textShadow?: unknown;
	};
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
		// Current field wins; otherwise migrate whatever `textShadow`
		// generation is on disk (boolean or structured object).
		textEffect: normalizeTextEffect(data.textEffect ?? data.textShadow),
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
		// Nested objects must also keep their identity (`s.card` and
		// `s.card.textEffect` are captured by settings-tab closures too).
		card: Object.assign(target.card ?? {}, clean.card, {
			textEffect: Object.assign(
				target.card?.textEffect ?? {},
				clean.card.textEffect,
			),
		}),
		showLevels: clean.showLevels,
	});
	return target;
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
		levelIndicatorStyle: DEFAULT_SETTINGS.levelIndicatorStyle,
		edgeFadeEnabled: DEFAULT_SETTINGS.edgeFadeEnabled,
		edgeFadeSize: DEFAULT_SETTINGS.edgeFadeSize,
		animationEnabled: DEFAULT_SETTINGS.animationEnabled,
		card: { ...DEFAULT_CARD, textEffect: { ...DEFAULT_TEXT_EFFECT } },
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

		new Setting(containerEl)
			.setName("Level indentation (legacy)")
			.setDesc("Pixels each deeper level steps toward the text body. Superseded by the level badge; kept for vaults that prefer the staircase. 0 = off.")
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

		// --- Text effect
		new Setting(containerEl).setName("Text effect").setHeading();

		new Setting(containerEl)
			.setName("Text effect")
			.setDesc("Halo adds a soft glow around label text for readability over busy backgrounds — most useful in pure text mode. Stroke draws a hairline outline.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("none", "None")
					.addOption("halo", "Halo")
					.addOption("stroke", "Stroke")
					.setValue(s.card.textEffect.mode)
					.onChange((value) => {
						s.card.textEffect.mode =
							value === "halo" || value === "stroke" ? value : "none";
						this.plugin.previewSettings();
						this.display();
					}),
			);

		if (s.card.textEffect.mode !== "none") {
			new Setting(containerEl)
				.setName("Effect color")
				.addColorPicker((picker) =>
					picker.setValue(s.card.textEffect.color).onChange((value) => {
						s.card.textEffect.color = value;
						this.plugin.previewSettings();
					}),
				);

			new Setting(containerEl)
				.setName("Effect opacity")
				.addSlider((slider) =>
					slider
						.setLimits(
							RANGES.textEffectOpacity.min,
							RANGES.textEffectOpacity.max,
							5,
						)
						.setValue(s.card.textEffect.opacity)
						.setDynamicTooltip()
						.onChange((value) => {
							s.card.textEffect.opacity = value;
							this.plugin.previewSettings();
						}),
				);

			if (s.card.textEffect.mode === "halo") {
				new Setting(containerEl)
					.setName("Halo size")
					.setDesc("Radius of the glow, in pixels.")
					.addSlider((slider) =>
						slider
							.setLimits(
								RANGES.textEffectBlur.min,
								RANGES.textEffectBlur.max,
								1,
							)
							.setValue(s.card.textEffect.blur)
							.setDynamicTooltip()
							.onChange((value) => {
								s.card.textEffect.blur = value;
								this.plugin.previewSettings();
							}),
					);
			}
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
