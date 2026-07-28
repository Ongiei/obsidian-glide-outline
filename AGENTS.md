# AGENTS.md — automated-workflow rules for Glide Outline

These are hard rules for automated agents (and a quick reference for humans).
Follow them exactly.

## Fixed workflow (mandatory)

1. **Build after every source change.**
   `pnpm run build` (runs `tsc --noEmit` + esbuild). A green build is required
   before deploying or committing.

2. **Deploy to the single test vault only.**
   Copy `main.js` / `manifest.json` / `styles.css` to:
   `/Users/ongiei/Documents/obsidian-eudic-bridge/integration-vault/.obsidian/plugins/glide-outline/`
   - Never overwrite that vault's `data.json`.
   - Never deploy to the main Obsidian library.

3. **Push after every task.** `git push -u origin <branch>` once a unit of work
   is committed. Do not accumulate unpushed work.

4. **Single PR, squash-merged.** Open exactly one PR into `main` per feature
   cluster. Merge with `gh pr merge --squash --delete-branch`. Retire superseded
   branches whose content is already folded into the merged tree.

5. **No release / no tag** unless the user explicitly asks for one. When asked,
   bump `manifest.json` + `package.json` + `versions.json` together, tag
   `X.Y.Z` (no `v` prefix), and attach the three build artifacts to the GitHub
   Release.

## Behavior rules

- **Implement directly. Do not add unrelated features.** Stay within the
  requested scope.
- Keep the runtime model fixed (Full motion); do not reintroduce motion-mode /
  animation toggles that were intentionally removed.
- Silently ignore legacy persisted settings (e.g. old `textEffect` /
  `textShadow`); migrate `pointerAutoScrollStrength` → `pointerAutoScrollSpeed`.
- Prefer the `aria-labelledby` + sr-only span pattern for accessible names
  (Obsidian renders `aria-label` as a hover tooltip — avoid it).

## Validation gates

Before declaring work done: `pnpm run build` ✅, `pnpm run lint` ✅,
`pnpm test` ✅. CI on the PR must be green before merging.
