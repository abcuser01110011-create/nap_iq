# NAP-IQ — Phase 12 (60%) — TASK 6 of N — Notes

## Scope of this session (one task only, per your instruction)

Following Task 1 (calculation engine), Task 2 (wiring live GPS fixes
into it), Task 3 (bridging state into the technician marker), Task 4
(wiring the same state into the Route Details Panel), and Task 5
(noise/monotonicity guarding), this session did exactly **one** more
task — the last remaining item on the "remaining Phase 12 tasks" list
left at the end of `PHASE12_TASK5_NOTES.md`:

> 3. Use of `offRouteDistanceMeters` to actually flag/handle a fix
>    that's too far from the road to trust.

Nothing else in Phase 12 was touched.

### Task 6 (done this session): reject fixes that are too far from the mapped road

**Only one file changed logic in: `app/static/js/nav-gps-route-progress.js`**
(the same Task 2/5 wiring file — the correct place for this, since
Task 1's `nav-route-progress.js` explicitly documents that deciding
whether to *trust* a projection, including how far off-road it is, is
out of its own scope, and Tasks 3/4 only *render* whatever this
module hands them).

**The guard, in plain terms:** Task 1's `computeProgress()` has
always returned `offRouteDistanceMeters` — the perpendicular distance
from the raw GPS fix to the nearest point on the actual route
geometry — but until this session nothing ever looked at that number
for anything other than passing it through to `getState()`. Task 5's
guard (last session) only judged a fix by its *along-route* movement
(how far/fast it moved compared to the last accepted fix); a fix that
was perfectly slow and monotonic along the route but sitting, say,
200m off to the side — a bad multipath reflection, a fix reported
while physically inside a building or parking structure, or genuinely
on a different road than the one being navigated — would sail through
Task 5's checks untouched, because "monotonic and slow" is exactly
what such a fix's *projection* can still look like.

This session adds a second, independent check:

- `MAX_OFF_ROUTE_DISTANCE_METERS = 60` — deliberately generous (wider
  than a typical road plus realistic consumer GPS error), so it only
  rejects fixes that are genuinely nowhere near the mapped route, not
  ordinary lane-width drift or urban-canyon jitter.
- If a fix's `offRouteDistanceMeters` exceeds that threshold, it is
  rejected with reason `too_far_off_route` and never reaches state —
  the same reject/keep policy Task 5 established: visible progress
  keeps showing the last accepted reading rather than being
  overwritten by a value this module doesn't trust.
- **This check runs first, and applies to every fix — including the
  very first one against a (newly) ready route.** Task 5's
  along-route checks intentionally skip the first fix (there's
  nothing yet to compare it to), but "is this fix even near the road"
  needs no prior fix to evaluate. Letting a wildly off-road first fix
  become the trusted baseline would have meant every subsequent
  fix — however good — got judged against a bad starting point, so
  this check is deliberately independent of `lastAccepted`.
- Everything downstream is unchanged: if a fix passes the off-route
  check, it proceeds into Task 5's existing backward/forward/speed/
  timestamp checks exactly as before. A fix that is both off-road
  *and* would have failed a Task 5 check is simply reported as
  `too_far_off_route` (the first check to run), since either reason
  produces the same outcome (rejected, state untouched).
- `guard.lastRejectionReason` can now additionally be
  `"too_far_off_route"` — no other field, event, or reset trigger
  changed shape.

**Not touched:** `nav-route-progress.js` (Task 1's pure calculation
engine — `offRouteDistanceMeters` was already computed there since
Task 1; this task only starts *acting* on the number, in the wiring
file, not the engine), `nav-gps-technician-marker.js` (Task 3), and
`nav-routing.js`'s Route Details Panel code (Task 4) — both
automatically benefit from the guard just by continuing to read
`NapIQNavGpsRouteProgress.getState()` as they already did, with no
changes needed on their side.

**Template comment-only change:** `app/templates/naps/map.html` — the
Task 2 script-tag comment now also describes Task 6's addition (no
new `<script>` tag was needed, same as Tasks 4 and 5).

### Verified

- `node --check app/static/js/nav-gps-route-progress.js` — syntax OK.
- Full syntax pass across every file in `app/static/js/*.js` and every
  `.py` file in `app/` — all OK, confirming no other file was touched.
- A standalone Node harness (`/tmp/test_task6.js`, not shipped —
  throwaway verification only) loaded the **real, unmodified**
  `nav-route-progress.js` and the **real, modified**
  `nav-gps-route-progress.js` against a synthetic 1km straight route,
  using a real `EventTarget`/`CustomEvent` to simulate the actual
  browser event flow, and fed it:
  1. A first fix exactly on the route (10% along) → **accepted**
     (on-route bootstrap).
  2. A fix ~222m perpendicular off the route, 5s later → **rejected**
     (`too_far_off_route`); shown progress stayed at 10%.
  3. A normal forward fix back on the route (~30% along), reasonable
     implied speed → **accepted**; progress correctly advanced to
     30% (confirming the guard doesn't block legitimate fixes after a
     rejection).
  4. A fix ~20m off the road (within the 60m tolerance, ~50% along)
     → **accepted**; progress advanced to 50% (confirming ordinary
     lane-width/GPS-error drift is not falsely rejected).
  5. Destination changed (route no longer ready) → state and the
     guard's baseline both reset (`active: false`,
     `guard.lastFixAccepted: null`).
  6. The same ~222m off-route fix from step 2, fed as the **first**
     fix against a fresh, newly-ready route → **rejected**
     (`too_far_off_route`) even with no prior baseline to compare
     against, confirming the off-route check is independent of
     `lastAccepted` and correctly guards the bootstrap case Task 5's
     checks alone could not.
  All six checks passed exactly as designed.
- Confirmed by inspection/diff against the previously delivered zip
  that `nav-route-progress.js`, `nav-gps-technician-marker.js`, and
  `nav-routing.js` are byte-for-byte unchanged this session — the new
  guard is fully contained in the one file whose job is state wiring.

## Explicitly NOT done this session

This closes the third and final item explicitly deferred from Task 5.
Phase 12's originally-scoped items (route-progress engine, GPS wiring,
technician marker, Route Details Panel, noise/monotonicity guarding,
off-route distance guarding) are now all implemented. Not evaluated or
claimed as done in this session, since they were never on the
Task 1–5 "remaining tasks" list and are outside this task's scope:

- **No smoothing/averaging.** Still deliberately not implemented —
  every number shown remains a real, single fix's projection, never a
  blended value, same as Task 5's own note on this.
- **Thresholds are not configurable or tuned against real device GPS
  traces** — chosen the same way Task 5's thresholds were: reasoned
  from plausible physical bounds (road width, consumer GPS accuracy
  specs), not from field data (this sandbox has no browser/GPS
  hardware).
- **No end-to-end / cross-browser verification.** As with every prior
  Phase 12 task, verification here is a Node harness exercising the
  real, unmodified production files — not a live device or browser.
- No visual/UI change was made or claimed here — this is state-layer
  logic only, same as Tasks 2 and 5.

## Files changed this session

- **Added:** `PHASE12_TASK6_NOTES.md` (this file)
- **Modified:** `app/static/js/nav-gps-route-progress.js` — added
  `MAX_OFF_ROUTE_DISTANCE_METERS`, the off-route check at the top of
  `evaluateGuard()` (runs before the Task 5 checks and before the
  "first fix" bootstrap shortcut), and the `too_far_off_route`
  rejection reason; updated header comments. `getState()`'s shape is
  unchanged — `guard.lastRejectionReason` simply gains one more
  possible string value. No other function, event name, field, or
  reset trigger was added, removed, or altered.
- **Modified:** `app/templates/naps/map.html` — comment-only update
  to the existing Task 2 script-tag block describing Task 6's
  addition; no `<script src="...">` line was added, removed, or
  reordered.

## Status

Phase 12 ("Live GPS route progress," 60%) now has all of its
originally-identified sub-tasks implemented:

1. ~~Route Details Panel wiring~~ — done (Task 4).
2. ~~Noise/monotonicity guarding~~ — done (Task 5).
3. ~~Use of `offRouteDistanceMeters` to flag/handle a fix too far
   from the road~~ — **done this session (Task 6).**

Per your instruction, stopping here — no further Phase 12 work was
started this session (e.g. no new UI, no tuning against real device
traces), and no Phase 13 work was touched. If you'd like, a future
session can do a full Phase 12 acceptance-criteria pass end-to-end
(the phase spec's own checklist) before calling the phase itself
100% verified — that full pass has not been explicitly re-run this
session, only this task's own scope.
