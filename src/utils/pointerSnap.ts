/** Short, jitter-tolerant aiming pause; never moves the OS pointer. */
export const POINTER_SNAP_DWELL_MS = 100;
export const POINTER_SNAP_ACQUIRE_PX = 6;
export const POINTER_SNAP_RELEASE_PX = 12;

export class PointerSnap {
	private key: string | null = null;
	private x = 0;
	private y = 0;
	private since = 0;
	locked = false;

	clear(): void {
		this.key = null;
		this.locked = false;
	}

	update(key: string | null, x: number, y: number, now: number): number {
		if (!key || !Number.isFinite(x + y + now)) {
			this.clear();
			return 0;
		}
		const distance = Math.hypot(x - this.x, y - this.y);
		const tolerance = this.locked
			? POINTER_SNAP_RELEASE_PX
			: POINTER_SNAP_ACQUIRE_PX;
		if (key !== this.key || distance > tolerance) {
			this.key = key;
			this.x = x;
			this.y = y;
			this.since = now;
			this.locked = false;
		}
		const remaining = Math.max(0, POINTER_SNAP_DWELL_MS - (now - this.since));
		if (remaining === 0) this.locked = true;
		return remaining;
	}
}
