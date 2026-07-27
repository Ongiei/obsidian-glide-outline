import { describe, expect, it } from "vitest";
import {
	DEFAULT_CARD,
	DEFAULT_SETTINGS,
	normalizeSettings,
	resetAppearance,
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
});
