import type { PointerEnvelopeItem, Rect } from "../utils/envelope";

/** Only the shared width between consecutive cards belongs to their gap. */
export function headingGap(a: Rect, b: Rect): Rect | null {
	const left = Math.max(a.left, b.left);
	const right = Math.min(a.right, b.right);
	const height = b.top - a.bottom;
	if (!(right > left && height > 0 && height <= 32)) return null;
	return { left, right, top: a.bottom, bottom: b.top };
}

/** Hover strips for the gaps between cards. They have no activation role. */
export class HeadingGapBridges {
	readonly el: HTMLElement;
	private readonly nodes: HTMLElement[] = [];
	private readonly dom: { createDiv: typeof createDiv };

	constructor(viewport: HTMLElement) {
		this.dom = viewport.ownerDocument.win as Window & { createDiv: typeof createDiv };
		this.el = this.dom.createDiv();
		this.el.className = "glide-outline-gap-layer";
		this.el.setAttribute("aria-hidden", "true");
		viewport.append(this.el);
	}

	update(items: readonly PointerEnvelopeItem[], viewportLeft: number): void {
		let count = 0;
		for (let i = 1; i < items.length; i++) {
			const gap = headingGap(items[i - 1].cardRect, items[i].cardRect);
			if (!gap) continue;
			let el = this.nodes[count];
			if (!el) {
				el = this.dom.createDiv();
				el.className = "glide-outline-heading-gap";
				this.el.append(el);
				this.nodes.push(el);
			}
			const geometry = {
				"--glide-gap-left": gap.left - viewportLeft,
				"--glide-gap-top": gap.top,
				"--glide-gap-width": gap.right - gap.left,
				"--glide-gap-height": gap.bottom - gap.top,
			};
			for (const [key, value] of Object.entries(geometry)) {
				const text = `${value.toFixed(3)}px`;
				if (el.style.getPropertyValue(key) !== text) el.style.setProperty(key, text);
			}
			count++;
		}
		while (this.nodes.length > count) this.nodes.pop()?.remove();
	}

	clear(): void {
		this.el.replaceChildren();
		this.nodes.length = 0;
	}

	dispose(): void {
		this.clear();
		this.el.remove();
	}
}
