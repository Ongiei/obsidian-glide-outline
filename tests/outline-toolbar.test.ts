// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { OutlineToolbar } from "../src/ui/OutlineToolbar";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";

describe("fixed outline controls", () => {
	it("opens settings and previews/commits depth with a native range", () => {
		const open = vi.fn(), depth = vi.fn();
		const toolbar = new OutlineToolbar(document, { onOpenSettings: open, onSetDepth: depth });
		toolbar.refresh(DEFAULT_SETTINGS);
		const buttons = toolbar.el.querySelectorAll("button");
		expect(buttons).toHaveLength(1);
		buttons[0].click();
		expect(open).toHaveBeenCalledTimes(1);
		for (let level = 2; level <= 6; level++) {
			const slider = toolbar.el.querySelector("input")!;
			slider.value = String(level);
			slider.dispatchEvent(new Event("input"));
			expect(depth).toHaveBeenLastCalledWith(level, false);
			slider.dispatchEvent(new Event("change"));
			expect(depth).toHaveBeenLastCalledWith(level, true);
		}
	});
	it("reflects settings, retains accessible names and keyboard-native controls", () => {
		const s = structuredClone(DEFAULT_SETTINGS);
		s.showLevels = [false, true, true, false, false, false];
		const toolbar = new OutlineToolbar(document, { onSetDepth: () => undefined });
		toolbar.refresh(s);
		const buttons = toolbar.el.querySelectorAll("button");
		expect(toolbar.el.querySelector("input")!.value).toBe("3");
		expect(toolbar.el.querySelector("input")!.getAttribute("aria-valuetext")).toContain("H1 follows");
		for (const b of buttons) {
			expect(b.type).toBe("button");
			expect(b.getAttribute("aria-labelledby")).toBeTruthy();
			expect(b.hasAttribute("aria-label")).toBe(false);
		}
	});
	it("keeps controls outside the heading viewport and available after all levels are hidden", () => {
		const host = document.createElement("div");
		document.body.append(host);
		const s = structuredClone(DEFAULT_SETTINGS);
		s.showLevels.fill(false);
		const view = new GlideOutlineView(host, () => s, { onJump: () => undefined, onSetDepth: () => undefined });
		view.setItems([]);
		expect(view.rootEl.contains(view.toolbar.el)).toBe(true);
		expect(view.viewportEl.contains(view.toolbar.el)).toBe(false);
		expect(view.toolbar.el.querySelectorAll("input:not(:disabled)")).toHaveLength(1);
		view.dispose();
		host.remove();
	});
});
