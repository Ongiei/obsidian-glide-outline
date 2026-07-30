# Changelog

All notable changes to Glide Outline will be documented in this file.

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

Collision continuity hotfix + pointer movement assist strength.

- fix: P0 collision regression — magnified neighbours no longer overlap at the motion-range boundary, and the "Newton's cradle" propagation under wheel scroll is eliminated. A three-range frame loop (Scale / Collision / Write) solves once per frame over Visible ∪ Scale + guard, and a lockstep taper chain walks the residual boundary push to zero across off-screen rows (snapped, re-anchored each frame, bridging legacy settling fields, half-pixel handoff apron).
- fix: solver per-pair gaps clamped to the base layout's own clearance + 1px DPR snap headroom on actively spread pairs.
- fix: scroll anchor refresh after scroll — stale anchors no longer cause overlap on the first post-scroll frame.
- feat: **Pointer movement assist strength** — a new independent setting (0.5–2.5, default 1) that scales the kinetic pre-scroll magnitude and cap. The Edge auto-scroll speed (renamed from "Auto-scroll speed") now only affects edge dwell scrolling; the two can be tuned completely independently. Base kinetic params retuned for a noticeably stronger default feel (min speed 140→120, gain 0.25→0.35, max share 0.45→0.60).
- feat: unified scroll-intent coordinator — edge auto-scroll (position-only, dwell + hysteresis latch) and pointer-follow (velocity-driven kinetic intent, no dwell) feed one shared acceleration-capped integrator. Manual wheel pauses both.
- perf: extended performance capture — solver/range/expansion samples, overlap diagnostics, renderer long-task stats, per-phase plugin RAF timings.
- test: 17-test collision-continuity regression suite (pointer sweeps + boundary cases, dpr 1/2, mixed heights).

## 0.1.2

Performance pipeline, wheel routing and pointer-follow pre-scroll.

- perf: split Visible/Motion/Settling ranges — each frame iterates only Motion ∪ Settling rows instead of the whole visible window.
- perf: expanding the outline no longer triggers a full geometry rebuild (envelope refresh only).
- perf: `measureRows` dedup — one batched read sweep, style writes only for rows whose height actually changed; redundant passes write nothing.
- perf: extended on-demand performance capture — renderer long-task stats (count/total/max), per-phase plugin RAF timings (avg/p95/max), measureRows / wheel / auto-scroll counters.
- fix: Windows text clarity — split `is-shifting` / `is-scaling` GPU layer hints per axis, narrowed `will-change` to actively moving rows, DPR pixel-aligned `translateY` shifts.
- fix: rows removed from the list drop both layer-hint classes exactly once.
- feat: wheel routing — the wheel scrolls the outline while the pointer is over it (window capture listener, pure-math ownership decision); dead ends, no-overflow, zoom gestures and horizontal wheels pass through to the editor; a manual wheel pauses automatic scrolling for 160 ms.
- feat: pointer-follow pre-scroll — fast vertical pointer flicks pre-scroll the list toward the gesture (no dwell), independent from edge auto-scroll, combined and clamped below max speed; new `Pointer-follow pre-scroll` setting (default on).
- docs: README documents the four independent scrolling mechanisms.
- test: 45 new tests (wheel routing, pointer-follow, measureRows dedup, plugin phase stats, split layer-hint classes).

Windows manual validation: not performed (macOS-only development; validate via BRAT).

## 0.1.0 (unreleased)

Initial version.

- Editor-margin heading rail rendered inside the active Markdown view.
- Marker length encodes heading level; active heading is highlighted.
- Pointer-proximity reveal: markers expand into heading labels on hover.
- Dock-style cosine magnification with continuous vertical displacement.
- Dual-channel heading data: instant editor parsing corrected by metadata cache.
- Stable heading identity (level + normalized text + occurrence index).
- Scroll-viewport based active heading tracking (activation line at 20% height).
- Click-to-jump in Source Mode, Live Preview and Reading Mode.
- Settings: position, marker style, magnification, label width, level filter, animation toggle.
- `prefers-reduced-motion` support, keyboard focus and Enter/Space activation.
