// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { App, Setting, SettingDefinition, SettingDefinitionGroup, SettingGroup, ToggleComponent } from "obsidian";
import type GlideOutlinePlugin from "../src/main";
import { DEFAULT_SETTINGS, GlideOutlineSettingTab } from "../src/settings";

function fixture() {
	const plugin = {
		settings: structuredClone(DEFAULT_SETTINGS),
		applySettings: vi.fn().mockResolvedValue(undefined),
		previewSettings: vi.fn(),
	};
	const tab = new GlideOutlineSettingTab({} as App, plugin as unknown as GlideOutlinePlugin);
	const groups = tab.getSettingDefinitions() as SettingDefinitionGroup[];
	const rows = groups.flatMap((group) => group.items ?? []) as SettingDefinition[];
	return { plugin, tab, groups, rows };
}

describe("searchable settings with shared legacy controls", () => {
	it("exposes all sections without constructing controls or saving settings", () => {
		const { plugin, groups, rows } = fixture();
		const names = rows.map((row) => row.name);
		expect(names).toEqual(expect.arrayContaining([
			"Enable outline", "Position", "H1", "H6", "Developer mode",
			"Restore default appearance", "Level indentation (legacy)",
		]));
		expect(names.length).toBeGreaterThan(30);
		expect(new Set(names).size).toBe(names.length);
		expect(groups.every((group) => group.items?.length)).toBe(true);
		expect(plugin.applySettings).not.toHaveBeenCalled();
		expect(plugin.previewSettings).not.toHaveBeenCalled();
	});

	it("native controls share the legacy values and persistence callback", async () => {
		const { plugin, rows } = fixture();
		let change: (value: boolean) => unknown = () => {};
		let displayed: boolean | null = null;
		const toggle = {
			setValue(value: boolean) { displayed = value; return this; },
			onChange(callback: (value: boolean) => unknown) { change = callback; return this; },
		} as unknown as ToggleComponent;
		const setting = {
			settingEl: document.createElement("div"),
			addToggle(callback: (control: ToggleComponent) => unknown) { callback(toggle); },
		} as unknown as Setting;
		const definition = rows.find((row) => row.name === "Enable outline");
		if (!definition?.render) throw new Error("Missing searchable outline toggle");
		definition.render(setting, {} as SettingGroup);
		expect(displayed).toBe(true);
		await change(false);
		expect(plugin.settings.enabled).toBe(false);
		expect(plugin.applySettings).toHaveBeenCalledTimes(1);
		expect(setting.settingEl.getAttribute("data-glide-outline-owner")).toBe("glide-outline");
	});
});
