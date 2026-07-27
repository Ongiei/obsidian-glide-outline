import type { ViewUpdate } from "@codemirror/view";

/**
 * Minimal shape of a CodeMirror update as consumed by the tracker.
 * Extracted so tests can feed synthetic updates without CM instances.
 */
export interface EditorUpdateSummary {
	/** The EditorView the update belongs to (identity only). */
	view: unknown;
	selectionSet: boolean;
	viewportChanged: boolean;
	geometryChanged: boolean;
	docChanged: boolean;
}

export type EditorUpdateHandler = (update: EditorUpdateSummary) => void;

/**
 * Event bridge between the plugin-level CodeMirror update listener and
 * per-view subscribers (P0-2).
 *
 * `registerEditorExtension` installs ONE `EditorView.updateListener` for
 * every editor in the workspace; each GlideOutlineController only cares
 * about updates of ITS MarkdownView's editor. The bridge fans updates out
 * to subscribers, which filter by EditorView identity themselves.
 */
export class EditorUpdateBridge {
	private readonly handlers = new Set<EditorUpdateHandler>();

	/** Fan a summarized CM update out to every subscriber. */
	dispatch(update: EditorUpdateSummary): void {
		for (const handler of this.handlers) {
			try {
				handler(update);
			} catch (error) {
				console.error("[glide-outline] editor update handler failed", error);
			}
		}
	}

	/** Subscribe; returns an unsubscribe cleanup. */
	subscribe(handler: EditorUpdateHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}
}

/** Reduce a full CM ViewUpdate to the fields the tracker consumes. */
export function summarizeViewUpdate(update: ViewUpdate): EditorUpdateSummary {
	return {
		view: update.view,
		selectionSet: update.selectionSet,
		viewportChanged: update.viewportChanged,
		geometryChanged: update.geometryChanged,
		docChanged: update.docChanged,
	};
}
