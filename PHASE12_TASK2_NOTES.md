# NAP-IQ — Phase 12 (60%) — TASK 2 of N — Notes

## Scope of this session (one task only, per your instruction)

Following on from Task 1 (`nav-route-progress.js`, the isolated
nearest-point-on-route calculation engine — see
`PHASE12_TASK1_NOTES.md`), this session did exactly **one** more
task: wire real, live GPS fixes into that engine and expose the
result as live progress state. Nothing else in Phase 12 was touched.

### Task 2 (done this session): wire GPS fixes → the Task 1 engine → live progress state

**1. Additive plumbing in `nav-gps-origin.js` (two small, non-breaking changes):**

- `onPosition()` now dispatches a new `napiq:gps-fix-received` event
  with `detail = {lat, lng, accuracy, timestamp}` on **every**
  accepted fix — not just the ones that clear the existing 15m
  `MIN_MOVE_METERS` threshold and get pushed as a new *origin*. That
  threshold exists to avoid spamming OSRM with re-route requests; it
  has nothing to do with how often on-route *progress* should be
  allowed to recompute, so progress needed its own, higher-frequency
  signal.
- `stopTracking()` and `onError()` now both dispatch a new
  `napiq:gps-tracking-stopped` event, since GPS tracking can stop
  without the origin itself changing (the existing code deliberately
  leaves the last-known origin in place when tracking stops).
- Nothing else in that file changed. No existing behavior, event, or
  function signature was altered.

**2. New file `app/static/js/nav-gps-route-progress.js`:**

Listens for `napiq:gps-fix-received`. On each fix, if
`nav-routing.js` currently has a route with `status === "ready"`, it
calls Task 1's `NapIQNavRouteProgress.computeProgress(route, fix)`
and stores the result as this module's own live state (progress %,
remaining distance/ETA, the on-route nearest point, off-route
distance, fix timestamp), then dispatches
`napiq:gps-route-progress-changed` so a later task can render it.

If there's no ready route, a fix is simply a no-op (no fabricated
progress against a route that doesn't exist). Live progress state is
reset to inactive when: GPS tracking stops/errors, or the active
route changes/stops being ready (destination or origin changed, or
the route itself moved away from `"ready"`) — otherwise a stale
progress value from a route that no longer applies would linger with
nothing in this task's scope to clear it.

Exposed as `window.NapIQNavGpsRouteProgress.getState()`.

**3. Template wiring:** one new `<script>` tag added to
`app/templates/naps/map.html`, loaded after both `nav-gps-origin.js`
and `nav-route-progress.js` (its two dependencies), with a comment
explaining the load-order requirement — same convention every prior
phase's script tag already follows in that file.

### Verified

- `node --check` on both the modified file (`nav-gps-origin.js`) and
  the new file (`nav-gps-route-progress.js`) — syntax OK.
- A standalone Node harness (`/tmp/test_gps_route_progress.js`, not
  shipped — throwaway verification only) simulated the real
  browser event flow using a real `EventTarget` + `CustomEvent`
  (both available natively in the Node 22 sandbox) and a fake
  `NapIQNavRouting.getState()`, and exercised:
  - a fix arriving with **no ready route yet** → stays inactive, no
    event dispatched (no-op, not a fabricated progress);
  - a fix arriving **once a route is ready** → correctly computes
    ~67% progress and remaining distance for the same known
    geometry Task 1's own test used, and dispatches exactly one
    `napiq:gps-route-progress-changed` event;
  - `napiq:gps-tracking-stopped` → live state fully resets
    (`active: false`, `progressPercent: null`);
  - the route context changing away from `"ready"`
    (`napiq:destination-changed` while `NapIQNavRouting` reports
    `idle`) while progress was active → correctly resets;
  - a malformed fix (missing `lat`/`lng`) → stays a safe no-op, no
    throw.
  All checks passed.
- Every other file from Phases 1–11 and from Task 1 is untouched
  except the two additive event-dispatch lines described above in
  `nav-gps-origin.js`.

## Explicitly NOT done this session (deferred to later Phase 12 tasks)

- **Still nothing renders.** `nav-technician-marker.js` still only
  reads `NapIQNavDemoTravel.getState()` — it does not yet know
  `NapIQNavGpsRouteProgress` exists. `nav-routing.js`'s Route Details
  Panel ("Remaining" distance/duration, the progress bar) still only
  reflects demo travel, not live GPS progress.
- **No noise/monotonicity guarding.** Every accepted fix is
  projected and stored exactly as Task 1's engine computes it — nothing
  here smooths a jumpy reading or refuses to let progress move
  backward on a bad fix. The phase's "do not allow noisy GPS
  readings to make progress jump wildly backward and forward"
  acceptance criterion is still open.
- **No use of `offRouteDistanceMeters` beyond storing it.** No
  threshold rejects or down-weights a fix that's far off the road
  yet.

## Files changed this session

- **Added:** `app/static/js/nav-gps-route-progress.js`
- **Added:** `PHASE12_TASK2_NOTES.md` (this file)
- **Modified:** `app/static/js/nav-gps-origin.js` — two additive
  `CustomEvent` dispatches only (`napiq:gps-fix-received` in
  `onPosition()`; `napiq:gps-tracking-stopped` in `stopTracking()`
  and `onError()`). No existing logic changed.
- **Modified:** `app/templates/naps/map.html` — one new `<script>`
  tag + explanatory comment; nothing else on that file touched.

## Status

Phase 12 is **still not complete**. This was task 2 of several.
Per your instruction, stopping here again — no further Phase 12
work was started this session, and no Phase 13 work was touched.
