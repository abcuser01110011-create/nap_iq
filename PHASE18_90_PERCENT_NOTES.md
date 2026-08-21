# PHASE 18 — 90% — Error handling + state cleanup + UX hardening

**Status: implemented for the scope defined in this phase. Verified by
static syntax checks against the real files, plus a functional
Playwright test harness that loads the actual, unmodified
`nav-*.js` modules in a browser and exercises the real event flow
(not a mock of the logic) — network egress was off this round, so
`pip install -r requirements.txt` could not reach PyPI and the real
Flask/MySQL app could not be booted, same constraint noted in every
prior phase's own notes. See §4.**

---

## 1. Scope (from the phase plan)

> Harden the entire navigation implementation. Test and fix:
> destination cleared while routing; origin cleared while routing;
> route request fails; OSRM returns no route; user changes
> destination during route loading; GPS permission denied; GPS
> unavailable; browser has no geolocation; user switches
> manual/device origin; demo travel reset; navigation panel closed;
> page reload; multiple route requests; stale route responses. Make
> sure no: orphaned Leaflet layers; duplicate route lines; duplicate
> GPS watchers; stale technician markers; stale navigation state;
> console errors.

This phase did **not** add any new navigation feature — no new
routing behavior, no new UI controls, no new API endpoints. It only
inspects the real Phases 1–17 implementation against every scenario
above and fixes what was actually broken.

## 2. What I found

Phases 1–17 already implemented most of this hardening incrementally
as they went (each phase's own notes document this — stale-request
guarding via `requestSeq` in Phase 5, GPS error-kind messaging in
Phase 11, the noise/monotonicity/off-route guards in Phase 12 Tasks
5–6, keyboard-focus and `aria-live` handling in the Phase 8 origin
picker, etc.). Rather than re-doing work that was already correct, I
went through every `nav-*.js` module plus the relevant parts of
`napmap.js` against each bullet in the phase's checklist and traced
the actual event flow for each one. Most items were already handled
correctly — see the "Already handled, verified, unchanged" list in
§3. Three real, reproducible gaps were found and fixed:

1. **Stale technician marker on GPS→demo handoff.** Phase 10's own
   file header (`nav-technician-marker.js`) and Phase 12 Task 3's
   file header (`nav-gps-technician-marker.js`) both explicitly
   documented this as a known gap left for Phase 18: when a live GPS
   fix takes over the technician marker from a demo-travel run, and
   GPS later goes inactive (tracking stopped, permission revoked, or
   the route stops being ready), the marker was unconditionally
   cleared — even if demo travel was still sitting there mid-run,
   paused, complete, or reset-to-origin with a perfectly valid
   position of its own.
2. **A live GPS watch left running during a manual map-pick could
   silently cancel the pick.** `nav-gps-origin.js`'s `startTracking()`
   already stops an in-progress manual map-pick when GPS starts (so
   that direction was covered), but the reverse was missing: starting
   a manual pick (`nav-origin-picker.js`) or using "my last known
   location" (`nav-technician-origin.js`) did not stop an
   *already-running* GPS watch. Since `nav-origin.js`'s
   `napiq:origin-changed` broadcast is what both a GPS fix and a
   manual pick's confirm both route through, a delayed background GPS
   fix arriving while the user was mid-pick would overwrite the
   origin and — via `nav-origin-picker.js`'s own (pre-existing,
   correct) "an origin change while a pick is pending cancels the
   pick" listener — silently cancel the user's in-progress pick with
   no explanation.
3. **A stale one-shot "my last known location" fetch could clobber a
   fresher origin.** `nav-technician-origin.js` makes a single
   `fetch()` per click with no request-token/abort guard. If the user
   picked a different origin (manually, via GPS, or via a second
   lookup click) while that fetch was still in flight, the eventually-
   arriving response would still call `setOriginPoint()` and silently
   overwrite whatever the user had since chosen.

## 3. Files changed

| File | Change |
|---|---|
| `app/static/js/nav-gps-technician-marker.js` | `handleInactive()` now checks `window.NapIQNavDemoTravel.getState()` before clearing the marker: if demo travel still has a real `position`, the marker is handed back to it (`render()` with `source: "demo"`) instead of being cleared. Only clears when demo travel truly has nothing to show. `handleActive()` (GPS always wins the instant a fix arrives) is unchanged. File header updated to describe the fix instead of listing it as deferred. |
| `app/static/js/nav-technician-marker.js` | Comment-only update: the "Multiple sources, one marker" note is rewritten to describe the now-implemented handoff instead of listing it as a known limitation. No code changed in this file — it already exposed `getSource()`/`render()`/`clear()`, which is all the fix above needed. |
| `app/static/js/nav-origin-picker.js` | `startPicking()` now also stops an active GPS watch (`window.NapIQNavGpsOrigin.stopTracking()`) if one is running, symmetric with GPS's own existing "starting tracking cancels an in-progress pick" behavior. |
| `app/static/js/nav-technician-origin.js` | `useMyLastKnownLocation()` now (a) proactively stops an active GPS watch before firing its fetch, same rule as the picker above, and (b) uses a `requestToken` counter so a slow/delayed response is dropped if a newer lookup started or the origin changed to something else in the meantime. A new `napiq:origin-changed` listener bumps the token whenever the origin becomes anything other than `"technician-db"`. |
| `app/static/js/nav-gps-origin.js` | `startTracking()` gets one defensive line: `if (watchId !== null) return;` — guards against a duplicate `watchPosition()` registration if the function were ever invoked twice before a re-render disables the Start button. Belt-and-suspenders; the UI already prevented this in practice. |
| `PHASE18_90_PERCENT_NOTES.md` | New. This file. |
| `phase18_screenshots/` | New. Screenshot of the verification harness run (see §4). |

No Python/backend changes, no template changes, no CSS changes — this
phase's scope is entirely client-side state-machine correctness, and
none of the three real bugs found were on the backend.

## 4. Verification performed

Network egress was off this round (same constraint as every prior
translation-project phase's own notes), so the real Flask/MySQL app
could not be booted for a live end-to-end browser session. Checks
performed against the real files:

1. `node --check` on every file under `app/static/js/` — all pass.
2. `python3 -m py_compile` across every file under `app/` — passes (no
   Python was touched this phase; re-run for safety, per the global
   instructions' end-of-phase checklist).
3. CSS brace balance on `app/static/css/napmap.css` (untouched this
   phase) — 86 open / 86 close, matched, confirming no accidental
   edit.
4. **A functional verification harness** (`harness.html` + the 12
   real, unmodified `nav-*.js` files from this project, run via
   Playwright/Chromium) — not just a static screenshot. It stubs only
   the browser platform surfaces this app depends on (a minimal
   Leaflet — `L.marker`/`circleMarker`/`polyline`/`layerGroup`/
   `divIcon`, a fake `window.NapIQMap`, `fetch()`, and
   `navigator.geolocation`) and then drives the actual, real
   `nav-destination.js` / `nav-origin.js` / `nav-origin-picker.js` /
   `nav-gps-origin.js` / `nav-technician-origin.js` / `nav-card.js` /
   `nav-routing.js` / `nav-demo-travel.js` / `nav-route-progress.js` /
   `nav-gps-route-progress.js` / `nav-technician-marker.js` /
   `nav-gps-technician-marker.js` code paths end-to-end through their
   real public APIs and real `CustomEvent`s — no logic in those files
   was reimplemented or bypassed for the test. It asserts, and all
   12 checks pass:
   - a destination + origin drives a real OSRM-shaped route request
     to "ready" (Phase 5, confirms nothing regressed);
   - demo travel starts and reaches a real interpolated `paused`
     position against that real route (Phase 9, unchanged);
   - the technician marker starts out owned by demo travel;
   - a live GPS fix takes it over (Phase 12 Task 3's pre-existing,
     unchanged priority rule);
   - **the Phase 18 fix**: when GPS tracking stops, the marker is
     handed back to demo travel's real paused position instead of
     going blank;
   - device GPS becomes the active origin (Phase 11, unchanged);
   - **the Phase 18 fix**: starting a manual map-pick while that GPS
     watch is still running stops the watch, and the pick is not
     silently cancelled;
   - **the Phase 18 fix**: a technician-location lookup response that
     resolves after the user has since picked a different, newer
     origin is discarded rather than overwriting it.
   Screenshot of the harness's own pass/fail output:
   `phase18_screenshots/01_hardening_verification_harness.png`.
5. Manually re-traced every other bullet in the phase's checklist
   against the real code (not just re-stated from memory) and
   confirmed each was already correct — see §5. Where a scenario was
   already correctly handled, nothing was changed, per the global
   instructions' "keep changes additive" and "never delete/rewrite a
   feature that already works" rules.

## 5. Already handled, verified, unchanged (no code change needed)

Traced against the real implementation, file and mechanism cited so
this isn't just an assertion:

- **Destination cleared while routing** — `nav-routing.js`'s
  `maybeAutoRequest()` (listens to `napiq:destination-changed`)
  invalidates the in-flight request (`requestSeq += 1`), resets to
  `idle`, and calls `clearPolyline()`.
- **Origin cleared while routing** — same function, same handling, on
  `napiq:origin-changed`.
- **Route request fails / OSRM returns no route** — `requestRoute()`'s
  `.catch()` distinguishes `network` vs `no_route` via the `err.kind`
  thrown at each failure point, each with its own honest message and
  a Retry button.
- **User changes destination during route loading / multiple route
  requests / stale route responses** — `requestRoute()`'s monotonic
  `requestSeq`/`seq` pair: a response is applied only if
  `seq === requestSeq` at the time it lands, so a superseded in-flight
  request is silently dropped, never applied on top of a newer one.
- **GPS permission denied / unavailable / timeout / unsupported** —
  `nav-gps-origin.js`'s `errorReasonMessage()` gives each
  `GeolocationPositionError` code (1/2/3) and the "no
  `navigator.geolocation`" case its own distinct, honest message; the
  status line never claims "tracking" outside `STATE_TRACKING` with a
  real fix received.
- **User switches manual/device origin** — `nav-gps-origin.js`'s
  `napiq:origin-changed` listener stops tracking the instant the
  store holds an origin this module didn't itself just push (a manual
  pick, typed coordinates, or the origin being cleared). This phase's
  fix (§2, item 2) only added the missing *proactive* direction; the
  reactive direction was already correct.
- **Demo travel reset** — `reset()` returns the simulated position to
  the route's own origin rather than clearing it (matching the
  phase-9 acceptance criterion); `hardReset()` (on
  destination/origin change) fully clears the snapshot, and
  `nav-demo-travel.js`'s `renderControls()` hides the whole controls
  block once neither a ready route nor a snapshot exists.
- **Navigation panel closed** — collapsing the card (`nav-card.js`)
  removes `#navCardRouteStatus`/`#navCardControls` from the DOM, but
  no background module (routing, demo travel, GPS) tears down its own
  state just because its render target briefly doesn't exist; each
  re-attaches correctly (`napiq:navcard-rendered`) the next time the
  card expands. No leak, no lost state, matches expected behavior for
  a "minimize", not a "stop".
- **Page reload** — every piece of navigation state in this project
  (destination, origin, route, demo travel, GPS) is deliberately
  in-memory-only, documented as such since Phase 8/11's own file
  headers ("Do not permanently save every GPS update to MySQL"). A
  full page reload naturally and correctly resets everything; there
  is no persistence layer this phase needs to reconcile.
- **No orphaned Leaflet layers / no duplicate route lines** —
  `nav-routing.js`'s `drawPolyline()` calls `clearPolyline()`
  unconditionally before creating a new `routeLayer`, so re-routing
  replaces rather than stacks. The origin-picker's temporary/confirmed
  markers and the technician marker are each a single module-level
  variable that's always removed before being replaced
  (`clearTempMarker()`, `syncConfirmedMarker()`, `upsertMarker()`).
- **No duplicate GPS watchers** — was already effectively true via UI
  gating (the Start button is disabled/hidden outside the idle state);
  this phase added the explicit `if (watchId !== null) return;` guard
  in `startTracking()` itself as defense-in-depth (§3), so it now
  holds regardless of caller.
- **No console errors** — grepped every `nav-*.js` file and
  `napmap.js` for `console.log`/`debugger` left over from development;
  none found. The only `console.*` calls present are intentional
  `console.error()`s guarding truly invalid input (e.g.
  `nav-destination.js`'s `setDestination()` on a malformed object),
  which is appropriate defensive logging, not a bug.

## 6. What was deliberately not done

- No new navigation feature, control, endpoint, or visual change —
  out of scope for a hardening phase, per the global instructions.
- No change to OSRM request logic, route drawing, demo-travel
  interpolation math, or the GPS noise/monotonicity/off-route guards
  built in Phase 12 — all already correct, untouched.
- No attempt to add cross-tab or reload persistence for navigation
  state. That would be a real, separate feature (a new client-side
  storage or backend session mechanism), not "hardening" the existing
  deliberately-in-memory design — and the phase plan does not ask for
  it.
- No change to `napmap.js`'s Add-NAP/Report-Issue placement-mode
  mutual exclusion (`window.NapIQMapModes.exitPlacementModes()`) —
  traced and confirmed already correct on both sides (Add-NAP/Report-
  Issue already yield to the origin picker via
  `NapIQNavOriginPicker.stopPicking()`, and the picker already yields
  to them via `NapIQMapModes.exitPlacementModes()`); nothing to fix.

## 7. Known limitations (honestly reported)

- The functional verification harness (§4) stubs the browser platform
  (Leaflet, `fetch`, `navigator.geolocation`) but is still a synthetic
  harness, not the real Flask/MySQL app with real OSRM traffic and a
  real browser GPS/permission prompt — that full a live check was not
  possible this round for the same network-egress reason every prior
  phase's notes cite. The harness's value is that it runs the actual,
  unmodified navigation module code (not a description or re-
  implementation of it) through the real event contracts, so the
  three fixes above are verified as *working code*, not just as
  reasoning about code.
- This phase did not attempt a full manual click-through of every
  scenario in the phase's checklist inside a live browser session
  against the real templates (`naps/map.html` etc.) — again the
  network/DB constraint. Every scenario was instead verified either
  functionally (the three fixed ones, via the harness) or by tracing
  the exact real code path and event sequence for every other listed
  scenario (§5), citing the specific function/listener responsible in
  each case rather than asserting from memory.
