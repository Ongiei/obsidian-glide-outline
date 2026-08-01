// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import GlideOutlinePlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { GlideOutlineSettings } from "../src/settings";
import type { ColdStartTrace } from "../src/core/ColdStartTrace";
import { getActiveColdStartTrace } from "../src/core/ColdStartTrace";
import type { PerfCapture } from "../src/core/PerfCapture";
// Imported by path, not by the "obsidian" specifier, so the static
// message list is typed — vitest aliases both to the same module.
import { Notice } from "./mocks/obsidian";

/**
 * §十四 / §十七: developer mode is the gate for the ENTIRE diagnostic
 * surface, and switching it off has to revoke three separate things:
 *
 *   1. a running performance capture (its longtask observer included);
 *   2. a running cold-start trace — a 30 s RAF loop plus a second
 *      longtask observer;
 *   3. the ARMED latch, which lives in settings and would otherwise
 *      silently start a trace on the NEXT reload, long after the user
 *      switched the tooling off.
 *
 * (3) is the nastiest of the three because it survives a restart, so it
 * is pinned from both ends: the gate clears it, and a reload that somehow
 * still sees it armed refuses to build the trace.
 */
interface PluginInternals {
	settings: GlideOutlineSettings;
	coldStart: ColdStartTrace | null;
	perf: PerfCapture;
	saveData(data: unknown): Promise<void>;
	maybeArmColdStart(coldStartAt: number): void;
	enforceDeveloperModeGate(): void;
}

describe("developer mode gate over the diagnostic surface (§十四)", () => {
	let plugin: PluginInternals;
	let saves: GlideOutlineSettings[];

	function settingsWith(
		patch: Partial<GlideOutlineSettings>,
	): GlideOutlineSettings {
		return { ...structuredClone(DEFAULT_SETTINGS), ...patch };
	}

	beforeEach(() => {
		Notice.messages.length = 0;
		saves = [];
		// The gate and the arm latch are pure settings/lifecycle logic —
		// they touch none of the workspace wiring `onload` sets up, so the
		// bare instance is the honest harness here.
		const Ctor = GlideOutlinePlugin as unknown as new () => unknown;
		plugin = new Ctor() as PluginInternals;
		plugin.saveData = async (data: unknown): Promise<void> => {
			saves.push(structuredClone(data) as GlideOutlineSettings);
		};
	});

	afterEach(() => {
		plugin.coldStart?.dispose();
		plugin.coldStart = null;
		if (plugin.perf.active) plugin.perf.abort();
		// Never leak a trace into the next test's ambient hooks.
		expect(getActiveColdStartTrace()).toBeNull();
	});

	describe("arming a cold-start trace", () => {
		it("builds the trace and consumes the latch on a developer reload", () => {
			plugin.settings = settingsWith({
				developerMode: true,
				coldStartCaptureArmed: true,
			});

			plugin.maybeArmColdStart(0);

			expect(plugin.coldStart).not.toBeNull();
			expect(getActiveColdStartTrace()).toBe(plugin.coldStart);
			// One-shot: the latch is cleared and persisted immediately, so a
			// crash later in onload cannot re-fire it.
			expect(plugin.settings.coldStartCaptureArmed).toBe(false);
			expect(saves).toHaveLength(1);
			expect(saves[0].coldStartCaptureArmed).toBe(false);

			plugin.enforceDeveloperModeGate(); // developer mode still on
			expect(plugin.coldStart).not.toBeNull();

			// Tidy up before the shared afterEach assertion.
			plugin.coldStart?.dispose();
			plugin.coldStart = null;
		});

		it("refuses to start a trace when developer mode is off", () => {
			// The user armed the capture, switched developer mode off, then
			// reloaded. The stale latch must not resurrect the trace.
			plugin.settings = settingsWith({
				developerMode: false,
				coldStartCaptureArmed: true,
			});

			plugin.maybeArmColdStart(0);

			expect(plugin.coldStart).toBeNull();
			expect(getActiveColdStartTrace()).toBeNull();
			expect(plugin.settings.coldStartCaptureArmed).toBe(false);
			// The revocation is written through, so the reload after this one
			// cannot observe the armed state either.
			expect(saves).toHaveLength(1);
			expect(saves[0].coldStartCaptureArmed).toBe(false);

			// A second reload sees a clean latch and does nothing at all.
			plugin.maybeArmColdStart(0);
			expect(plugin.coldStart).toBeNull();
			expect(saves).toHaveLength(1);
		});

		it("costs nothing on an un-armed reload", () => {
			plugin.settings = settingsWith({
				developerMode: true,
				coldStartCaptureArmed: false,
			});

			plugin.maybeArmColdStart(0);

			expect(plugin.coldStart).toBeNull();
			expect(getActiveColdStartTrace()).toBeNull();
			expect(saves).toHaveLength(0);
			expect(Notice.messages).toHaveLength(0);
		});
	});

	describe("switching developer mode off", () => {
		it("disposes a running trace and clears the ambient hook", () => {
			plugin.settings = settingsWith({
				developerMode: true,
				coldStartCaptureArmed: true,
			});
			plugin.maybeArmColdStart(0);
			const trace = plugin.coldStart;
			expect(trace).not.toBeNull();
			saves.length = 0;

			plugin.settings.developerMode = false;
			plugin.enforceDeveloperModeGate();

			expect(plugin.coldStart).toBeNull();
			expect(getActiveColdStartTrace()).toBeNull();
			expect(saves).toHaveLength(1);
			expect(
				Notice.messages.some((m) => /cold-start capture/.test(m)),
			).toBe(true);
		});

		it("revokes an armed latch even when no trace is running", () => {
			// Arming and then switching developer mode off in the SAME
			// session: there is no trace yet, only the persisted latch.
			plugin.settings = settingsWith({
				developerMode: false,
				coldStartCaptureArmed: true,
			});

			plugin.enforceDeveloperModeGate();

			expect(plugin.settings.coldStartCaptureArmed).toBe(false);
			expect(plugin.coldStart).toBeNull();
			expect(saves).toHaveLength(1);
			expect(saves[0].coldStartCaptureArmed).toBe(false);
			expect(
				Notice.messages.some((m) => /disarmed and discarded/.test(m)),
			).toBe(true);
		});

		it("aborts a running performance capture and discards its samples", () => {
			plugin.settings = settingsWith({ developerMode: true });
			plugin.perf.start(window as Window & typeof globalThis);
			expect(plugin.perf.active).toBe(true);

			plugin.settings.developerMode = false;
			plugin.enforceDeveloperModeGate();

			expect(plugin.perf.active).toBe(false);
			// `abort` discards — a report is never produced from it.
			expect(plugin.perf.stop(window as Window & typeof globalThis)).toBeNull();
			expect(
				Notice.messages.some((m) => /performance capture/.test(m)),
			).toBe(true);
		});

		it("revokes the capture and the latch together in one pass", () => {
			plugin.settings = settingsWith({
				developerMode: true,
				coldStartCaptureArmed: true,
			});
			plugin.maybeArmColdStart(0);
			plugin.perf.start(window as Window & typeof globalThis);
			plugin.settings.coldStartCaptureArmed = true; // re-armed for the next reload
			saves.length = 0;
			Notice.messages.length = 0;

			plugin.settings.developerMode = false;
			plugin.enforceDeveloperModeGate();

			expect(plugin.perf.active).toBe(false);
			expect(plugin.coldStart).toBeNull();
			expect(getActiveColdStartTrace()).toBeNull();
			expect(plugin.settings.coldStartCaptureArmed).toBe(false);
			expect(Notice.messages).toHaveLength(2);
		});

		it("says nothing when there is nothing to revoke", () => {
			plugin.settings = settingsWith({
				developerMode: false,
				coldStartCaptureArmed: false,
			});

			plugin.enforceDeveloperModeGate();

			expect(saves).toHaveLength(0);
			expect(Notice.messages).toHaveLength(0);
		});

		it("is a no-op while developer mode is on", () => {
			plugin.settings = settingsWith({
				developerMode: true,
				coldStartCaptureArmed: true,
			});

			plugin.enforceDeveloperModeGate();

			expect(plugin.settings.coldStartCaptureArmed).toBe(true);
			expect(saves).toHaveLength(0);
			expect(Notice.messages).toHaveLength(0);
		});
	});
});
