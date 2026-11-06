# Review fixes and verification — 2026-11-06

The eight confirmed defects from the full review are fixed. The final batch
also addresses short-distance heading-selection jitter, measured full-list
work in hot paths, settings discoverability, and local community checks.
The runtime remains Full motion; no release or version change is included.

## Correctness and lifecycle

| Finding | Result | Regression coverage |
| --- | --- | --- |
| F1: old jumps keep correcting after user takeover or context changes | Cancel correction and preview retries on real input; reject stale file, mode, editor and document contexts | Controller navigation and tracker integration tests |
| F2: mixed scroll/document coordinates | Highlight and navigation share the editor content-origin adapter | Padding, document-top and viewport coordinate tests |
| F3: duplicate preview titles with virtualized gaps | Reserve line matches first; ambiguous incomplete duplicate groups cannot use text fallback | Preview heading mapping tests |
| F4: rich-label cache ignores source file | Include sourcePath; each label owns its render component and replacement DOM | Cross-file links, late render completion and component cleanup tests |
| F5: auxiliary mouse buttons activate headings | Only unmodified primary activation; links retain their own actions; lost capture releases the press | Pointer activation and capture tests |
| F6: edge dwell completes after leaving its zone | Cancel/revalidate pending dwell without removing engaged-edge hysteresis | Edge scroll controller tests |
| F7: deeper headings leave stale width budgets | Recompute responsive width when visible depth changes | View layout tests |
| F8: preview blur handlers outlive their owner | One idempotent cleanup per temporary focus target | Navigation cleanup tests |

F1–F4 were merged in [PR #17](https://github.com/Ongiei/obsidian-glide-outline/pull/17).
F5–F8 were merged in [PR #18](https://github.com/Ongiei/obsidian-glide-outline/pull/18).
Late metadata snapshots are also ignored when they differ from the active
editor document; fresh metadata and preview-mode updates still apply.

## Neighbour-selection jitter

The old ownership test treated velocity above 120 px/s outside the frozen
snap area as browsing intent. A 3px move every 16ms already exceeds that
threshold. It could start scrolling before the neighbouring card acquired
the pointer; a transparent gap also temporarily released the layout anchor.
When the pointer slowed, snap ownership returned, producing competing motion.

The controller now resolves the immediate neighbour in the pointer's vertical
direction. It preserves the current anchor across the shared horizontal gap
and transfers directly when the pointer enters the neighbour's real bounds.
Sustained travel of at least max(48px, current magnified row height) within the
90ms sample window yields to browsing. The frozen in-card hold still wins;
rail-edge intent, ongoing scroll and press locking retain their priority.
No new preference, invisible click target or fixed waiting delay is added.

Regression fixtures reproduce the pre-fix unintended scroll with 3px steps.
They now cover upward/downward and left/right transfers at 1.85× magnification
and 2.5× follow strength, with no scroll, no empty ownership and no backtrack.
Existing sustained sweep, edge dwell, braking and press tests remain enabled.

## Performance and maintenance

- Cache maximum row height with the geometry revision instead of scanning all
  heights each frame. A 10,000-row range lookup reads fewer than 40 heights.
- Use lazy binary search for active headings in source/cursor modes instead
  of measuring every heading on scroll. A 10,000-heading lookup is logarithmic.
- Snapshot model, geometry and appearance settings separately. Speed/opacity
  adjustments no longer reconcile every row or remeasure unchanged geometry.
- Collect modern searchable setting definitions from the same control builders
  used by the legacy display path, avoiding two independently maintained UIs.
- Represent non-contiguous heading filters honestly as Custom in the toolbar.
- Use the active editor's window for performance capture and instance-owned
  CSS anchors for otherwise-static mount hosts, with reversible cleanup.
- Upgrade the project-local official lint plugin from 0.4.1 to 0.5.1; validate
  source, manifest, package and license with zero permitted warnings. No
  official rule was suppressed to satisfy third-party guidance.

## Verification

- Build, lint, local `check:community`, frozen-lockfile installation and all
  779 tests across 55 files passed. Lint reports zero errors and warnings.
  PR CI must also pass before merge.
- Test host: Obsidian 1.15.0, installer 1.14.4, existing Test Vaults.
- Deployed only main.js, manifest.json and styles.css; verified copied bytes
  and preserved data.json. The previous artifacts were backed up.
- Actual-host programmatic pointer test: three neighbouring transfers over
  42 sampled frames with the vault's 1.85× scale and 2.5× follow strength;
  zero scroll drift, missing owners, follow frames or backtracks.
- Actual-host navigation interruption cancels further correction after wheel
  input; auxiliary mouse buttons do not activate headings.
- Native settings render 34 searchable controls in 10 groups; all 16 sliders
  retain their value readouts. No errors were captured during the checks.

These checks establish deterministic behaviour, not subjective physical-mouse
smoothness. The minimum supported 1.5.0 runtime, mobile/popout matrix, native
wheel-boundary handoff and online Community scanner were not certified by
this batch. The local readiness command is not the online scanner.

## Lower-priority follow-up

Large controller/view decomposition, diagnostic-schema extraction, incremental
parsing and full DOM virtualization remain possible improvements, not verified
defects. They need separate profiling and behaviour-preserving changes rather
than being mixed into this repair. Keyboard roving focus and a unified Escape
return path are likewise separate interaction enhancements. This record does
not claim that every architectural suggestion has been implemented.

## Settings interface correction

The initial native-group migration bypassed the custom display() layout on
modern hosts. The settings page now uses one native render definition that
mounts the original four tabs, with the 34 control names as page search aliases.
Search locates the tabbed page rather than individual native control rows.
Chinese host language now supplies Chinese tabs, setting names, descriptions,
options and reset-button text. Actual-host checks clicked all four tabs and
verified Chinese panels and 34 search aliases. The earlier native-group counts
above describe the superseded implementation, not the current interface.
