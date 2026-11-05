import { setIcon } from "obsidian";
import type { GlideOutlineSettings } from "../settings";

export interface OutlineControls {
	onOpenSettings?(): void;
	onToggleLevel?(level: number): void;
}

let controlId = 0;

/** Fixed controls live outside the scroller and its transformed rows. */
export class OutlineToolbar {
	readonly el: HTMLElement;
	private readonly levels = new Map<number, HTMLButtonElement>();
	constructor(doc: Document, controls: OutlineControls) {
		const win = doc.win as Window & {
			createDiv: typeof createDiv;
			createSpan: typeof createSpan;
			createEl: typeof createEl;
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
		setIcon(icon, "settings-2");
		settings.append(icon);
		settings.disabled = !controls.onOpenSettings;
		settings.addEventListener("click", () => controls.onOpenSettings?.());
		for (let level = 2; level <= 6; level++) {
			const el = button(`Show heading level ${level}`);
			const label = win.createSpan();
			label.textContent = `H${level}`;
			label.setAttribute("aria-hidden", "true");
			el.append(label);
			el.disabled = !controls.onToggleLevel;
			el.addEventListener("click", () => controls.onToggleLevel?.(level));
			this.levels.set(level, el);
		}
	}
	refresh(settings: GlideOutlineSettings): void {
		for (const [level, el] of this.levels) {
			el.setAttribute("aria-pressed", String(settings.showLevels[level - 1]));
		}
	}
}
