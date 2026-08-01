/**
 * Minimal Obsidian API stub for unit tests.
 * Only the surfaces imported at module top-level by src files under test.
 */

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl = { empty: () => {} } as unknown;
	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
	display(): void {}
	hide(): void {}
}

export class Setting {
	constructor(_containerEl: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addDropdown(): this {
		return this;
	}
	addSlider(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
}

export class Component {
	load(): void {}
	unload(): void {}
}

/**
 * Obsidian's toast. The tests care about *whether* the plugin told the
 * user something (e.g. that developer mode revoked a running capture), so
 * every message is recorded on a static list the suite can read and reset.
 */
export class Notice {
	static messages: string[] = [];
	constructor(message: string) {
		Notice.messages.push(message);
	}
	setMessage(): this {
		return this;
	}
	hide(): void {}
}

export class Plugin {}
export class MarkdownView {}

export const MarkdownRenderer = {
	render: async (): Promise<void> => {},
};
