# NAP-IQ — Phase 12 (60%) — TASK 4 of N — Notes

## Scope of this session (one task only, per your instruction)

Following Task 1 (the route-progress calculation engine), Task 2
(wiring live GPS fixes into it, exposing
`NapIQNavGpsRouteProgress.getState()`), and Task 3 (bridging that
state into the existing technician marker), this session did exactly
**one** more task, the first item on the "remaining Phase 12 tasks"
list left at the end of `PHASE12_TASK3_NOTES.md`:

> 1. Route Details Panel wiring (show live GPS progress there too).

Nothing else in Phase 12 was touched. Task 2's noise/monotonicity
guarding and Task 3's leftover multi-source-arbitration edge case are
still open, exactly as documented previously.

### Task 4 (done this session): make the Route Details Panel reflect live GPS progress

**Only one file changed logic in: `app/static/js/nav-routing.js`**
(Phase 7/9's Route Details Panel, unchanged in every other way).

1. **New helper, `getActiveProgressSource()`.** Since Phase 9, the
   panel's "Route completion" block and "Remaining" metric already
   read `window.NapIQNavDemoTravel.getState()` when a demo run is
   active. This task adds a second possible source,
   `window.NapIQNavGpsRouteProgress.getState()` (Task 2), and picks
   between them with **live GPS taking precedence over demo travel**
   whenever GPS is active — the same precedence Task 3 already
   established for the technician marker (a real fix outranks a
   simulated preview). If GPS is not active, behavior falls straight
   through to Task-2-free Phase 9 demo-travel logic; if neither
   source is active, it's the original Phase 7 static 0%/totals
   placeholder. This keeps every prior phase's behavior byte-for-byte
   identical for anyone not using live GPS.

2. **`completionPlaceholderHtml()`** and **`readyMetricsHtml()`** —
   both now call `getActiveProgressSource()` instead of reading
   `NapIQNavDemoTravel` directly. Their output shape is unchanged
   (same badge, same progress bar, same "Remaining" row); only the
   caption text now distinguishes "Live GPS progress — …" from "Demo
   travel in progress/paused — …", and the placeholder copy for the
   fully-idle case now mentions enabling device GPS as an alternative
   to starting demo travel, since that option now actually feeds this
   panel.

3. **New listener:** `window.addEventListener("napiq:gps-route-
   progress-changed", render)` — mirrors the existing
   `napiq:demo-travel-changed` listener already on this file, so the
   panel re-renders every time Task 2 computes a new GPS-based
   progress reading. No routing/OSRM logic, no map-layer code, and no
   other event listener on this file was touched.

**Template comment-only change:** `app/templates/naps/map.html` — no
new `<script>` tag was needed (this task only edited an already-loaded
file), so the change here is limited to correcting the Task 2 and
Task 3 script-tag comments, which previously stated "the Route
Details Panel still doesn't read it yet" — no longer true — plus a
new comment block noting Task 4 added no new script tag.

### Verified

- `node --check app/static/js/nav-routing.js` — syntax OK.
- A standalone Node harness (`/tmp/test_routing_panel.js`, not
  shipped — throwaway verification only) loaded the real
  `nav-routing.js` file with a fake `NapIQNavCard`/`NapIQNavigation`/
  `NapIQNavOrigin` and a ready route, then exercised
  `window.NapIQNavRouting.refresh()` across five states:
  - no demo, no GPS → 0%, the honest Phase 7 placeholder caption;
  - demo running at 40% (no GPS) → panel shows 40%, "Demo travel in
    progress — … remaining";
  - **GPS active at 70% while demo is still "running" at 40%** → panel
    shows **70%**, caption says "Live GPS progress — …", and the demo
    caption text is absent — confirming GPS correctly wins;
  - GPS reaches 100% → panel shows 100%, "Live GPS progress complete
    — destination reached.", and the progress bar gets the `bg-
    success` class (same visual treatment Task 1–9's demo-complete
    state already used);
  - GPS goes inactive again (demo still running at 40%) → panel
    correctly falls back to the demo's 40%, with no leftover GPS
    text.
  All five checks passed.
- Rendered the exact HTML the real code produces (via the same
  harness, with a sample NAP destination) into a static screenshot —
  see `phase12_task4_screenshots/01_route_details_panel_live_gps.png`
  — showing the "Remaining" row's new "LIVE GPS" source pill, 63%
  completion, and the "Live GPS progress — 1.2 km remaining, about 3
  min left." caption, sourced from the harness's simulated GPS state
  (not a live device, since this environment has no browser/GPS
  hardware — see Limitations).
- Confirmed by inspection that Task 1
  (`nav-route-progress.js`), Task 2 (`nav-gps-route-progress.js`), and
  Task 3 (`nav-gps-technician-marker.js`, `nav-technician-marker.js`)
  are completely unmodified this session, and that
  `nav-demo-travel.js` (Phase 9) is untouched — the panel's demo-travel
  code path is reached exactly as before whenever GPS isn't active.

## Explicitly NOT done this session (deferred to later Phase 12 tasks)

- **No noise/monotonicity guarding.** The panel renders whatever
  `NapIQNavGpsRouteProgress` currently reports, however jumpy a single
  fix might be — this task only decided *which* source to show, not
  whether a given GPS reading should be trusted. Still open, per Task
  1/2/3's notes.
- **No use of `offRouteDistanceMeters`** in this panel (e.g. an
  "off-road" warning) — still unused past Task 2's storage of it.
- **No change to the multi-source marker-ownership edge case** Task 3
  documented (GPS taking the marker over mid-demo-run, then going
  inactive, doesn't hand the marker back to demo travel). That's
  Phase 18 scope, unrelated to this task's panel-only change.

## Files changed this session

- **Added:** `PHASE12_TASK4_NOTES.md` (this file)
- **Added:** `phase12_task4_screenshots/01_route_details_panel_live_gps.png`
- **Modified:** `app/static/js/nav-routing.js` — added
  `getActiveProgressSource()`; `completionPlaceholderHtml()` and
  `readyMetricsHtml()` now call it instead of reading
  `NapIQNavDemoTravel` directly; added one new
  `napiq:gps-route-progress-changed` event listener. No other
  function, event listener, or the OSRM/route-layer code in this file
  was changed.
- **Modified:** `app/templates/naps/map.html` — comment-only changes
  to the Task 2/Task 3 script-tag blocks (correcting statements that
  are no longer accurate) plus a new comment noting Task 4 needed no
  script tag; no `<script src="...">` line was added, removed, or
  reordered.

## Known limitation (environment, not code)

This sandbox has no browser, so this session could not click through
a live map page with real device GPS. Verification instead exercised
the real `nav-routing.js` file's actual functions directly (see
above) with simulated GPS/demo state, and rendered its real HTML
output as the screenshot. The end-to-end path — an actual
`watchPosition()` fix flowing through `nav-gps-origin.js` →
`nav-route-progress.js` → `nav-gps-route-progress.js` → this task's
panel code, in a real browser against a real OSRM response — still
needs a manual browser check, same limitation already noted in
`PHASE12_TASK1_NOTES.md` through `PHASE12_TASK3_NOTES.md`.

## Status

Phase 12 is **still not complete**. This was task 4 of several.
Per your instruction, stopping here again — no further Phase 12 work
was started this session, and no Phase 13 work was touched.

Remaining Phase 12 tasks (per the running list):
1. ~~Route Details Panel wiring~~ — **done this session.**
2. Noise/monotonicity guarding (don't let a noisy fix make progress
   jump wildly backward/forward).
3. Use of `offRouteDistanceMeters` to actually flag/handle a fix
   that's too far from the road to trust.
