// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { headingGap, HeadingGapBridges } from "../src/ui/HeadingGapBridges";
import { resolveClickTarget } from "../src/utils/activation";

const a = {left: 100, right: 500, top: 10, bottom: 30};
const b = {left: 130, right: 210, top: 36, bottom: 60};
describe("adjacent heading hover gaps", () => {
 it("uses only the shared width, never the longest heading's blank space", () => {
  expect(headingGap(a,b)).toEqual({left:130,right:210,top:30,bottom:36});
 });
 it("does not cover overlapping, distant or horizontally disjoint headings", () => {
  for (const rect of [{...b,top:29},{...b,top:100},{...b,left:510,right:600}]) expect(headingGap(a,rect)).toBeNull();
 });
 it("updates in content coordinates, is not a jump target, and removes stale strips", () => {
  const host = document.createElement("div");
  const bridge = new HeadingGapBridges(host);
  const item = (key:string, cardRect:typeof a) => ({key,cardRect,markerRect:cardRect,bridgeRect:cardRect});
  bridge.update([item("a",a),item("b",b)],80);
  const el = host.querySelector<HTMLElement>(".glide-outline-heading-gap")!;
  expect(el.style.getPropertyValue("--glide-gap-left")).toBe("50.000px");
  expect(el.style.getPropertyValue("--glide-gap-top")).toBe("30.000px");
  expect(resolveClickTarget(el)).toBeNull();
  expect(el.hasAttribute("tabindex")).toBe(false);
  bridge.update([item("a",a)],80);
  expect(host.querySelector(".glide-outline-heading-gap")).toBeNull();
  bridge.dispose();expect(host.children).toHaveLength(0);
 });
});
