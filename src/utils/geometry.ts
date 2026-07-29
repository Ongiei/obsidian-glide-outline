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
 * Options that align the solver with what the user actually SEES (P0-5).
 *
 * Rows are laid out at their base centers, but the rendered card/marker
 * moves by the previous frame's translateY (`--glide-shift-y`). The
 * pointer lives in VISUAL space; the solver works in BASE space. These
 * options carry the previous frame's shifts (visualCenter = center +
 * shift) plus, when the pointer is physically over a row element, that
 * row's index as the authoritative anchor.
 */
export interface CollisionSolveOptions {
	/**
	 * Previous frame's translateY per item (same order). When present and
	 * length-matched, the pointer is mapped from visual space into base
	 * space before solving. Single implicit iteration per frame — the
	 * previous shifts are read, never re-derived, so the mapping cannot
	 * oscillate within a frame; across frames it converges because the
	 * displacement field is smooth with |gradient| < 1.
	 */
	currentShifts?: readonly number[];
	/**
	 * Index of the row the pointer is visually over (from DOM hit-testing,
	 * e.g. `event.target.closest(".glide-outline-row")`). Takes priority
	 * over the nearest-visual-center estimate. -1 / undefined = blank
	 * area: fall back to interpolating between visual centers.
	 */
	preferredAnchorIndex?: number;
}

/**
 * Map a pointer position from VISUAL space to BASE space (pure, P0-5).
 *
 * With an anchor: subtract exactly that row's current shift, so a pointer
 * resting on the visually displaced card of row A yields distance 0 to
 * A's base center — A gets the maximum scale, matching what the user
 * points at.
 *
 * Without an anchor (blank area): interpolate the shift between the two
 * visual centers bracketing the pointer. The interpolation is continuous
 * in pointerY, so sweeping across blank space never teleports the
 * magnification focus.
 */
export function mapVisualPointerToBase(
	pointerY: number,
	baseCenters: readonly number[],
	currentShifts: readonly number[],
	preferredAnchorIndex?: number,
): number {
	const n = baseCenters.length;
	if (!Number.isFinite(pointerY) || n === 0 || currentShifts.length !== n) {
		return pointerY;
	}
	const shiftAt = (i: number): number =>
		Number.isFinite(currentShifts[i]) ? currentShifts[i] : 0;
	if (
		preferredAnchorIndex !== undefined &&
		preferredAnchorIndex >= 0 &&
		preferredAnchorIndex < n
	) {
		return pointerY - shiftAt(preferredAnchorIndex);
	}
	// Visual centers keep the base order (the solver never reorders rows).
	const firstVisual = baseCenters[0] + shiftAt(0);
	if (pointerY <= firstVisual) return pointerY - shiftAt(0);
	const lastVisual = baseCenters[n - 1] + shiftAt(n - 1);
	if (pointerY >= lastVisual) return pointerY - shiftAt(n - 1);
	for (let i = 0; i + 1 < n; i++) {
		const lower = baseCenters[i] + shiftAt(i);
		const upper = baseCenters[i + 1] + shiftAt(i + 1);
		if (pointerY >= lower && pointerY <= upper) {
			const span = upper - lower;
			const t = span > 0 ? (pointerY - lower) / span : 0;
			const shift = shiftAt(i) + (shiftAt(i + 1) - shiftAt(i)) * t;
			return pointerY - shift;
		}
	}
	return pointerY;
}

/**
 * DPR snap headroom (§三): written shifts are pixel-aligned per row, so two
 * adjacent rows whose RAW shifts differ by ε can straddle a rounding
 * boundary and end up a full device pixel closer after snapping. Pairs that
 * the magnification actively spreads (either side scaled > 1) get this much
 * extra clearance so the WRITTEN geometry keeps the published invariant.
 * Uniformly-shifted pairs snap identically (no relative error), and taper
 * pairs differ by whole pixels (snap commutes) — neither needs headroom.
 */
export const COLLISION_SNAP_HEADROOM_PX = 1;

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
	options?: CollisionSolveOptions,
): CollisionLayoutResult[] {
	const n = items.length;
	if (n === 0) return [];
	if (reducedMotion || !Number.isFinite(pointerY)) {
		return items.map(() => ({ scale: 1, translateY: 0 }));
	}
	// P0-5: the pointer arrives in visual space; solve in base space.
	if (options?.currentShifts) {
		pointerY = mapVisualPointerToBase(
			pointerY,
			items.map((item) => item.center),
			options.currentShifts,
			options.preferredAnchorIndex,
		);
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

	// Per-pair minimum gap: never demand MORE clearance than the base
	// layout provides at identity (§四). If the DOM stacks rows tighter
	// than `minimumGap`, that spacing is the renderer's business — the
	// solver must not "fix" it by spreading untouched rows apart, which
	// would push an unbounded displacement across the whole list.
	const pairGaps = new Array<number>(Math.max(0, n - 1));
	for (let i = 0; i + 1 < n; i++) {
		const baseGap =
			items[i + 1].center -
			items[i].center -
			Math.max(0, items[i].height) / 2 -
			Math.max(0, items[i + 1].height) / 2;
		let pg = Math.min(gap, Math.max(0, baseGap));
		// §三 DPR snap headroom: the controller writes `--glide-shift-y`
		// pixel-aligned (`Math.round(shift·dpr)/dpr`), so two adjacent rows
		// whose RAW targets differ by ε can straddle a rounding boundary and
		// end up ~1 device pixel CLOSER after snapping — that can violate
		// the published gap invariant by up to OVERLAP_TOLERANCE_PX. Pairs
		// the magnification ACTIVELY spreads (either side scaled > 1) get
		// this much extra clearance so the WRITTEN geometry keeps the
		// invariant. Uniformly-shifted pairs snap identically (no relative
		// error) and taper pairs differ by whole pixels (snap commutes) —
		// neither needs headroom, so we only widen active pairs.
		if (scales[i] > 1 || scales[i + 1] > 1) {
			pg += COLLISION_SNAP_HEADROOM_PX;
		}
		pairGaps[i] = pg;
	}

	// 2. Anchored solve: `anchor` keeps its original center; constraints
	// propagate outward without ever pulling items toward the anchor.
	const solve = (anchor: number): number[] => {
		const centers = new Array<number>(n);
		centers[anchor] = items[anchor].center;
		for (let i = anchor - 1; i >= 0; i--) {
			const required =
				scaledHeights[i] / 2 + scaledHeights[i + 1] / 2 + pairGaps[i];
			centers[i] = Math.min(items[i].center, centers[i + 1] - required);
		}
		for (let i = anchor + 1; i < n; i++) {
			const required =
				scaledHeights[i - 1] / 2 + scaledHeights[i] / 2 + pairGaps[i - 1];
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
