/**
 * Coordinate systems around a CodeMirror editor, centralized (P0-2).
 *
 * Four spaces are involved and MUST NOT be mixed implicitly:
 *  - document space:  y from the top of the rendered document
 *                     (`lineBlockAt(offset).top` lives here)
 *  - scroll space:    `scrollDOM.scrollTop` / `clientHeight`
 *                     (also includes inline title, properties and padding)
 *  - viewport space:  y relative to the visible top of the scroller
 *                     (viewport = document − scrollTop)
 *  - client space:    `getBoundingClientRect()` coordinates
 *                     (client = viewport + scrollerRect.top)
 *
 * The adapter is deliberately DUMB: pure conversions over a minimal CM
 * surface, no caching, no listeners — so it can be unit-tested with a
 * fake CM view and never goes stale.
 */

/** Minimal CodeMirror 6 surface the adapter relies on. */
export interface CmViewLike {
	scrollDOM: HTMLElement;
	/** Client-space top of the first document line, excluding padding. */
	readonly documentTop?: number;
	readonly documentPadding?: { top: number; bottom: number };
	contentDOM?: HTMLElement;
	lineBlockAt(pos: number): { top: number; height: number };
}

export class EditorPositionAdapter {
	constructor(private readonly cm: CmViewLike) {}

	/** Document-space top of the line block containing `offset`. */
	documentTopOfOffset(offset: number): number {
		return this.cm.lineBlockAt(offset).top;
	}

	/** Document-space y of the activation line (top + ratio × height). */
	activationLineDocument(ratio: number): number {
		return this.viewportToDocument(this.cm.scrollDOM.clientHeight * ratio);
	}

	/** Document origin in scroll space, including host content above CM. */
	contentOriginOffset(): number {
		const { scrollDOM, contentDOM, documentTop } = this.cm;
		if (typeof documentTop === "number" && Number.isFinite(documentTop)) {
			return documentTop - scrollDOM.getBoundingClientRect().top + scrollDOM.scrollTop;
		}
		if (contentDOM) {
			return contentDOM.getBoundingClientRect().top -
				scrollDOM.getBoundingClientRect().top + scrollDOM.scrollTop +
				(this.cm.documentPadding?.top ?? 0);
		}
		// Older/stripped-down CM surfaces expose no origin information.
		return 0;
	}

	/** document space → viewport space. */
	documentToViewport(documentY: number): number {
		return documentY + this.contentOriginOffset() - this.cm.scrollDOM.scrollTop;
	}

	/** viewport space → document space. */
	viewportToDocument(viewportY: number): number {
		return viewportY + this.cm.scrollDOM.scrollTop - this.contentOriginOffset();
	}

	/** viewport space → client space (needs one rect read). */
	viewportToClient(viewportY: number): number {
		return viewportY + this.cm.scrollDOM.getBoundingClientRect().top;
	}
}
