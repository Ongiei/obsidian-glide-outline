import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"versions.json",
		"main.js",
		"pnpm-lock.yaml",
		"tsconfig.json",
	]),
	{
		files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mjs",
						"vitest.config.ts",
					],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["tests/**/*.ts", "vitest.config.ts"],
		rules: {
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/unbound-method": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/no-static-styles-assignment": "off",
			"obsidianmd/prefer-create-el": "off",
			"obsidianmd/prefer-instanceof": "off",
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}"],
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"no-console": ["warn", { allow: ["warn", "error"] }],
		},
	},
);
