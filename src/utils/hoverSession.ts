import type { PointerEnvelope } from "./envelope";

/** Hover retention only: never creates an invisible DOM/click surface. */
export class HoverSession {
	private left = Infinity;
	private right = -Infinity;
	clear(): void { this.left = Infinity; this.right = -Infinity; }
	include(envelope: PointerEnvelope): void {
		for (const item of envelope.items) {
			const r = item.bridgeRect;
			if (r.right <= r.left) continue;
			this.left = Math.min(this.left, r.left);
			this.right = Math.max(this.right, r.right);
		}
	}
	contains(x: number, y: number, top: number, bottom: number): boolean {
		return bottom > top && y >= top && y <= bottom && x >= this.left && x <= this.right;
	}
}
