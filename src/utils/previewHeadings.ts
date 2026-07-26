import type { HeadingItem } from "../model/HeadingItem";
import { normalizeHeadingText } from "./headingIdentity";

export interface PreviewHeadingMatch {
	/** Index into the heading model. */
	modelIndex: number;
	element: HTMLElement;
}

/**
 * Match rendered Reading Mode heading elements against the heading model,
 * in document order. Obsidian may virtualize distant sections, so the match
 * is sequential and tolerant of missing elements.
 */
export function matchPreviewHeadings(
	previewEl: HTMLElement,
	items: readonly HeadingItem[],
): PreviewHeadingMatch[] {
	const matches: PreviewHeadingMatch[] = [];
	const elements = previewEl.querySelectorAll<HTMLElement>(
		".markdown-preview-sizer h1, .markdown-preview-sizer h2, .markdown-preview-sizer h3, .markdown-preview-sizer h4, .markdown-preview-sizer h5, .markdown-preview-sizer h6",
	);
	let modelIndex = 0;
	for (const element of Array.from(elements)) {
		const level = Number(element.tagName.charAt(1));
		const text = normalizeHeadingText(element.textContent ?? "");
		let candidate = modelIndex;
		while (
			candidate < items.length &&
			!(items[candidate].level === level && items[candidate].text === text)
		) {
			candidate++;
		}
		if (candidate >= items.length) continue;
		matches.push({ modelIndex: candidate, element });
		modelIndex = candidate + 1;
	}
	return matches;
}
