# NAP-IQ — Phase 12 (60%) — TASK 1 of N — Notes

## Scope of this session (one task only, per your instruction)

Phase 12 is "Live GPS route progress." Its full scope is: connect
device GPS updates to route progress, updating technician navigation
position, percentage, remaining distance, and remaining ETA, based
on the route geometry (not straight-line distance), while tolerating
GPS points slightly off the road and not letting noisy readings make
progress jump wildly backward and forward.

That's several distinct pieces of work. Per your instruction, this
session implemented **exactly one** of them and stopped:

### Task 1 (done this session): the route-progress calculation engine

New file: `app/static/js/nav-route-progress.js`, exposing
`window.NapIQNavRouteProgress.computeProgress(route, gpsPoint)`.

Given:
- `route` — the same shape `nav-routing.js` already stores
  (`{ points: [{lat,lng}, ...], distanceMeters, durationSeconds }`,
  unchanged, read-only),
- `gpsPoint` — a raw `{lat, lng}` fix,

it returns:
- `progressRatio` / `progressPercent` — how far along the **real
  route geometry** the fix projects to, not straight-line distance
  to the destination;
- `remainingDistanceMeters` / `remainingDurationSeconds` — derived
  proportionally from the OSRM route's own totals, the same honesty
  standard `nav-routing.js`'s existing "remaining" fields already
  use;
- `nearestPoint` — the actual point ON the route polyline closest to
  the fix (for later use — e.g. snapping the technician marker to
  the road instead of showing it floating off to the side);
- `offRouteDistanceMeters` — how far off the road geometry the raw
  fix was, for a later task's use in deciding whether a fix is
  trustworthy;
- `segmentIndex` — which road segment the projection landed on.

**Algorithm:** for every segment of the route polyline, project the
GPS point onto that segment (clamped to the segment's endpoints)
using a local equirectangular approximation — accurate at the
sub-kilometer segment lengths an OSRM polyline actually has, the
same scale assumption `nav-demo-travel.js` already relies on for its
own haversine-based interpolation. Keep whichever segment's
projection is closest to the raw fix. This is a linear scan over the
route's points, matching `nav-demo-travel.js`'s own documented
choice to do the same rather than adding a spatial-index dependency
this project doesn't otherwise need.

This module is loaded in `app/templates/naps/map.html` (after
`nav-technician-marker.js`, for proximity only — it has no load-order
dependency, since it's a pure function with no DOM access and no
reads of any other module's state).

### Verified

- `node --check app/static/js/nav-route-progress.js` — syntax OK.
- A standalone Node harness (`/tmp/test_route_progress.js`, not
  shipped — throwaway verification only) exercised:
  - a fix exactly at the route start → 0% progress, full remaining
    distance;
  - a fix exactly at the route end → 100% progress, ~0 remaining
    distance;
  - a fix ~2/3 along the route but offset sideways (simulating a GPS
    point slightly off the road) → progress correctly lands around
    67%, and `offRouteDistanceMeters` correctly reports the sideways
    offset as nonzero;
  - a route with fewer than 2 points → returns `null` rather than
    throwing;
  - a missing/malformed `gpsPoint` → returns `null` rather than
    throwing.
  All checks passed.
- No existing file was modified except adding one `<script>` tag to
  `app/templates/naps/map.html` to load the new file; every other
  file from Phases 1–11 is untouched.

## Explicitly NOT done this session (deferred to later Phase 12 tasks)

- **Not wired to live GPS.** `nav-gps-origin.js`'s
  `navigator.geolocation.watchPosition()` handler does not call this
  module yet. Every GPS fix still only becomes a route *origin*
  (Phase 11's job), never route *progress* input.
- **No technician marker updates from this.**
  `nav-technician-marker.js` still only reads
  `NapIQNavDemoTravel.getState()` (Phase 9/10's demo-travel
  position); it does not yet know this module exists.
- **No Route Details Panel updates from this.** `nav-routing.js`'s
  "Remaining" distance/duration display still only reflects demo
  travel, not live GPS progress.
- **No noise/monotonicity guarding.** This module reports an honest
  instantaneous projection for whatever fix it's given — it does
  **not** decide whether a given fix is noisy enough to distrust, or
  prevent progress from moving backward on a bad fix. That "do not
  allow noisy GPS readings to make progress jump wildly backward and
  forward" requirement is real Phase 12 work, just not this task.
- **No handling of GPS points far off the road** beyond reporting
  `offRouteDistanceMeters` — no threshold/rejection logic uses that
  number yet.

## Files changed this session

- **Added:** `app/static/js/nav-route-progress.js`
- **Added:** `PHASE12_TASK1_NOTES.md` (this file)
- **Modified:** `app/templates/naps/map.html` (one new `<script>`
  tag + explanatory comment; nothing else on that file touched)

## Status

Phase 12 is **not** complete. This is 1 of several tasks that phase
needs. Per your instruction, stopping here — no further Phase 12
tasks were started this session, and no Phase 13 work was touched.
