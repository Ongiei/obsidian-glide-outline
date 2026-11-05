/** H1 is independently configured; the quick slider controls H2..H6. */
export function setHeadingDepth(levels: boolean[], depth: number): void {
	const last = Number.isFinite(depth) ? Math.max(2, Math.min(6, Math.round(depth))) : 2;
	for (let level = 2; level <= 6; level++) levels[level - 1] = level <= last;
}
