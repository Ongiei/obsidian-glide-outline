import { setIcon } from "obsidian";
import type { GlideOutlineSettings } from "../settings";

export interface OutlineControls {
	onOpenSettings?(): void;
	onSetDepth?(level: number, commit: boolean): void;
}

let controlId = 0;

/** Fixed controls live outside the scroller and its transformed rows. */
export class OutlineToolbar {
	readonly el: HTMLElement;
	private readonly depth: HTMLInputElement;
	private readonly track: HTMLElement;
	constructor(doc: Document, controls: OutlineControls) {
		const win = doc.win as Window & {
			createDiv: typeof createDiv;
			createSpan: typeof createSpan;
			createEl: typeof createEl;
			Node: typeof Node;
		};
		this.el = win.createDiv();
		this.el.className = "glide-outline-toolbar";
		this.el.setAttribute("role", "group");
		const name = win.createSpan();
		name.className = "glide-outline-a11y-label";
		name.id = `glide-controls-${controlId++}`;
		name.textContent = "Outline controls";
		this.el.append(name);
		this.el.setAttribute("aria-labelledby", name.id);
		let pointerFocus = false;
		this.el.addEventListener("pointerdown", () => {
			pointerFocus = true;
			this.el.classList.remove("is-keyboard-focus");
		});
		this.el.addEventListener("keydown", () => {
			pointerFocus = false;
			this.el.classList.add("is-keyboard-focus");
		});
		this.el.addEventListener("focusin", () => {
			if (!pointerFocus) this.el.classList.add("is-keyboard-focus");
		});
		this.el.addEventListener("focusout", event => {
			if (!(event.relatedTarget instanceof win.Node) || !this.el.contains(event.relatedTarget)) {
				pointerFocus = false;
				this.el.classList.remove("is-keyboard-focus");
			}
		});
		const button = (label: string): HTMLButtonElement => {
			const el = win.createEl("button");
			el.type = "button";
			el.className = "glide-outline-control";
			const text = win.createSpan();
			text.className = "glide-outline-a11y-label";
			text.id = `glide-control-${controlId++}`;
			text.textContent = label;
			el.append(text);
			el.setAttribute("aria-labelledby", text.id);
			this.el.append(el);
			return el;
		};
		const settings = button("Open plugin settings");
		const icon = win.createSpan();
		icon.setAttribute("aria-hidden", "true");
		setIcon(icon, "settings");
		settings.append(icon);
		settings.disabled = !controls.onOpenSettings;
		settings.addEventListener("click", () => controls.onOpenSettings?.());
		const track = win.createDiv();
		this.track = track;
		track.className = "glide-outline-depth";
		const label = win.createSpan();
		label.className = "glide-outline-a11y-label";
		label.id = `glide-depth-${controlId++}`;
		label.textContent = "Show headings through level";
		this.depth = win.createEl("input");
		this.depth.type = "range";
		this.depth.min = "2";
		this.depth.max = "6";
		this.depth.step = "1";
		this.depth.setAttribute("aria-labelledby", label.id);
		this.depth.disabled = !controls.onSetDepth;
		const ticks = win.createDiv();
		ticks.className = "glide-outline-depth-ticks";
		ticks.setAttribute("aria-hidden", "true");
		for (let level = 2; level <= 6; level++) {
			const tick = win.createSpan();
			tick.textContent = `H${level}`;
			ticks.append(tick);
		}
		track.append(label, this.depth, ticks);
		this.el.append(track);
		this.depth.addEventListener("input", () => controls.onSetDepth?.(Number(this.depth.value), false));
		this.depth.addEventListener("change", () => controls.onSetDepth?.(Number(this.depth.value), true));
	}
	refresh(settings: GlideOutlineSettings): void {
		let depth = 2;
		for (let level = 2; level <= 6; level++) if (settings.showLevels[level - 1]) depth = level;
		this.depth.value = String(depth);
		const continuous = settings.showLevels.slice(1).every((shown, i) => shown === (i + 2 <= depth));
		this.track.dataset.depth = continuous ? `H${depth}` : "Custom";
		const selected = settings.showLevels.flatMap((shown, i) => shown ? [`H${i + 1}`] : []);
		this.depth.setAttribute("aria-valuetext", continuous
			? `H2 through H${depth}; H1 follows plugin settings`
			: `Custom selection: ${selected.join(", ") || "none"}; adjusting sets a continuous range; H1 follows plugin settings`);
		this.track.style.setProperty("--glide-depth-fill", continuous ? `${(depth - 1) * 20}%` : "0%");
	}
}
