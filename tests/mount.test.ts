// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import {
	closestOwned,
	createOutlineMount,
	INSTANCE_ATTR,
	OWNED_SELECTOR,
	OWNER_ATTR,
	OWNER_VALUE,
} from "../src/ui/mount";
import { resolveClickTarget } from "../src/utils/activation";

/**
 * Mount isolation (§ "the plugin owns exactly one node").
 *
 * Glide Outline renders into a MarkdownView's `contentEl`, a node owned by
 * Obsidian and shared with every other plugin. These tests pin the three
 * guarantees that make that safe: one owned wrapper, a reversible lifecycle,
 * and addressing that fails closed when it meets a foreign lookalike.
 */

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::0`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = [heading(1, "Alpha", 0), heading(2, "Beta", 5)];

describe("owned mount wrapper", () => {
	let host: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = "";
		host = document.createElement("div");
		document.body.appendChild(host);
	});

	it("adds exactly one node to the host, and tags it as owned", () => {
		const before = host.childNodes.length;
		const mount = createOutlineMount(host);

		expect(host.childNodes.length).toBe(before + 1);
		expect(mount.mountEl.parentElement).toBe(host);
		expect(mount.mountEl.getAttribute(OWNER_ATTR)).toBe(OWNER_VALUE);
		expect(mount.mountEl.getAttribute(INSTANCE_ATTR)).toBe(mount.instanceId);
		expect(host.querySelectorAll(OWNED_SELECTOR).length).toBe(1);
	});

	it("issues a distinct instance id per mount", () => {
		const a = createOutlineMount(host);
		const other = document.createElement("div");
		document.body.appendChild(other);
		const b = createOutlineMount(other);

		expect(a.instanceId).not.toBe(b.instanceId);
	});

	it("sweeps a stale owned wrapper instead of stacking a second rail", () => {
		const stale = document.createElement("div");
		stale.setAttribute(OWNER_ATTR, OWNER_VALUE);
		stale.textContent = "left behind by a reload";
		host.appendChild(stale);

		const mount = createOutlineMount(host);

		expect(stale.isConnected).toBe(false);
		expect(host.querySelectorAll(OWNED_SELECTOR).length).toBe(1);
		expect(host.querySelector(OWNED_SELECTOR)).toBe(mount.mountEl);
	});

	it("leaves the host byte-for-byte unchanged after dispose", () => {
		host.setAttribute("class", "markdown-source-view");
		const before = host.outerHTML;

		const mount = createOutlineMount(host);
		expect(host.outerHTML).not.toBe(before);

		mount.dispose();
		expect(host.outerHTML).toBe(before);
	});

	it("is idempotent on dispose", () => {
		const mount = createOutlineMount(host);
		mount.dispose();
		expect(() => mount.dispose()).not.toThrow();
		expect(host.querySelectorAll(OWNED_SELECTOR).length).toBe(0);
	});

	it("does not touch a host that is already a containing block", () => {
		host.style.position = "absolute";
		const mount = createOutlineMount(host);

		expect(host.style.position).toBe("absolute");
		mount.dispose();
		expect(host.style.position).toBe("absolute");
	});

	it("restores a foreign inline position written after we anchored", () => {
		// jsdom reports `static` for an unstyled div, so the mount anchors.
		const mount = createOutlineMount(host);
		expect(host.style.position).toBe("relative");

		// Another actor takes over the property — we must not clobber it.
		host.style.position = "sticky";
		mount.dispose();
		expect(host.style.position).toBe("sticky");
	});
});

describe("fail-closed ownership addressing", () => {
	let host: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = "";
		host = document.createElement("div");
		document.body.appendChild(host);
	});

	it("owns() accepts its own subtree and rejects everything else", () => {
		const mount = createOutlineMount(host);
		const inside = document.createElement("span");
		mount.mountEl.appendChild(inside);
		const outside = document.createElement("span");
		host.appendChild(outside);

		expect(mount.owns(inside)).toBe(true);
		expect(mount.owns(mount.mountEl)).toBe(true);
		expect(mount.owns(outside)).toBe(false);
		expect(mount.owns(null)).toBe(false);
		expect(mount.owns({ closest: () => null })).toBe(false);
	});

	it("closestOwned refuses a foreign node wearing our class names", () => {
		const mount = createOutlineMount(host);

		const mine = document.createElement("div");
		mine.className = "glide-outline-marker";
		mount.mountEl.appendChild(mine);

		// Another plugin (or a theme snippet) using the same class name.
		const impostor = document.createElement("div");
		impostor.className = "glide-outline-marker";
		host.appendChild(impostor);

		expect(closestOwned(mine, ".glide-outline-marker", mount.owns)).toBe(mine);
		expect(closestOwned(impostor, ".glide-outline-marker", mount.owns)).toBe(
			null,
		);
		// Without a mount reference it falls back to the ownership attribute,
		// which the impostor does not carry.
		expect(closestOwned(impostor, ".glide-outline-marker")).toBe(null);
		expect(closestOwned(mine, ".glide-outline-marker")).toBe(mine);
		expect(closestOwned(null, ".glide-outline-marker")).toBe(null);
	});

	it("resolveClickTarget ignores an unowned lookalike", () => {
		const mount = createOutlineMount(host);

		const card = (parent: HTMLElement): HTMLElement => {
			const item = document.createElement("button");
			item.className = "glide-outline-item";
			item.dataset.key = "1::alpha::0";
			const surface = document.createElement("div");
			surface.className = "glide-outline-card";
			item.appendChild(surface);
			parent.appendChild(item);
			return surface;
		};

		const owned = card(mount.mountEl);
		const impostor = card(host);

		expect(resolveClickTarget(owned, mount.owns)).not.toBe(null);
		expect(resolveClickTarget(impostor, mount.owns)).toBe(null);
		expect(resolveClickTarget(impostor)).toBe(null);
	});
});

describe("GlideOutlineView lifecycle isolation", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;

	beforeEach(() => {
		document.body.innerHTML = "";
		host = document.createElement("div");
		host.className = "markdown-source-view";
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
	});

	it("restores the host exactly, including its class list", () => {
		const before = host.outerHTML;
		const view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);

		expect(host.querySelectorAll(OWNED_SELECTOR).length).toBe(1);
		expect(host.classList.contains("glide-outline-host")).toBe(false);

		view.dispose();
		expect(host.outerHTML).toBe(before);
	});

	it("never leaves two rails behind when a view is recreated", () => {
		const first = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		first.setItems(HEADINGS);
		// Simulate a reload where dispose never ran.
		const second = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		second.setItems(HEADINGS);

		expect(host.querySelectorAll(OWNED_SELECTOR).length).toBe(1);
		expect(host.querySelectorAll(".glide-outline-root").length).toBe(1);

		second.dispose();
		expect(host.querySelectorAll(OWNED_SELECTOR).length).toBe(0);
	});

	it("answers ownership questions for its own subtree", () => {
		const view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);

		const card = host.querySelector(".glide-outline-card");
		expect(card).not.toBe(null);
		expect(view.owns(card)).toBe(true);
		expect(view.owns(host)).toBe(false);
		view.dispose();
	});
});

/* --------------------------------------------------------------------------
   Static sweeps: these fail the build if a tooltip or an unscoped rule is
   ever reintroduced, which review alone would not reliably catch.
   -------------------------------------------------------------------------- */

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

const SRC_DIR = resolve(process.cwd(), "src");
const SRC_FILES = sourceFiles(SRC_DIR);

/** Source with comments removed — prose may still discuss tooltips. */
function code(file: string): string {
	return readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

describe("the plugin ships no tooltips", () => {
	it("never writes aria-label (Obsidian renders it as a hover bubble)", () => {
		for (const file of SRC_FILES) {
			const body = code(file).replace(/aria-labelledby/g, "");
			expect(body, file).not.toContain("aria-label");
		}
	});

	it("never sets title, data-tooltip or Obsidian's tooltip helpers", () => {
		for (const file of SRC_FILES) {
			const body = code(file);
			expect(body, file).not.toContain("setTooltip");
			expect(body, file).not.toContain("setDynamicTooltip");
			expect(body, file).not.toContain("data-tooltip");
			expect(body, file).not.toMatch(/\.title\s*=/);
			expect(body, file).not.toMatch(/setAttribute\(\s*["']title["']/);
		}
	});

	it("gives every accessible name a real sr-only target", () => {
		const view = readFileSync(join(SRC_DIR, "ui", "GlideOutlineView.ts"), "utf8");
		expect(view).toContain("glide-outline-a11y-label");
		expect(view).toContain("aria-labelledby");
	});
});

describe("styles.css is scoped fail-closed", () => {
	const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const SCOPE = ":where([data-glide-outline-owner])";

	/** Selector lists of every top-level rule (depth 0), one per rule. */
	function topLevelSelectors(): string[] {
		const selectors: string[] = [];
		let depth = 0;
		let buffer = "";
		for (const char of stripped) {
			if (char === "{") {
				if (depth === 0) selectors.push(buffer.trim());
				buffer = "";
				depth++;
			} else if (char === "}") {
				depth = Math.max(0, depth - 1);
				buffer = "";
			} else {
				buffer += char;
			}
		}
		return selectors.filter(Boolean);
	}

	it("prefixes every selector of every rule with the ownership scope", () => {
		for (const list of topLevelSelectors()) {
			// At-rules (@media, @keyframes …) carry no selector of their own;
			// their nested rules are checked by the same scan at depth 0.
			if (list.startsWith("@") || list.startsWith(":root")) continue;
			for (const selector of list.split(",")) {
				const trimmed = selector.trim();
				if (!trimmed) continue;
				// Percentage keyframe stops are not selectors.
				if (/^(from|to|[\d.]+%)$/.test(trimmed)) continue;
				expect(trimmed.startsWith(SCOPE), trimmed).toBe(true);
			}
		}
	});

	it("uses :where for the scope so existing specificity is untouched", () => {
		// A bare attribute prefix would add (0,1,0) to every rule and could
		// start winning against theme rules that used to win.
		expect(stripped).not.toMatch(/^\[data-glide-outline-owner\]/m);
	});

	it("no longer styles the host by class (anchoring is inline + reversible)", () => {
		expect(stripped).not.toContain(".glide-outline-host");
	});

	it("keeps the wrapper boxless so layout is unchanged", () => {
		expect(stripped).toMatch(
			/:where\(\[data-glide-outline-owner\]\)\.glide-outline-mount\s*\{[^}]*display:\s*contents/,
		);
	});

	it("contains no :has and no !important", () => {
		expect(stripped).not.toContain(":has(");
		expect(stripped).not.toContain("!important");
	});
});
