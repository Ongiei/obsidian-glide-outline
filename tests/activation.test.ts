// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_ATTR, OWNER_VALUE } from "../src/ui/mount";
import { resolveClickTarget } from "../src/utils/activation";

/**
 * Activation targeting (section 6): a jump may resolve ONLY from the real
 * marker or card element the user actually hit. The motion corridor, the
 * reveal wrapper, row slack and the viewport background must all resolve
 * to null — even though they are ancestors/siblings inside the same item.
 *
 * DOM mirrors GlideOutlineView.createRow(), including the owned mount that
 * every rail now lives inside — resolution is fail-closed, so a marker or
 * card outside that wrapper resolves to null no matter how it is classed
 * (covered in mount.test.ts):
 *   [data-glide-outline-owner] > row > button.glide-outline-item[data-key]
 *     > .glide-outline-motion > .glide-outline-marker
 *                             > .glide-outline-reveal > .glide-outline-card
 */
describe("resolveClickTarget", () => {
	let row: HTMLElement;
	let button: HTMLElement;
	let motion: HTMLElement;
	let marker: HTMLElement;
	let reveal: HTMLElement;
	let card: HTMLElement;
	let label: HTMLElement;

	beforeEach(() => {
		row = document.createElement("div");
		row.className = "glide-outline-row";
		button = document.createElement("button");
		button.className = "glide-outline-item";
		button.dataset.key = "2::intro::4";
		motion = document.createElement("div");
		motion.className = "glide-outline-motion";
		marker = document.createElement("div");
		marker.className = "glide-outline-marker";
		reveal = document.createElement("div");
		reveal.className = "glide-outline-reveal";
		card = document.createElement("div");
		card.className = "glide-outline-card";
		label = document.createElement("span");
		label.className = "glide-outline-label";
		card.appendChild(label);
		reveal.appendChild(card);
		motion.appendChild(marker);
		motion.appendChild(reveal);
		button.appendChild(motion);
		row.appendChild(button);
		const mount = document.createElement("div");
		mount.setAttribute(OWNER_ATTR, OWNER_VALUE);
		mount.appendChild(row);
		document.body.replaceChildren(mount);
	});

	it("resolves a direct marker hit", () => {
		expect(resolveClickTarget(marker)).toEqual({
			key: "2::intro::4",
			targetType: "marker",
		});
	});

	it("resolves a direct card hit", () => {
		expect(resolveClickTarget(card)).toEqual({
			key: "2::intro::4",
			targetType: "card",
		});
	});

	it("resolves a hit on a DESCENDANT of the card (the label span)", () => {
		expect(resolveClickTarget(label)).toEqual({
			key: "2::intro::4",
			targetType: "card",
		});
	});

	it("returns null for the motion corridor (transparent gap)", () => {
		expect(resolveClickTarget(motion)).toBeNull();
	});

	it("returns null for the reveal wrapper", () => {
		expect(resolveClickTarget(reveal)).toBeNull();
	});

	it("returns null for the item button itself (row slack)", () => {
		expect(resolveClickTarget(button)).toBeNull();
	});

	it("returns null for the row and for unrelated elements", () => {
		expect(resolveClickTarget(row)).toBeNull();
		expect(resolveClickTarget(document.body)).toBeNull();
		expect(resolveClickTarget(null)).toBeNull();
	});

	it("returns null when the item has no data-key", () => {
		delete button.dataset.key;
		expect(resolveClickTarget(marker)).toBeNull();
	});

	it("never resolves from an edge-fade overlay element", () => {
		const fade = document.createElement("div");
		fade.className = "glide-outline-fade-top";
		document.body.appendChild(fade);
		expect(resolveClickTarget(fade)).toBeNull();
	});
});
