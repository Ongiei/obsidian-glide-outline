# Changelog

All notable changes to Glide Outline will be documented in this file.

## 0.1.6 — Windows frame-budget reduction

Pure hot-path cost reduction. **No change** to interaction, animation, collision
correctness, or macOS smoothness.

- **§三** On-demand `PerfCapture` with a cheap LIGHT mode (≈6 `performance.now()`
  reads/frame) plus a DEEP mode whose fine-grained sub-phases are time-shared
  across four groups (§3.2), so a capture never distorts the budget it measures.
- **§五.1** The outline scroll path now reads only `scrollTop`; `clientHeight` /
  `scrollHeight` are cached (no forced layout read on every auto-scroll frame).
- **§五.2** Edge-fade classes are written only when they actually change; identical
  re-evaluations are skipped.
- **§六** A `pointerenter` that merely re-enters an already-expanded outline reuses
  the cached envelope geometry instead of queuing a forced layout; a `pointerleave`
  derives the envelope from cached motion math instead of rebuilding it.
- **§七** GPU compositor-layer hints are bounded to the magnification disc
  (scale range) plus a two-row guard, instead of being promoted for the whole
  visible window.
- **§九** `schedule()` is now attributed by reason (input vs self-scheduled); the
  idle-RAF loop is measured (`idleRafCount`, which must stay 0).

Correctness invariants preserved across the suite: `visibleOverlapViolationCount`,
`maxVisibleOverlapPx`, and `anchorFallbackScanCount` all remain 0.

> Frame-rate impact on Windows Electron is **not measured in CI** — it must be
> verified on a real Windows machine via BRAT after this release.

## 0.1.5

Consistently smooth editor jumps, and the 0.1.4 scroll-pipeline stats actually wired.

- fix: **editor jumps are now smooth every time**. The correction loop is a small state machine (smooth-estimate → smooth-client-correction → boundary-accepted / instant-fallback); an instant scroll only happens when explicitly gated, never as a silent fallback mid-round. Previously a jump was sometimes smooth and sometimes teleported depending on which correction round it landed in.
- fix: **scroll pipeline sub-phase stats were all zero in 0.1.4**. The eleven sub-phases are now measured inside the controller's own frame callback with paired timing reads; with capture off the path performs zero timing calls.
- feat: **scroll source attribution**. Every scroll event is classified (manual-wheel / edge / kinetic / combined / jump / mount / file-change / mode-change / external) via write-depth guards plus short-lived frame-TTL notes, and the perf report gains a `scrollDeltaBySource` histogram.
- feat: **large scroll delta diagnostics**. A scroll whose delta exceeds the viewport height records a bounded (max 10) snapshot — previous/current scrollTop, delta, heights, attributed source, pending context flags, instance id. Anomalous scrolls are never clamped or swallowed.
- feat: **mount host mutation diagnostics** (read-only, mount behaviour unchanged): computed/inline position before and after, whether the host was mutated and restored, and how many stale wrappers were swept.
- test: 513 tests (+28): 8 large-scroll-delta, 7 scroll-pipeline, 4 mount host-mutation lifecycle, plus a static outline-DOM tooltip-attribute scan (§十二) alongside the existing settings scan.

Collision taper, scale/collision ranges, pointer-follow strength and gain, edge auto-scroll, wheel routing, the content-coordinate cache, anchor resolve, CSS transforms, edge fade, markdown labels and tooltip visuals are untouched. Not re-verified on Windows across full jump distances in this release.

## 0.1.4

Jump accuracy, a content-space scroll pipeline, and clean DOM boundaries.

- fix: **jump landing error**. The corrector compared `lineBlockAt` (content origin) against `scrollTop` (scroller origin), so the inline title + properties block stayed in as a residual — a Windows capture settled 416.65625 px away while reporting zero error. The landing is now measured in client space via `coordsAtPos`, and a heading at the end of the document settles as `scroll-boundary` instead of failing.
- perf: **row geometry moved to content space**. A scroll now updates one number instead of rewriting every cached row, solver entry and envelope rect.
- perf: **anchor lookup is local + binary**. Anchor resolution is deferred to one per frame and done by a ±3 probe with a binary-search fallback, so `anchorFallbackScanCount` is 0 by construction.
- perf: **sparse dirty rows**. The write loop visits `collision ∪ dirty` as a set instead of an inclusive span, which always over-covered after a boundary taper.
- fix: **pointer follow**. `predictedY` drives the kinetic depth factor while eligibility keeps the actual position; gap moves are parked and committed by the frame-fresh envelope check, so the velocity ring no longer starves between cards and gap re-entry no longer wipes the gesture.
- feat: **mount isolation**. Everything the plugin renders now hangs off a single wrapper tagged `data-glide-outline-owner` (`display: contents`, so layout is unchanged). The host is no longer branded with a class: its computed `position` is read and an inline `position: relative` is written only when the host is `static`, then restored verbatim on dispose. Mounting sweeps stale wrappers, the pending measure rAF is cancelled, and the `tabindex="-1"` written onto preview headings is removed.
- fix: **fail-closed targeting**. Click/pointer resolution, the anchor lookup and the reading-intent gesture test verify ownership instead of trusting a class name, so a foreign node wearing Glide Outline's class names is ignored.
- fix: **the stylesheet can no longer paint outside the plugin**. Every rule is scoped with `:where([data-glide-outline-owner])` — zero added specificity, so existing cascade outcomes are unchanged.
- change: **no tooltips anywhere**. Obsidian renders `aria-label` as a hover bubble, so accessible names moved to sr-only spans referenced by `aria-labelledby`, and all 16 slider tooltips were replaced with an always-visible value readout next to the track.
- perf: `autoScroll` diagnostics split into eleven steps, plus scroll-pipeline, anchor-strategy, dirty-row and pointer-follow counters.
- test: 485 tests (+66), including a 21-test mount-isolation suite and static sweeps that fail the build if a tooltip or an unscoped CSS rule is reintroduced.

Not verified on Windows: this release was developed and tested on macOS only. The jump fix targets a Windows capture but has not been manually re-measured there.

## 0.1.3

Collision continuity hotfix + pointer movemen filter, animation toggle.
- `prefers-reduced-motion` support, keyboard focus and Enter/Space activation.
