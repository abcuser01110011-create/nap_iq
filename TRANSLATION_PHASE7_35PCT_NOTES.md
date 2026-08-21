# Phase 7 (35%) — Route details panel — translation notes

## Scope of this phase (per phase_7.pdf)

> Translate the prototype's RouteDetails functionality. Display: total route
> distance, estimated duration, ETA/remaining duration where applicable,
> route status, route completion percentage placeholder, origin,
> destination. Use sensible formatting (meters/kilometers, minutes/hours,
> human-readable ETA). Handle: loading, ready, error, idle. Do not yet
> implement live GPS progress. Do not fabricate progress.

Only this. Nothing from a future phase was started, per the instructions at
the bottom of the PDF.

## What changed this phase

One file: **`nap_iq/app/static/js/nav-routing.js`**. Nothing else —
`nav-card.js`, `nav-origin.js`, `napmap.css`, `map.html` — was touched,
because nothing else needed to change to satisfy this phase's spec. The
route-layer drawing logic added in Phase 6 (panes, casing/line polylines,
endpoint markers, fit-bounds, layer-group replace/clear) is completely
unchanged.

This phase only expands what already rendered into nav-card.js's existing
`#navCardRouteStatus` container (owned by this file since Phase 5) into a
fuller **Route Details Panel**, translated from the prototype's
`RouteDetails.tsx`.

### 1. Route status badge (all states)

A small badge (`#navCardRouteStatusBadge`) now sits at the top of the panel
in every state — Idle / Loading / Ready / and a distinct **"No route
found"** vs **"Request failed"** label for the two error kinds the routing
engine already distinguished internally since Phase 5 (translated from the
prototype's `routeStatus` union). This was previously only implied by tone
and copy; it's now an explicit, always-visible status indicator.

### 2. Origin / destination rows (all states)

Two new rows (`Origin: <lat, lng>` / `Destination: <label> — <lat, lng>`)
are shown at the top of the panel in every state, including idle, loading,
and error — not just when a route is ready. When there is no origin yet,
it honestly says **"not set"** rather than a blank or a fabricated value
(translated from the prototype always rendering `navigation.manualOrigin` /
`navigation.destination` regardless of route status).

### 3. Ready-state metrics grid

Rebuilt from the Phase 5/6 two-cell grid (Distance, ETA) into a four-cell
grid matching the prototype's `Metric` components:

- **Route distance** — `state.route.distanceMeters`, formatted with the
  same `formatDistance()` used since Phase 5 (meters under 1 km, km above,
  translated 1:1 from the prototype's `formatRouteDistance`).
- **Estimated duration** — `state.route.durationSeconds`, formatted with
  the existing `formatDuration()` (minutes under an hour, `Xh Ym` above,
  translated 1:1 from `formatRouteDuration`).
- **Arrival ETA** — new this phase: a human-readable clock time (e.g.
  `4:29 AM`), computed as `now + durationSeconds` via a new `formatEta()`
  helper. The prototype doesn't render a clock-time ETA directly (it
  renders a countdown-style "Initial ETA" duration instead), so this is a
  small, spec-driven addition — the phase explicitly asks for a
  "human-readable ETA," which for a one-shot (non-live-tracked) route reads
  most naturally as an arrival time rather than a second duration string.
- **Remaining** — shown equal to the total duration. This is deliberate,
  not a shortcut: with no live GPS progress tracked (this phase's own
  constraint), the route is honestly 0% traveled, so 100% of its distance
  and time remain. This mirrors the prototype's own math exactly
  (`remainingRatio = 1 - navigation.progress`, `progress` never advances
  without the demo-travel/device-GPS features this phase excludes) — it is
  the correct value given the current state, not a fabricated one.

### 4. Route completion percentage placeholder

A new labeled section (`#navCardRouteCompletion`) shows a progress bar
frozen at **0%**, with the caption *"Placeholder only — live GPS progress
tracking isn't implemented yet."* This satisfies the phase's explicit
request for "a route completion percentage placeholder" while strictly
honoring "do not fabricate progress" and "do not yet implement live GPS
progress" — the number never moves and is never derived from anything but
the hard-coded 0.

### 5. Loading / error / idle states

- **Loading** — unchanged copy/spinner from Phase 5, now with the status
  badge + origin/destination rows above it.
- **Error** (both `no_route` and `network` kinds) — unchanged message/retry
  button from Phase 5, now with the status badge (showing which kind) +
  origin/destination rows above it.
- **Idle** — unchanged "set a starting point" / "route information will
  appear here" copy, now with the status badge + origin/destination rows
  above it.

### Formatting added this phase

- `formatEta(durationSeconds)` — `Date.now() + durationSeconds*1000`,
  rendered via `toLocaleTimeString()`. Wrapped in try/catch with an
  em-dash fallback so a display-only value can never throw and break
  rendering.
- `formatCoords(pos)` — `"lat, lng"` to 6 decimal places, reused for both
  the origin and destination rows (same precision nav-card.js already uses
  for the destination summary).

## Acceptance criteria — how each is met

- **"Route details are based on the actual OSRM response."** Distance,
  duration, ETA, and "remaining" are all derived directly from
  `state.route.distanceMeters` / `state.route.durationSeconds`, which come
  straight from the same OSRM `fetch()` response Phase 5 already parsed —
  nothing in this phase touches or duplicates that parsing.
- **"Distance and duration match the route data."** Verified by the
  automated test (below): a mocked OSRM response of `distance: 5432` /
  `duration: 725` produces exactly `"5.4 km"` and `"13 min"` in the
  rendered panel.
- **"Empty/error states are clear."** Every state (idle, loading, ready,
  error) now carries an explicit status badge plus origin/destination
  context, not just prose.
- **"No fake progress is shown."** The completion placeholder is a
  hard-coded `0%` / `width: 0%`, explicitly labeled as a placeholder, and
  "Remaining" is mathematically equal to the total (0% traveled) rather
  than any simulated or interpolated value.

## Verification performed this phase

`napmap.js`, the real Flask app, and its MySQL database are still not part
of any delta package supplied to this project (unchanged blocker, see
below), so the real `/naps/map` page could not be exercised end-to-end.
Two things were done instead:

1. **Automated functional test** (`test_phase7.js`, not part of the app —
   a throwaway harness, same approach as `test_phase6.js`) — mocks a
   minimal `document`/`window` (just enough for `escapeHtml()` and element
   lookups, no real DOM) and a mocked OSRM `fetch()`, then loads the real,
   unmodified `nav-routing.js` and drives it through:
   - idle with a destination set but no origin yet — asserts the status
     badge reads "Idle", the destination row shows the real label/coords,
     and the origin row honestly reads "not set";
   - loading — asserts the badge, spinner, and real origin coordinates are
     shown while a request is in flight;
   - ready (mocked OSRM response of 5432 m / 725 s) — asserts the badge
     reads "Ready", distance renders as exactly `"5.4 km"`, duration as
     exactly `"13 min"`, an Arrival ETA is shown, the completion section
     shows exactly `0%` / `width: 0%`, and it's labeled "Placeholder only";
   - network error — asserts a distinct "Request failed" badge, the retry
     button, and the error message;
   - no-route error — asserts a distinct "No route found" badge (proving
     the two error kinds are told apart in the UI, not just internally);
   - clearing the destination — asserts `#navCardRouteStatus` is left
     completely untouched (Phase 5's existing contract with nav-card.js's
     own idle placeholder), i.e. this phase didn't regress that behavior.

   All checks passed (`node test_phase7.js`).
2. **`node --check`** run against the modified file — no syntax errors.
3. **Static illustrative screenshot** — the test harness's actual
   generated HTML for all four states was captured and rendered into a
   small offline preview page (Bootstrap-alike CSS, no CDN dependency) and
   screenshotted, since the real Bootstrap-styled page can't be loaded
   without `napmap.js`/the live app. See
   `screenshots/07_phase7_route_details_panel.png` — the HTML shown is the
   exact, real output of this phase's code, not a mockup; only the
   surrounding page chrome/CSS is illustrative.
4. **`demo/phase7_demo.html`** (also not part of the app, mirrors Phase 6's
   demo page) — loads the real, unmodified `nav-card.js` / `nav-origin.js`
   and this phase's `nav-routing.js` against a real Leaflet map via CDN,
   with buttons to set a destination, set/move an origin, trigger a
   guaranteed no-route destination (mid-ocean coordinates), and clear —
   for manual click-through review in any browser with internet access.

## The one thing still not finished — same blocker as Phase 5 and Phase 6

**`window.NapIQMap` is still not set anywhere**, because **`napmap.js`
(where the real Leaflet map is created) has still not been part of any
delta package supplied to this translation project**, across Phase 4,
Phase 5, Phase 6, or this phase. This phase did not need to touch that file
either — the Route Details Panel lives entirely inside the Navigation Card
DOM (`#navCardRouteStatus`) and has no dependency on the map instance.

**Practical effect on the live app right now:** the Route Details Panel
(status badge, origin/destination, distance, duration, ETA, honest 0%
completion placeholder, loading/ready/error/idle handling — all this
phase's work) will render correctly in the Navigation Card regardless of
`window.NapIQMap`. The route *line on the map itself* (Phase 6 work) still
will not be visible on the live `/naps/map` page until the one-line change
already documented in `TRANSLATION_PHASE6_30PCT_NOTES.md` is made in the
real `napmap.js`:

```js
window.NapIQMap = map;
```

No other change is needed anywhere for either the map route line or this
phase's Route Details Panel.

## Remaining limitations (unchanged from Phase 5/6, plus none new)

- Route line on the map still not visible on the real page until
  `napmap.js` sets `window.NapIQMap` (unchanged blocker, not this phase's
  to fix).
- Live GPS progress / route-completion tracking is explicitly out of scope
  for this phase (per the spec) — the completion percentage is a static,
  clearly-labeled 0% placeholder only, as required.
- Demo travel simulation and origin search beyond manual lat/lng entry
  remain out of scope, unchanged from Phase 5.
- No change was made to `map.html`, `napmap.css`, `nav-card.js`, or
  `nav-origin.js` — none of Phase 7's requirements needed one.

**Per your instructions: this is not the next phase.** No further phase was
started or implemented — this package covers Phase 7 only, as given.
