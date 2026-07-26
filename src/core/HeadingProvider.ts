import type { App, TFile } from "obsidian";
import type { HeadingItem, RawHeading } from "../model/HeadingItem";
import { buildHeadingItems } from "../utils/headingIdentity";

/**
 * Dual-channel heading source.
 *
 * - Authoritative channel: `metadataCache.getFileCache(file).headings`.
 * - Live channel: instant parsing of the current editor text, so newly
 *   typed / deleted / renamed headings show up immediately and are later
 *   corrected by the metadata cache.
 */
export class HeadingProvider {
	constructor(private readonly app: App) {}

	/** Authoritative headings from the metadata cache. */
	fromCache(file: TFile): HeadingItem[] {
		const cached = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		return buildHeadingItems(
			cached.map((heading) => ({
				level: heading.level,
				text: heading.heading,
				line: heading.position.start.line,
			})),
		);
	}

	/** Instant headings parsed from raw markdown text. */
	fromText(markdown: string): HeadingItem[] {
		return buildHeadingItems(parseMarkdownHeadings(markdown));
	}
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const SETEXT_H1_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2_RE = /^ {0,3}-+[ \t]*$/;
const LIST_OR_QUOTE_RE = /^ {0,3}(?:[-*+][ \t]|\d+[.)][ \t]|>)/;

/**
 * Parse ATX (H1–H6) and simple Setext (H1/H2) headings from markdown.
 *
 * - Skips fenced code blocks (``` and ~~~, up to 3 leading spaces; the
 *   closing fence must use the same character and be at least as long).
 * - Skips YAML frontmatter at the start of the document.
 * - Excludes empty headings ("#" with no text).
 * - Keeps duplicates; identity disambiguation happens later.
 */
export function parseMarkdownHeadings(markdown: string): RawHeading[] {
	const lines = markdown.split(/\r?\n/);
	const headings: RawHeading[] = [];

	let startLine = 0;
	if (lines[0]?.trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed === "---" || trimmed === "...") {
				startLine = i + 1;
				break;
			}
		}
	}

	let inFence = false;
	let fenceChar = "";
	let fenceLength = 0;
	/** Previous non-consumed line, for Setext detection. */
	let prevLine: string | null = null;
	let prevLineIndex = -1;
	let prevLineWasHeading = false;

	for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		const fenceMatch = line.match(FENCE_RE);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const char = marker[0];
			if (!inFence) {
				inFence = true;
				fenceChar = char;
				fenceLength = marker.length;
			} else if (
				char === fenceChar &&
				marker.length >= fenceLength &&
				fenceMatch[2].trim() === ""
			) {
				inFence = false;
			}
			prevLine = null;
			prevLineWasHeading = false;
			continue;
		}
		if (inFence) continue;

		const atxMatch = line.match(ATX_RE);
		if (atxMatch) {
			// Strip optional closing hashes: "## Title ##" -> "Title".
			// "##  ##" (hashes only) is an empty heading and is excluded.
			let text = atxMatch[2].trim();
			text = /^#+$/.test(text)
				? ""
				: text.replace(/[ \t]+#+$/, "").trim();
			if (text.length > 0) {
				headings.push({ level: atxMatch[1].length, text, line: lineIndex });
				prevLineWasHeading = true;
			} else {
				prevLineWasHeading = false;
			}
			prevLine = null;
			continue;
		}

		// Setext underline: promote the previous paragraph line.
		if (
			prevLine !== null &&
			!prevLineWasHeading &&
			(SETEXT_H1_RE.test(line) || SETEXT_H2_RE.test(line))
		) {
			const text = prevLine.trim();
			if (
				text.length > 0 &&
				!LIST_OR_QUOTE_RE.test(prevLine) &&
				!prevLine.startsWith("    ")
			) {
				headings.push({
					level: SETEXT_H1_RE.test(line) ? 1 : 2,
					text,
					line: prevLineIndex,
				});
				prevLine = null;
				prevLineWasHeading = true;
				continue;
			}
		}

		prevLineWasHeading = false;
		prevLine = line.trim().length > 0 ? line : null;
		prevLineIndex = lineIndex;
	}

	return headings;
}
