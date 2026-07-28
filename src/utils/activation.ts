/**
 * Heading activation from a real visual target.
 *
 * Click / pointer activation must act ONLY on the marker or card the user
 * actually sees. Transparent regions — the motion corridor, the gap
 * between a marker and its card, row slack, the viewport background, the
 * edge fade and any removed interaction surface — must NEVER trigger a
 * jump. We resolve the heading from the actually-hit element via
 * `closest()`, never from pointer coordinates or a corridor button.
 *
 * Duck-typed `closest`/`classList` so the same code path works inside
 * pop-out windows where the element constructors differ from the main window.
 */

export type ActivationTargetType = "marker" | "card";

export interface ActivationTarget {
	key: string;
	targetType: ActivationTargetType;
}

interface ClosestCapable {
	closest?(selector: string): Element | null;
	classList?: { contains?(className: string): boolean };
}

/**
 * Resolve which heading a click / pointer activation should act on.
 *
 * @returns the heading key + whether a marker or card was hit, or `null`
 *   when the event did not land on a real marker or card.
 */
export function resolveClickTarget(
	target: EventTarget | null,
): ActivationTarget | null {
	const el = target as (ClosestCapable & Element) | null;
	if (!el || typeof el.closest !== "function") return null;
	const interactive = el.closest(".glide-outline-marker, .glide-outline-card");
	if (!interactive) return null;
	const item = interactive.closest(".glide-outline-item");
	const key = item?.getAttribute?.("data-key");
	if (!key) return null;
	const targetType: ActivationTargetType = interactive.classList?.contains(
		"glide-outline-card",
	)
		? "card"
		: "marker";
	return { key, targetType };
}
