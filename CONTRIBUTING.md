# Contributing to Glide Outline

Thanks for contributing! This plugin is a TypeScript Obsidian extension built with
esbuild, Vitest (jsdom), ESLint, and pnpm.

## Development

```bash
pnpm install
pnpm run build     # tsc --noEmit + esbuild production bundle
pnpm run lint      # eslint src tests
pnpm test          # vitest run
```

Run all three before opening a pull request — CI runs the same pipeline.

## Branching & pull requests (important)

Glide Outline uses a **linear, single-PR** workflow:

- Build each piece of work on a dedicated branch cut from `main` (or from the
  branch that already carries its prerequisite work). Keep branches **linear**:
  a later branch should descend from an earlier one rather than fanning out.
- Open **exactly one PR into `main`** per feature cluster. Do not open one PR
  per branch and merge them in parallel — fold the work into a single PR.
- Merge with **squash** (`gh pr merge --squash --delete-branch`) so `main`
  stays a clean, reviewable line of commits.
- Once a branch's content has landed on `main`, **retire the superseded
  branches** (`git push origin --delete <branch>` + local `git branch -D`).
  Verify the content is already reachable from the merged tree before deleting.
- Never leave orphan branches lying around.

## Local testing

After **every** source change, rebuild and copy the three artifacts into the
**single** integration test vault:

```
/Users/ongiei/Documents/obsidian-eudic-bridge/integration-vault/.obsidian/plugins/glide-outline/
```

Copy only `main.js`, `manifest.json`, and `styles.css`. **Do not** overwrite
that vault's `data.json`, and **do not** deploy to the main Obsidian library.

## Commits

Group changes into themed commits (one concern per commit) with conventional
prefixes: `feat:`, `fix:`, `refactor:`, `perf:`, `test:`, `chore:`. Keep PRs
squash-merged, so the per-commit history is for review clarity, not permanence.

## Releases

Releases are cut from `main` only when explicitly requested. Bump
`manifest.json`, `package.json`, and `versions.json` together, tag
`vX.Y.Z` **without** a `v` prefix, and publish a GitHub Release with the three
build artifacts (`main.js`, `manifest.json`, `styles.css`) attached.
