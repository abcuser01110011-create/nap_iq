# Phase 13 (65%) — Navigation destination panels

## What this phase implements

Integrates navigation with the existing NAP-IQ entity panels, per the
plan's acceptance criteria:

- **Subscriber panel** (`app/templates/subscribers/view.html`)
- **NAP panel** (`app/templates/naps/view.html`)
- **Complaint panel** (`app/templates/issues/view.html`)

Each panel now has a **Navigate** button. Clicking it:

1. identifies the entity (NAP / Subscriber / TechnicalIssue, by id),
2. converts it into a navigation destination,
3. opens the navigation UI (the existing GeoMap + Navigation Card),
4. leaves origin selection and route calculation to the navigation UI
   already built in Phases 4–12 (unchanged — this phase does not add
   routing).

This is the "Navigate" / "Start route" entry point the plan asks for,
extending the existing panel architecture rather than duplicating it.

## How it works

Nothing new was invented for *selecting* or *storing* a destination —
Phase 13 reuses the exact mechanism Phase 3 (15%) already built for
map-popup "Set as destination" buttons:

- `app/static/js/napmap.js` already has `buildDestinationFromNap()`,
  `buildDestinationFromIssue()`, `buildDestinationFromSubscriber()`,
  and `window.NapIQNavigation.setDestination()` (from
  `nav-destination.js`).
- The only thing missing was a way to reach that flow from a
  standalone entity page instead of from a map marker popup.

**Backend** (`app/routes/naps.py`, `geomap()`):
Accepts an optional `?navigate_type=nap|subscriber|issue&navigate_id=<id>`
query-param pair, whitelist-validated (`navigate_type` is silently
discarded — but the map still loads normally — if it isn't one of the
three known values), and passes both through to the template. This
mirrors the existing `?issue_id=` (Phase 20) and
`?recommend_request_id=` (Phase 22) query-param conventions exactly:
unvalidated ids, "unknown id selects nothing, no crash."

**Template** (`app/templates/naps/map.html`):
Exposes `navigate_type`/`navigate_id` as `data-navigate-type` /
`data-navigate-id` attributes on `#napMap`, alongside the existing
`data-focus-issue-id` / `data-recommend-request-id` attributes.

**JS** (`app/static/js/napmap.js`):
New `focusNavigationFromQueryParam()`, called once after the initial
`renderAll()` (same place `focusIssueFromQueryParam()` and
`focusNapRecommendationFromQueryParam()` already run, so `allNaps`/
`allIssues`/`allSubscribers` are guaranteed loaded). It:

1. reads the two data attributes,
2. looks the entity up in the in-memory dataset already loaded from
   the real `/api/naps` / `/api/issues` / `/api/subscribers` feeds —
   **no fake or hard-coded data**,
3. pans/zooms the map and opens the marker's popup — reusing the
   existing `selectNap()` / `focusIssue()` helpers, plus a new
   `focusSubscriber()` helper written the same way (subscriber
   markers are an optional layer off by default, so this also flips
   the "Show Subscribers" toggle on, same idea as forcing a
   status/priority filter on for NAPs/issues),
4. builds the destination object with the existing
   `buildDestinationFrom*()` helpers and calls
   `window.NapIQNavigation.setDestination(destination)` — the exact
   same call a "Set as destination" popup click makes.

A NAP/subscriber/issue reached via a panel's Navigate button is
therefore **indistinguishable, from that point on,** from one picked
by hand on the map — the sidebar "Navigation destination" panel and
the floating Navigation Card both populate immediately.

**Panels** (`naps/view.html`, `subscribers/view.html`,
`issues/view.html`):
Added a `Navigate` link/button pointing at
`url_for('naps.geomap', navigate_type=..., navigate_id=...)`.

- NAP: always shown — `Nap.latitude`/`longitude` are non-nullable.
- Subscriber and Issue: wrapped in
  `{% if entity.latitude is not none and entity.longitude is not none %}`
  since those columns are nullable on their models, and a Navigate
  button that leads to "nothing was selected" would be a dead
  control. (Verified: a subscriber with no coordinates renders the
  page with no Navigate button.)

## Files changed

- `app/routes/naps.py` — `geomap()` route
- `app/templates/naps/map.html` — new data attributes + doc comment
- `app/static/js/napmap.js` — `focusNavigationFromQueryParam()`,
  `focusSubscriber()`, one extra call in `init()`
- `app/templates/naps/view.html` — Navigate button
- `app/templates/subscribers/view.html` — Navigate button (guarded)
- `app/templates/issues/view.html` — Navigate button (guarded)

No models, no database schema, no API endpoints, no existing route
signatures were changed. No React, no Tailwind, no new frontend
framework. Nothing was removed from any panel.

## Tests performed

1. **Static checks** — clean on all changed files:
   - `python3 -m py_compile` (all of `app/`)
   - `node --check` on every file in `app/static/js/`
   - Jinja `Environment.parse()` on all 4 changed templates

2. **Live functional test** (`Flask` test client, real app via
   `app.create_app()`, in-memory SQLite — the same pattern
   `tests/conftest.py` already uses for the Phase 19 suite, since a
   live MySQL server isn't available in this environment):
   - Logged in as an administrator.
   - Confirmed a `Navigate` link (with the correct
     `navigate_type`/`navigate_id`) is present on `/naps/<id>`,
     `/subscribers/<id>`, and `/issues/<id>` for seeded real
     records.
   - Confirmed `/naps/map?navigate_type=nap&navigate_id=<id>` (and
     `subscriber`, `issue` variants) renders the corresponding
     `data-navigate-type` / `data-navigate-id` attributes.
   - Confirmed `?navigate_type=bogus` is sanitized server-side to an
     empty attribute (map loads normally, nothing selected).
   - Confirmed a subscriber **without** coordinates gets **no**
     Navigate button.

3. **Full browser click-through** (Playwright + Chromium, against the
   real Flask dev server + SQLite, seeded with one real NAP,
   subscriber, and technical issue — no fake/hard-coded map data):
   - Clicked `Navigate` from the NAP detail page → landed on the
     GeoMap with the NAP's popup open, its marker panned into view,
     the sidebar "Navigation destination" panel showing
     "Sta. Cruz Central NAP", and the floating Navigation Card
     showing the same destination with route status "Idle".
   - Repeated for the Subscriber detail page → GeoMap opened with the
     "Show Subscribers" layer auto-enabled, the subscriber's popup
     open, and the destination armed as type "Subscriber".
   - Repeated for the Issue detail page → GeoMap opened with the
     issue's popup open, destination armed as type "Complaint".
   - Screenshots saved (see below) confirming each of the three
     flows end-to-end.
   - No JavaScript console errors from application code. (Console
     did report 403s from `tile.openstreetmap.org` — those are this
     sandboxed test environment's network egress rules blocking the
     public OSM tile server, unrelated to Phase 13's code; the
     underlying markers/panels/destination logic all still rendered
     correctly with the tiles just showing as blank grey.)

## Known limitations

- This phase only *selects* the destination and opens the navigation
  UI, exactly as scoped — it does not calculate or draw a route
  (that's Phases 5–7, already implemented from earlier phases) and
  does not change origin selection behavior.
- Verified against SQLite (via the existing test-fixture pattern),
  not a live MySQL server — no MySQL-specific SQL was touched by this
  phase, so this is consistent with how earlier phases' automated
  tests were run.
- The Navigate button on Subscriber/Issue panels is hidden (not
  disabled) when the record has no coordinates, since there's nothing
  for it to navigate to; this matches how those panels already handle
  other coordinate-dependent behavior on the GeoMap.
