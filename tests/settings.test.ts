import { describe, expect, it } from "vitest";
import {
	DEFAULT_CARD,
	DEFAULT_SETTINGS,
	DEFAULT_TEXT_SHADOW,
	normalizeSettings,
	normalizeTextShadow,
	resetAppearance,
	textShadowCss,
} from "../src/settings";

describe("normalizeSettings", () => {
	it("returns defaults for empty input", () => {
		expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it("clamps numeric values into their ranges", () => {
		const s = normalizeSettings({
			maxScale: 99,
			radius: -5,
			baseFontSize: 200,
			maxLabelWidth: 1,
			verticalOffset: -9999,
		});
		expect(s.maxScale).toBe(1.75);
		expect(s.radius).toBe(40);
		expect(s.baseFontSize).toBe(18);
		expect(s.maxLabelWidth).toBe(140);
		expect(s.verticalOffset).toBe(-400);
	});

	it("clamps cardGap into 0–16 and falls back to the default", () => {
		expect(normalizeSettings({ cardGap: -3 }).cardGap).toBe(0);
		expect(normalizeSettings({ cardGap: 99 }).cardGap).toBe(16);
		expect(normalizeSettings({ cardGap: 8 }).cardGap).toBe(8);
		// Old data without cardGap migrates to the default.
		expect(normalizeSettings({ maxScale: 1.5 }).cardGap).toBe(
			DEFAULT_SETTINGS.cardGap,
		);
		expect(normalizeSettings({ cardGap: "wide" }).cardGap).toBe(
			DEFAULT_SETTINGS.cardGap,
		);
	});

	it("rejects invalid enums", () => {
		const s = normalizeSettings({ position: "top", markerStyle: "star" });
		expect(s.position).toBe(DEFAULT_SETTINGS.position);
		expect(s.markerStyle).toBe(DEFAULT_SETTINGS.markerStyle);
	});

	it("migrates data without a card section (backwards compatible)", () => {
		const s = normalizeSettings({ enabled: false, maxScale: 1.5 });
		expect(s.card).toEqual(DEFAULT_CARD);
		expect(s.enabled).toBe(false);
		expect(s.maxScale).toBe(1.5);
	});

	it("clamps card values", () => {
		const s = normalizeSettings({
			card: { opacity: 500, radius: -3, paddingX: 99, paddingY: -1 },
		});
		expect(s.card.opacity).toBe(100);
		expect(s.card.radius).toBe(0);
		expect(s.card.paddingX).toBe(18);
		expect(s.card.paddingY).toBe(0);
		expect(s.card.border).toBe(DEFAULT_CARD.border);
	});

	it("defaults renderMarkdown to false", () => {
		expect(normalizeSettings({}).renderMarkdown).toBe(false);
		expect(normalizeSettings({ renderMarkdown: true }).renderMarkdown).toBe(true);
	});

	it("repairs malformed showLevels arrays", () => {
		const s = normalizeSettings({ showLevels: [false, "x"] });
		expect(s.showLevels).toEqual([false, true, true, true, true, true]);
	});

	it("defaults the new placement and overflow fields", () => {
		const s = normalizeSettings({});
		expect(s.horizontalOffset).toBe(12);
		expect(s.levelIndent).toBe(3);
		expect(s.edgeFadeEnabled).toBe(true);
		expect(s.edgeFadeSize).toBe(28);
		expect(s.pointerAutoScroll).toBe(true);
	});

	it("clamps horizontalOffset into 0–64", () => {
		expect(normalizeSettings({ horizontalOffset: -5 }).horizontalOffset).toBe(0);
		expect(normalizeSettings({ horizontalOffset: 999 }).horizontalOffset).toBe(64);
		expect(normalizeSettings({ horizontalOffset: 0 }).horizontalOffset).toBe(0);
		expect(normalizeSettings({ horizontalOffset: 64 }).horizontalOffset).toBe(64);
		expect(normalizeSettings({ horizontalOffset: "far" }).horizontalOffset).toBe(
			DEFAULT_SETTINGS.horizontalOffset,
		);
	});

	it("clamps levelIndent into 0–8", () => {
		expect(normalizeSettings({ levelIndent: -1 }).levelIndent).toBe(0);
		expect(normalizeSettings({ levelIndent: 99 }).levelIndent).toBe(8);
		expect(normalizeSettings({ levelIndent: 5 }).levelIndent).toBe(5);
	});

	it("clamps edgeFadeSize into 12–64 and accepts the toggles", () => {
		expect(normalizeSettings({ edgeFadeSize: 1 }).edgeFadeSize).toBe(12);
		expect(normalizeSettings({ edgeFadeSize: 500 }).edgeFadeSize).toBe(64);
		expect(normalizeSettings({ edgeFadeEnabled: false }).edgeFadeEnabled).toBe(false);
		expect(normalizeSettings({ pointerAutoScroll: false }).pointerAutoScroll).toBe(false);
	});
});

describe("normalizeTextShadow", () => {
	it("migrates the legacy boolean true to enabled + defaults", () => {
		expect(normalizeTextShadow(true)).toEqual({
			...DEFAULT_TEXT_SHADOW,
			enabled: true,
		});
	});

	it("migrates the legacy boolean false to the disabled default", () => {
		expect(normalizeTextShadow(false)).toEqual({
			...DEFAULT_TEXT_SHADOW,
			enabled: false,
		});
	});

	it("returns defaults for missing/invalid input", () => {
		expect(normalizeTextShadow(undefined)).toEqual(DEFAULT_TEXT_SHADOW);
		expect(normalizeTextShadow(null)).toEqual(DEFAULT_TEXT_SHADOW);
		expect(normalizeTextShadow({})).toEqual(DEFAULT_TEXT_SHADOW);
	});

	it("clamps opacity, blur and offsets", () => {
		const s = normalizeTextShadow({
			enabled: true,
			opacity: 500,
			blur: -2,
			offsetX: 99,
			offsetY: -99,
		});
		expect(s.opacity).toBe(100);
		expect(s.blur).toBe(0);
		expect(s.offsetX).toBe(6);
		expect(s.offsetY).toBe(-6);
	});

	it("rejects invalid colors and keeps valid 3/6-digit hex", () => {
		expect(normalizeTextShadow({ color: "red" }).color).toBe(
			DEFAULT_TEXT_SHADOW.color,
		);
		expect(normalizeTextShadow({ color: "#12" }).color).toBe(
			DEFAULT_TEXT_SHADOW.color,
		);
		expect(normalizeTextShadow({ color: "#abc" }).color).toBe("#abc");
		expect(normalizeTextShadow({ color: "#A1B2C3" }).color).toBe("#A1B2C3");
	});

	it("migrates via normalizeSettings from a legacy card.textShadow boolean", () => {
		const s = normalizeSettings({ card: { textShadow: true } });
		expect(s.card.textShadow.enabled).toBe(true);
		expect(s.card.textShadow.blur).toBe(DEFAULT_TEXT_SHADOW.blur);
	});
});

describe("textShadowCss", () => {
	it("returns none when disabled", () => {
		expect(textShadowCss({ ...DEFAULT_TEXT_SHADOW, enabled: false })).toBe(
			"none",
		);
	});

	it("builds a full rgba shadow from the default values", () => {
		expect(textShadowCss({ ...DEFAULT_TEXT_SHADOW, enabled: true })).toBe(
			"0px 1px 4px rgba(0, 0, 0, 0.55)",
		);
	});

	it("expands 3-digit hex colors", () => {
		expect(
			textShadowCss({
				enabled: true,
				color: "#f00",
				opacity: 100,
				blur: 2,
				offsetX: 1,
				offsetY: -1,
			}),
		).toBe("1px -1px 2px rgba(255, 0, 0, 1)");
	});

	it("maps opacity percent to a 0–1 alpha", () => {
		const css = textShadowCss({
			enabled: true,
			color: "#000000",
			opacity: 30,
			blur: 0,
			offsetX: 0,
			offsetY: 0,
		});
		expect(css).toContain("rgba(0, 0, 0, 0.3)");
	});
});

describe("resetAppearance", () => {
	it("resets appearance but preserves workflow settings", () => {
		const custom = normalizeSettings({
			enabled: false,
			position: "left",
			verticalOffset: 120,
			markerStyle: "dot",
			maxScale: 1.6,
			baseFontSize: 16,
			renderMarkdown: true,
			showLevels: [true, true, false, false, false, false],
			cardGap: 12,
			card: { opacity: 0, border: true, shadow: true },
		});
		const reset = resetAppearance(custom);

		// Preserved.
		expect(reset.enabled).toBe(false);
		expect(reset.position).toBe("left");
		expect(reset.verticalOffset).toBe(120);
		expect(reset.renderMarkdown).toBe(true);
		expect(reset.showLevels).toEqual([true, true, false, false, false, false]);

		// Reset.
		expect(reset.markerStyle).toBe(DEFAULT_SETTINGS.markerStyle);
		expect(reset.maxScale).toBe(DEFAULT_SETTINGS.maxScale);
		expect(reset.baseFontSize).toBe(DEFAULT_SETTINGS.baseFontSize);
		expect(reset.cardGap).toBe(DEFAULT_SETTINGS.cardGap);
		expect(reset.card).toEqual(DEFAULT_CARD);
	});

	it("preserves placement/workflow but resets the new appearance fields", () => {
		const custom = normalizeSettings({
			horizontalOffset: 40,
			pointerAutoScroll: false,
			levelIndent: 8,
			edgeFadeEnabled: false,
			edgeFadeSize: 64,
			card: { textShadow: { enabled: true, blur: 9 } },
		});
		const reset = resetAppearance(custom);

		// Placement & interaction workflow: preserved.
		expect(reset.horizontalOffset).toBe(40);
		expect(reset.pointerAutoScroll).toBe(false);

		// Appearance: reset.
		expect(reset.levelIndent).toBe(DEFAULT_SETTINGS.levelIndent);
		expect(reset.edgeFadeEnabled).toBe(DEFAULT_SETTINGS.edgeFadeEnabled);
		expect(reset.edgeFadeSize).toBe(DEFAULT_SETTINGS.edgeFadeSize);
		expect(reset.card.textShadow).toEqual(DEFAULT_TEXT_SHADOW);
	});
});
