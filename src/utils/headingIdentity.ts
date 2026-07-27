import type { HeadingItem, RawHeading } from "../model/HeadingItem";

/** Collapse internal whitespace and trim. Empty result means "not a heading". */
export function normalizeHeadingText(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/**
 * Assign stable identities to raw headings.
 *
 * Identity = level + normalized text + duplicate occurrence index.
 * Line numbers are carried along as positional data but do not participate
 * in identity, so inserting content above a heading does not change its key.
 */
export function buildHeadingItems(raw: readonly RawHeading[]): HeadingItem[] {
	const occurrences = new Map<string, number>();
	const items: HeadingItem[] = [];
	for (const heading of raw) {
		const text = normalizeHeadingText(heading.text);
		if (text.length === 0) continue;
		const level = clampLevel(heading.level);
		const base = `${level}::${text}`;
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		items.push({
			key: `${base}::${occurrence}`,
			level,
			text,
			displaySource: heading.text.trim(),
			line: heading.line,
		});
	}
	return items;
}

/** True when both lists contain the same keys in the same order. */
export function sameHeadingKeys(
	a: readonly HeadingItem[],
	b: readonly HeadingItem[],
): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].key !== b[i].key) return false;
	}
	return true;
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 1;
	return Math.min(6, Math.max(1, Math.round(level)));
}
