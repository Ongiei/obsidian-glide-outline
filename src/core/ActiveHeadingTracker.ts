import { MarkdownView } from "obsidian";
import type { HeadingItem } from "../model/HeadingItem";
import { selectActiveIndex } from "../utils/geometry";
import { matchPreviewHeadings } from "../utils/previewHeadings";
import { DisposableStore } from "../utils/disposable";

/** Activation line sits at 20% of the viewport height. */
export const ACTIVATION_RATIO = 0.2;

/** Minimal CodeMirror 6 surface we rely on (accessed defensively). */
interface CmView {
	scrollDOM: HTMLElement;
	lineBlockAt(pos: number): { top: number; height: number };
}

/**
 * Determines the "currently read" heading from the scroll viewport —
 * NOT from the editor cursor. The heading whose top is the last one at or
 * above the activation line (viewport top + 20% height) wins.
 *
 * Edit modes use CodeMirror line-block coordinates; Reading Mode uses the
 * rendered h1–h6 DOM. Updates are RAF-throttled.
 */
export class ActiveHeadingTracker {
	private readonly disposables = new DisposableStore();
	private readonly win: Window;
	private items: readonly HeadingItem[] = [];
	private activeKey: string | null = null;
	private rafId = 0;
	private disposed = false;

	constructor(
		private readonly view: MarkdownView,
		private readonly onChange: (key: string | null) => void,
	) {
		const win = view.contentEl.ownerDocument.defaultView;
		if (!win) throw new Error("glide-outline: detached document");
		this.win = win;

		const onScroll = (event: Event): void => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			if (
				!target.classList.contains("cm-scroller") &&
				!target.classList.contains("markdown-preview-view")
			) {
				return;
			}
			this.schedule();
		};
		view.contentEl.addEventListener("scroll", onScroll, {
			capture: true,
			passive: true,
		});
		this.disposables.add(() =>
			view.contentEl.removeEventListener("scroll", onScroll, { capture: true }),
		);
	}

	setItems(items: readonly HeadingItem[]): void {
		this.items = items;
		this.schedule();
	}

	/** Request a recomputation on the next animation frame. */
	schedule(): void {
		if (this.disposed || this.rafId !== 0) return;
		this.rafId = this.win.requestAnimationFrame(() => {
			this.rafId = 0;
			this.compute();
		});
	}

	dispose(): void {
		this.disposed = true;
		if (this.rafId !== 0) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.disposables.dispose();
	}

	private compute(): void {
		if (this.disposed) return;
		const index = this.computeIndex();
		const key = index >= 0 && index < this.items.length ? this.items[index].key : null;
		if (key !== this.activeKey) {
			this.activeKey = key;
			this.onChange(key);
		}
	}

	private computeIndex(): number {
		if (this.items.length === 0) return -1;
		if (this.view.getMode() === "preview") return this.computePreviewIndex();
		return this.computeEditorIndex();
	}

	private computeEditorIndex(): number {
		const editor = this.view.editor;
		const cm = (editor as unknown as { cm?: CmView }).cm;
		if (cm?.scrollDOM) {
			try {
				const scroller = cm.scrollDOM;
				const activationY =
					scroller.scrollTop + scroller.clientHeight * ACTIVATION_RATIO;
				const lastLine = Math.max(0, editor.lineCount() - 1);
				const tops = this.items.map((item) => {
					const line = Math.min(item.line, lastLine);
					const offset = editor.posToOffset({ line, ch: 0 });
					return cm.lineBlockAt(offset).top;
				});
				return selectActiveIndex(tops, activationY);
			} catch {
				// CM internals shifted — fall through to the line approximation.
			}
		}
		// Fallback: approximate with line numbers against the visible range.
		const scrollInfo = (
			editor as unknown as {
				getScrollInfo?: () => { top: number; clientHeight?: number };
			}
		).getScrollInfo?.();
		if (!scrollInfo) return 0;
		const lineHeightGuess = 24;
		const activationY =
			scrollInfo.top + (scrollInfo.clientHeight ?? 400) * ACTIVATION_RATIO;
		const tops = this.items.map((item) => item.line * lineHeightGuess);
		return selectActiveIndex(tops, activationY);
	}

	private computePreviewIndex(): number {
		const previewEl = this.view.contentEl.querySelector<HTMLElement>(
			".markdown-preview-view",
		);
		if (!previewEl) return 0;
		const rect = previewEl.getBoundingClientRect();
		const activationY = rect.top + previewEl.clientHeight * ACTIVATION_RATIO;
		const matches = matchPreviewHeadings(previewEl, this.items);
		if (matches.length === 0) return 0;
		let active = -1;
		for (const match of matches) {
			if (match.element.getBoundingClientRect().top <= activationY) {
				active = match.modelIndex;
			} else {
				break;
			}
		}
		return active === -1 ? matches[0].modelIndex : active;
	}
}
