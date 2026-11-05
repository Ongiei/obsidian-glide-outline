/** Short, jitter-tolerant aiming pause; never moves the OS pointer. */
export const POINTER_SNAP_DWELL_MS = 100;
export const POINTER_SNAP_ACQUIRE_PX = 6;
export const POINTER_SNAP_RELEASE_PX = 18;

export class PointerSnap {
	private key: string | null = null;
	private x = 0;
	private y = 0;
	private since = 0;
	locked = false;
	get targetKey(): string | null { return this.locked ? this.key : null; }

	clear(): void {
		this.key = null;
		this.locked = false;
	}

	update(key: string | null, x: number, y: number, now: number): number {
		if (!Number.isFinite(x + y + now)) {
			this.clear();
			return 0;
		}
		const distance = Math.hypot(x - this.x, y - this.y);
		// DOM hits may change as neighbours move or a tiny hand movement
		// crosses a gap. Keep the ORIGINAL target through that deadband.
		if (this.locked && distance <= POINTER_SNAP_RELEASE_PX) return 0;
		if (!key) { this.clear(); return 0; }
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
