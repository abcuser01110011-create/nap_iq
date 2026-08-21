# NAP-IQ — Phase 22 Notes (phase_11.pdf Nearest Available NAP Recommendation)

## Scope

phase_11.pdf, in full: given a customer/proposed-installation
location on a `service_requests` row, recommend the nearest NAP that
can actually take a new connection right now — active status, a real
available port — ranked nearest-first, shown to an Administrator with
the reasoning, displayed on the GeoMap, and never assigned without
their explicit confirmation.

This phase is scoped to exactly that. It does not touch anything from
Phases 1-21 except one schema addition (below) — see PHASE21_NOTES.md's
Round 5 for the one exception (a test-only bug fix in Phase 21's own
suite, found while getting `pytest` running for real this round; no
Phase 21 app code changed).

## Egress and test-run status this round

Network egress was genuinely on this round — confirmed via `curl -I`
against domains on this sandbox's own allowlist (`pypi.org`,
`files.pythonhosted.org`, `archive.ubuntu.com`, all `200`;
`example.com`/`google.com`, not on the allowlist, correctly still
`403 host_not_allowed` — that's expected, not a red flag). This let
this phase be verified for real rather than by trace/shim:

- `pip install -r requirements.txt` — succeeded for real.
- `pytest -v`, full suite — **96 passed, 0 failed**
  (81 pre-existing + 15 new in `tests/test_nap_recommendation.py`).
  See PHASE21_NOTES.md's Round 5 for one pre-existing test-only bug
  found and fixed in `test_recommendation.py` while getting the full
  suite green — unrelated to this phase's own code.
- `python3 -m py_compile` — clean on every new/changed `.py` file.
- `node --check` — clean on `app/static/js/napmap.js`.
- **Real browser screenshots** (Playwright + Chromium, both already
  present in this sandbox) of the actual running app against a
  seeded SQLite dev database — see `phase22_screenshots/`:
  - `01_recommend_nap.png` — the recommendation page with two
    suitable NAPs shown nearest-first, the closer one flagged
    "Nearest", and (implicitly, by absence) the seeded full NAP
    correctly excluded.
  - `02_geomap_recommendation.png` — `GET /naps/map?
    recommend_request_id=<id>`, showing the customer pin (purple)
    and the recommended NAP's popup open, auto-fit to bounds. Map
    tiles render gray because `tile.openstreetmap.org` isn't on this
    sandbox's network allowlist (a sandbox limitation, not an app
    bug — markers, popups, and the fetch/plot logic all worked; this
    would render normally against a real deployment).
  - `03_service_request_form_with_location.png` — the edit form with
    Customer Latitude/Longitude filled in and the "Find Nearest NAP"
    button.
  - `04_service_requests_list_row_action.png` — the list page's new
    row-action icon.
- **Not done this round**: a live-MySQL round-trip. Attempted
  `apt-get install mysql-server` now that egress is on — apt reached
  `archive.ubuntu.com`/`security.ubuntu.com` fine, but the specific
  `mysql-server` packages 404'd at the mirror (a genuine package-
  availability gap this round, not an egress block — worth
  re-attempting in a future round, possibly with a different
  MySQL package/version or `mysql-server-8.0` explicitly). SQLite
  (used throughout this suite, same as every other phase) still
  hasn't been swapped for a real MySQL connection for this specific
  feature.

## What was built

- **`app/nap_recommendation.py`** (new) — the engine. Read its own
  module docstring first; it documents the full filter/sort/distance
  logic, why this is a filter-then-sort rather than a weighted score
  (unlike Phase 21's technician engine), and the exact return shape.
  Reuses `app.recommendation.haversine_km` rather than redefining it.

- **`GET /service-requests/<id>/recommend-nap`** and
  **`POST /service-requests/<id>/assign-nap`** (new routes,
  `app/routes/service_requests.py`) — same advisory-page +
  separate-confirm-route shape Phase 21 established for technician
  dispatch. The GET is read-only; the POST re-validates the NAP is
  still active with an available port server-side before writing
  (the same don't-trust-the-page pattern `naps.quick_add_nap()`
  already uses), and redirects with a flash instead of writing if a
  NAP went stale between page render and click.

- **`service_requests.latitude`/`longitude`** (schema/model/form
  change) — the one schema change this phase needed. See "Why this
  schema change" below.

- **Two entry points**, both Administrator-only (service requests are
  already an Administrator-only module since Phase 15):
  - `service_requests/form.html`'s "Find Nearest NAP" button.
  - `service_requests/list.html`'s row-action icon.

- **GeoMap integration** (phase_11.pdf requirement 8, "display the
  result on the GeoMap") — the last piece finished this round:
  - `naps.geomap()` now accepts an optional `?recommend_request_id=`
    query param, mirroring Phase 20's existing `?issue_id=` pattern
    exactly (same "pass through unvalidated, empty string means no
    focus, unknown id just matches nothing client-side" reasoning).
  - New read-only `GET /api/service-requests/<id>/recommend-nap` JSON
    endpoint (`app/routes/api.py`) — Administrator-only, 404s on an
    unknown request id, 400s if the request has no customer location
    set, otherwise returns the customer coordinates plus the same
    ranked candidate list the HTML page shows (so the map never
    duplicates `app/nap_recommendation.py`'s logic in JavaScript).
  - `app/static/js/napmap.js`: a new `recommendationLayer` layer
    group, a `focusNapRecommendationFromQueryParam()` function
    (mirrors `focusIssueFromQueryParam()`'s shape — reads the data
    attribute, fetches, plots on success, `showAlert("danger", ...)`
    on failure), a `plotNapRecommendation()` function that adds a
    customer-location marker, force-enables the NAP status/port
    filters so the recommended NAP is guaranteed visible, fits the
    map to show both pins, and opens the recommended NAP's existing
    popup (reusing `markersById`, the same lookup `focusIssue()`
    already uses for issue markers) — and a `buildCustomerIcon()`
    icon builder (same teardrop shape as NAP markers, distinct purple
    color, per the map's own legend).
  - `naps/map.html`: `#napMap` now also carries
    `data-recommend-request-id`, and the legend gained one entry for
    the new marker color.

- **`tests/test_nap_recommendation.py`** (new, 15 tests) — see "Test
  cases" below.

## The algorithm

Two independent filters (both required, applied before distance is
even computed for a candidate):

1. `status == 'active'` — checked directly on `status`, not inferred
   from port count, so a NAP an administrator has manually flagged
   `maintenance` is excluded even if `available_ports` happens to
   still show a nonzero value.
2. `available_ports > 0` — the same application-maintained column
   used everywhere else in this app.

Surviving candidates are sorted by haversine distance from the
service request's `(latitude, longitude)` to each NAP's `(latitude,
longitude)`, ascending, ties broken by `nap_code` for determinism.
The nearest is flagged `is_recommended=True`; every suitable
candidate is returned (not just the top pick), same "show everyone,
not just the winner" choice Phase 21's technician engine already
makes, so the Administrator can pick a different one if they know
something the algorithm doesn't (e.g. a NAP that's about to go into
maintenance).

No score is computed — this is a hard filter-then-sort, not a
weighted trade-off, because phase_11.pdf asks for the *nearest
suitable* NAP, not a balance between competing factors the way
Phase 21's technician dispatch does. See
`app/nap_recommendation.py`'s own docstring for the full reasoning
(same content, not duplicated here).

## How distance is calculated

Straight-line (haversine) distance in kilometers, same formula and
same module (`app.recommendation.haversine_km`) Phase 21's technician
engine already uses — one source of truth for "great-circle distance
in km" across both recommendation features. `naps.latitude`/
`longitude` are `NOT NULL` columns, so unlike Phase 21's technician
distance factor, there's no "unknown location" fallback case to
handle on the NAP side — every candidate always has a real
coordinate. The service request's own `latitude`/`longitude` (this
phase's new columns) is required before the recommend route will
even run the algorithm — see `recommend_nap()`'s redirect-with-flash
behavior for a request with no location set yet.

## Database queries

Exactly one: `Nap.query.filter_by(status="active").all()`, filtered
to `available_ports > 0` in Python — same "roster is small, one query
plus a Python filter beats a second WHERE clause" reasoning
`app/recommendation.py`'s technician query already uses. No new index
needed.

## How Administrator override works

Same pattern Phase 21 established: the recommendation page is
advisory only and makes no assignment by itself. Every candidate's
"Use This NAP" button is a real CSRF-protected HTML form that POSTs
to `assign_nap()`, which re-checks the NAP's live status/port count
server-side before writing (never trusting a value just because it
came from the page that itself just rendered live data — the NAP
could have gone inactive or filled up in the interim). The
Administrator can:

- Assign the nearest (top) pick.
- Assign any other listed suitable candidate instead.
- Ignore the recommendation page entirely and set `Requested NAP`
  manually from the pre-existing Edit form dropdown (Phase 15/16,
  unchanged).

## Why this schema change

`service_requests` had no location data at all before this phase —
`subscribers.latitude`/`longitude` exists, but a service request can
be a **walk-in applicant with no subscriber record yet** (the
`subscriber_id IS NULL` case `_populate_choices()`'s "-- No
subscriber record yet --" option already handles, present since
Phase 15's seed data), so there's no subscriber row to borrow
coordinates from in general — the location has to live on the
request itself. Nullable, since a request can still be created with
no location (matching the existing walk-in flow) and simply can't be
run through the recommender until one is set.

For an already-provisioned database (schema.sql's
`CREATE TABLE IF NOT EXISTS` won't retrofit an existing install):

```sql
ALTER TABLE service_requests
    ADD COLUMN latitude  DECIMAL(10,7) NULL AFTER status,
    ADD COLUMN longitude DECIMAL(10,7) NULL AFTER latitude;
```

Nullable with no default, so this is safe to run against a table with
existing rows — every pre-existing request simply has `NULL`
coordinates until an administrator sets them (or the request is
edited again), exactly the same "not yet located" state a
brand-new request has before this phase's form fields are filled in.

## Test cases

`tests/test_nap_recommendation.py`, 15 tests, two groups:

**Pure logic tests (real DB via the `app` fixture, no HTTP route):**
1. `test_nearby_available_nap_is_recommended` — phase_11.pdf case 1.
2. `test_nearby_full_nap_is_excluded` — phase_11.pdf case 2.
3. `test_inactive_nap_excluded_even_with_available_ports` — the
   status-checked-directly reasoning above, not just an inferred one.
4. `test_multiple_available_naps_sorted_nearest_first` — phase_11.pdf
   case 3: three NAPs, all returned, correctly ordered, only the
   nearest flagged.
5. `test_no_available_nap_returns_empty_list` — phase_11.pdf case 4.
6. `test_limit_returns_only_top_n` — the optional `limit` parameter.

**Integration tests (Flask test client + in-memory SQLite):**
7. `test_recommend_nap_route_requires_administrator` — 403 for a
   technician, same RBAC pattern as every other admin-only route.
8. `test_recommend_nap_route_lists_candidates_for_administrator` —
   200, candidate NAP code present.
9. `test_recommend_nap_route_redirects_without_location` — a request
   with no lat/lon redirects to the edit form with a flash, doesn't
   crash.
10. `test_assign_nap_sets_requested_nap_id` — confirming actually
    writes `requested_nap_id`.
11. `test_assign_nap_rechecks_nap_is_still_suitable` — a NAP that's
    gone inactive between page render and the confirm click is
    rejected server-side, `requested_nap_id` stays unset.
12. `test_recommend_nap_json_feed_requires_administrator` — 403 for
    a technician on the new GeoMap JSON feed.
13. `test_recommend_nap_json_feed_404s_for_unknown_request` — 404 on
    a bad id.
14. `test_recommend_nap_json_feed_400s_without_location` — 400 when
    the request has no customer coordinates.
15. `test_recommend_nap_json_feed_returns_ranked_candidates` — 200,
    correct JSON shape, `recommended_nap_id` matches the nearest
    suitable candidate.

All 15 run for real this round (`pytest -v`, genuine execution, not a
shim or trace) and pass, alongside the full 81-test pre-existing
suite — **96 passed, 0 failed** total.

## Not verified this round (outstanding)

- **Live MySQL round-trip** — attempted (see "Egress and test-run
  status" above); the `mysql-server` apt package 404'd at the mirror
  this round, a genuine package-availability gap rather than an
  egress block. Worth retrying in a future round.
- No `phase_12.pdf` or later spec has been provided yet — nothing
  about a next phase is assumed here.
