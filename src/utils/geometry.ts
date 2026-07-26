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
