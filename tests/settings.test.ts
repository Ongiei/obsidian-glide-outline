import { describe, expect, it } from "vitest";
import {
	DEFAULT_CARD,
	DEFAULT_SETTINGS,
	normalizeSettings,
	normalizeSettingsInPlace,
	resetAppearance,
	resetAppearanceInPlace,
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

	it("clamps edgeFadeSize into 12–120 and accepts the toggles", () => {
		expect(normalizeSettings({ edgeFadeSize: 1 }).edgeFadeSize).toBe(12);
		expect(normalizeSettings({ edgeFadeSize: 500 }).edgeFadeSize).toBe(120);
		expect(normalizeSettings({ edgeFadeSize: 100 }).edgeFadeSize).toBe(100);
		expect(normalizeSettings({ edgeFadeEnabled: false }).edgeFadeEnabled).toBe(false);
		expect(normalizeSettings({ pointerAutoScroll: false }).pointerAutoScroll).toBe(false);
	});
});

describe("removed text effect (§五)", () => {
	it("silently ignores every legacy text-effect shape", () => {
		// Legacy boolean textShadow, structured textShadow and the full
		// textEffect object must all normalize without error and without
		// leaving any trace on the card settings.
		for (const legacyCard of [
			{ textShadow: true },
			{ textShadow: { enabled: true, blur: 5 } },
			{ textEffect: { mode: "halo", color: "#abc", opacity: 80, blur: 5 } },
			{ textShadow: false, textEffect: { mode: "none" } },
		]) {
			const s = normalizeSettings({ card: legacyCard });
			expect(s.card).toEqual(DEFAULT_CARD);
			expect(s.card).not.toHaveProperty("textEffect");
			expect(s.card).not.toHaveProperty("textShadow");
		}
	});

	it("keeps the final label appearance shape minimal", () => {
		expect(Object.keys(DEFAULT_CARD).sort()).toEqual([
			"border",
			"opacity",
			"paddingX",
			"paddingY",
			"radius",
			"shadow",
		]);
	});
});

describe("normalizeSettingsInPlace", () => {
	it("preserves the identity of the settings object and nested card", () => {
		const settings = normalizeSettings({});
		const card = settings.card;
		settings.maxScale = 99 as never;
		const result = normalizeSettingsInPlace(settings);
		expect(result).toBe(settings);
		expect(settings.card).toBe(card);
	});

	it("clamps out-of-range values in place", () => {
		const settings = normalizeSettings({});
		settings.maxScale = 99;
		settings.card.opacity = 500;
		normalizeSettingsInPlace(settings);
		expect(settings.maxScale).toBe(2.25);
		expect(settings.card.opacity).toBe(100);
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
	});
});

describe("pointerAutoScrollSpeed (P1-3, renamed from strength)", () => {
	it("defaults to 1 and clamps into 0.25–4", () => {
		expect(normalizeSettings({}).pointerAutoScrollSpeed).toBe(1);
		expect(
			normalizeSettings({ pointerAutoScrollSpeed: 0 }).pointerAutoScrollSpeed,
		).toBe(0.25);
		expect(
			normalizeSettings({ pointerAutoScrollSpeed: 99 }).pointerAutoScrollSpeed,
		).toBe(4);
		expect(
			normalizeSettings({ pointerAutoScrollSpeed: 3 }).pointerAutoScrollSpeed,
		).toBe(3);
		expect(
			normalizeSettings({ pointerAutoScrollSpeed: 1.5 }).pointerAutoScrollSpeed,
		).toBe(1.5);
		expect(
			normalizeSettings({ pointerAutoScrollSpeed: "fast" })
				.pointerAutoScrollSpeed,
		).toBe(1);
	});

	it("migrates the legacy pointerAutoScrollStrength field (same unit)", () => {
		const s = normalizeSettings({ pointerAutoScrollStrength: 2.5 });
		expect(s.pointerAutoScrollSpeed).toBe(2.5);
		expect(s).not.toHaveProperty("pointerAutoScrollStrength");
		// An explicit new value wins over a stale legacy one.
		expect(
			normalizeSettings({
				pointerAutoScrollSpeed: 0.5,
				pointerAutoScrollStrength: 3,
			}).pointerAutoScrollSpeed,
		).toBe(0.5);
		// Legacy values clamp into the shared range.
		expect(
			normalizeSettings({ pointerAutoScrollStrength: 99 })
				.pointerAutoScrollSpeed,
		).toBe(4);
	});

	it("survives resetAppearance (workflow, not appearance)", () => {
		const custom = normalizeSettings({ pointerAutoScrollSpeed: 0.5 });
		expect(resetAppearance(custom).pointerAutoScrollSpeed).toBe(0.5);
	});
});

describe("pointerAutoScrollZone (§十)", () => {
	it("defaults to 120 and clamps into 40–220", () => {
		expect(normalizeSettings({}).pointerAutoScrollZone).toBe(120);
		expect(
			normalizeSettings({ pointerAutoScrollZone: 10 }).pointerAutoScrollZone,
		).toBe(40);
		expect(
			normalizeSettings({ pointerAutoScrollZone: 999 }).pointerAutoScrollZone,
		).toBe(220);
		expect(
			normalizeSettings({ pointerAutoScrollZone: 80 }).pointerAutoScrollZone,
		).toBe(80);
		expect(
			normalizeSettings({ pointerAutoScrollZone: "big" })
				.pointerAutoScrollZone,
		).toBe(120);
	});

	it("survives resetAppearance (workflow, not appearance)", () => {
		const custom = normalizeSettings({ pointerAutoScrollZone: 200 });
		expect(resetAppearance(custom).pointerAutoScrollZone).toBe(200);
	});
});

describe("resetAppearanceInPlace (P1-6)", () => {
	it("preserves object identities while resetting values", () => {
		const settings = normalizeSettings({
			markerStyle: "dot",
			maxScale: 1.6,
			card: { opacity: 0 },
		});
		const card = settings.card;
		const result = resetAppearanceInPlace(settings);
		// Identity: the same objects every closure captured stay live.
		expect(result).toBe(settings);
		expect(settings.card).toBe(card);
		// Values: reset to defaults.
		expect(settings.markerStyle).toBe(DEFAULT_SETTINGS.markerStyle);
		expect(settings.maxScale).toBe(DEFAULT_SETTINGS.maxScale);
		expect(settings.card).toEqual(DEFAULT_CARD);
	});
});

describe("developerMode + cold-start latch (§六/§八)", () => {
	it("defaults both new fields to false", () => {
		expect(DEFAULT_SETTINGS.developerMode).toBe(false);
		expect(DEFAULT_SETTINGS.coldStartCaptureArmed).toBe(false);
		const s = normalizeSettings({});
		expect(s.developerMode).toBe(false);
		expect(s.coldStartCaptureArmed).toBe(false);
	});

	it("persists an explicit developerMode choice without clearing the latch", () => {
		const s = normalizeSettings({
			developerMode: true,
			coldStartCaptureArmed: true,
		});
		expect(s.developerMode).toBe(true);
		// Arming is independent of developer mode: the one-shot latch must
		// survive a reload even with dev mode off (the copy command re-gates).
		expect(s.coldStartCaptureArmed).toBe(true);
	});

	it("resets the latch on a clear reload (one-shot, not sticky)", () => {
		const s = normalizeSettings({ coldStartCaptureArmed: false });
		expect(s.coldStartCaptureArmed).toBe(false);
	});

	it("coerces non-boolean inputs to the default false", () => {
		const s = normalizeSettings({
			developerMode: "yes",
			coldStartCaptureArmed: 1,
		});
		expect(s.developerMode).toBe(false);
		expect(s.coldStartCaptureArmed).toBe(false);
	});
});
