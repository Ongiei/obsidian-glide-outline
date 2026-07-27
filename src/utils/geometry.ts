/**
 * Pure geometry for dock-style proximity magnification.
 *
 * Everything in this module works on plain numbers in a single coordinate
 * system chosen by the caller (Glide Outline uses viewport client
 * coordinates for both the pointer and cached item centers). No DOM access.
 */

export interface MagnificationResult {
	/** Scale factor, 1 <= scale <= maxScale. */
	scale: number;
	/** Vertical displacement in px. Negative above the pointer, positive below. */
	translateY: number;
}

export interface MagnificationOptions {
	/**
	 * Peak vertical displacement in px. Defaults to a value proportional to
	 * the extra height introduced by magnification.
	 */
	shiftAmplitude?: number;
	/** When true, every item gets scale 1 / translateY 0. */
	reducedMotion?: boolean;
}

/**
 * Cosine-falloff scale.
 * distance 0 → maxScale; distance >= radius → 1; smooth in between.
 */
export function computeScale(
	distance: number,
	maxScale: number,
	radius: number,
): number {
	if (!Number.isFinite(distance) || !Number.isFinite(maxScale)) return 1;
	if (radius <= 0 || maxScale <= 1) return 1;
	const d = Math.abs(distance);
	if (d >= radius) return 1;
	return 1 + ((maxScale - 1) * (1 + Math.cos((Math.PI * d) / radius))) / 2;
}

/**
 * Continuous vertical displacement so magnified neighbours give way.
 *
 * Uses a sine profile: zero at the pointer (sign flips there, so continuity
 * requires it), zero again at the radius edge, peaking in between. Items
 * above the pointer move up (negative), items below move down (positive).
 */
export function computeShift(
	signedOffset: number,
	radius: number,
	amplitude: number,
): number {
	if (!Number.isFinite(signedOffset) || radius <= 0 || amplitude <= 0) return 0;
	const d = Math.abs(signedOffset);
	if (d === 0 || d >= radius) return 0;
	const magnitude = amplitude * Math.sin((Math.PI * d) / radius);
	return signedOffset > 0 ? magnitude : -magnitude;
}

/** Default displacement amplitude derived from the magnification strength. */
export function defaultShiftAmplitude(maxScale: number): number {
	return Math.max(0, maxScale - 1) * 34;
}

/**
 * Compute scale + displacement for every item center.
 *
 * @param pointerY    pointer position (same coordinate system as itemCenters)
 * @param itemCenters vertical centers of the outline items
 * @param maxScale    peak scale at distance 0
 * @param radius      falloff radius in px
 */
export function computeMagnification(
	pointerY: number,
	itemCenters: readonly number[],
	maxScale: number,
	radius: number,
	options?: MagnificationOptions,
): MagnificationResult[] {
	const reduced = options?.reducedMotion === true;
	const amplitude = options?.shiftAmplitude ?? defaultShiftAmplitude(maxScale);
	return itemCenters.map((center) => {
		if (reduced || !Number.isFinite(pointerY) || !Number.isFinite(center)) {
			return { scale: 1, translateY: 0 };
		}
		const offset = center - pointerY;
		return {
			scale: round3(computeScale(offset, maxScale, radius)),
			translateY: round2(computeShift(offset, radius, amplitude)),
		};
	});
}

/** One outline row as seen by the collision solver. */
export interface CollisionLayoutItem {
	/** Vertical center of the row (any consistent coordinate system). */
	center: number;
	/** Unscaled height of the visual card in px. */
	height: number;
}

export interface CollisionLayoutResult {
	scale: number;
	translateY: number;
}

/**
 * Collision-free dock magnification (pure function).
 *
 * 1. Every item gets a cosine-falloff scale from its distance to the pointer.
 * 2. An anchored layout keeps one item at its original center and pushes
 *    neighbours outward just enough that scaled half-heights plus
 *    `minimumGap` never overlap (never pulling anything inward).
 * 3. To stay continuous while the pointer sweeps, the final layout is a
 *    linear blend of the two anchored layouts surrounding the pointer.
 *    The separation constraints are linear inequalities (an intersection of
 *    half-spaces, hence a convex set), so any convex combination of two
 *    feasible layouts is itself feasible — the invariant survives blending.
 *
 * Guarantees for any adjacent pair (i, i+1):
 *   finalCenter(i+1) - finalCenter(i)
 *     >= scaledHeight(i)/2 + scaledHeight(i+1)/2 + minimumGap
 *
 * Items must be ordered top-to-bottom (ascending center).
 */
export function computeCollisionFreeMagnification(
	pointerY: number,
	items: readonly CollisionLayoutItem[],
	maxScale: number,
	radius: number,
	minimumGap: number,
	reducedMotion?: boolean,
): CollisionLayoutResult[] {
	const n = items.length;
	if (n === 0) return [];
	if (reducedMotion || !Number.isFinite(pointerY)) {
		return items.map(() => ({ scale: 1, translateY: 0 }));
	}
	const gap = Math.max(0, minimumGap);

	// 1. Scales and scaled heights. Scales are rounded *before* the solve so
	// the published invariant holds exactly for the values consumers see.
	const scales = new Array<number>(n);
	const scaledHeights = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const scale = round3(
			computeScale(items[i].center - pointerY, maxScale, radius),
		);
		scales[i] = scale;
		scaledHeights[i] = Math.max(0, items[i].height) * scale;
	}

	// 2. Anchored solve: `anchor` keeps its original center; constraints
	// propagate outward without ever pulling items toward the anchor.
	const solve = (anchor: number): number[] => {
		const centers = new Array<number>(n);
		centers[anchor] = items[anchor].center;
		for (let i = anchor - 1; i >= 0; i--) {
			const required = scaledHeights[i] / 2 + scaledHeights[i + 1] / 2 + gap;
			centers[i] = Math.min(items[i].center, centers[i + 1] - required);
		}
		for (let i = anchor + 1; i < n; i++) {
			const required = scaledHeights[i - 1] / 2 + scaledHeights[i] / 2 + gap;
			centers[i] = Math.max(items[i].center, centers[i - 1] + required);
		}
		return centers;
	};

	// 3. Continuous anchoring: blend the two anchored layouts that surround
	// the pointer. A hard "nearest center" switch would teleport items when
	// the pointer crosses the midpoint between two rows.
	let centers: number[];
	if (pointerY <= items[0].center) {
		centers = solve(0);
	} else if (pointerY >= items[n - 1].center) {
		centers = solve(n - 1);
	} else {
		let k = 0;
		while (k + 1 < n && items[k + 1].center <= pointerY) k++;
		const span = items[k + 1].center - items[k].center;
		const t = span > 0 ? (pointerY - items[k].center) / span : 0;
		if (t <= 0) {
			centers = solve(k);
		} else {
			const lower = solve(k);
			const upper = solve(k + 1);
			centers = lower.map((c, i) => c + (upper[i] - c) * t);
		}
	}

	return items.map((item, i) => ({
		scale: scales[i],
		translateY: round2(centers[i] - item.center),
	}));
}

/**
 * Select the active heading index for a given activation line.
 * Returns the last heading whose top is at or above the activation line;
 * the first heading when none qualifies; -1 for an empty list.
 */
export function selectActiveIndex(
	headingTops: readonly number[],
	activationY: number,
): number {
	if (headingTops.length === 0) return -1;
	let active = -1;
	for (let i = 0; i < headingTops.length; i++) {
		if (headingTops[i] <= activationY) active = i;
	}
	return active === -1 ? 0 : active;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
