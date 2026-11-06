# Pointer interaction revision (draft)

Baseline: remote main a128b5d, version 0.1.7, PR #15 already merged.
Local comparison branch: codex/interaction-baseline-a128b5d.

## Decision paths

- Previously, any real outline element at an edge Y could start scrolling;
  latched sessions also survived the full hover envelope. Edge acquisition
  now uses the separately cached, actual 28px marker-rail rectangle. Card
  width and hover-retention width never participate. Left/right use the
  measured rail, not assumed screen coordinates.
- Hover Snap previously reset both intents, the applied velocity and the
  pointer sample ring. It now yields to rail-edge intent, meaningful pointer
  motion outside the snap deadband, or an already-moving integrator.
  Pressed Target Lock remains independent and immediately freezes motion.
- Edge owns the integrator while eligible, rather than adding an opposing
  follow velocity. Rail exit brakes the existing velocity before follow
  resumes. Wheel cooldown retains priority.
- HoverSession no longer accumulates a viewport-wide longest-title corridor.
  It uses current per-row bridge geometry and connects only neighbouring
  gaps up to 32px. Existing collapse grace covers brief larger crossings.
  Item geometry uses content coordinates; fixed rail geometry uses client
  coordinates. No invisible DOM surface was introduced.
- Unlocked Dock focus uses continuous pointer inversion, not a rapidly
  changing preferred DOM anchor. A real, positive-sized acquisition rect
  must still contain the pointer, preventing stale scroll-time DOM hits
  from acquiring the old card.

## Parameters and diagnostics

Maximum speed, acceleration, 140ms edge dwell, snap deadband, configured
edge depth, and persisted settings are unchanged. Tests use 40px end bands
as the requested initial experiment. Follow no longer treats samples older
than its existing 90ms window as sustained input; integrator braking remains.

In Developer Mode, start an existing performance capture and reproduce the
gesture, then use “Copy Glide Outline diagnostics”. `outline.interactionTrace`
contains up to 300 frames: coordinates, Rail/Card/Gap/Outside, pending/active
edge state, follow state, snap key, anchor key, stop reason and velocity.
Normal mode records no trace. This is a bounded diagnostic export, not an
automated runtime replay tool or a persistent vault log. Lock/anchor/intent
transitions can be compared between successive exported frames; dedicated
aggregate transition counters are not added in this draft.

## Verification and remaining human check

`tests/interaction-zones.test.ts` exercises 126 variable-height, mixed-level,
mixed-length rows: left/right edges, continuous edge scrolling, wide cards,
rail exit braking, stationary non-edge rail hover, invalid rail geometry,
follow release, sample preservation, old-snap override, exclusive edge
priority, prompt follow stopping and independent press activation.
Existing collision continuity, sparse writes, frame budgets, gap sampling,
wheel routing and activation tests remain part of the full suite.

Manual acceptance in Test Vaults remains necessary: slow movement, 1–3px
jitter on enlarged cards, rapid reversal/deceleration, long-to-short gap
crossings and click accuracy after scrolling. Compare the existing zone
setting with 40px manually; this draft does not overwrite user preferences.
Do not merge or release until those checks are approved.
