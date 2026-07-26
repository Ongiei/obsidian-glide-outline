import { PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import type GlideOutlinePlugin from "./main";

export type OutlinePosition = "left" | "right";
export type MarkerStyle = "line" | "dot";

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
	/** Max label width in px; longer headings get an ellipsis. */
	maxLabelWidth: number;
	/** showLevels[level - 1] — whether H(level) is rendered. */
	showLevels: [boolean, boolean, boolean, boolean, boolean, boolean];
	animationEnabled: boolean;
}

export const DEFAULT_SETTINGS: GlideOutlineSettings = {
	enabled: true,
	position: "right",
	verticalOffset: 0,
	markerStyle: "line",
	maxScale: 1.25,
	radius: 90,
	baseFontSize: 12,
	maxLabelWidth: 240,
	showLevels: [true, true, true, true, true, true],
	animationEnabled: true,
};

const RANGES = {
	verticalOffset: { min: -400, max: 400 },
	maxScale: { min: 1, max: 1.75 },
	radius: { min: 40, max: 240 },
	baseFontSize: { min: 9, max: 18 },
	maxLabelWidth: { min: 140, max: 400 },
} as const;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, n));
}

/** Merge persisted data with defaults and clamp everything into valid ranges. */
export function normalizeSettings(raw: unknown): GlideOutlineSettings {
	const data = (raw ?? {}) as Partial<GlideOutlineSettings>;
	const levels = Array.isArray(data.showLevels) ? data.showLevels : [];
	return {
		enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled,
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
		showLevels: [0, 1, 2, 3, 4, 5].map((i) =>
			typeof levels[i] === "boolean" ? (levels[i] as boolean) : true,
		) as GlideOutlineSettings["showLevels"],
		animationEnabled: typeof data.animationEnabled === "boolean"
			? data.animationEnabled
			: DEFAULT_SETTINGS.animationEnabled,
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

		new Setting(containerEl)
			.setName("Enable Glide Outline")
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
					.onChange(async (value) => {
						s.verticalOffset = value;
						await this.plugin.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("Marker style")
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

		new Setting(containerEl)
			.setName("Maximum magnification")
			.setDesc("Peak scale of the heading nearest the pointer.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.maxScale.min, RANGES.maxScale.max, 0.05)
					.setValue(s.maxScale)
					.setDynamicTooltip()
					.onChange(async (value) => {
						s.maxScale = value;
						await this.plugin.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("Magnification radius")
			.setDesc("Distance (px) over which magnification decays to normal size.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.radius.min, RANGES.radius.max, 5)
					.setValue(s.radius)
					.setDynamicTooltip()
					.onChange(async (value) => {
						s.radius = value;
						await this.plugin.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("Base font size")
			.setDesc("Label font size in px, before magnification.")
			.addSlider((slider) =>
				slider
					.setLimits(RANGES.baseFontSize.min, RANGES.baseFontSize.max, 1)
					.setValue(s.baseFontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						s.baseFontSize = value;
						await this.plugin.applySettings();
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
					.onChange(async (value) => {
						s.maxLabelWidth = value;
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

		new Setting(containerEl)
			.setName("Animation")
			.setDesc("Disable for instant reveal without motion.")
			.addToggle((toggle) =>
				toggle.setValue(s.animationEnabled).onChange(async (value) => {
					s.animationEnabled = value;
					await this.plugin.applySettings();
				}),
			);
	}
}
