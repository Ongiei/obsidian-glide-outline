import { describe, expect, it } from "vitest";
import {
	DEFAULT_CARD,
	DEFAULT_SETTINGS,
	DEFAULT_TEXT_EFFECT,
	normalizeSettings,
	normalizeSettingsInPlace,
	normalizeTextEffect,
	resetAppearance,
	resetAppearanceInPlace,
	textEffectHaloCss,
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
		expect(s.maxScale).toBe(2.25);
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

	it("defaults the placement and overflow fields", () => {
		const s = normalizeSettings({});
		expect(s.horizontalOffset).toBe(12);
		expect(s.edgeFadeEnabled).toBe(true);
		expect(s.edgeFadeSize).toBe(28);
		expect(s.pointerAutoScroll).toBe(true);
	});

	it("defaults the hierarchy cue to the badge, not the staircase", () => {
		const s = normalizeSettings({});
		expect(s.levelIndicatorStyle).toBe("badge");
		// The indent staircase is legacy — off by default.
		expect(s.levelIndent).toBe(0);
	});

	it("validates levelIndicatorStyle and keeps persisted choices", () => {
		expect(
			normalizeSettings({ levelIndicatorStyle: "none" }).levelIndicatorStyle,
		).toBe("none");
		expect(
			normalizeSettings({ levelIndicatorStyle: "badge" }).levelIndicatorStyle,
		).toBe("badge");
		expect(
			normalizeSettings({ levelIndicatorStyle: "rainbow" }).levelIndicatorStyle,
		).toBe(DEFAULT_SETTINGS.levelIndicatorStyle);
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

	it("clamps the legacy levelIndent into 0–8", () => {
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

describe("normalizeTextEffect", () => {
	it("migrates the legacy boolean true to a halo", () => {
		expect(normalizeTextEffect(true)).toEqual({
			...DEFAULT_TEXT_EFFECT,
			mode: "halo",
		});
	});

	it("migrates the legacy boolean false to none", () => {
		expect(normalizeTextEffect(false)).toEqual({
			...DEFAULT_TEXT_EFFECT,
			mode: "none",
		});
	});

	it("returns the disabled default for missing/invalid input", () => {
		expect(normalizeTextEffect(undefined)).toEqual(DEFAULT_TEXT_EFFECT);
		expect(normalizeTextEffect(null)).toEqual(DEFAULT_TEXT_EFFECT);
		expect(normalizeTextEffect({})).toEqual(DEFAULT_TEXT_EFFECT);
		expect(DEFAULT_TEXT_EFFECT.mode).toBe("none");
	});

	it("migrates a structured legacy text-shadow object via `enabled`", () => {
		expect(normalizeTextEffect({ enabled: true, blur: 5 })).toEqual({
			...DEFAULT_TEXT_EFFECT,
			mode: "halo",
			blur: 5,
		});
		expect(normalizeTextEffect({ enabled: false }).mode).toBe("none");
	});

	it("drops the legacy directional offsets entirely", () => {
		const effect = normalizeTextEffect({
			enabled: true,
			offsetX: 2,
			offsetY: 4,
		});
		expect(effect).not.toHaveProperty("offsetX");
		expect(effect).not.toHaveProperty("offsetY");
	});

	it("accepts every explicit mode and rejects unknown ones", () => {
		expect(normalizeTextEffect({ mode: "halo" }).mode).toBe("halo");
		expect(normalizeTextEffect({ mode: "none" }).mode).toBe("none");
		expect(normalizeTextEffect({ mode: "glow" }).mode).toBe(
			DEFAULT_TEXT_EFFECT.mode,
		);
	});

	it("folds the retired stroke mode into none (P1-2)", () => {
		expect(normalizeTextEffect({ mode: "stroke" }).mode).toBe("none");
		// Color/opacity/blur survive so switching to Halo keeps the tuning.
		const s = normalizeTextEffect({
			mode: "stroke",
			color: "#abc",
			opacity: 80,
			blur: 5,
		});
		expect(s.color).toBe("#abc");
		expect(s.opacity).toBe(80);
		expect(s.blur).toBe(5);
	});

	it("clamps opacity into 0–100 and blur into 1–8", () => {
		const s = normalizeTextEffect({ mode: "halo", opacity: 500, blur: -2 });
		expect(s.opacity).toBe(100);
		expect(s.blur).toBe(1);
		expect(normalizeTextEffect({ blur: 99 }).blur).toBe(8);
	});

	it("rejects invalid colors and keeps valid 3/6-digit hex", () => {
		expect(normalizeTextEffect({ color: "red" }).color).toBe(
			DEFAULT_TEXT_EFFECT.color,
		);
		expect(normalizeTextEffect({ color: "#12" }).color).toBe(
			DEFAULT_TEXT_EFFECT.color,
		);
		expect(normalizeTextEffect({ color: "#abc" }).color).toBe("#abc");
		expect(normalizeTextEffect({ color: "#A1B2C3" }).color).toBe("#A1B2C3");
	});

	it("migrates via normalizeSettings from a legacy card.textShadow boolean", () => {
		const on = normalizeSettings({ card: { textShadow: true } });
		expect(on.card.textEffect.mode).toBe("halo");
		const off = normalizeSettings({ card: { textShadow: false } });
		expect(off.card.textEffect.mode).toBe("none");
	});

	it("prefers the current textEffect over a stale legacy textShadow", () => {
		const s = normalizeSettings({
			card: { textShadow: false, textEffect: { mode: "halo" } },
		});
		expect(s.card.textEffect.mode).toBe("halo");
	});
});

describe("textEffectHaloCss", () => {
	it("returns none for the none mode", () => {
		expect(textEffectHaloCss({ ...DEFAULT_TEXT_EFFECT, mode: "none" })).toBe(
			"none",
		);
	});

	it("builds three concentric zero-offset layers (no direction)", () => {
		const css = textEffectHaloCss({
			mode: "halo",
			color: "#000000",
			opacity: 40,
			blur: 3,
		});
		expect(css).toBe(
			"0 0 1px rgba(0, 0, 0, 0.4), 0 0 3px rgba(0, 0, 0, 0.32), 0 0 6px rgba(0, 0, 0, 0.2)",
		);
		// Every layer starts with a 0 0 offset — never a directional smear.
		for (const layer of css.split(", 0 0")) {
			expect(layer).not.toMatch(/^\s*\d+px \d+px/);
		}
	});

	it("expands 3-digit hex colors", () => {
		const css = textEffectHaloCss({
			mode: "halo",
			color: "#f00",
			opacity: 100,
			blur: 2,
		});
		expect(css).toContain("0 0 1px rgba(255, 0, 0, 1)");
		expect(css).toContain("0 0 2px rgba(255, 0, 0, 0.8)");
		expect(css).toContain("0 0 4px rgba(255, 0, 0, 0.5)");
	});
});

describe("normalizeSettingsInPlace", () => {
	it("preserves the identity of the settings object and nested card", () => {
		const settings = normalizeSettings({});
		const card = settings.card;
		const textEffect = settings.card.textEffect;
		settings.maxScale = 99 as never;
		const result = normalizeSettingsInPlace(settings);
		expect(result).toBe(settings);
		expect(settings.card).toBe(card);
		expect(settings.card.textEffect).toBe(textEffect);
	});

	it("clamps out-of-range values in place", () => {
		const settings = normalizeSettings({});
		settings.maxScale = 99;
		settings.card.opacity = 500;
		settings.card.textEffect.blur = -3;
		normalizeSettingsInPlace(settings);
		expect(settings.maxScale).toBe(2.25);
		expect(settings.card.opacity).toBe(100);
		expect(settings.card.textEffect.blur).toBe(1);
	});

	it("keeps closure writes visible after repeated normalization", () => {
		// Regression for the "set once, then dead" settings-tab bug: a
		// closure captured before normalization must still write into the
		// live object after several normalization passes.
		const settings = normalizeSettings({});
		const write = (v: number) => {
			settings.horizontalOffset = v;
		};
		normalizeSettingsInPlace(settings);
		normalizeSettingsInPlace(settings);
		write(40);
		normalizeSettingsInPlace(settings);
		expect(settings.horizontalOffset).toBe(40);
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
			levelIndicatorStyle: "none",
			edgeFadeEnabled: false,
			edgeFadeSize: 64,
			card: { textEffect: { mode: "halo", blur: 8 } },
		});
		const reset = resetAppearance(custom);

		// Placement & interaction workflow: preserved.
		expect(reset.horizontalOffset).toBe(40);
		expect(reset.pointerAutoScroll).toBe(false);

		// Appearance: reset.
		expect(reset.levelIndent).toBe(DEFAULT_SETTINGS.levelIndent);
		expect(reset.levelIndicatorStyle).toBe(
			DEFAULT_SETTINGS.levelIndicatorStyle,
		);
		expect(reset.edgeFadeEnabled).toBe(DEFAULT_SETTINGS.edgeFadeEnabled);
		expect(reset.edgeFadeSize).toBe(DEFAULT_SETTINGS.edgeFadeSize);
		expect(reset.card.textEffect).toEqual(DEFAULT_TEXT_EFFECT);
	});
});

describe("pointerAutoScrollStrength (P1-3)", () => {
	it("defaults to 1 and clamps into 0.25–2", () => {
		expect(normalizeSettings({}).pointerAutoScrollStrength).toBe(1);
		expect(
			normalizeSettings({ pointerAutoScrollStrength: 0 })
				.pointerAutoScrollStrength,
		).toBe(0.25);
		expect(
			normalizeSettings({ pointerAutoScrollStrength: 99 })
				.pointerAutoScrollStrength,
		).toBe(2);
		expect(
			normalizeSettings({ pointerAutoScrollStrength: 1.5 })
				.pointerAutoScrollStrength,
		).toBe(1.5);
		expect(
			normalizeSettings({ pointerAutoScrollStrength: "fast" })
				.pointerAutoScrollStrength,
		).toBe(1);
	});

	it("survives resetAppearance (workflow, not appearance)", () => {
		const custom = normalizeSettings({ pointerAutoScrollStrength: 0.5 });
		expect(resetAppearance(custom).pointerAutoScrollStrength).toBe(0.5);
	});
});

describe("resetAppearanceInPlace (P1-6)", () => {
	it("preserves object identities while resetting values", () => {
		const settings = normalizeSettings({
			markerStyle: "dot",
			maxScale: 1.6,
			card: { opacity: 0, textEffect: { mode: "halo", blur: 8 } },
		});
		const card = settings.card;
		const textEffect = settings.card.textEffect;
		const result = resetAppearanceInPlace(settings);
		// Identity: the same objects every closure captured stay live.
		expect(result).toBe(settings);
		expect(settings.card).toBe(card);
		expect(settings.card.textEffect).toBe(textEffect);
		// Values: reset to defaults.
		expect(settings.markerStyle).toBe(DEFAULT_SETTINGS.markerStyle);
		expect(settings.maxScale).toBe(DEFAULT_SETTINGS.maxScale);
		expect(settings.card).toEqual(DEFAULT_CARD);
		expect(settings.card.textEffect).toEqual(DEFAULT_TEXT_EFFECT);
	});
});
