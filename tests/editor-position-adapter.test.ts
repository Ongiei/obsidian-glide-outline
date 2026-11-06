// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorPositionAdapter } from "../src/core/EditorPositionAdapter";

describe("editor coordinate origins", () => {
	it.each([0, 200, 400])("accounts for content above the document at scrollTop=%i", (scrollTop) => {
		const scrollDOM = document.createElement("div");
		Object.defineProperty(scrollDOM, "clientHeight", { value: 500 });
		scrollDOM.scrollTop = scrollTop;
		scrollDOM.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
		const cm = {
			scrollDOM,
			documentTop: 250 - scrollTop,
			lineBlockAt: () => ({ top: 80, height: 20 }),
		};
		const adapter = new EditorPositionAdapter(cm);
		expect(adapter.activationLineDocument(0.2)).toBe(scrollTop - 100);
		expect(adapter.contentOriginOffset()).toBe(200);
		expect(adapter.documentToViewport(80)).toBe(280 - scrollTop);
		expect(adapter.viewportToDocument(adapter.documentToViewport(80))).toBe(80);
		expect(adapter.viewportToClient(100)).toBe(150);
	});

	it("includes document padding in the contentDOM fallback", () => {
		const scrollDOM = document.createElement("div");
		const contentDOM = document.createElement("div");
		contentDOM.getBoundingClientRect = () => ({ top: 200 }) as DOMRect;
		const adapter = new EditorPositionAdapter({
			scrollDOM, contentDOM, documentPadding: { top: 16, bottom: 8 },
			lineBlockAt: () => ({ top: 0, height: 20 }),
		});
		expect(adapter.contentOriginOffset()).toBe(216);
	});
});
