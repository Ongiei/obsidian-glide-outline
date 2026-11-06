// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, MarkdownView } from "obsidian";
import { MarkdownRenderer } from "obsidian";
import { GlideOutlineController } from "../src/core/GlideOutlineController";
import { HeadingProvider } from "../src/core/HeadingProvider";
import { EditorUpdateBridge } from "../src/core/EditorUpdateBridge";
import { DEFAULT_SETTINGS } from "../src/settings";

function createFixture() {
	const host = document.createElement("div");
	const scroller = document.createElement("div");
	scroller.className = "cm-scroller";
	host.append(scroller);
	document.body.append(host);
	Object.defineProperties(scroller, {
		clientHeight: { value: 500 },
		scrollHeight: { value: 6000 },
	});
	const scrollTo = vi.fn();
	scroller.scrollTo = scrollTo;
	const bridge = new EditorUpdateBridge();
	const state = { mode: "source", cursor: 0 };
	const cm = {
		scrollDOM: scroller,
		get documentTop() { return -scroller.scrollTop; },
		lineBlockAt: (pos: number) => ({ top: pos * 100, height: 20 }),
		coordsAtPos: (pos: number) => ({
			top: pos * 100 - scroller.scrollTop,
			bottom: pos * 100 + 20 - scroller.scrollTop,
			left: 0, right: 100,
		}),
		dispatch: vi.fn(),
	};
	const emit = (changes = {}) => bridge.dispatch({
		view: cm, selectionSet: false, viewportChanged: false,
		geometryChanged: false, docChanged: false, ...changes,
	});
	const headings = [
		{ level: 1, heading: "Alpha", position: { start: { line: 0 } } },
		{ level: 2, heading: "Beta", position: { start: { line: 10 } } },
	];
	const app = { metadataCache: { getFileCache: () => ({ headings }) } } as unknown as App;
	const editor = {
		cm,
		lineCount: () => 50,
		posToOffset: ({ line }: { line: number }) => line,
		getCursor: () => ({ line: state.cursor, ch: 0 }),
		setCursor: ({ line }: { line: number }) => {
			state.cursor = line;
			emit({ selectionSet: true });
		},
		getValue: () => "# Alpha\n" + "\n".repeat(9) + "## Beta",
		focus: vi.fn(),
		scrollIntoView: vi.fn(),
	};
	const view = {
		app, contentEl: host, file: { path: "A.md" }, editor,
		getMode: () => state.mode,
		setEphemeralState: vi.fn(),
	} as unknown as MarkdownView;
	const settings = structuredClone(DEFAULT_SETTINGS);
	const controller = new GlideOutlineController(view, new HeadingProvider(app), () => settings, bridge);
	const jump = (index = 1) => {
		host.querySelectorAll<HTMLButtonElement>("button.glide-outline-item")[index].click();
	};
	return { controller, view, state, scroller, scrollTo, emit, jump, headings, settings, host };
}

describe("controller navigation sessions", () => {
	let fixture: ReturnType<typeof createFixture>;
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.stubGlobal("ResizeObserver", class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		});
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
			window.setTimeout(() => cb(performance.now()), 16));
		vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
		fixture = createFixture();
	});
	afterEach(() => {
		fixture.controller.dispose();
		fixture.host.remove();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("still corrects an uninterrupted jump", () => {
		fixture.jump();
		expect(fixture.scrollTo).toHaveBeenCalledWith({ top: 988, behavior: "smooth" });
		vi.advanceTimersByTime(800);
		expect(fixture.scrollTo).toHaveBeenCalledTimes(2);
	});

	it("does not replace live headings with an older metadata snapshot", () => {
		fixture.view.editor.getValue = () => "# Current heading";
		fixture.controller.refreshFromEditor();
		if (!fixture.view.file) throw new Error("Missing fixture file");
		fixture.controller.handleMetadataChanged(fixture.view.file, "# Older heading");
		expect(fixture.host.querySelector(".glide-outline-label")?.textContent).toBe("Current heading");
		fixture.headings[0].heading = "Current heading";
		fixture.headings.splice(1);
		fixture.controller.handleMetadataChanged(fixture.view.file, "# Current heading");
		expect(fixture.host.querySelectorAll(".glide-outline-label")).toHaveLength(1);
	});

	it("skips row measurements for motion and paint-only settings but measures geometry changes", () => {
		vi.advanceTimersByTime(100);
		const card = fixture.host.querySelector<HTMLElement>(".glide-outline-card")!;
		const reads = vi.spyOn(card, "offsetHeight", "get");
		fixture.settings.pointerAutoScrollSpeed = 2;
		fixture.controller.applySettings();
		vi.advanceTimersByTime(50);
		expect(reads).not.toHaveBeenCalled();
		fixture.settings.card.opacity = 50;
		fixture.controller.applySettings();
		vi.advanceTimersByTime(50);
		expect(reads).not.toHaveBeenCalled();
		expect(fixture.host.querySelector<HTMLElement>(".glide-outline-root")?.style.getPropertyValue("--glide-card-opacity")).toBe("50%");
		fixture.settings.baseFontSize++;
		fixture.controller.applySettings();
		vi.advanceTimersByTime(50);
		expect(reads).toHaveBeenCalled();
	});

	it("does not cancel a jump for an unrelated workspace layout event", () => {
		fixture.jump();
		fixture.controller.handleContextChange("mode-change");
		vi.advanceTimersByTime(800);
		expect(fixture.scrollTo).toHaveBeenCalledTimes(2);
	});

	it("keeps the first heading active while properties occupy the activation line", () => {
		Object.defineProperty(fixture.view.editor, "cm", { value: {
			scrollDOM: fixture.scroller, documentTop: 200,
			lineBlockAt: (pos: number) => ({ top: pos * 8, height: 20 }),
		} });
		vi.advanceTimersByTime(50);
		const buttons = fixture.host.querySelectorAll<HTMLButtonElement>("button.glide-outline-item");
		expect(buttons[0].getAttribute("aria-current")).toBeTruthy();
		expect(buttons[1].hasAttribute("aria-current")).toBe(false);
	});

	it.each([0, 350])("wheel cancels correction even after the highlight settles (%i ms)", (delay) => {
		fixture.jump();
		vi.advanceTimersByTime(delay);
		fixture.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
		fixture.scroller.scrollTop = 100;
		fixture.scroller.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(2000);
		expect(fixture.scrollTo).toHaveBeenCalledTimes(1);
	});

	it.each(["cursor", "edit", "workspace-edit", "file", "mode", "silent-file", "dispose"])(
		"does not correct an obsolete jump after %s", (reason) => {
			fixture.jump();
			if (reason === "cursor") {
				fixture.state.cursor = 2;
				fixture.emit({ selectionSet: true });
			} else if (reason === "edit") {
				fixture.emit({ docChanged: true });
			} else if (reason === "workspace-edit") {
				fixture.controller.handleEditorChange(fixture.view.editor, fixture.view);
			} else if (reason === "dispose") {
				fixture.controller.dispose();
			} else {
				if (reason === "mode") fixture.state.mode = "preview";
				else if (fixture.view.file) fixture.view.file.path = "B.md";
				if (reason !== "silent-file") fixture.controller.handleContextChange();
			}
			fixture.scroller.scrollTop = 100;
			vi.advanceTimersByTime(2000);
			expect(fixture.scrollTo).toHaveBeenCalledTimes(1);
		},
	);

	it("a newer jump replaces the old target", () => {
		fixture.jump();
		fixture.scroller.scrollTop = 500;
		fixture.jump(0);
		fixture.scrollTo.mockClear();
		vi.advanceTimersByTime(800);
		expect(fixture.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
		expect(fixture.scrollTo).not.toHaveBeenCalledWith({ top: 988, behavior: "smooth" });
	});

	it.each(["wheel", "file", "new-jump", "dispose"])("cancels a preview retry on %s", (reason) => {
		fixture.state.mode = "preview";
		fixture.controller.handleContextChange();
		fixture.jump(); // no rendered heading yet; schedules a retry
		const preview = document.createElement("div");
		preview.className = "markdown-preview-view";
		const sizer = document.createElement("div");
		sizer.className = "markdown-preview-sizer";
		const heading = document.createElement("h2");
		heading.dataset.line = "10";
		heading.textContent = "Beta";
		heading.scrollIntoView = vi.fn();
		sizer.append(heading);
		preview.append(sizer);
		fixture.host.append(preview);
		if (reason === "wheel") preview.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
		else if (reason === "file") {
			if (fixture.view.file) fixture.view.file.path = "B.md";
			fixture.controller.handleContextChange("file-change");
		} else if (reason === "new-jump") fixture.jump(0);
		else fixture.controller.dispose();
		vi.advanceTimersByTime(50);
		expect(heading.scrollIntoView).not.toHaveBeenCalled();
	});

	it("rerenders identical rich headings with the new file's source path", async () => {
		const cleanup = vi.fn();
		const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation(
			(_app, _source, el, path, component) => {
				el.textContent = path;
				component.register(cleanup);
				return Promise.resolve();
			},
		);
		fixture.settings.renderMarkdown = true;
		fixture.headings[1].heading = "[[./Target]]";
		fixture.controller.refreshFromCache();
		expect(render).toHaveBeenCalledTimes(1);
		if (fixture.view.file) fixture.view.file.path = "B/Note.md";
		fixture.controller.handleContextChange("file-change");
		await Promise.resolve();
		expect(render).toHaveBeenCalledTimes(2);
		expect(render.mock.calls.map((call) => call[3])).toEqual(["A.md", "B/Note.md"]);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(fixture.host.querySelectorAll(".glide-outline-label")[1].textContent).toBe("B/Note.md");
		fixture.controller.dispose();
		expect(cleanup).toHaveBeenCalledTimes(2);
	});

	it.each(["resolve", "reject"])("an old async render cannot overwrite plain text on %s", async (outcome) => {
		let finish: () => void = () => {};
		const cleanup = vi.fn();
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(
			(_app, _source, el, _path, component) => new Promise<void>((resolve, reject) => {
				component.register(cleanup);
				finish = () => {
					el.textContent = "stale renderer output";
					if (outcome === "resolve") resolve();
					else reject(new Error("late renderer failure"));
				};
			}),
		);
		fixture.settings.renderMarkdown = true;
		fixture.headings[1].heading = "**Beta**";
		fixture.controller.refreshFromCache();
		fixture.settings.renderMarkdown = false;
		fixture.controller.applySettings();
		expect(cleanup).toHaveBeenCalledTimes(1);
		finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(fixture.host.querySelectorAll(".glide-outline-label")[1].textContent).toBe("**Beta**");
	});

	it("unloads a rich row when filtering removes it", () => {
		const cleanup = vi.fn();
		vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, _source, _el, _path, component) => {
			component.register(cleanup);
			return Promise.resolve();
		});
		fixture.settings.renderMarkdown = true;
		fixture.headings[1].heading = "**Beta**";
		fixture.controller.refreshFromCache();
		fixture.headings.pop();
		fixture.controller.refreshFromCache();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it.each(["blur", "dispose", "mode"])("cleans up preview focus listeners on %s", (reason) => {
		fixture.state.mode = "preview";
		fixture.controller.handleContextChange();
		const preview = document.createElement("div");
		preview.className = "markdown-preview-view";
		const sizer = document.createElement("div");
		sizer.className = "markdown-preview-sizer";
		const heading = document.createElement("h2");
		heading.dataset.line = "10";
		heading.scrollIntoView = vi.fn();
		sizer.append(heading);
		preview.append(sizer);
		fixture.host.append(preview);
		const remove = vi.spyOn(heading, "removeEventListener");
		fixture.jump();
		expect(heading.getAttribute("tabindex")).toBe("-1");
		if (reason === "blur") heading.dispatchEvent(new FocusEvent("blur"));
		else if (reason === "dispose") fixture.controller.dispose();
		else {
			fixture.state.mode = "source";
			fixture.controller.handleContextChange();
		}
		expect(heading.hasAttribute("tabindex")).toBe(false);
		expect(remove).toHaveBeenCalledWith("blur", expect.any(Function));
		const count = remove.mock.calls.length;
		heading.dispatchEvent(new FocusEvent("blur"));
		expect(remove).toHaveBeenCalledTimes(count);
	});
});
