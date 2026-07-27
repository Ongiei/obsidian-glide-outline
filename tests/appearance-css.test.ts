import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS regressions for the appearance round: horizontal offset placement,
 * hierarchy staircase, per-level marker sizes and overflow edge fades.
 * (Same static-analysis style as the button-reset tests.)
 */
const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

function declarations(selectorPart: string): string[] {
	const blocks: string[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(css)) !== null) {
		if (match[1].includes(selectorPart)) blocks.push(match[2]);
	}
	return blocks;
}

/** Declaration block whose (comma-free) selector matches EXACTLY. */
function exactBlock(selector: string): string {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(stripped)) !== null) {
		if (match[1].trim() === selector) return match[2];
	}
	return "";
}

describe("horizontal offset placement", () => {
	it("anchors the right side with the offset variable, not 0", () => {
		const right = exactBlock(".glide-outline-root--right");
		expect(right).toMatch(/right:\s*var\(--glide-horizontal-offset/);
		expect(right).not.toMatch(/right:\s*0(px)?\s*(;|$)/);
	});

	it("anchors the left side with the same variable", () => {
		const left = exactBlock(".glide-outline-root--left");
		expect(left).toMatch(/left:\s*var\(--glide-horizontal-offset/);
	});
});

describe("hierarchy staircase", () => {
	it("adds the level indent to the marker→card column gap", () => {
		const motion = declarations(".glide-outline-motion").join(";");
		expect(motion).toMatch(
			/column-gap:\s*calc\(\s*var\(--glide-label-gap[^)]*\)\s*\+\s*var\(--glide-level-indent/,
		);
	});
});

describe("per-level marker sizes", () => {
	function sizesFor(variable: string): string[] {
		const values: string[] = [];
		for (let level = 1; level <= 6; level++) {
			const blocks = declarations(`[data-level="${level}"]`).join(";");
			const match = blocks.match(new RegExp(`${variable}:\\s*([\\d.]+px)`));
			if (match) values.push(match[1]);
		}
		return values;
	}

	it("defines six strictly decreasing line lengths", () => {
		const sizes = sizesFor("--glide-line-size").map(parseFloat);
		expect(sizes).toHaveLength(6);
		for (let i = 1; i < sizes.length; i++) {
			expect(sizes[i]).toBeLessThan(sizes[i - 1]);
		}
	});

	it("defines six DISTINCT dot diameters (no more uniform dots)", () => {
		const sizes = sizesFor("--glide-dot-size").map(parseFloat);
		expect(sizes).toHaveLength(6);
		expect(new Set(sizes).size).toBe(6);
		for (let i = 1; i < sizes.length; i++) {
			expect(sizes[i]).toBeLessThan(sizes[i - 1]);
		}
	});

	it("sizes dots from their own variable, never clamped to the line size", () => {
		const dot = declarations(
			".glide-outline-root--marker-dot .glide-outline-marker::before",
		).join(";");
		expect(dot).toMatch(/width:\s*var\(--glide-dot-size/);
		expect(dot).toMatch(/height:\s*var\(--glide-dot-size/);
		expect(dot).not.toContain("min(");
	});

	it("highlights the active dot with a paint-only scale", () => {
		const active = declarations(
			".glide-outline-root--marker-dot .glide-outline-item.is-active .glide-outline-marker::before",
		).join(";");
		expect(active).toMatch(/scale:\s*[\d.]+/);
		// Paint-only: the active state must not change layout boxes.
		expect(active).not.toMatch(/width|height|margin|padding/);
	});
});

describe("overflow edge fades", () => {
	it("masks the viewport only when the feature class is on", () => {
		const gated = declarations(
			".glide-outline-root--edge-fade .glide-outline-viewport",
		);
		expect(gated.join(";")).toContain("mask-image");
		// No unconditional mask on the bare viewport selector.
		const bare = declarations(".glide-outline-viewport").filter(
			(_, i, arr) => arr, // keep all; check below on non-gated ones
		);
		const ungated = bare.filter(
			(block) => !gated.includes(block),
		);
		for (const block of ungated) {
			expect(block).not.toContain("mask-image");
		}
	});

	it("ships the -webkit- prefix alongside the standard property", () => {
		const gated = declarations(
			".glide-outline-root--edge-fade .glide-outline-viewport",
		).join(";");
		expect(gated).toContain("-webkit-mask-image");
	});

	it("defaults both fade stops to 0 (invisible without overflow)", () => {
		const gated = declarations(
			".glide-outline-root--edge-fade .glide-outline-viewport",
		).join(";");
		expect(gated).toMatch(/--glide-fade-top-stop:\s*0px/);
		expect(gated).toMatch(/--glide-fade-bottom-stop:\s*0px/);
	});

	it("activates each stop from its own state class", () => {
		expect(css).toMatch(
			/\.glide-outline-root--edge-fade\.glide-outline-root--fade-top[^{]*\{[^}]*--glide-fade-top-stop:\s*var\(--glide-edge-fade-size/,
		);
		expect(css).toMatch(
			/\.glide-outline-root--edge-fade\.glide-outline-root--fade-bottom[^{]*\{[^}]*--glide-fade-bottom-stop:\s*var\(--glide-edge-fade-size/,
		);
	});

	it("never intercepts pointer events for the fade (mask, not overlay)", () => {
		// The fade must be a mask on the viewport itself — no extra overlay
		// element classes exist in the stylesheet.
		expect(css).not.toContain("glide-outline-fade-overlay");
	});
});

describe("text effect variables", () => {
	it("applies the TS-built halo under its feature class only", () => {
		expect(css).toMatch(
			/\.glide-outline-root--text-halo[^{]*\{[^}]*text-shadow:\s*var\(--glide-text-halo/,
		);
		// The old directional shadow class is gone for good.
		expect(css).not.toContain("glide-outline-root--text-shadow");
		expect(css).not.toContain("--glide-text-shadow:");
	});

	it("applies the hairline stroke under its feature class", () => {
		expect(css).toMatch(
			/\.glide-outline-root--text-stroke[^{]*\{[^}]*-webkit-text-stroke:\s*var\(--glide-text-stroke/,
		);
	});
});

describe("level badge", () => {
	it("hides the badge unless the feature class is on", () => {
		const base = exactBlock(".glide-outline-level-badge");
		expect(base).toMatch(/display:\s*none/);
		const gated = exactBlock(
			".glide-outline-root--level-badge .glide-outline-level-badge",
		);
		expect(gated).toMatch(/display:\s*inline-block/);
	});

	it("keeps the badge non-interactive for hit-testing", () => {
		const base = exactBlock(".glide-outline-level-badge");
		expect(base).toMatch(/pointer-events:\s*none/);
	});

	it("recolors the active badge with the accent", () => {
		const active = declarations(
			".glide-outline-item.is-active .glide-outline-level-badge",
		).join(";");
		expect(active).toMatch(/--interactive-accent|--glide-accent/);
	});
});

describe("H1–H6 label typography ramp", () => {
	function labelRamp(property: string): string[] {
		const values: string[] = [];
		for (let level = 1; level <= 6; level++) {
			const block = exactBlock(
				`.glide-outline-item[data-level="${level}"] .glide-outline-label`,
			);
			const match = block.match(
				new RegExp(`${property}:\\s*([^;\\n]+)`),
			);
			if (match) values.push(match[1].trim());
		}
		return values;
	}

	it("defines six non-increasing font weights, heaviest for H1", () => {
		const weights = labelRamp("font-weight").map(Number);
		expect(weights).toHaveLength(6);
		expect(weights[0]).toBeGreaterThanOrEqual(650);
		expect(weights[5]).toBeLessThanOrEqual(450);
		for (let i = 1; i < weights.length; i++) {
			expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
		}
	});

	it("defines six non-increasing font sizes", () => {
		const sizes = labelRamp("font-size").map(parseFloat);
		expect(sizes).toHaveLength(6);
		for (let i = 1; i < sizes.length; i++) {
			expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
		}
		expect(sizes[5]).toBeLessThan(sizes[0]);
	});
});

describe("hover interaction corridor", () => {
	it("keeps the motion wrapper inert while collapsed", () => {
		const motion = exactBlock(".glide-outline-motion");
		expect(motion).toMatch(/pointer-events:\s*none/);
	});

	it("activates the corridor only when expanded or focused", () => {
		expect(css).toMatch(
			/\.glide-outline-root\.is-expanded\s+\.glide-outline-motion[^{]*\{[^}]*pointer-events:\s*auto/,
		);
		expect(css).toMatch(
			/\.glide-outline-root:focus-within\s+\.glide-outline-motion[^{]*\{[^}]*pointer-events:\s*auto/,
		);
	});
});
