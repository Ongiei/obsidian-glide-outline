// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";
import { MagnificationController } from "../src/ui/MagnificationController";

/** Realistic layout without browser layout: 126 mixed-height/length rows,
 * real rail bounds, transformed card bounds, synchronous scroll delivery. */
function fixture(side: "left" | "right" = "left") {
	const host = document.createElement("div");
	document.body.append(host);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.position = side;
	settings.pointerAutoScrollZone = 40;
	const heights = Array.from({ length: 126 }, (_, i) => i % 7 === 0 ? 42 : 24);
	let total = 0;
	const tops = heights.map(height => { const top = total; total += height + 6; return top; });
	const items = heights.map((_, i) => ({ key: `heading-${i}`, text: i % 4 === 0 ? "Long title ".repeat(12) : `Title ${i}`, displaySource: `Title ${i}`, level: 2 + i % 5, line: i * 3 }));
	const jump = vi.fn();
	const view = new GlideOutlineView(host, () => settings, { onJump: jump });
	view.setItems(items);
	const railLeft = side === "left" ? 100 : 700;
	const railX = railLeft + 14;
	const cardX = side === "left" ? 280 : 540;
	const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
	view.viewportEl.getBoundingClientRect = () => rect(100, 100, 628, 400);
	view.hitZoneEl.getBoundingClientRect = () => rect(railLeft, 100, 28, 400);
	Object.defineProperties(view.viewportEl, { clientHeight: { value: 400, configurable: true }, scrollHeight: { value: total, configurable: true } });
	let scroll = 900;
	Object.defineProperty(view.viewportEl, "scrollTop", { configurable: true, get: () => scroll, set: (n: number) => {
		const next = Math.max(0, Math.min(total - 400, n));
		if (next === scroll) return;
		scroll = next;
		view.viewportEl.dispatchEvent(new Event("scroll"));
	} });
	const rows = [...view.listEl.children] as HTMLElement[];
	rows.forEach((row, i) => {
		row.getBoundingClientRect = () => rect(100, 100 + tops[i] - scroll, 628, heights[i]);
		const marker = row.querySelector(".glide-outline-marker") as HTMLElement;
		const card = row.querySelector(".glide-outline-card") as HTMLElement;
		const shift = () => Number.parseFloat(row.style.getPropertyValue("--glide-shift-y") || "0");
		const scale = () => Number.parseFloat(row.style.getPropertyValue("--glide-scale") || "1");
		marker.getBoundingClientRect = () => rect(railLeft, 100 + tops[i] - scroll + shift(), 28, heights[i]);
		card.getBoundingClientRect = () => {
			const s = scale(), width = (i % 4 === 0 ? 540 : 160) * s;
			return rect(side === "left" ? 136 : 692 - width, 100 + tops[i] - scroll + shift() - heights[i] * (s - 1) / 2, width, heights[i] * s);
		};
	});
	view.getBaseCardHeight = key => heights[items.findIndex(item => item.key === key)] ?? 24;
	view.updateOverflowState();
	const controller = new MagnificationController(view, () => settings, null, jump);
	const event = (target: EventTarget, type: string, x: number, y: number) => {
		const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
		Object.defineProperties(e, { timeStamp: { value: performance.now() }, pointerId: { value: 1 } });
		target.dispatchEvent(e);
	};
	const card = (i: number) => rows[i].querySelector(".glide-outline-card") as HTMLElement;
	const nearest = (y: number) => rows.reduce((a, row, i) => Math.abs(card(i).getBoundingClientRect().top - y) < Math.abs(card(a).getBoundingClientRect().top - y) ? i : a, 0);
	return { host, settings, view, controller, rows, items, card, nearest, event, railX, cardX, jump, dispose: () => { controller.dispose(); host.remove(); } };
}

describe("interaction zones: rail versus 126 heading cards", () => {
	let raf: Map<number, FrameRequestCallback>, nextId: number;
	let f: ReturnType<typeof fixture>;
	const step = (n = 1) => { for (let i = 0; i < n; i++) { vi.advanceTimersByTime(16); const queue = [...raf.values()]; raf.clear(); queue.forEach(cb => cb(performance.now())); } };
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		raf = new Map(); nextId = 0;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { raf.set(++nextId, cb); return nextId; });
		vi.stubGlobal("cancelAnimationFrame", (id: number) => raf.delete(id));
		vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	});
	afterEach(() => { f?.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });

	it.each(["left", "right"] as const)("B: %s rail bottom keeps scrolling past changing rows", side => {
		f = fixture(side);
		f.event(f.view.hitZoneEl, "pointerenter", f.railX, 497);
		step(35);
		const first = f.view.viewportEl.scrollTop;
		expect(first).toBeGreaterThan(900);
		step(35);
		expect(f.view.viewportEl.scrollTop).toBeGreaterThan(first);
	});
	it.each(["left", "right"] as const)("C: a wide %s card at the bottom never starts edge scrolling", side => {
		f = fixture(side);
		f.settings.pointerFollowEnabled = false;
		f.event(f.card(f.nearest(490)), "pointerenter", f.cardX, 497);
		step(50);
		expect(f.view.viewportEl.scrollTop).toBe(900);
	});
	it("leaving the rail for a card brakes without restarting or reversing edge scroll", () => {
		f = fixture(); f.settings.pointerFollowEnabled = false;
		f.event(f.view.hitZoneEl, "pointerenter", f.railX, 497); step(35);
		const before = f.view.viewportEl.scrollTop;
		f.event(f.card(f.nearest(490)), "pointermove", f.cardX, 497);
		step(); const firstDelta = f.view.viewportEl.scrollTop - before;
		expect(firstDelta).toBeGreaterThan(0); // coast down, not a snap reset
		step(30); const stopped = f.view.viewportEl.scrollTop;
		step(30); expect(f.view.viewportEl.scrollTop).toBe(stopped);
		expect(stopped - before).toBeLessThan(50);
	});
	it("a stationary rail pointer outside the 40px end bands does not scroll", () => {
		f = fixture(); f.event(f.view.hitZoneEl, "pointerenter", f.railX, 420); step(50);
		expect(f.view.viewportEl.scrollTop).toBe(900);
	});
	it("an unmeasurable rail fails closed, never falling back to the root width", () => {
		f = fixture(); f.view.hitZoneEl.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 }) as DOMRect;
		f.event(f.view.hitZoneEl, "pointerenter", f.railX, 497); step(50);
		expect(f.view.viewportEl.scrollTop).toBe(900);
	});
	it("A: a sustained card sweep releases hover snap without losing its samples", () => {
		f = fixture(); f.settings.pointerAutoScroll = false;
		const card = f.card(f.nearest(280));
		f.event(card, "pointerenter", f.cardX, 290); step(40);
		const before = f.view.viewportEl.scrollTop;
		for (let i = 0; i < 12; i++) {
			f.event(card, "pointermove", f.cardX, 295 + i * 10); step();
		}
		expect(f.view.viewportEl.scrollTop).toBeGreaterThan(before + 2);
	});
	it("hover stability does not clear the real pointer sample ring", () => {
		f = fixture(); const card = f.card(f.nearest(280));
		f.event(card, "pointerenter", f.cardX, 290); step(40);
		f.event(card, "pointermove", f.cardX, 291); step();
		f.event(card, "pointermove", f.cardX, 292); step();
		const state = f.controller as unknown as { kinematics: { samples: { length: number } } };
		expect(state.kinematics.samples.length).toBe(2);
	});
	it("retains a snap during a fast move inside the acquired tall card", () => {
		f = fixture();
		const card = f.card(f.nearest(280));
		card.getBoundingClientRect = () => ({ left: 136, right: 600, top: 250, bottom: 350 }) as DOMRect;
		f.event(card, "pointerenter", f.cardX, 280); step(40);
		const state = f.controller as unknown as { pointerSnap: { targetKey: string | null } };
		const key = state.pointerSnap.targetKey;
		expect(key).not.toBeNull();
		f.event(card, "pointermove", f.cardX, 281); step();
		f.event(card, "pointermove", f.cardX, 310); step();
		expect(state.pointerSnap.targetKey).toBe(key);
		expect(f.view.viewportEl.scrollTop).toBe(900);
	});
	it("does not let disabled follow cancel a fast card-to-card handoff", () => {
		f = fixture(); f.settings.pointerFollowEnabled = false; f.settings.pointerAutoScroll = false;
		const a = f.card(f.nearest(280)), b = f.card(f.nearest(350));
		a.getBoundingClientRect = () => ({ left: 136, right: 600, top: 270, bottom: 300 }) as DOMRect;
		b.getBoundingClientRect = () => ({ left: 136, right: 600, top: 330, bottom: 370 }) as DOMRect;
		f.event(a, "pointerenter", f.cardX, 280); step(40);
		f.event(a, "pointermove", f.cardX, 281); step();
		f.event(b, "pointermove", f.cardX, 350); step();
		const state = f.controller as unknown as { pointerSnap: { targetKey: string | null } };
		expect(state.pointerSnap.targetKey).toBe(b.closest(".glide-outline-row")?.getAttribute("data-key"));
	});
	it.each(["left", "right"] as const)("%s neighbouring selection keeps scroll still through gaps in both directions", side => {
		f = fixture(side);
		f.settings.pointerAutoScroll = false;
		f.settings.pointerFollowStrength = 2.5;
		f.settings.maxScale = 1.85;
		const i = f.nearest(280), card = f.card(i), initial = card.getBoundingClientRect();
		const x = side === "left" ? initial.left + 40 : initial.right - 40;
		let y = (initial.top + initial.bottom) / 2;
		f.event(card, "pointerenter", x, y); step(40);
		const state = f.controller as unknown as { pointerSnap: { targetKey: string | null } };
		for (const destination of [i + 1, i, i - 1]) {
			const key = f.items[destination].key;
			const origin = state.pointerSnap.targetKey;
			const rect = f.card(destination).getBoundingClientRect();
			const end = (rect.top + rect.bottom) / 2;
			const direction = Math.sign(end - y);
			let transferred = false;
			while (Math.abs(end - y) > 0.1) {
				y += direction * Math.min(3, Math.abs(end - y));
				// Browser hit testing follows the animated cards, including transparent gaps.
				const hit = f.rows.map((_, n) => f.card(n)).find(el => {
					const r = el.getBoundingClientRect();
					return y >= r.top && y <= r.bottom && x >= r.left && x <= r.right;
				}) ?? f.view.listEl;
				f.event(hit, "pointermove", x, y); step();
				expect(f.view.viewportEl.scrollTop).toBe(900);
				expect(transferred ? [key] : [origin, key]).toContain(state.pointerSnap.targetKey);
				transferred ||= state.pointerSnap.targetKey === key;
			}
			step(40);
			expect(state.pointerSnap.targetKey).toBe(key);
			expect(f.view.viewportEl.scrollTop).toBe(900);
		}
	});
	it.each(["left", "right"] as const)("D: %s micro-moves keep one owner despite alternating DOM targets", side => {
		f = fixture(side);
		const i = f.nearest(280), card = f.card(i), r = card.getBoundingClientRect();
		const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
		f.event(card, "pointerenter", x, y); step(40);
		const state = f.controller as unknown as { pointerSnap: { targetKey: string | null } };
		const key = state.pointerSnap.targetKey;
		expect(key).not.toBeNull();
		for (let n = 0; n < 30; n++) {
			f.event(f.card(i + n % 2), "pointermove", x + n % 3, y + n % 3); step();
			expect(state.pointerSnap.targetKey).toBe(key);
			expect(f.view.listEl.querySelectorAll("[data-glide-snapped]")).toHaveLength(1);
		}
	});
	it("acquires a slow neighbouring card without waiting for visual release easing", () => {
		f = fixture(); f.settings.pointerAutoScroll = false;
		const i = f.nearest(280), a = f.card(i), b = f.card(i + 1);
		a.getBoundingClientRect = () => ({ left: 136, right: 600, top: 270, bottom: 300 }) as DOMRect;
		b.getBoundingClientRect = () => ({ left: 136, right: 600, top: 330, bottom: 370 }) as DOMRect;
		f.event(a, "pointerenter", f.cardX, 280); step(40);
		// A slow move across a real gap keeps the old owner until the next card.
		f.event(f.view.listEl, "pointermove", f.cardX, 329); step();
		f.event(b, "pointermove", f.cardX, 330); step();
		const state = f.controller as unknown as { pointerSnap: { targetKey: string | null } };
		expect(state.pointerSnap.targetKey).toBe(b.closest(".glide-outline-row")?.getAttribute("data-key"));
	});
	it("B: entering the rail end overrides a nearby old card snap", () => {
		f = fixture();
		const card = f.card(f.nearest(490));
		card.getBoundingClientRect = () => ({ left: 130, right: 500, top: 475, bottom: 510 }) as DOMRect;
		f.event(card, "pointerenter", 136, 490); step(40);
		const before = f.view.viewportEl.scrollTop;
		f.event(f.view.hitZoneEl, "pointermove", 126, 497); step(40);
		expect(f.view.viewportEl.scrollTop).toBeGreaterThan(before + 10);
	});
	it("edge intent owns the integrator instead of summing opposing follow velocity", () => {
		f = fixture();
		f.event(f.view.hitZoneEl, "pointerenter", f.railX, 497); step(40);
		f.event(f.view.hitZoneEl, "pointermove", f.railX, 496); step();
		f.event(f.view.hitZoneEl, "pointermove", f.railX, 480); step();
		const state = f.controller as unknown as { integrator: { edgeIntentVelocity: number; kineticIntentVelocity: number; combinedTargetVelocity: number } };
		expect(state.integrator.edgeIntentVelocity).toBeGreaterThan(0);
		expect(state.integrator.kineticIntentVelocity).toBe(0);
		expect(state.integrator.combinedTargetVelocity).toBe(state.integrator.edgeIntentVelocity);
	});
	it("F: a stopped follow gesture settles promptly without a long tail", () => {
		f = fixture(); f.settings.pointerAutoScroll = false;
		f.event(f.view.hitZoneEl, "pointerenter", f.railX, 250);
		for (let y = 260; y <= 380; y += 15) { f.event(f.view.hitZoneEl, "pointermove", f.railX, y); step(); }
		step(20); const stopped = f.view.viewportEl.scrollTop;
		step(20); expect(f.view.viewportEl.scrollTop).toBe(stopped);
		expect(f.controller.getInteractionDiagnostics()).toHaveLength(0);
	});
	it("E: a press freezes and activates its own target even if the release hits a neighbour", () => {
		f = fixture(); const i = f.nearest(280), card = f.card(i), b = card.getBoundingClientRect();
		const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
		f.event(card, "pointerenter", x, y); step(40);
		const r = card.getBoundingClientRect(), cy = (r.top + r.bottom) / 2;
		f.event(card, "pointerdown", x, cy); const scroll = f.view.viewportEl.scrollTop; step(20);
		expect(f.view.viewportEl.scrollTop).toBe(scroll);
		f.event(f.card(i + 1), "pointerup", x, cy);
		expect(f.jump).toHaveBeenCalledExactlyOnceWith(f.items[i]);
	});
});
