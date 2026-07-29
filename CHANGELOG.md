# Changelog

All notable changes to Glide Outline will be documented in this file.

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
