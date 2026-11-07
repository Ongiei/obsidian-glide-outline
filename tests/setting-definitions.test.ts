// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import type { App, Setting, SettingDefinition } from "obsidian";
import type GlideOutlinePlugin from "../src/main";
import { DEFAULT_SETTINGS, GlideOutlineSettingTab } from "../src/settings";

function fixture() {
 const plugin = { settings: structuredClone(DEFAULT_SETTINGS), applySettings: vi.fn(), previewSettings: vi.fn() };
 const tab = new GlideOutlineSettingTab({} as App, plugin as unknown as GlideOutlinePlugin);
 return { plugin, tab };
}
afterEach(() => vi.restoreAllMocks());
describe("native search preserves the tabbed settings interface", () => {
 it("indexes settings terms without constructing or saving controls", () => {
  const {tab,plugin} = fixture();
  const definitions = tab.getSettingDefinitions() as SettingDefinition[];
  expect(definitions).toHaveLength(1);
  expect(definitions[0].aliases).toEqual(expect.arrayContaining(["Enable outline", "Position", "Restore default appearance"]));
  expect(definitions[0].aliases?.length).toBeGreaterThan(30);
  expect(plugin.applySettings).not.toHaveBeenCalled();
 });
 it("uses the same tab renderer on modern and legacy hosts", () => {
  const {tab} = fixture();
  const render = vi.spyOn(tab as unknown as {renderTabs: (el: HTMLElement) => void}, "renderTabs").mockImplementation(() => {});
  const host = document.createElement("div");
  host.empty = () => host.replaceChildren();
  host.addClass = name => host.classList.add(name);
  const definition = tab.getSettingDefinitions()[0] as SettingDefinition;
  if (!definition.render) throw Error("Missing tab renderer");
  definition.render({settingEl:host} as unknown as Setting, {} as obsidian.SettingGroup);
  expect(render).toHaveBeenCalledWith(host);
  tab.display();
  expect(render).toHaveBeenCalledTimes(2);
 });
 it("provides Chinese search labels when Obsidian uses Chinese", () => {
  vi.spyOn(obsidian, "getLanguage").mockReturnValue("zh");
  const {tab} = fixture();
  const definition = tab.getSettingDefinitions()[0] as SettingDefinition;
  expect(definition.name).toBe("插件设置");
  expect(definition.aliases).toContain("启用大纲");
  expect(definition.aliases).toContain("恢复默认外观");
 });
 it("uses English without accessing the newer language API on older hosts", () => {
  vi.spyOn(obsidian, "requireApiVersion").mockReturnValue(false);
  const getLanguage = vi.spyOn(obsidian, "getLanguage");
  const {tab} = fixture();
  const definition = tab.getSettingDefinitions()[0] as SettingDefinition;
  expect(definition.name).toBe("Plugin settings");
  expect(getLanguage).not.toHaveBeenCalled();
 });

});
