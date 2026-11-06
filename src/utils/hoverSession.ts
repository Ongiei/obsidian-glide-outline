import { pointInRect, type PointerEnvelope } from "./envelope";

/** Hover retention only: never creates an invisible DOM/click surface. */
export class HoverSession {
	private envelope: PointerEnvelope | null = null;
	clear(): void { this.envelope = null; }
	include(envelope: PointerEnvelope): void {
		this.envelope = envelope;
	}
	contains(x: number, y: number, top: number, bottom: number): boolean {
		if (!(bottom > top && y >= top && y <= bottom)) return false;
		const items = this.envelope?.items ?? [];
		for (let i = 0; i < items.length; i++) {
			const a = items[i].bridgeRect;
			if (a.right > a.left && pointInRect(a, x, y)) return true;
			const b = items[i + 1]?.bridgeRect;
			// Only bridge a small gap between these two neighbours. A wide
			// heading never lends its width to the rest of the viewport.
			if (b && b.top - a.bottom <= 32 && y >= a.bottom && y <= b.top &&
				x >= Math.min(a.left, b.left) && x <= Math.max(a.right, b.right)) return true;
		}
		return false;
	}
}
