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

describe("text shadow variable", () => {
	it("applies the TS-built shadow variable under the feature class", () => {
		expect(css).toMatch(
			/\.glide-outline-root--text-shadow[^{]*\{[^}]*text-shadow:\s*var\(--glide-text-shadow/,
		);
	});
});
