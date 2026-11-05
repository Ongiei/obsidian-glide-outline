// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { OutlineToolbar } from "../src/ui/OutlineToolbar";
import { DEFAULT_SETTINGS } from "../src/settings";
import { GlideOutlineView } from "../src/ui/GlideOutlineView";

describe("fixed outline controls", () => {
	it("opens settings and toggles exactly the chosen H2–H6 level", () => {
		const open = vi.fn(), toggle = vi.fn();
		const toolbar = new OutlineToolbar(document, { onOpenSettings: open, onToggleLevel: toggle });
		toolbar.refresh(DEFAULT_SETTINGS);
		const buttons = toolbar.el.querySelectorAll("button");
		expect(buttons).toHaveLength(6);
		buttons[0].click();
		expect(open).toHaveBeenCalledTimes(1);
		for (let level = 2; level <= 6; level++) {
			buttons[level - 1].click();
			expect(toggle).toHaveBeenLastCalledWith(level);
		}
	});
	it("reflects settings, retains accessible names and keyboard-native controls", () => {
		const s = structuredClone(DEFAULT_SETTINGS);
		s.showLevels[2] = false;
		const toolbar = new OutlineToolbar(document, { onToggleLevel: () => undefined });
		toolbar.refresh(s);
		const buttons = toolbar.el.querySelectorAll("button");
		expect(buttons[2].getAttribute("aria-pressed")).toBe("false");
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
		const view = new GlideOutlineView(host, () => s, { onJump: () => undefined, onToggleLevel: () => undefined });
		view.setItems([]);
		expect(view.rootEl.contains(view.toolbar.el)).toBe(true);
		expect(view.viewportEl.contains(view.toolbar.el)).toBe(false);
		expect(view.toolbar.el.querySelectorAll("button:not(:disabled)")).toHaveLength(5);
		view.dispose();
		host.remove();
	});
});
