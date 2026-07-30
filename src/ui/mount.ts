/**
 * The mount layer — the one place Glide Outline is allowed to touch DOM it
 * does not own.
 *
 * Glide Outline lives inside a MarkdownView's `contentEl`, which belongs to
 * Obsidian and is shared with every other plugin that decorates the editor.
 * Three rules follow from that, and this module is where they are enforced:
 *
 * 1. **One owned node.** Everything the plugin renders hangs off a single
 *    wrapper tagged `data-glide-outline-owner`. Nothing else is added to the
 *    host, so unmounting is `wrapper.remove()` and cannot leave debris.
 *    The wrapper is `display: contents`, so it generates no box and the rail
 *    lays out exactly as if it were a direct child of the host.
 *
 * 2. **Ownership is checkable.** `owns()` and `OWNED_SELECTOR` let every
 *    `closest()` in the codebase ask "is this actually mine?" instead of
 *    trusting a class name that any other plugin (or a stale copy of us)
 *    could also be using.
 *
 * 3. **Host mutation is conditional and reversible.** The rail is absolutely
 *    positioned, so it needs the host to be a containing block. Rather than
 *    permanently branding the host with a class, we check first: when the
 *    host is already positioned — which it is in current Obsidian — we write
 *    nothing at all. Only a `static` host gets an inline `position: relative`,
 *    recorded here and restored verbatim on dispose, and only if nobody else
 *    has written over it in the meantime.
 *
 * Mounting is idempotent: any owned wrapper already sitting in the host (a
 * previous instance that was never disposed, e.g. after a reload mid-frame)
 * is swept before the new one is attached, so a double mount can never leave
 * two rails behind.
 */

export const OWNER_ATTR = "data-glide-outline-owner";
export const OWNER_VALUE = "glide-outline";
export const INSTANCE_ATTR = "data-glide-outline-instance";

/** Matches any node Glide Outline owns — never a foreign lookalike. */
export const OWNED_SELECTOR = `[${OWNER_ATTR}="${OWNER_VALUE}"]`;

/** Monotonic per-process instance id (unique across pop-out windows). */
let mountSeq = 0;

/** Anything with a `closest`, duck-typed for pop-out windows. */
interface ClosestCapable {
	closest?(selector: string): Element | null;
}

/**
 * §十一: what the mount observed and did to the HOST node. Pure
 * observation — exposing these numbers changes no mount behaviour.
 * `mountHostInlinePositionAfter` / `mountRestoredHostPosition` are
 * updated at dispose time; before dispose they describe the mounted
 * state.
 */
export interface MountHostMutationDiagnostics {
	/** getComputedStyle(host).position at mount time. */
	mountHostComputedPosition: string;
	/** host.style.position BEFORE any write of ours ("" when unset). */
	mountHostInlinePositionBefore: string;
	/** True when we wrote inline `position: relative` onto the host. */
	mountMutatedHostPosition: boolean;
	/** host.style.position after mount (== before when not mutated). */
	mountHostInlinePositionAfter: string;
	/** True once dispose verbatim-restored the host's inline position. */
	mountRestoredHostPosition: boolean;
	/** Owned wrappers from earlier instances swept away at mount. */
	staleMountsRemoved: number;
}

export interface OutlineMount {
	/** The owned wrapper. All plugin DOM must be created inside it. */
	readonly mountEl: HTMLElement;
	/** Stable id for this mount, mirrored onto the wrapper. */
	readonly instanceId: string;
	/** §十一: host-mutation observation (live object, updated on dispose). */
	readonly diagnostics: MountHostMutationDiagnostics;
	/** True when `node` lives inside this mount. */
	owns(node: unknown): boolean;
	/** Idempotent: detaches the wrapper and undoes any host mutation. */
	dispose(): void;
}

/** Remove owned wrappers left behind by an instance that never disposed. */
function sweepStaleMounts(hostEl: HTMLElement): number {
	let removed = 0;
	for (const child of Array.from(hostEl.children)) {
		if (child.getAttribute?.(OWNER_ATTR) === OWNER_VALUE) {
			child.remove();
			removed++;
		}
	}
	return removed;
}

export function createOutlineMount(hostEl: HTMLElement): OutlineMount {
	const doc = hostEl.ownerDocument;
	const instanceId = `${++mountSeq}`;

	const staleMountsRemoved = sweepStaleMounts(hostEl);
	const inlinePositionBefore = hostEl.style.position;

	const mountEl = doc.createElement("div");
	mountEl.className = "glide-outline-mount";
	mountEl.setAttribute(OWNER_ATTR, OWNER_VALUE);
	mountEl.setAttribute(INSTANCE_ATTR, instanceId);

	// Containing block for the absolutely positioned rail. Only written when
	// the host would not provide one anyway — see the header note.
	const win = doc.defaultView;
	const hostPosition =
		win && typeof win.getComputedStyle === "function"
			? win.getComputedStyle(hostEl).position
			: "";
	const anchored = hostPosition === "static";
	const previousInlinePosition = anchored ? hostEl.style.position : null;
	if (anchored) hostEl.style.position = "relative";

	hostEl.appendChild(mountEl);

	// §十一: observation only — every value mirrors a decision the mount
	// already made above; nothing reads back later except dispose.
	const diagnostics: MountHostMutationDiagnostics = {
		mountHostComputedPosition: hostPosition,
		mountHostInlinePositionBefore: inlinePositionBefore,
		mountMutatedHostPosition: anchored,
		mountHostInlinePositionAfter: hostEl.style.position,
		mountRestoredHostPosition: false,
		staleMountsRemoved,
	};

	let disposed = false;
	return {
		mountEl,
		instanceId,
		diagnostics,
		owns(node: unknown): boolean {
			const candidate = node as Node | null;
			if (!candidate || typeof candidate.nodeType !== "number") return false;
			return mountEl.contains(candidate);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			mountEl.remove();
			// Restore only what we wrote, and only if it is still ours —
			// another actor may legitimately have changed it since.
			if (anchored && hostEl.style.position === "relative") {
				hostEl.style.position = previousInlinePosition ?? "";
				if (hostEl.getAttribute("style") === "") {
					hostEl.removeAttribute("style");
				}
				diagnostics.mountRestoredHostPosition = true;
			}
			diagnostics.mountHostInlinePositionAfter = hostEl.style.position;
		},
	};
}

/**
 * `closest(selector)` that additionally refuses anything outside Glide
 * Outline's own subtree — fail-closed addressing for event targets, which
 * can originate anywhere in the document.
 */
export function closestOwned(
	target: unknown,
	selector: string,
	owns?: (node: unknown) => boolean,
): Element | null {
	const el = target as (ClosestCapable & Element) | null;
	if (!el || typeof el.closest !== "function") return null;
	const found = el.closest(selector);
	if (!found) return null;
	if (owns) return owns(found) ? found : null;
	// No mount reference available (pure helpers, tests): fall back to the
	// ownership attribute, which foreign lookalikes do not carry.
	return found.closest(OWNED_SELECTOR) ? found : null;
}
