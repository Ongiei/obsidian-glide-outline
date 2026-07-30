// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadingItem } from "../src/model/HeadingItem";
import type { GlideOutlineSettings } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import { translateEnvelopeItemsY } from "../src/utils/envelope";
import type { PointerEnvelope } from "../src/utils/envelope";

function heading(level: number, text: string, line: number): HeadingItem {
	return {
		key: `${level}::${text.toLowerCase()}::${line}`,
		level,
		text,
		displaySource: text,
		line,
	};
}

const HEADINGS = Array.from({ length: 10 }, (_, i) =>
	heading(2, `Section ${i}`, i * 4),
);

describe("collectEnvelope active range (section 6)", () => {
	let host: HTMLElement;
	let settings: GlideOutlineSettings;
	let view: GlideOutlineView;

	beforeEach(() => {
		vi.stubGlobal(
			"matchMedia",
			() =>
				({
					matches: false,
					addEventListener: () => undefined,
					removeEventListener: () => undefined,
				}) as unknown as MediaQueryList,
		);
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			},
		);
		host = document.createElement("div");
		document.body.appendChild(host);
		settings = structuredClone(DEFAULT_SETTINGS);
		view = new GlideOutlineView(host, () => settings, {
			onJump: () => undefined,
		});
		view.setItems(HEADINGS);
	});

	afterEach(() => {
		view.dispose();
		vi.unstubAllGlobals();
		host.remove();
	});

	it("builds rects ONLY for rows inside [startIndex, endIndex]", () => {
		const envelope = view.collectEnvelope(9, 5, 2, 5);
		expect(envelope.items).toHaveLength(4);
		expect(envelope.items.map((i) => i.key)).toEqual(
			HEADINGS.slice(2, 6).map((h) => h.key),
		);
	});

	it("defaults to all visible items when no range is given", () => {
		const envelope = view.collectEnvelope();
		expect(envelope.items).toHaveLength(HEADINGS.length);
	});

	it("clamps an out-of-bounds range instead of throwing", () => {
		const envelope = view.collectEnvelope(9, 5, -10, 999);
		expect(envelope.items).toHaveLength(HEADINGS.length);
		const empty = view.collectEnvelope(9, 5, 8, 2);
		expect(empty.items).toHaveLength(0); // inverted range → no items
	});

	it("never uses querySelector — marker/card come from the ItemRecord cache", () => {
		const querySpy = vi.spyOn(Element.prototype, "querySelector");
		const queryAllSpy = vi.spyOn(Element.prototype, "querySelectorAll");
		view.collectEnvelope(9, 5, 0, HEADINGS.length - 1);
		expect(querySpy).not.toHaveBeenCalled();
		expect(queryAllSpy).not.toHaveBeenCalled();
		querySpy.mockRestore();
		queryAllSpy.mockRestore();
	});

	it("reads exactly one rect per marker/card plus the rail (bounded reads)", () => {
		const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
		view.collectEnvelope(9, 5, 3, 6); // 4 rows
		// 1 rail + 4 markers + 4 cards = 9 reads, not 1 + 2n for all n.
		expect(rectSpy).toHaveBeenCalledTimes(9);
		rectSpy.mockRestore();
	});
});

describe("translateEnvelopeItemsY (§七 client↔content conversion)", () => {
	function makeEnvelope(): PointerEnvelope {
		return {
			railRect: { left: 0, top: 100, right: 30, bottom: 500 },
			items: [
				{
					key: "a",
					markerRect: { left: 0, top: 110, right: 30, bottom: 140 },
					cardRect: { left: 30, top: 115, right: 180, bottom: 135 },
					bridgeRect: { left: -9, top: 105, right: 189, bottom: 145 },
				},
			],
		};
	}

	it("translates item rects by +delta; the rail stays viewport-fixed", () => {
		const env = makeEnvelope();
		// Client → content for a scroller at client top 100, scrollTop 50.
		translateEnvelopeItemsY(env, 50 - 100);
		expect(env.items[0].markerRect.top).toBe(60);
		expect(env.items[0].markerRect.bottom).toBe(90);
		expect(env.items[0].cardRect.top).toBe(65);
		expect(env.items[0].bridgeRect.top).toBe(55);
		// Horizontal edges untouched.
		expect(env.items[0].cardRect.left).toBe(30);
		// The rail hit zone is viewport-fixed and must NOT be converted.
		expect(env.railRect.top).toBe(100);
		expect(env.railRect.bottom).toBe(500);
	});

	it("positive delta moves rects down", () => {
		const env = makeEnvelope();
		translateEnvelopeItemsY(env, 20);
		expect(env.items[0].markerRect.top).toBe(130);
	});

	it("zero or non-finite deltas are no-ops", () => {
		const env = makeEnvelope();
		translateEnvelopeItemsY(env, 0);
		translateEnvelopeItemsY(env, Number.NaN);
		expect(env.items[0].markerRect.top).toBe(110);
	});

	it("round-trips: content→client→content is the identity", () => {
		const env = makeEnvelope();
		const before = env.items[0].cardRect.top;
		translateEnvelopeItemsY(env, -137.5);
		translateEnvelopeItemsY(env, 137.5);
		expect(env.items[0].cardRect.top).toBeCloseTo(before, 10);
	});
});
