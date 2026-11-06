# Pointer interaction revision — historical validation notes

Historical baseline: a128b5d, version 0.1.7. The implementation described below was merged as PR #16 (4939ec3). See REVIEW_FIXES.md for the subsequent review fixes and current validation limits.

## Decision paths

- Previously, any real outline element at an edge Y could start scrolling;
  latched sessions also survived the full hover envelope. Edge acquisition
  now uses the separately cached, actual 28px marker-rail rectangle. Card
  width and hover-retention width never participate. Left/right use the
  measured rail, not assumed screen coordinates.
- Hover Snap previously reset both intents, the applied velocity and the
  pointer sample ring. It now yields to rail-edge intent, meaningful pointer
  motion outside the snap retention geometry, or an already-moving integrator.
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
These physical-pointer checks remain an explicit manual acceptance task; automated tests do not certify subjective smoothness or release readiness.

## Follow-up review: snap ownership and endpoint symmetry

- Reproduced a controller-level mismatch: `PointerSnap.holds` accepts the
  acquired card plus tolerance OR the 18px deadband, but the controller
  checked only that deadband before clearing the lock for pointer velocity.
  A fast move inside a tall card therefore lost its valid owner. Both now
  use the same retention predicate; rail edge and already-running scroll
  still win. Follow must also be enabled, have overflow and have a fresh
  sample before it can claim a new gesture.
- Release used to force one empty ownership frame in `PointerSnap.update`,
  followed by a controller acquisition embargo until `aimSettling` ended.
  A valid neighbouring card now takes ownership immediately when no scroll
  owns the gesture. Visual release easing continues only when there is no
  valid new target. Press target locking remains unchanged.
- No solver, collision taper, envelope algorithm, maximum speed, damping,
  edge depth or saved setting was changed in this follow-up. The retained
  geometry is still frozen at acquisition; subjective behaviour at the
  boundary of a card that grows during magnification needs real mouse QA.
- Removed the bottom half-viewport spacer to match the already-zero top
  spacer. Endpoint active-follow now clamps to the actual scroll extent;
  the existing clamped-target path hides the misleading centre playhead.
  Expansion does not change layout or the endpoint scroll position.
- Settings now uses the native `settings` gear, with a 24px round hit/hover
  surface aligned to the 24px depth control. Resting Hx remains unpainted.
- Regression coverage adds fast in-card movement, disabled-follow handoff,
  slow handoff during release easing, left/right 1–3px jitter with alternating
  DOM hits, and last-row bottom alignment across expansion. These complement
  existing continuous-edge, press locking, no-overlap and idle-RAF tests.

These checks establish deterministic decision behaviour, not proof of
subjectively smooth physical-pointer interaction. Test Vaults human acceptance
remains pending; this document is a historical checklist, not evidence that it was completed.
