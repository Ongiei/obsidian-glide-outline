import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * §十 / §十七: the active marker — line OR dot — must always be painted in
 * the user's own Obsidian accent.
 *
 * The failure this guards against is a cascade accident, not a typo. Every
 * rule in this sheet is wrapped in `:where(...)`, which contributes ZERO
 * specificity, so an accent declaration can be tied by any later rule of
 * equal weight (the quiet `--text-faint` base, the dot geometry block, a
 * hover treatment) and lose on source order alone — the marker then stays
 * grey while the DOM says it is active. Static analysis is the right tool
 * here: jsdom implements no cascade, so a rendered assertion would prove
 * nothing.
 */
const RAW = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
/** Comments hold example selectors — strip them before parsing. */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");

const OWNER_SCOPE = ":where([data-glide-outline-owner])";
const MARKER_PSEUDO = ".glide-outline-marker::before";

interface Rule {
	selectors: string[];
	body: string;
	at: number;
}

function rules(): Rule[] {
	const out: Rule[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(CSS)) !== null) {
		out.push({
			selectors: match[1]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			body: match[2],
			at: match.index,
		});
	}
	return out;
}

const ALL_RULES = rules();

/** Rules with at least one selector ending in the marker pseudo-element. */
const MARKER_RULES = ALL_RULES.filter((rule) =>
	rule.selectors.some((s) => s.endsWith(MARKER_PSEUDO)),
);

const ACCENT_PAINTS = MARKER_RULES.filter((rule) =>
	/background-color:\s*var\(--interactive-accent\)/.test(rule.body),
);

/**
 * The authoritative active-state block: the LAST marker rule in the sheet
 * that paints the accent. Source order is the whole point — see the block
 * comment above it in styles.css.
 */
const ACCENT_RULE = [...ACCENT_PAINTS].reverse()[0];

describe("active marker accent (§十)", () => {
	it("resolves the active state in one block at the end of the sheet", () => {
		expect(ACCENT_RULE).toBeDefined();
		// Only two rules in the whole sheet paint a marker with the accent:
		// the generic focus-visible feedback (any focused item) and this
		// active-state block. Both use the same variable, so a marker that
		// is active AND focused cannot get two different answers.
		expect(ACCENT_PAINTS).toHaveLength(2);
		for (const rule of ACCENT_PAINTS) {
			expect(rule.body).toMatch(
				/background-color:\s*var\(--interactive-accent\)/,
			);
		}
		// Every active-state selector lives in this one block, so the whole
		// question is decided in a single place.
		expect((ACCENT_RULE?.selectors ?? []).length).toBe(8);
		for (const selector of ACCENT_RULE?.selectors ?? []) {
			expect(selector).toMatch(/\.is-active|\[aria-current="true"\]/);
		}
	});

	it("covers line and dot markers, active by class AND by aria-current", () => {
		const selectors = (ACCENT_RULE?.selectors ?? []).map((s) =>
			s.startsWith(`${OWNER_SCOPE} `) ? s.slice(OWNER_SCOPE.length + 1) : s,
		);
		// Line (the default marker style) — the generic, unqualified form.
		expect(selectors).toContain(
			`.glide-outline-item.is-active ${MARKER_PSEUDO}`,
		);
		expect(selectors).toContain(
			`.glide-outline-item[aria-current="true"] ${MARKER_PSEUDO}`,
		);
		// Dot — same states, but qualified by the root marker-style class so
		// it also outranks the dot geometry block.
		expect(selectors).toContain(
			`.glide-outline-root--marker-dot .glide-outline-item.is-active ${MARKER_PSEUDO}`,
		);
		expect(selectors).toContain(
			`.glide-outline-root--marker-dot .glide-outline-item[aria-current="true"] ${MARKER_PSEUDO}`,
		);
		// Hovering an expanded rail must not repaint the active marker.
		expect(selectors).toContain(
			`.glide-outline-root.is-expanded .glide-outline-item.is-active:hover ${MARKER_PSEUDO}`,
		);
		// Nor may keyboard focus.
		expect(selectors).toContain(
			`.glide-outline-root button.glide-outline-item.is-active:focus-visible ${MARKER_PSEUDO}`,
		);
	});

	it("pins full opacity so no inherited fade can dilute the accent", () => {
		expect(ACCENT_RULE?.body).toMatch(/opacity:\s*1\s*;/);
	});

	it("uses the theme variable — never a hard-coded colour", () => {
		const body = ACCENT_RULE?.body ?? "";
		expect(body).toMatch(/background-color:\s*var\(--interactive-accent\)/);
		expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(body).not.toMatch(/\brgba?\(/);
		expect(body).not.toMatch(/\bhsla?\(/);
	});

	it("never resorts to !important", () => {
		expect(ACCENT_RULE?.body).not.toMatch(/!important/);
		// …and neither does any other marker rule.
		for (const rule of MARKER_RULES) {
			expect(rule.body).not.toMatch(/!important/);
		}
	});

	it("scopes every accent selector under the ownership attribute", () => {
		for (const selector of ACCENT_RULE?.selectors ?? []) {
			expect(selector.startsWith(`${OWNER_SCOPE} `)).toBe(true);
		}
	});

	it("is the LAST marker paint in the sheet — nothing can outrank it later", () => {
		const accentAt = ACCENT_RULE?.at ?? -1;
		expect(accentAt).toBeGreaterThan(0);
		const later = MARKER_RULES.filter(
			(rule) =>
				rule.at > accentAt &&
				/(^|[;{\s])(background-color|background|opacity|color)\s*:/.test(
					rule.body,
				),
		);
		expect(later.map((r) => r.selectors.join(", "))).toEqual([]);
	});

	it("keeps the dot's active rule geometry-only", () => {
		// The dot block used to carry the colour too. Two equal-weight rules
		// painting the same pixel is the whole bug — the active dot's own
		// block must now only scale it.
		const dotActive = ALL_RULES.find(
			(rule) =>
				rule.at < (ACCENT_RULE?.at ?? Number.POSITIVE_INFINITY) &&
				rule.selectors.some(
					(s) =>
						s.includes("--marker-dot") &&
						s.includes(".is-active") &&
						s.endsWith(MARKER_PSEUDO),
				),
		);
		expect(dotActive).toBeDefined();
		expect(dotActive?.body).toMatch(/scale:\s*1\.3/);
		expect(dotActive?.body).not.toMatch(/background-color/);
	});

	it("still paints inactive markers with the quiet base colour", () => {
		const base = MARKER_RULES.find(
			(rule) =>
				rule.selectors.length === 1 &&
				rule.selectors[0] === `${OWNER_SCOPE} ${MARKER_PSEUDO}`,
		);
		expect(base).toBeDefined();
		expect(base?.body).toMatch(/background-color:\s*var\(--text-faint\)/);
		// The accent must come later in source order than the quiet base.
		expect(ACCENT_RULE?.at ?? -1).toBeGreaterThan(base?.at ?? 0);
	});

	it("transitions the accent rather than snapping it", () => {
		const base = MARKER_RULES.find(
			(rule) => rule.selectors[0] === `${OWNER_SCOPE} ${MARKER_PSEUDO}`,
		);
		expect(base?.body).toMatch(/transition:[^;]*background-color/);
	});
});
