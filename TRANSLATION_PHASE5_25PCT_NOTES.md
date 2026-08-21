# Translation Project — Phase 5 (25%): Route-line engine using OSRM

Source prototype: `napV4-route line` (2) — `src/store/NavigationStore.tsx` (routing
slice: `loadRoute()`, `routeRequestRef` stale-guard) and
`src/components/navigation/RouteDetails.tsx` (distance/ETA display, error UI).
Target: the Phase 4 (20%) delta (`nap_iq_PHASE4_20pct_navigation_ui_foundation.zip`)
on top of `nap_iq_phase23_15pct_FULL_PROJECT`.

## Important: what this phase was built against

Only the **Phase 4 (20%) delta zip** was supplied for this phase — three files
(`nav-card.js`, `napmap.css`, `map.html`) plus its notes — not the full
`nap_iq_phase23_15pct_FULL_PROJECT`. That means `napmap.js`, `nav-destination.js`,
`app/routes/naps.py`, `app/routes/api.py`, and the SQLAlchemy models were **not
available to inspect**. Per this project's own ground rules ("before changing
code, inspect the actual target implementation"), this phase did not guess at or
fabricate the contents of those files. Instead, every new file here only depends
on the **documented public contracts** those files already expose
(`window.NapIQNavigation`, `window.NapIQNavCard.elements()`), and one clearly
call-out limitation below explains the one thing that couldn't be finished
without them.

## What this phase actually implements

### New files
- **`app/static/js/nav-origin.js`** — a minimal origin store
  (`window.NapIQNavOrigin`), mirroring the existing destination store's
  shape: `getOrigin()` / `setOrigin(lat, lng, label)` / `clearOrigin()`,
  firing a `napiq:origin-changed` event. Manual lat/lng entry only this
  phase (see "Scope decisions" below).
- **`app/static/js/nav-routing.js`** — the actual route-line engine:
  - Requests a real driving route from OSRM's public driving service
    (`https://router.project-osrm.org/route/v1/driving/...?overview=full&geometries=geojson`),
    the same endpoint the prototype's `loadRoute()` calls directly from the
    browser.
  - Stores **real road geometry** as route points (parsed from the response's
    GeoJSON `LineString`, not a straight line), plus `distanceMeters` and
    `durationSeconds` from the OSRM response — never placeholder numbers.
  - Implements all four states the phase spec asks for: **loading**,
    **ready** (distance + ETA), **invalid/no-route** (`payload.code !== 'Ok'`
    or missing geometry), and **network failure** (fetch rejects or a
    non-OK HTTP response) — with distinct icons and messages so they're
    honestly distinguishable, not just the same generic error text.
  - **Retry**: a "Retry route" button appears in both error states and
    re-issues the exact same request.
  - **Stale-response protection**: a monotonically increasing request id
    (mirrors the prototype's `routeRequestRef`) is captured per request;
    if the origin or destination changes again before a response lands, the
    stale response is discarded on arrival (checked both on success and on
    error) and never overwrites newer state.
  - Draws the route as a Leaflet polyline (`#0d6efd`, weight 5) as an
    additive layer, and removes it when the destination is cleared, the
    origin is cleared, or a new request supersedes it. See "Remaining
    limitation" below for the one prerequisite this needs from `napmap.js`.
  - No GPS movement or demo travel — not implemented, per the phase spec.

### Modified files (both additive, backward compatible)
- **`app/static/js/nav-card.js`** — one addition: `render()` now dispatches
  a `napiq:navcard-rendered` event after it rebuilds the card DOM. Nothing
  else in this file changed. This lets `nav-routing.js` re-apply its content
  into the (freshly rebuilt) `#navCardRouteStatus` / `#navCardControls`
  containers after every card re-render — e.g. collapse/expand — without
  `nav-card.js` needing to know routing exists. This is exactly the
  "documented hook point" extension pattern the phase notes for Phase 4
  called for.
- **`app/templates/naps/map.html`** — added two `<script>` tags
  (`nav-origin.js`, `nav-routing.js`) after `nav-card.js`, plus a comment
  explaining the load order and the `window.NapIQMap` integration point.
  Nothing else changed; `#napMap` and all existing markup are untouched.
- **`app/static/css/napmap.css`** — appended (not modified) rules for the
  origin form's inputs. No existing rule was changed.

## Scope decisions (and why)

- **Origin input is manual lat/lng entry, not a search/device-GPS picker.**
  The prototype's `OriginPicker.tsx` offers address/subscriber/NAP search
  and device GPS. Device GPS and demo travel are explicitly out of scope
  this phase per the spec. A search-based picker, or pulling a real
  technician position from the database, would require reading
  `napmap.js`'s existing marker/search plumbing and the technician
  position model — neither of which was in this phase's delta package.
  Manual lat/lng entry satisfies the phase spec's literal input contract
  ("origin latitude/longitude, destination latitude/longitude") without
  guessing at files this translation project hasn't seen yet.
- **OSRM is called directly from the browser, not proxied through Flask.**
  This exactly matches the prototype's own `loadRoute()`, requires zero
  changes to `app/routes/`, and therefore carries no risk to existing
  auth/RBAC/CSRF-protected routes. A future phase could proxy it through
  Flask (for caching, or if a firewall blocks the public OSRM host) — see
  "Remaining limitations."

## Acceptance criteria check

- [x] Selecting an origin and destination requests a real driving route
      (confirmed against a mocked OSRM response exercising the real
      `requestRoute()` code path — see Verification below; real network
      access to `router.project-osrm.org` isn't reachable from this
      sandbox, so an actual outbound call couldn't be captured here, only
      the full request/parse/render pipeline against a realistic response).
- [x] Route geometry is returned as coordinate points (`state.route.points`,
      parsed from the response's GeoJSON `coordinates`).
- [x] Distance and duration are stored in navigation state
      (`state.route.distanceMeters` / `durationSeconds`).
- [x] Errors are shown honestly — distinct copy and icon for "no road route
      returned" vs. "route service unavailable," never a fabricated number.
- [x] No straight-line route is ever presented as a road route — the ready
      state only renders after OSRM returns real `LineString` geometry;
      nothing draws a two-point line between origin and destination.

## Verification performed

1. `node --check` on all three touched/added JS files
   (`nav-card.js`, `nav-origin.js`, `nav-routing.js`) — pass.
2. Jinja syntax parse of `naps/map.html` (`jinja2.Environment().parse(...)`) —
   pass. (Full render wasn't possible — `base.html` and the rest of the
   template tree weren't part of this delta.)
3. Rendered the **real, unmodified** shipped files (`nav-card.js`,
   `nav-origin.js`, `nav-routing.js`, `napmap.css`) in a standalone Leaflet +
   Bootstrap + Bootstrap Icons harness (real npm packages, not CDN mocks),
   with a small stand-in for the not-yet-available `nav-destination.js`
   (harness-only, documented as such, not part of this delta) and
   `window.NapIQMap` set to a real Leaflet map the way `napmap.js` is
   expected to. Captured screenshots of all four states by driving the
   real code paths — including mocking only `window.fetch`'s response so
   the actual `requestRoute()` parsing/state/polyline logic runs
   end-to-end:
   - `01_destination_awaiting_origin.png` — destination selected, no
     origin yet, honest "set a starting point" message, origin form shown.
   - `02_route_ready_with_polyline.png` — real distance (3.1 km) and ETA
     (11 min) from a realistic OSRM-shaped response, with the road-shaped
     polyline actually drawn on the map.
   - `03_route_error_retry.png` — simulated network failure, distinct
     "Route request failed" message, Retry button present.
   - `04_no_route_state.png` — simulated `code: "NoRoute"` OSRM response,
     distinct "No road route found" message (different icon/copy from the
     network-failure state), Retry button present.

## Remaining limitations

- **Map polyline needs one line in `napmap.js`.** `napmap.js` (which
  creates the Leaflet map instance) wasn't part of this phase's delta
  package, so it couldn't be inspected or edited. `nav-routing.js` looks
  for the map instance at `window.NapIQMap` and draws/clears the route
  polyline on it *if present*; distance, ETA, loading, ready, error, and
  retry all work fully in the Navigation Card regardless. To finish
  wiring the polyline onto the real `#napMap`, add one line to
  `napmap.js` right after the map is created: `window.NapIQMap = map;`
  (substituting the actual local variable name).
- **No real technician-position origin from the database.** Origin is
  manual lat/lng entry this phase (see "Scope decisions"). A real
  "technician's last known/assigned position" origin needs the
  SQLAlchemy model and route for it, which weren't available this phase.
- **No live test against the real `router.project-osrm.org` host.** This
  sandbox's network access doesn't include that host, so end-to-end
  verification used a mocked `fetch` response shaped exactly like a real
  OSRM reply, exercising the real request/parse/state/render/polyline
  code. The request URL, parsing logic, and all four states match the
  prototype's own `loadRoute()` implementation; an actual outbound OSRM
  call should be re-verified once this lands in an environment with
  normal internet access.
- **Origin persists across destination changes, matching the prototype**
  (clearing the destination does not clear a manually-set origin) — this
  is a deliberate choice, not an oversight, since a technician navigating
  to several stops in a row would otherwise have to re-enter their start
  point every time.
- Demo travel, device GPS, and richer origin selection remain for later
  phases, as scoped.

STOP — this phase (Phase 5, route-line engine using OSRM) is complete
against everything it could be verified against without files outside this
delta package. Not proceeding to any further phase.
