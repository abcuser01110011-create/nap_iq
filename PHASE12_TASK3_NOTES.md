# NAP-IQ — Phase 12 (60%) — TASK 3 of N — Notes

## Scope of this session (one task only, per your instruction)

Following Task 1 (the calculation engine) and Task 2 (wiring live
GPS fixes into it, exposing `NapIQNavGpsRouteProgress.getState()`),
this session did exactly **one** more task: make the live GPS
position actually visible on the map, using the existing Phase 10
technician marker rather than building a second marker layer.
Nothing else in Phase 12 was touched.

### Task 3 (done this session): bridge live GPS progress into the technician marker

**1. New file `app/static/js/nav-gps-technician-marker.js`:**

Listens for `napiq:gps-route-progress-changed` (from Task 2).
Translates that state into the exact shape
`nav-technician-marker.js`'s existing `render()` function already
accepts (`{status, position, progressPercent,
remainingDistanceMeters, remainingDurationSeconds}`), adding a new
`source: "live-gps"` field, and calls `render()` — reusing Phase
10's marker/pane/icon/popup machinery entirely. `position` is always
the GPS fix's **nearestPoint** (the fix snapped onto the actual
route geometry from Task 1), not the raw fix, so the marker sits ON
the road, same as demo travel already does. `status` becomes
`"complete"` once `progressPercent >= 100`, otherwise `"running"`
(live GPS has no equivalent of demo travel's "paused" state). When
GPS progress goes inactive, this module clears the marker **only if
GPS currently owns it** (see below) — it does not blindly clear
whatever's on the map.

**2. Minimal, additive changes to `app/static/js/nav-technician-marker.js`
(Phase 10's file) so it can distinguish two sources sharing one marker:**

- `upsertMarker()` / `markerHtml()` / `popupHtml()` now read an
  optional `source` field on the state they're given
  (`"demo"` | `"live-gps"`), defaulting to `"demo"` — so Phase 9's
  existing `napiq:demo-travel-changed` event, which carries no
  `source` field and is completely unchanged, keeps behaving exactly
  as before.
- Each source gets a distinct ribbon label/color and popup
  title/blurb ("DEMO" / dark ribbon / "Demo travel" vs. "GPS" / blue
  ribbon / "Live GPS position") — the same light-touch
  color-and-label distinction Phase 11 already used for Manual vs.
  Device GPS origins, not a whole new icon shape.
- A new `getSource()` getter was added to the module's public API so
  a second source can check who currently owns the marker before
  deciding whether it's safe to touch it.
- Nothing about the marker's pane, icon shape, bearing/heading math,
  or lifecycle triggered by `napiq:demo-travel-changed` changed.

**3. Multi-source policy for this task (documented as a known,
deliberate limitation, not a bug):**

Both demo travel and live GPS render into the same single marker
slot. This task's rule: a live GPS fix always takes over the marker
(real device data outranks a simulated preview). If GPS then goes
inactive, the marker is cleared **only if GPS itself was the one
showing** — so stopping GPS never rips a marker out from under an
actively-running demo. What this task does **not** solve: if GPS
takes the marker over while demo travel is mid-run, and GPS then
goes inactive, the marker clears rather than reverting to demo
travel's own current position — because nothing re-fires
`napiq:demo-travel-changed` at that moment for `nav-technician-
marker.js` to react to. Full arbitration between two simultaneously-
active sources is exactly the kind of cross-cutting interaction
Phase 18 ("Error handling + state cleanup + UX hardening") owns; this
task only needed to make live GPS visible without regressing demo
travel's existing behavior when GPS isn't in the picture at all,
which it does (verified below).

**4. Template wiring:** one new `<script>` tag added to
`app/templates/naps/map.html`, loaded after both
`nav-gps-route-progress.js` and `nav-technician-marker.js` (its two
dependencies), plus an updated comment on the Task 2 script tag
(it previously said "not yet read by nav-technician-marker.js",
which this task makes no longer true).

### Verified

- `node --check` on both the modified file
  (`nav-technician-marker.js`) and the new file
  (`nav-gps-technician-marker.js`) — syntax OK.
- A standalone Node harness (`/tmp/test_gps_technician_marker.js`,
  not shipped — throwaway verification only) used a minimal fake
  Leaflet (`L.marker`/`L.divIcon`, a fake map) and exercised:
  - a GPS-active event → a marker is created, `getSource()` reports
    `"live-gps"`, the popup says "Live GPS position" and shows the
    correct progress percent;
  - progress reaching 100% → the marker moves to the new
    `nearestPoint` and the popup shows the "Complete" badge;
  - demo travel owning the marker (via the shared `render()` call,
    `source: "demo"`), then a GPS-inactive event arriving →
    `getSource()` still reports `"demo"` — the marker was **not**
    cleared;
  - a GPS-active event arriving again while demo still owned the
    marker → GPS correctly takes it back over
    (`getSource() === "live-gps"`);
  - a GPS-inactive event arriving while GPS itself owned the marker
    → the marker is correctly cleared (`getMarker() === null`).
  All checks passed.
- Confirmed by inspection that `nav-demo-travel.js` (Phase 9) is
  completely unmodified and its dispatched event shape carries no
  `source` field, so the `demoState.source || "demo"` default keeps
  every existing demo-travel behavior byte-for-byte the same.

## Explicitly NOT done this session (deferred to later Phase 12 tasks)

- **No noise/monotonicity guarding.** An active GPS state is
  rendered on the marker exactly as Task 1/2 computed it, however
  jumpy a single fix might be.
- **No use of `offRouteDistanceMeters`** for anything visual (e.g. a
  "you're off the mapped road" indicator) — it's still only carried
  in the state, unused past Task 2.
- **No Route Details Panel wiring.** `nav-routing.js`'s progress
  bar / "Remaining" fields still don't reflect live GPS progress —
  only the map marker does now.
- **No full multi-source arbitration**, as detailed above — deferred
  to Phase 18.

## Files changed this session

- **Added:** `app/static/js/nav-gps-technician-marker.js`
- **Added:** `PHASE12_TASK3_NOTES.md` (this file)
- **Modified:** `app/static/js/nav-technician-marker.js` — added an
  optional `source` field (default `"demo"`) to `upsertMarker()` /
  `markerHtml()` / `icon()` / `popupHtml()` / `removeMarker()`, a
  `SOURCE_META` table, and a new `getSource()` getter. No existing
  parameter, event listener, or Phase 9/10 behavior was removed or
  altered.
- **Modified:** `app/templates/naps/map.html` — one new `<script>`
  tag + explanatory comment, plus a corrected comment on the
  existing Task 2 script tag; nothing else on that file touched.

## Status

Phase 12 is **still not complete**. This was task 3 of several.
Per your instruction, stopping here again — no further Phase 12
work was started this session, and no Phase 13 work was touched.

Remaining Phase 12 tasks (per the running count given earlier):
1. Route Details Panel wiring (show live GPS progress there too).
2. Noise/monotonicity guarding (don't let a noisy fix make progress
   jump wildly backward/forward).
3. Use of `offRouteDistanceMeters` to actually flag/handle a fix
   that's too far from the road to trust.
