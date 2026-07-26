/**
 * A single heading entry in the Glide Outline model.
 *
 * `key` is a *stable identity*: it survives line-number shifts caused by
 * editing text above the heading, so the DOM node for a heading is only
 * recreated when the heading itself (level/text/occurrence) changes.
 */
export interface HeadingItem {
	/** Stable identity: `${level}::${normalizedText}::${occurrenceIndex}`. */
	readonly key: string;
	/** Heading level, 1–6. */
	readonly level: number;
	/** Normalized heading text (whitespace collapsed, trimmed). */
	readonly text: string;
	/** 0-based line of the heading start. Positional info only — never identity. */
	readonly line: number;
}

/** Raw heading before identity assignment. */
export interface RawHeading {
	readonly level: number;
	readonly text: string;
	readonly line: number;
}
