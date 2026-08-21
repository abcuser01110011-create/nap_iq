# Phase 14 (70%) — Technician dispatch integration

## What this phase implements

Per the plan: after a technician is assigned to an issue, give them a
navigation action that (1) identifies them as the assigned
technician, (2) uses the complaint/subscriber location as the
destination, and (3) lets their current/manual/device position become
the route origin — without touching dispatch scoring, assignment
permissions, or creating/modifying any assignment.

Two additive pieces:

### 1. A "Navigate" action on the technician's own assignments

`app/templates/technician/index.html` ("My Work") already had a
small map-pin icon button per assignment row that just *pans* the
GeoMap to the issue (`?issue_id=`, Phase 20) — it never selected a
destination or opened the navigation UI. This phase adds a second,
clearly-labelled **Navigate** button next to it, using the exact
destination-arming mechanism Phase 13 (65%) already built:

```
{{ url_for('naps.geomap', navigate_type='issue', navigate_id=a.technical_issue_id) }}
```

Clicking it lands the technician on the GeoMap with the job already
armed as the navigation destination (via `navigate_type`/
`navigate_id` → `napmap.js`'s `focusNavigationFromQueryParam()` →
`NapIQNavigation.setDestination()`, all unchanged from Phase 13) — the
sidebar "Navigation destination" panel and the floating Navigation
Card populate immediately, exactly as if the technician had clicked
the issue's marker popup and hit "Set as destination" themselves.

Guarded the same way Phase 13 guarded Subscriber/Issue Navigate
buttons: only rendered when
`a.technical_issue.latitude`/`longitude` are both set (nullable
columns on `TechnicalIssue`), so there's never a dead "Navigate to
nothing" control.

This satisfies "identify the assigned technician" implicitly — the
row only exists on this page because `technician.index()` already
scopes assignments to `Assignment.technician_id == profile.id`
(the signed-in technician's own linked profile); no new query or
lookup was needed for that part.

### 2. The technician's own last-known DB position as a navigation origin

Manual origin (Phase 8, 40%) and device GPS (Phase 11, 55%) already
existed as ways to set a route's starting point. This phase adds the
third: `technicians.current_latitude`/`current_longitude`, exposed
read-only since the Phase 23 10% data-contract step
(`GET /api/technicians/<id>/location`, `origin_from_technician()` in
`app/navigation_contract.py`) but never actually wired into any UI
until now.

**Backend** (`app/routes/naps.py`, `geomap()`): resolves the
signed-in user's own `Technician` profile id (server-side, via
`Technician.query.filter_by(user_id=g.user.id)` — never trusts a
client-supplied id) and passes it to the template as
`own_technician_id`. `None`/blank for an Administrator, who has no
linked Technician profile.

**Template** (`app/templates/naps/map.html`): exposes it as
`data-own-technician-id` on `#napMap`, alongside the existing
`data-navigate-type` / `data-navigate-id` / etc. attributes.

**New JS** (`app/static/js/nav-technician-origin.js`): a sibling of
`nav-gps-origin.js`, not a rewrite — same "render into a container
inside `nav-origin.js`'s panel" pattern. Renders a
"Use my last known location" button into a new
`#navOriginTechnicianControls` slot. On click, does a one-shot
`fetch("/api/technicians/<id>/location")` (the existing, unmodified
endpoint) and, if a position is on file, calls
`window.NapIQNavOrigin.setOriginPoint()` with `source:
"technician-db"` — the same call `nav-gps-origin.js` makes for a GPS
fix, just a different source label. If the technician has no
last-known position yet (an expected, common state — nothing keeps
that column live today, see PHASE23_5_PERCENT_NOTES.md §8), shows an
honest inline message instead of a fake/zero coordinate.

Unlike GPS, this is deliberately **not** a live watch: one lookup per
click, no `navigator.geolocation`, nothing written back to the
database, nothing polled continuously.

**`app/static/js/nav-origin.js`**: added the new
`#navOriginTechnicianControls` render slot (in both the empty and
confirmed panel states, next to the existing GPS and map-picker
slots) and a distinct badge — "My Last Known Location" with a
person-badge icon — so a technician-DB-derived origin is always
visually distinguishable from a manual pick, typed coordinates, or a
live device-GPS fix, per the plan's "must clearly distinguish" origin
requirement (carried over from Phase 11's own acceptance criteria,
which this phase's third origin source inherits).

**Visibility**: the control renders nothing at all — not even an
empty state — for an Administrator or any user with no linked
Technician profile, since `data-own-technician-id` is blank for them
and `/api/technicians/<id>/location` would 403 an id that isn't
their own anyway.

## Files changed

- `app/routes/naps.py` — `geomap()`: resolves + passes
  `own_technician_id`
- `app/templates/naps/map.html` — `data-own-technician-id` attribute
  + doc comment; new `<script>` include
- `app/static/js/nav-origin.js` — `#navOriginTechnicianControls` slot
  (both states) + `"technician-db"` badge
- `app/static/js/nav-technician-origin.js` — **new file**
- `app/templates/technician/index.html` — new "Navigate" button per
  assignment row (guarded on issue coordinates existing)

No models, no database schema, no existing API endpoint signatures,
no dispatch/recommendation logic (`app/recommendation.py`,
`app/routes/dispatch.py`), and no RBAC decorators were touched.
Nothing was removed from any existing page. `dispatch_score`,
`Assignment` creation/reassignment/cancellation, and technician
status transitions in `app/routes/technician.py` are all completely
unchanged — this phase only adds a way to *look at* an existing
assignment's location and *read* an existing DB column, never a way
to write to either.

## Tests performed

1. **Static checks** — clean on every changed file:
   - `python3 -m py_compile app/routes/naps.py`
   - `node --check` on `nav-origin.js` and the new
     `nav-technician-origin.js`
   - `jinja2.Environment().parse()` on both changed templates

2. **Real `pytest -v` run** — network egress was open this session
   (confirmed: `pip install` of the actual `requirements.txt`
   dependencies — Flask-SQLAlchemy, Flask-WTF, Flask-Limiter, pytest,
   email-validator — succeeded for real), so this is the genuine
   suite, not a shim:

   ```
   111 passed, 3 failed
   ```

   The 3 failures (`test_reports_phase23.py::
   test_new_issue_reported_notification_staff_route`,
   `test_reports_phase23.py::
   test_new_issue_reported_notification_customer_route`,
   `test_technician_workflow.py::
   test_reports_page_shows_technician_workload`) are pre-existing and
   unrelated to this phase — they're in the issue-reporting/reports
   modules, which nothing in this phase touched. The two tests that
   *do* exercise `geomap()` directly
   (`test_geomap_with_issue_id_does_not_500`,
   `test_geomap_without_issue_id_still_works`) both pass, confirming
   the new `own_technician_id` resolution doesn't break that route
   for either an Administrator or an unauthenticated/edge case the
   existing tests already cover.

3. **Manual code-path trace** (no live MySQL, no browser available —
   see Known limitations below):
   - Traced `geomap()` for an Administrator: `g.user.role !=
     "technician"` → `own_technician_id` stays `None` →
     `data-own-technician-id=""` → `nav-technician-origin.js`'s
     `getOwnTechnicianId()` returns `null` → `render()` sets
     `host.innerHTML = ""` — no control, no stray API call.
   - Traced it for a Technician **with** a linked profile → attribute
     is a real integer → button renders → click → `fetch()` to the
     existing, unmodified `/api/technicians/<id>/location` → same
     RBAC check that endpoint already enforces (`g.user.role ==
     "technician"` → must be `own_profile.id`) → succeeds trivially
     since it's always the signed-in technician's own id being
     requested.
   - Traced it for a Technician with **no** `current_latitude`/
     `current_longitude` on file: `technician_location_json()`
     returns `"origin": None` → the new JS shows "No last known
     location is on file for your technician profile yet." rather
     than silently doing nothing or fabricating a point.
   - Traced the new "Navigate" button's guard: an issue with `NULL`
     lat/lng renders the assignment row with no Navigate button (only
     the existing "View on GeoMap" pin icon), matching Phase 13's
     identical guard on Subscriber/Issue panels.

## Known limitations

- No live MySQL server or browser is available in this sandbox this
  round, so the "Navigate" button and the technician-DB-origin button
  were verified by tracing the actual code paths (query filters,
  Jinja guards, JS DOM/event wiring) against the real, unmodified
  files they call into — not by a live click-through. The two
  automated `geomap()` tests that *do* run for real both still pass
  after this phase's changes.
- `playwright` is importable in this environment but has no browser
  binaries installed, and the Playwright CDN isn't on this sandbox's
  network allowlist, so a real screenshot of the rendered "Navigate"
  button / origin panel couldn't be captured this round. No
  screenshot is included with this phase's zip for that reason —
  happy to add one in a future round if browser download access is
  enabled.
- As before (Phase 23 10%, §8), `technicians.current_latitude`/
  `current_longitude` isn't kept live by anything in this app today —
  the "Use my last known location" button surfaces whatever's
  actually in that column (often nothing, for a technician who's
  never had it set), it doesn't make the data any fresher. That's
  unchanged scope from earlier phases, not a new gap this phase
  introduces.
- This phase deliberately does not touch `app/routes/dispatch.py` or
  `app/recommendation.py` — the plan is explicit that dispatch
  scoring/permissions must stay untouched, and they do.
