/**
 * Coordinate systems around a CodeMirror editor, centralized (P0-2).
 *
 * Four spaces are involved and MUST NOT be mixed implicitly:
 *  - document space:  y from the top of the rendered document
 *                     (`lineBlockAt(offset).top` lives here)
 *  - scroll space:    `scrollDOM.scrollTop` / `clientHeight`
 *                     (scroll space offsets document space by scrollTop)
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
		const scroller = this.cm.scrollDOM;
		return scroller.scrollTop + scroller.clientHeight * ratio;
	}

	/** document space → viewport space. */
	documentToViewport(documentY: number): number {
		return documentY - this.cm.scrollDOM.scrollTop;
	}

	/** viewport space → document space. */
	viewportToDocument(viewportY: number): number {
		return viewportY + this.cm.scrollDOM.scrollTop;
	}

	/** viewport space → client space (needs one rect read). */
	viewportToClient(viewportY: number): number {
		return viewportY + this.cm.scrollDOM.getBoundingClientRect().top;
	}
}
