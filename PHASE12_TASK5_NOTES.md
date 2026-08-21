# NAP-IQ — Phase 12 (60%) — TASK 5 of N — Notes

## Scope of this session (one task only, per your instruction)

Following Task 1 (calculation engine), Task 2 (wiring live GPS fixes
into it), Task 3 (bridging state into the technician marker), and
Task 4 (wiring the same state into the Route Details Panel), this
session did exactly **one** more task — the second item on the
"remaining Phase 12 tasks" list left at the end of
`PHASE12_TASK4_NOTES.md`:

> 2. Noise/monotonicity guarding (don't let a noisy fix make progress
>    jump wildly backward/forward).

Nothing else in Phase 12 was touched. Item 3 on that list (using
`offRouteDistanceMeters` to flag/handle a fix too far from the road)
is still open and is a distinct signal from what this task guards.

### Task 5 (done this session): reject noisy/jumpy GPS fixes before they reach visible state

**Only one file changed logic in: `app/static/js/nav-gps-route-progress.js`**
(Task 2's wiring file — the correct place for this, since Task 1's
`nav-route-progress.js` explicitly documents that deciding whether to
*trust* a projection is out of its own scope, and Tasks 3/4 only
*render* whatever this module hands them).

**The guard, in plain terms:** every raw GPS fix is still projected
onto the route by Task 1's unchanged `computeProgress()` exactly as
before. What's new is a gate in front of accepting that projection
into the state Task 3/4 read:

- The **first** fix against a (newly) ready route is always accepted
  — nothing to compare it to yet.
- Every fix after that is compared to the **last accepted** fix (not
  the last *received* one, so a run of bad fixes can't drag the
  baseline off course):
  - **Backward jump** — projects more than 25m behind the last
    accepted point → **rejected**. A small allowance (25m) is kept for
    ordinary GPS jitter, which can legitimately nudge the projection a
    few meters backward even while genuinely moving forward.
  - **Hard forward ceiling** — projects more than 400m ahead of the
    last accepted point, regardless of how much time passed →
    **rejected** outright (catches teleport-style glitches no matter
    the time gap).
  - **Implausible speed** — for smaller forward jumps where enough
    time has passed to make a speed estimate meaningful, an implied
    speed over 45 m/s (~162 km/h, deliberately generous for a road
    vehicle) → **rejected**.
  - **Out-of-order timestamp** — a fix timestamped earlier than the
    last accepted one → **rejected**.
  - Anything else → **accepted**, becomes the new baseline.
- **Rejected fixes change nothing visible.** This is a reject/keep
  policy, not smoothing or averaging: the panel and marker keep
  showing the last *accepted* real projection until a new fix passes
  the gate. No number shown is ever blended or invented — always a
  real projection from some actual fix.
- The guard's own bookkeeping (`lastFixAccepted`,
  `lastRejectionReason`, `acceptedFixCount`, `rejectedFixCount`) is
  exposed as a new `guard` object on `getState()`, purely for
  visibility/testing — it does not feed back into the progress
  numbers themselves.
- The guard's baseline (`lastAccepted`) resets alongside the rest of
  this module's state at every existing reset trigger (GPS tracking
  stopped, destination/origin changed, route no longer ready) so a
  comparison never spans two different routes or GPS sessions.

**Not touched:** `nav-route-progress.js` (Task 1's pure calculation
engine — still computes an honest instantaneous projection with no
opinion on trust, exactly as its own header always said it would),
`nav-gps-technician-marker.js` (Task 3), and `nav-routing.js`'s Route
Details Panel code (Task 4) — both automatically benefit from the
guard just by continuing to read `NapIQNavGpsRouteProgress.getState()`
as they already did, with no changes needed on their side.

**Template comment-only change:** `app/templates/naps/map.html` — the
Task 2 script-tag comment now also describes Task 5's addition (no new
`<script>` tag was needed).

### Verified

- `node --check app/static/js/nav-gps-route-progress.js` — syntax OK.
- A standalone Node harness (`/tmp/test_guard.js`, not shipped —
  throwaway verification only) loaded the **real, unmodified**
  `nav-route-progress.js` and the **real, modified**
  `nav-gps-route-progress.js` against a synthetic 1km straight route,
  using a real `EventTarget`/`CustomEvent` (both native in the Node 22
  sandbox) to simulate the actual browser event flow, and fed it a
  sequence of raw fixes:
  1. First fix (~10% along route) → **accepted** (bootstrap case).
  2. Normal forward movement 5s later to ~30% (40 m/s implied, under
     the 45 m/s cap) → **accepted**.
  3. Sudden backward jump to ~5%, only 1s later → **rejected**
     (`backward_jump`); shown progress stayed at 30%.
  4. Small backward jitter (~10m behind the last accepted fix, within
     the 25m tolerance) → **accepted**.
  5. A teleport-style jump to ~90%, 1s later (implies ~600 m/s and
     exceeds the 400m hard ceiling) → **rejected**
     (`forward_jump_too_large`); shown progress stayed unchanged.
  6. Legitimate continued forward movement at a normal speed, several
     seconds later → **accepted**.
  7. Destination changed (route no longer ready) → state and the
     guard's baseline both reset (`active: false`,
     `guard.lastFixAccepted: null`).
  8. A fix that would have been rejected against the *old* baseline
     (the same ~90% jump from step 5) → **accepted** once fed against
     a fresh, ready route, confirming the guard correctly starts over
     rather than carrying a stale baseline across routes.
  All eight checks passed exactly as designed — see
  `phase12_task5_screenshots/01_noise_guard_test_sequence.png` for a
  rendered summary of steps 1–6 (built from the same test's real
  logged output, not hand-typed numbers).
- Confirmed by inspection/diff against the previously delivered zip
  that `nav-route-progress.js`, `nav-gps-technician-marker.js`, and
  `nav-routing.js` are byte-for-byte unchanged this session — the
  guard is fully contained in the one file whose job is state wiring.

## Explicitly NOT done this session (deferred to the next Phase 12 task)

- **No use of `offRouteDistanceMeters`.** This task guards
  *along-route* jump size/speed only. A fix that's perfectly
  monotonic and slow along the route but sitting, say, 200m
  perpendicular off the mapped road (e.g. a technician actually inside
  a building, or a bad multipath fix that happens to still project
  plausibly) is still accepted by this task's guard — that's a
  different signal, and is explicitly the next open item.
- **No smoothing/averaging.** Deliberately not implemented — every
  number shown remains a real, single fix's projection, never a
  blended value. If this turns out to be too abrupt in practice (e.g.
  visible "steps" between accepted fixes), that would be a UX
  refinement for a later phase, not something this task's acceptance
  criteria ask for.
- **Thresholds are not configurable or tuned against real device GPS
  traces** — chosen to be generous/conservative based on reasoning
  about plausible vehicle speeds and typical consumer GPS jitter, not
  from field data (this sandbox has no browser/GPS hardware — same
  limitation noted in every prior Phase 12 task's notes).

## Files changed this session

- **Added:** `PHASE12_TASK5_NOTES.md` (this file)
- **Added:** `phase12_task5_screenshots/01_noise_guard_test_sequence.png`
- **Modified:** `app/static/js/nav-gps-route-progress.js` — added the
  guard thresholds, `lastAccepted` baseline, `guard` bookkeeping
  object, `evaluateGuard()`, and the accept/reject branch inside
  `onFixReceived()`; `resetState()` now also clears the guard's
  baseline and bookkeeping. `getState()` gained one new `guard` field;
  every existing field is unchanged in shape and meaning. No other
  function, event name, or reset trigger was added, removed, or
  altered.
- **Modified:** `app/templates/naps/map.html` — comment-only update to
  the existing Task 2 script-tag block describing Task 5's addition;
  no `<script src="...">` line was added, removed, or reordered.

## Status

Phase 12 is **still not complete**. This was task 5 of several.
Per your instruction, stopping here again — no further Phase 12 work
was started this session, and no Phase 13 work was touched.

Remaining Phase 12 tasks (per the running list):
1. ~~Route Details Panel wiring~~ — done (Task 4).
2. ~~Noise/monotonicity guarding~~ — **done this session (Task 5).**
3. Use of `offRouteDistanceMeters` to actually flag/handle a fix
   that's too far from the road to trust.
