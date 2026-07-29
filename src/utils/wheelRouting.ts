/**
 * §十 Wheel routing (pure math, no DOM): decide whether a wheel event
 * belongs to the Outline, should be handed to the editor, or ignored.
 *
 * The controller listens on the WINDOW in the capture phase; every
 * decision input is a cached boolean/number — deciding ownership never
 * reads layout. Ownership rules:
 *
 *   - Outline collapsed / a heading held (pressed)      → ignore
 *   - Ctrl/Meta (zoom gesture) or dominant horizontal    → ignore
 *   - Pointer not over the outline nor inside envelope   → ignore
 *   - Outline has no overflow                            → editor handoff
 *   - Scrolling past a boundary it cannot pass           → editor handoff
 *   - Otherwise                                          → outline owns it
 */

/** After a manual wheel on the outline, edge auto-scroll AND pointer
 * follow stay paused this long — the user's hand is on the wheel; the
 * outline must not fight it. The outline never collapses on wheel. */
export const MANUAL_WHEEL_COOLDOWN_MS = 160;

/** deltaMode 1 (line) → px conversion. Firefox reports lines. */
export const WHEEL_LINE_HEIGHT_PX = 16;
/** deltaMode 2 (page) fallback height when the viewport is unknown. */
export const WHEEL_PAGE_FALLBACK_PX = 400;

export type WheelRouteAction = "outline" | "editor" | "ignore";

export type WheelIgnoreReason =
	| "collapsed"
	| "pressed"
	| "zoom-gesture"
	| "horizontal"
	| "zero-delta"
	| "outside"
	| "no-overflow"
	| "boundary";

export interface WheelRouteInput {
	/** Outline expanded (pointer or focus)? Collapsed = never ours. */
	expanded: boolean;
	/** A heading is held (pointerdown lock) — wheel must not scroll. */
	pressed: boolean;
	/** Cached outline overflow state. */
	hasOverflow: boolean;
	canScrollUp: boolean;
	canScrollDown: boolean;
	/** Raw wheel deltas + mode from the event. */
	deltaY: number;
	deltaX: number;
	/** 0 = pixel, 1 = line, 2 = page (WheelEvent.deltaMode). */
	deltaMode: number;
	ctrlKey: boolean;
	metaKey: boolean;
	/** Event target inside the outline root (marker/card/rail/list). */
	targetInOutline: boolean;
	/** Pointer inside the geometric envelope (incl. transparent gaps). */
	insideEnvelope: boolean;
	/** Outline viewport height for deltaMode 2 normalization. */
	viewportHeight: number;
}

export interface WheelRouteDecision {
	action: WheelRouteAction;
	/** Normalized scroll delta in px (0 unless action = "outline"). */
	deltaPx: number;
	/** Why the event was NOT taken by the outline; null when it was. */
	reason: WheelIgnoreReason | null;
}

/** Normalize a wheel delta to pixels (§十.3). */
export function normalizeWheelDelta(
	deltaY: number,
	deltaMode: number,
	viewportHeight: number,
): number {
	if (!Number.isFinite(deltaY)) return 0;
	switch (deltaMode) {
		case 1:
			return deltaY * WHEEL_LINE_HEIGHT_PX;
		case 2: {
			const page =
				Number.isFinite(viewportHeight) && viewportHeight > 0
					? viewportHeight
					: WHEEL_PAGE_FALLBACK_PX;
			return deltaY * page;
		}
		default:
			return deltaY;
	}
}

export function resolveWheelRoute(input: WheelRouteInput): WheelRouteDecision {
	if (!input.expanded) {
		return { action: "ignore", deltaPx: 0, reason: "collapsed" };
	}
	if (input.pressed) {
		return { action: "ignore", deltaPx: 0, reason: "pressed" };
	}
	// Zoom gestures (Ctrl+wheel, pinch-as-ctrl) belong to the app.
	if (input.ctrlKey || input.metaKey) {
		return { action: "ignore", deltaPx: 0, reason: "zoom-gesture" };
	}
	// Dominantly horizontal wheels are never outline scrolling.
	if (Math.abs(input.deltaX) > Math.abs(input.deltaY)) {
		return { action: "ignore", deltaPx: 0, reason: "horizontal" };
	}
	const deltaPx = normalizeWheelDelta(
		input.deltaY,
		input.deltaMode,
		input.viewportHeight,
	);
	if (deltaPx === 0) {
		return { action: "ignore", deltaPx: 0, reason: "zero-delta" };
	}
	// Ownership: over an outline element OR inside the geometric envelope
	// (transparent marker↔card gaps count as outline ground).
	if (!input.targetInOutline && !input.insideEnvelope) {
		return { action: "ignore", deltaPx: 0, reason: "outside" };
	}
	// Nothing to scroll — the editor keeps its native behaviour.
	if (!input.hasOverflow) {
		return { action: "editor", deltaPx: 0, reason: "no-overflow" };
	}
	// Boundary handoff (§十.4): wheeling past a dead end passes through.
	if (deltaPx < 0 && !input.canScrollUp) {
		return { action: "editor", deltaPx: 0, reason: "boundary" };
	}
	if (deltaPx > 0 && !input.canScrollDown) {
		return { action: "editor", deltaPx: 0, reason: "boundary" };
	}
	return { action: "outline", deltaPx, reason: null };
}
