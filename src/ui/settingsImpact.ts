import type { GlideOutlineSettings } from "../settings";

/** Snapshot values, not references: the settings UI mutates nested objects. */
export function settingsImpact(settings: GlideOutlineSettings) {
	const s = settings;
	return {
		model: JSON.stringify([s.showLevels, s.renderMarkdown]),
		geometry: JSON.stringify([
			s.position, s.verticalOffset, s.horizontalOffset, s.levelIndent,
			s.levelIndicatorStyle, s.maxScale, s.baseFontSize, s.maxLabelWidth,
			s.cardGap, s.card.border, s.card.shadow, s.card.paddingX, s.card.paddingY,
		]),
		appearance: JSON.stringify([
			s.markerStyle, s.edgeFadeEnabled, s.edgeFadeSize, s.card.opacity, s.card.radius,
		]),
	};
}
