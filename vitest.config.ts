import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		setupFiles: ["./tests/setup.ts"],
		/**
		 * Keep files serial. The collision-continuity suite is deliberately
		 * CPU-bound; running it beside the other animation suites can starve
		 * fake-frame loops long enough to hit the wall-clock timeout even though
		 * every case passes in isolation.
		 */
		fileParallelism: false,
		/**
		 * The collision-continuity suite sweeps thousands of simulated
		 * frames per case; it is compute-bound, not wall-clock-asserting,
		 * and legitimately needs more than the 5 s default. Setting it here
		 * (rather than passing --testTimeout on the command line) keeps
		 * `pnpm test` green as the single validation gate.
		 */
		testTimeout: 40000,
		hookTimeout: 40000,
	},
});
