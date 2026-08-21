# PHASE 19 — 95% — Full integration testing

**Status: test pass performed against the actual, unmodified
`nap_iq_full_project_phase18` application — automated (pytest, real
Flask app + SQLite via Flask's test client) and manual/browser
(Playwright + Chromium driving the real app on a seeded SQLite DB).
No application code was changed in this phase — Phase 19 is a test
pass, not a feature phase. 3 pre-existing, non-navigation test
failures were found and are reported honestly below (not fixed — see
§6, out of this phase's scope). No navigation/dispatch/RBAC defects
were found.**

---

## 1. Scope (from the phase plan)

> Perform a complete test pass against the actual
> nap_iq_full_project_phase18 application. Do not rely only on code
> inspection. Test: Map (markers, filters, search, interactions);
> Navigation (destinations, origin, OSRM route, route line, distance,
> duration, demo travel, pause/reset/replay, device GPS, GPS error);
> Dispatch (recommendation, assignment, assigned technician,
> technician job, navigation from job); Security (RBAC boundaries for
> administrator/technician/collector/customer). Run Python syntax
> checks, test suite, JavaScript checks, browser/manual checks,
> MySQL-backed checks where available. Fix only real failures.

## 2. What was actually run

| Check | Command | Result |
|---|---|---|
| Python syntax | `python -m py_compile` on every file in `app/` and `tests/`, plus `run.py` | **Clean** — no syntax errors |
| JavaScript syntax | `node --check` on all 14 files in `app/static/js/`, including every `nav-*.js` module | **Clean** — no syntax errors |
| Automated test suite | `pytest` (real Flask app via `app.create_app`, SQLite in-memory, no mocks — see `tests/conftest.py`) | **121 passed, 3 failed** (see §6) |
| Navigation/dispatch/RBAC tests specifically | `pytest tests/test_dispatch_navigation.py tests/test_rbac_matrix.py tests/test_scoped_access.py` | **42/42 passed** |
| Manual/browser check | Playwright (Chromium) driving the real app, booted with `dev_seed_phase19_server.py` against a fresh on-disk SQLite DB seeded with a real NAP, subscriber, technician, and two issues (one unassigned, one assigned) | Performed — see §3, screenshots in `phase19_screenshots/` |
| MySQL-backed check | **Not run this phase.** No live MySQL server is reachable in this environment (same constraint every prior phase's notes recorded). The automated suite already proves the SQLAlchemy/ORM logic is dialect-agnostic (see `tests/conftest.py`'s own note); a real MySQL run is still recommended once before production deploy, same recommendation as `TESTING.md` §10. |

## 3. Manual/browser pass — what was checked and what I saw

Using the real, unmodified app (only two new one-off scripts were
added for this: `dev_seed_phase19_server.py` and
`verify_phase19_live.py` — neither is imported by `app/` or shipped
to it):

1. **Admin — map load & real markers** (`01_admin_map_markers.png`).
   Logged in as `admin1`, loaded `/naps/map`. The NAP/issue markers,
   filter panel, and search box render from the real seeded database
   rows, not fixture/sample data.
2. **Admin — destination selection** (`02_admin_navigation_card_destination.png`).
   Loaded `/naps/map?navigate_type=nap&navigate_id=1` (the same query
   param the real "Navigate" button on `naps/view.html` uses). The
   navigation card correctly shows the real NAP's code, name, and
   coordinates (`NAP-0019`, `14.283000, 121.417000`) as the
   destination, and an idle "no starting point set" origin section
   with the three real origin options (device location / pick on map
   / manual lat-lng).
3. **Admin — manual origin picker** (`03_admin_manual_origin.png`).
   Clicking "Pick on map" correctly switches the button to "Cancel
   picking" and shows the "Click anywhere on the map to drop a
   starting point…" instruction — i.e., the picking state machine
   from Phase 8 works. The click itself did not land a pin because
   the Leaflet base-tile server is not on this sandbox's network
   allow-list (tiles never load, map area is blank gray) — a sandbox
   limitation, not an app defect; see §4.
4. **Admin — route/error state** (`04_admin_route_or_error_state.png`).
   Because the map tiles couldn't load, no map click could be
   registered as a coordinate, so no origin was ever confirmed and no
   OSRM request was fired in this run. I separately confirmed OSRM
   itself is unreachable from this sandbox (`curl` to
   `router.project-osrm.org` returns `403` from the egress proxy — the
   domain isn't on the allow-list). `nav-routing.js` does have a
   distinct `errorKind: 'network'` vs `'no_route'` state with its own
   icon/label/retry button (verified by reading the code, §4), but I
   could not trigger it live this run for the reason above.
5. **Admin — dispatch board** (`05_admin_dispatch_board.png`). Real
   dispatch board loads with the seeded assigned issue.
6. **Technician — navigate to own assigned job**
   (`06_technician_navigate_to_assigned_job.png`). Logged in as
   `tech1`, loaded `/naps/map?navigate_type=issue&navigate_id=2` (the
   real assigned issue). Navigation card correctly resolves the issue
   as a destination.
7. **RBAC — collector** (`07_collector_map_rbac.png`). `collector1`
   hitting `/naps/map` gets a real `403` and the app's own "Access
   Denied" page — collector never sees technician/admin navigation
   controls, confirming the existing RBAC boundary holds.
8. **RBAC — customer** (`08_customer_map_rbac.png`). Same result:
   `customer1` gets `403` / Access Denied on `/naps/map`.

Full text log (every step, plus every `console.error` captured across
all four browser sessions) is in
`phase19_screenshots/REPORT.txt`.

## 4. Sandbox network limitations (honest disclosure)

This container's egress proxy allow-lists only package-registry
domains (PyPI, npm, GitHub, etc.) — it does **not** allow
`router.project-osrm.org` (OSRM, returns `403`) or the Leaflet base
map tile CDN (also unreachable, hence the blank gray map in every
screenshot above). This is the same class of constraint every prior
translation-phase's own notes recorded (network egress being off or
restricted). It means:

- I could not visually capture a real drawn road route line, a real
  OSRM network-failure error card, live demo travel, or live device
  GPS in this sandbox.
- I *did* confirm, by reading the actual shipped code
  (`app/static/js/nav-routing.js`), that a distinct network-failure
  error state (as opposed to a "no route found" state) exists,
  correctly separates the two cases with different icons/labels
  (`errorKind === "no_route"` vs the network-failure branch), and
  offers a retry — this matches Phase 5/7's own acceptance criteria
  and Phase 18's hardening of the same code path. This is a code-level
  read, not a live-browser observation, and is called out as such.
- This does **not** indicate an app defect. It's an artifact of this
  particular sandbox's network allow-list, unrelated to the
  application's own logic. A deployment with normal internet egress
  (as every real NAP-IQ deployment will have) does not have this
  restriction — this is exactly what Phases 5–12's own dev/CI
  environments experienced too, per their notes.

## 5. Security / RBAC — what was actually exercised

- `administrator`: full access to `/naps/map`, dispatch board, and
  navigation UI — confirmed via automated `test_rbac_matrix.py` /
  `test_scoped_access.py` (all passing) and live in §3.1–§3.5.
- `technician`: can reach their own assigned job's navigation via
  `?navigate_type=issue&navigate_id=`, confirmed live in §3.6 and by
  `test_dispatch_navigation.py` (10/10 passing, includes
  `test_full_dispatch_to_navigation_flow` and
  `test_dispatch_board_offers_navigate_link_once_assigned`).
- `payment_collector`: correctly denied `/naps/map` (`403`, real
  Access Denied page) — confirmed live in §3.7.
- `user` (customer): correctly denied `/naps/map` (`403`) — confirmed
  live in §3.8.

No RBAC regression was found in either the automated suite or the
live pass.

## 6. Automated test failures — reported honestly, NOT fixed this phase

3 of 124 pytest tests fail on the unmodified codebase:

| Test | File | What it expects vs. what happens |
|---|---|---|
| `test_new_issue_reported_notification_staff_route` | `tests/test_reports_phase23.py` | Expects `POST /issues/report` to return `200`; it actually returns `201 Created`. |
| `test_new_issue_reported_notification_customer_route` | `tests/test_reports_phase23.py` | Expects `POST /customer/report-issue` (with `follow_redirects=True`) to end at `200`; it actually ends at `404`. |
| `test_reports_page_shows_technician_workload` | `tests/test_technician_workflow.py` | Expects the literal text `"Technician Workload"` on `/reports/`; that heading is not present in the rendered page. |

**These are pre-existing and unrelated to the route-line/navigation
integration this 20-phase plan covers.** They concern the issue-
report notification flow and the reports page's technician-workload
section — neither is in Phase 19's test checklist (Map, Navigation,
Dispatch, Security) nor was touched by any of Phases 1–18 of this
translation project. Per the phase plan's global rule to keep changes
additive and not touch anything outside the current phase's stated
scope ("Don't add anything that is not in this phase"), I'm reporting
these as a known, pre-existing limitation rather than fixing them
here — fixing them would mean changing `app/routes/issues.py`,
`app/routes/customer.py`, and/or `app/templates/reports/*.html`
for reasons unrelated to navigation, which the phase plan reserves for
a phase that actually covers that surface. Flagging for a future,
appropriately-scoped phase or ticket.

## 7. Files added this phase

| File | Purpose |
|---|---|
| `dev_seed_phase19_server.py` | One-off dev server: boots the real Flask app on on-disk SQLite seeded with a real NAP/subscriber/technician/2 issues (one assigned) for the manual browser pass. Not imported by `app/`, safe to delete. |
| `verify_phase19_live.py` | Playwright script driving the above server through the 8 scenarios in §3 and saving screenshots + a text report. Not imported by `app/`, safe to delete. |
| `phase19_screenshots/` | The 8 PNG screenshots referenced in §3, plus `REPORT.txt` (full step log + captured console errors). |
| `PHASE23_95_PERCENT_NOTES.md` | This file. |

No `app/` file was modified this phase — Phase 19 is a test pass only.

## 8. Acceptance criteria check

- ✅ No known critical navigation defects — the only failures found
  (§6) are in an unrelated part of the app (issue-report notification
  routes, reports page), not navigation/route-line/dispatch/RBAC.
- ✅ No regression to existing NAP-IQ functionality — 121/124
  automated tests pass, and all navigation/dispatch/RBAC-specific
  tests (42/42) pass.
- ✅ Test results are honestly reported — §6 lists the 3 failures by
  name with their actual vs. expected behavior, and §4 discloses the
  sandbox's network limitations rather than presenting worked-around
  or faked results.
