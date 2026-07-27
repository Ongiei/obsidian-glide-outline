export interface ResponsiveWidthInput {
	/** Width of the host (MarkdownView contentEl) in px. */
	hostWidth: number;
	/** Configured maximum label width in px. */
	maxLabelWidth: number;
	/** Peak magnification scale. */
	maxScale: number;
	/** Width of the marker rail strip in px. */
	railWidth: number;
	/** Gap between rail and label column in px. */
	labelGap: number;
	/** Extra slack so magnified labels never clip. */
	safeSlack: number;
	/** Below this effective label width the outline enters compact mode. */
	compactThreshold: number;
}

export interface ResponsiveWidthResult {
	/** Actual root width in px (never exceeds the host). */
	rootWidth: number;
	/** Effective label width in px so labels fit even at max scale. */
	labelWidth: number;
	/** True when the pane is too narrow to show labels at all. */
	compact: boolean;
}

/**
 * Narrow-pane adaptation (pure function).
 *
 * The root wants `rail + ceil(maxLabelWidth * maxScale) + gap + slack` px,
 * but must never exceed the host width. When it is clamped, the label width
 * is reduced so the *magnified* label still fits: available / maxScale.
 * Below `compactThreshold` the labels are hidden entirely (markers only).
 */
export function computeResponsiveWidth(
	input: ResponsiveWidthInput,
): ResponsiveWidthResult {
	const scale = Math.max(1, input.maxScale);
	const idealWidth =
		input.railWidth +
		Math.ceil(input.maxLabelWidth * scale) +
		input.labelGap +
		input.safeSlack;
	const hostWidth = Math.max(0, Math.floor(input.hostWidth));
	const rootWidth = Math.max(
		Math.min(input.railWidth, hostWidth),
		Math.min(idealWidth, hostWidth),
	);
	const available =
		rootWidth - input.railWidth - input.labelGap - input.safeSlack;
	const labelWidth = Math.max(
		0,
		Math.min(input.maxLabelWidth, Math.floor(available / scale)),
	);
	return {
		rootWidth,
		labelWidth,
		compact: labelWidth < input.compactThreshold,
	};
}
