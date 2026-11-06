import type { HeadingItem } from "../model/HeadingItem";
import { normalizeHeadingText } from "./headingIdentity";

export interface PreviewHeadingMatch {
	/** Index into the heading model. */
	modelIndex: number;
	element: HTMLElement;
	/** Which strategy produced this match (line info beats occurrence). */
	matchedBy: "line" | "occurrence";
}

/**
 * Containers whose headings do NOT belong to this document's outline:
 * embedded notes and callouts render their own h1–h6 inside the preview
 * sizer, but the metadata cache (our model) never contains them.
 */
const EXCLUDED_ANCESTOR_SELECTOR =
	".markdown-embed, .internal-embed, .callout";

const HEADING_SELECTOR =
	".markdown-preview-sizer h1, .markdown-preview-sizer h2, .markdown-preview-sizer h3, .markdown-preview-sizer h4, .markdown-preview-sizer h5, .markdown-preview-sizer h6";

/**
 * Extract a reliable SOURCE LINE for a rendered heading, if the DOM
 * carries one (P0-4). Checked on the heading element itself first, then
 * on ancestors up to the preview sizer — Obsidian versions differ in
 * whether `data-line` sits on the element or its wrapping section div.
 * Returns null when no usable line info exists (older builds, plugins
 * that strip attributes) so callers fall back to occurrence matching.
 */
export function readPreviewSourceLine(element: HTMLElement): number | null {
	let el: HTMLElement | null = element;
	while (el) {
		const raw = el.dataset?.line;
		if (raw !== undefined && raw !== "") {
			const line = Number(raw);
			if (Number.isFinite(line) && line >= 0) return Math.floor(line);
		}
		if (el.classList?.contains("markdown-preview-sizer")) break;
		el = el.parentElement;
	}
	return null;
}

/** Rendered text of a preview heading (data-heading is the raw source). */
function previewHeadingText(element: HTMLElement): string {
	const raw = element.dataset?.heading;
	return normalizeHeadingText(
		raw !== undefined && raw !== "" ? raw : (element.textContent ?? ""),
	);
}

/**
 * Match rendered Reading Mode heading elements against the heading model
 * (P0-4). Two strategies, per element:
 *
 * 1. SOURCE LINE (authoritative): when the DOM carries `data-line`
 *    (element or wrapping section), match `HeadingItem.line` exactly.
 *    Immune to duplicate texts and virtualization holes.
 * 2. OCCURRENCE (fallback): only when ALL copies of a (level, text)
 *    pair are rendered. With missing copies, occurrence indices are
 *    ambiguous; leave those elements unmatched so jumps use source lines.
 *
 * Headings inside embedded notes or callouts are excluded — they exist in
 * the rendered DOM but never in the model. Obsidian may virtualize
 * distant sections; both strategies tolerate missing elements.
 */
export function matchPreviewHeadings(
	previewEl: HTMLElement,
	items: readonly HeadingItem[],
): PreviewHeadingMatch[] {
	const elements = Array.from(
		previewEl.querySelectorAll<HTMLElement>(HEADING_SELECTOR),
	).filter((element) => !element.closest(EXCLUDED_ANCESTOR_SELECTOR));

	// Model lookups: exact line → index, and (level::text) → ordered indices.
	const byLine = new Map<number, number>();
	const modelOccurrences = new Map<string, number[]>();
	for (let i = 0; i < items.length; i++) {
		if (!byLine.has(items[i].line)) byLine.set(items[i].line, i);
		const base = `${items[i].level}::${items[i].text}`;
		const list = modelOccurrences.get(base);
		if (list) {
			list.push(i);
		} else {
			modelOccurrences.set(base, [i]);
		}
	}

	const domOccurrences = new Map<string, HTMLElement[]>();
	for (const element of elements) {
		const base = `${element.tagName.charAt(1)}::${previewHeadingText(element)}`;
		const list = domOccurrences.get(base) ?? [];
		list.push(element);
		domOccurrences.set(base, list);
	}
	const used = new Set<number>();
	const matches = new Map<HTMLElement, PreviewHeadingMatch>();

	// Reserve every authoritative match before considering any fallback.
	for (const element of elements) {
		const level = Number(element.tagName.charAt(1));
		const line = readPreviewSourceLine(element);
		if (line !== null) {
			const modelIndex = byLine.get(line);
			if (
				modelIndex !== undefined &&
				!used.has(modelIndex) &&
				items[modelIndex].level === level
			) {
				used.add(modelIndex);
				matches.set(element, { modelIndex, element, matchedBy: "line" });
			}
		}
	}

	for (const [base, copies] of domOccurrences) {
		const candidates = modelOccurrences.get(base);
		if (!candidates || copies.length !== candidates.length) continue;
		// Conflicting line anchors mean even equal counts are not reliable.
		if (copies.some((element, i) => {
			const line = readPreviewSourceLine(element);
			return line !== null && line !== items[candidates[i]].line;
		})) continue;
		for (let i = 0; i < copies.length; i++) {
			const element = copies[i];
			const modelIndex = candidates[i];
			if (matches.has(element) || used.has(modelIndex)) continue;
			used.add(modelIndex);
			matches.set(element, { modelIndex, element, matchedBy: "occurrence" });
		}
	}

	return elements.flatMap((element) => {
		const match = matches.get(element);
		return match ? [match] : [];
	});
}
