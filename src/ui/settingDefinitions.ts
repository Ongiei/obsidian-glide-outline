import type {
	ButtonComponent, DropdownComponent, Setting, SettingDefinition,
	SettingDefinitionGroup, SliderComponent, ToggleComponent,
} from "obsidian";
import { OWNER_ATTR, OWNER_VALUE } from "./mount";

/** Common surface for live legacy rows and deferred searchable rows. */
export interface SettingRow {
	setName(name: string): SettingRow;
	setDesc(desc: string): SettingRow;
	setHeading(): SettingRow;
	addToggle(callback: (control: ToggleComponent) => unknown): SettingRow;
	addDropdown(callback: (control: DropdownComponent) => unknown): SettingRow;
	addSlider(callback: (control: SliderComponent) => unknown): SettingRow;
	addButton(callback: (control: ButtonComponent) => unknown): SettingRow;
}

/** Collect metadata without creating DOM or invoking control callbacks. */
export class SettingDefinitionRow implements SettingRow {
	name = "";
	desc = "";
	heading = false;
	private readonly controls: Array<(setting: Setting) => void> = [];
	setName(name: string): this { this.name = name; return this; }
	setDesc(desc: string): this { this.desc = desc; return this; }
	setHeading(): this { this.heading = true; return this; }
	addToggle(callback: (control: ToggleComponent) => unknown): this {
		this.controls.push((setting) => { setting.addToggle(callback); }); return this;
	}
	addDropdown(callback: (control: DropdownComponent) => unknown): this {
		this.controls.push((setting) => { setting.addDropdown(callback); }); return this;
	}
	addSlider(callback: (control: SliderComponent) => unknown): this {
		this.controls.push((setting) => { setting.addSlider(callback); }); return this;
	}
	addButton(callback: (control: ButtonComponent) => unknown): this {
		this.controls.push((setting) => { setting.addButton(callback); }); return this;
	}
	definition(): SettingDefinition {
		return {
			name: this.name, desc: this.desc,
			render: (setting) => {
				setting.settingEl.setAttribute(OWNER_ATTR, OWNER_VALUE);
				for (const control of this.controls) control(setting);
			},
		};
	}
}

export function groupSettingDefinitions(heading: string, rows: readonly SettingDefinitionRow[]): SettingDefinitionGroup[] {
	const groups: SettingDefinitionGroup[] = [];
	let group: SettingDefinitionGroup = { type: "group", heading, items: [] };
	groups.push(group);
	for (const row of rows) {
		if (row.heading) {
			group = { type: "group", heading: row.name, items: [] };
			groups.push(group);
		} else {
			group.items?.push(row.definition());
		}
	}
	return groups.filter((entry) => entry.items?.length);
}
