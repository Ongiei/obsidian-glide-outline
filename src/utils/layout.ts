export interface ResponsiveWidthInput {
	/** Width of the host (MarkdownView contentEl) in px. */
	hostWidth: number;
	/** Configured maximum width of the label TEXT content area in px. */
	maxLabelWidth: number;
	/** Peak magnification scale. */
	maxScale: number;
	/** Width of the marker rail strip in px. */
	railWidth: number;
	/** Gap between rail and the label card column in px. */
	labelGap: number;
	/** Card horizontal padding per side in px. */
	cardPaddingX: number;
	/** Card border width per side in px (0 when the border is off). */
	cardBorderWidth: number;
	/** Horizontal room reserved for the card shadow (0 when off). */
	shadowAllowance: number;
	/** Extra slack so magnified cards never touch the pane edge. */
	safeSlack: number;
	/** Below this effective text width the outline enters compact mode. */
	compactThreshold: number;
	/** Distance between the rail and the pane edge it is anchored to, px. */
	horizontalOffset: number;
	/**
	 * Largest hierarchy indent among visible headings, px:
	 * `(deepestVisibleLevel - 1) * levelIndent`. Deeper cards step toward
	 * the text body, so the widest layout must budget for it.
	 */
	maxLevelIndent: number;
	/**
	 * Width the H1–H6 edge badge (incl. its gap) adds INSIDE the card,
	 * px. 0 when the badge is disabled. Budgeted so a badge never eats
	 * into the text ellipsis width.
	 */
	badgeAllowance: number;
}

export interface ResponsiveWidthResult {
	/** Actual root width in px (never exceeds the host). */
	rootWidth: number;
	/** Effective label TEXT content width so the whole card fits at max scale. */
	labelContentWidth: number;
	/** True when the pane is too narrow to show cards at all. */
	compact: boolean;
	/**
	 * Width of the continuous interaction surface, px: from the rail to
	 * the farthest SAFE card edge (indent + magnified card + shadow), but
	 * WITHOUT the outer safe slack — the editor text beyond the widest
	 * possible card must stay clickable even while the outline is
	 * expanded. Never exceeds rootWidth.
	 */
	interactionWidth: number;
}

/**
 * Narrow-pane adaptation (pure function).
 *
 * `maxLabelWidth` is the TEXT content budget; the card adds padding and
 * border on both sides, magnification multiplies the whole card, the
 * shadow needs painting room outside the card, deeper headings step
 * toward the text body by up to `maxLevelIndent`, and the whole root is
 * pushed inward from the pane edge by `horizontalOffset`:
 *
 *   cardBaseWidth      = text + 2*paddingX + 2*borderWidth
 *   magnifiedCardWidth = ceil(cardBaseWidth * maxScale)
 *   rootWidth          = rail + gap + maxLevelIndent + magnifiedCardWidth
 *                        + shadowAllowance + safeSlack
 *                        (clamped to hostWidth - horizontalOffset)
 *
 * When the host clamps the root, the text budget is solved in reverse so
 * the *complete* magnified card still fits. Below `compactThreshold`
 * the labels are hidden entirely (markers only). The user's configured
 * `maxLabelWidth` is never mutated — only the effective value shrinks.
 */
export function computeResponsiveWidth(
	input: ResponsiveWidthInput,
): ResponsiveWidthResult {
	const scale = Math.max(1, input.maxScale);
	const offset = Math.max(0, input.horizontalOffset);
	const maxLevelIndent = Math.max(0, input.maxLevelIndent);
	const badgeAllowance = Math.max(0, input.badgeAllowance);
	const chromeX =
		2 * input.cardPaddingX + 2 * input.cardBorderWidth + badgeAllowance;
	const cardBaseWidth = input.maxLabelWidth + chromeX;
	const idealWidth =
		input.railWidth +
		input.labelGap +
		maxLevelIndent +
		Math.ceil(cardBaseWidth * scale) +
		input.shadowAllowance +
		input.safeSlack;
	// The offset eats into the host: the root may never be pushed out of
	// the opposite side of the pane.
	const effectiveHostWidth = Math.max(
		0,
		Math.floor(input.hostWidth) - offset,
	);
	const rootWidth = Math.max(
		Math.min(input.railWidth, effectiveHostWidth),
		Math.min(idealWidth, effectiveHostWidth),
	);
	const availableCardWidth =
		(rootWidth -
			input.railWidth -
			input.labelGap -
			maxLevelIndent -
			input.shadowAllowance -
			input.safeSlack) /
		scale;
	const labelContentWidth = Math.max(
		0,
		Math.min(input.maxLabelWidth, Math.floor(availableCardWidth - chromeX)),
	);
	// Continuous interaction surface: covers rail → farthest safe card
	// edge at max magnification (effective text width, not the configured
	// one), excluding the outer safe slack so editor text beyond the
	// widest card never loses the pointer while expanded.
	const interactionWidth = Math.min(
		rootWidth,
		input.railWidth +
			input.labelGap +
			maxLevelIndent +
			Math.ceil((labelContentWidth + chromeX) * scale) +
			input.shadowAllowance,
	);
	return {
		rootWidth,
		labelContentWidth,
		compact: labelContentWidth < input.compactThreshold,
		interactionWidth,
	};
}

export interface VerticalSafeSpaceInput {
	/** Tallest unscaled card in the current list, px. */
	maxBaseCardHeight: number;
	/** Peak magnification scale. */
	maxScale: number;
	/** Magnification falloff radius in px. */
	radius: number;
	/** Minimum gap kept between neighbouring cards, px. */
	cardGap: number;
	/** Vertical room reserved for the card shadow (0 when off). */
	shadowAllowance: number;
}

/** Baseline breathing room applied even without magnification. */
export const MIN_VERTICAL_PAD = 14;

/**
 * Vertical painting space needed above the first and below the last row so
 * magnified edge cards are never clipped (pure function).
 *
 * Derivation (worst case at a list edge):
 * - Collision displacement is one-sided at the edge. Every row inside the
 *   falloff radius expands by up to `height * (maxScale - 1)`, and the
 *   cosine profile averages half of that across the radius, so the edge
 *   item is displaced outward by at most `radius * (maxScale - 1) / 2`.
 * - The edge card itself grows around its center by
 *   `maxBaseCardHeight * (maxScale - 1) / 2` beyond its unscaled half.
 * - The row already reserves the unscaled half plus `cardGap / 2`; the
 *   shadow needs its own painting room on top.
 */
export function computeVerticalSafeSpace(
	input: VerticalSafeSpaceInput,
): number {
	const scaleGain = Math.max(0, input.maxScale - 1);
	const displacement = (Math.max(0, input.radius) * scaleGain) / 2;
	const cardGrowth = (Math.max(0, input.maxBaseCardHeight) * scaleGain) / 2;
	const pad = Math.ceil(
		displacement +
			cardGrowth +
			Math.max(0, input.cardGap) +
			Math.max(0, input.shadowAllowance),
	);
	return Math.max(MIN_VERTICAL_PAD, pad);
}
