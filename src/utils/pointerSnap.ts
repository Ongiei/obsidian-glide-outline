import { pointInRect, type Rect } from "./envelope";
/** Immediate, geometry-locked aiming; never moves the OS pointer. */
export const POINTER_SNAP_DWELL_MS = 0;
export const POINTER_SNAP_ACQUIRE_PX = 6;
export const POINTER_SNAP_RELEASE_PX = 18;

export class PointerSnap {
	private key: string | null = null;
	private x = 0;
	private y = 0;
	private bounds: Rect | null = null;
	locked = false;
	get targetKey(): string | null { return this.locked ? this.key : null; }

	clear(): void {
		this.key = null;
		this.locked = false;
		this.bounds = null;
	}

	holds(x: number, y: number): boolean {
		return this.locked && (this.inDeadband(x, y) ||
			(this.bounds !== null && pointInRect(this.bounds, x, y)));
	}

	inDeadband(x: number, y: number): boolean {
		return this.locked && Math.hypot(x - this.x, y - this.y) <= POINTER_SNAP_RELEASE_PX;
	}

	update(key: string | null, x: number, y: number, now: number, rect?: Rect): number {
		if (!Number.isFinite(x + y + now)) {
			this.clear();
			return 0;
		}
		// DOM hits may change as neighbours move or a tiny hand movement
		// crosses a gap. Keep the ORIGINAL target through that deadband.
		if (this.holds(x, y)) return 0;
		// A valid neighbouring card can take over in this same frame.
		// Releasing first and waiting another frame creates a visible gap
		// in target ownership even during a deliberate slow handoff.
		if (this.locked) this.clear();
		if (!key) { this.clear(); return 0; }
		this.key = key;
		this.x = x;
		this.y = y;
		this.bounds = rect && rect.bottom > rect.top && rect.right > rect.left
			? { left: rect.left - 6, right: rect.right + 6, top: rect.top - 6, bottom: rect.bottom + 6 }
			: null;
		this.locked = true;
		return 0;
	}
}
