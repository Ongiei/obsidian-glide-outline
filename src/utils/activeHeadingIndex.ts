/**
 * Last heading at/before a position in an ordered model. Query positions
 * lazily so scrolling needs O(log N) CodeMirror measurements, no full array.
 * Equal positions (folded blocks, clamped deleted lines) choose the last.
 */
export function activeHeadingIndex(
	count: number,
	positionAt: (index: number) => number,
	position: number,
): number {
	if (count === 0) return -1;
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (positionAt(mid) <= position) lo = mid + 1;
		else hi = mid;
	}
	return Math.max(0, lo - 1);
}
