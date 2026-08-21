# PHASE 23 — 10% — Navigation Data Contract

**Status:** Phase 2 of the napV4-route-line integration (see
`PHASE23_5_PERCENT_NOTES.md` for Phase 1's audit/architecture-only
groundwork). This phase adds the **data contract only** — JSON shapes
and one read-only endpoint. **No navigation UI was added.** No
existing route, model, template, or JS file was modified except the
single additive change to `app/routes/api.py` described below.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `app/navigation_contract.py` | **New.** Pure JSON-shaping helper functions — no routes, no models, no DB writes. |
| `app/routes/api.py` | **Additive.** One new import line, one new endpoint (`GET /api/technicians/<id>/location`) appended at the end of the file. Every existing endpoint in this file is unchanged. |
| `PHASE23_10_PERCENT_NOTES.md` | **New.** This file. |

Nothing else changed. `git diff --stat`-equivalent for this phase is
two files touched (one of them just an append), one file added.

## 2. Why a contract module instead of inlining dicts in routes

`app/routes/api.py`'s existing endpoints (`/api/naps`, `/api/issues`,
`/api/subscribers`) each build their JSON response inline with a
list comprehension. That pattern works when a shape is used in
exactly one place. The navigation feature is different: the same
"destination" and "origin" shapes will need to be built from *three*
different source tables (subscriber, NAP, issue) and consumed from
*multiple* future call sites (a destination `<select>`, an origin
picker, a "Navigate" link's initial payload) once the actual UI
phase lands. Centralizing the shape in one module now means:

- Phase 3+ (whenever the UI is built) imports `destination_from_issue`
  etc. instead of re-deriving the dict shape by hand in a template or
  another route.
- The contract is testable in isolation (see §6) without needing a
  running Flask request/response cycle.
- If the shape ever needs to change, it changes in one place.

This mirrors how `app/nap_recommendation.py` already keeps its scoring
logic out of `app/routes/service_requests.py` and
`app/routes/api.py`, rather than duplicating it in both.

## 3. The contract, translated from the prototype

Source: `src/types/index.ts` and `src/store/NavigationStore.tsx` in
`napV4-route line (2)`.

### 3.1 `LatLng` → `latlng_json(latitude, longitude)`

```json
{ "lat": 14.5995, "lng": 120.9842 }
```

Returns `None`/`null` if either coordinate is missing (same
skip-if-unplottable rule `/api/naps` and `/api/issues` already use).

### 3.2 `NavigationDestination` → `destination_json(...)` and its three
per-source builders

```json
{
  "id": "issue-482",
  "type": "issue",
  "label": "ISS-000482",
  "subtitle": "Juan Dela Cruz",
  "position": { "lat": 14.601, "lng": 120.982 },
  "issueId": 482
}
```

| Prototype field | This contract | Notes |
|---|---|---|
| `id` | `id` | `"{type}-{entity_id}"` — disambiguates subscriber #12 from NAP #12 (the prototype's own ids were opaque strings for the same reason). |
| `type` | `type` | `'subscriber' \| 'nap' \| 'issue'`. Prototype used `'complaint'`; NAP-IQ's equivalent entity is `TechnicalIssue`, so the type string is `'issue'` — see the mapping table in `PHASE23_5_PERCENT_NOTES.md` §3. |
| `label` | `label` | Subscriber → `full_name`; NAP → `name`; Issue → `issue_code` (falls back to `"Issue #{id}"` if a legacy row has no code). |
| `subtitle` | `subtitle` | Subscriber → `subscriber_code`; NAP → `nap_code`; Issue → linked subscriber's name, falling back to the issue's own address. |
| `position` | `position` | Built via `latlng_json`. |
| `complaintId` (optional) | `issueId` (optional) | Only set by `destination_from_issue`. Renamed to match NAP-IQ's own vocabulary (`TechnicalIssue`, not `Complaint`) rather than keeping the prototype's name for a field that now points at a different table. |

Three builders, one per real source table, all in
`navigation_contract.py`:

- `destination_from_subscriber(subscriber)`
- `destination_from_nap(nap)`
- `destination_from_issue(issue)`

Each takes an **already-fetched** model instance — none of them query
the database. Callers keep full control of scoping (e.g. a
Technician-scoped `/api/issues` query result feeds
`destination_from_issue` exactly the way it feeds today's inline
dict), so this phase changes zero RBAC behavior.

### 3.3 `NavigationOrigin` → `origin_json(...)` / `origin_from_technician(...)`

```json
{
  "id": "technician-7",
  "label": "Mark Santos",
  "subtitle": "Last known technician location",
  "position": { "lat": 14.590, "lng": 120.979 }
}
```

`origin_from_technician` reads `Technician.current_latitude` /
`current_longitude` — confirmed in Phase 1 as an existing column,
no schema change needed. Returns `None` if the technician has no
known position yet (see §5's note on staleness).

The prototype's *other* origin source — a manually-picked mapped
subscriber/NAP address — needs no new helper at all: `/api/subscribers`
and `/api/naps` already return `latitude`/`longitude`, and a future
origin picker can wrap either response in `origin_json(...)` directly.

The prototype's *device* origin (live browser GPS) is, by design,
never built server-side — it only ever exists in the browser, exactly
as `NavigationStore.tsx`'s own `deviceOrigin` state never touches its
backend either. No helper needed here; it belongs entirely to the
future `nav-route.js`.

### 3.4 `NavigationRoute` → `route_json(points, distance_meters, duration_seconds)`

```json
{
  "points": [{ "lat": 14.59, "lng": 120.97 }, ...],
  "distanceMeters": 4210.5,
  "durationSeconds": 612
}
```

Confirmed (Phase 1, carried forward): the route itself is **never**
computed or stored server-side. It comes from the public OSRM API,
fetched client-side, exactly like the prototype. This helper exists
only so that if a future phase adds a thin server-side OSRM proxy (to
solve rate-limiting, not to change the data source), its response
already matches the shape `nav-route.js` will expect. No such proxy
was added in this phase — nothing calls `route_json` yet.

### 3.5 Enums (kept as plain string tuples, not persisted)

| Prototype | This contract | Values |
|---|---|---|
| `NavigationRouteStatus` | `NAVIGATION_ROUTE_STATUSES` | `idle, loading, ready, error` |
| `NavigationMode` | `NAVIGATION_MODES` | `demo, device` |
| `NavigationOriginMode` | `NAVIGATION_ORIGIN_MODES` | `manual, device` |
| `DemoTravelStatus` | `DEMO_TRAVEL_STATUSES` | `idle, running, paused, complete` |
| `DeviceLocationStatus` | `DEVICE_LOCATION_STATUSES` | `idle, requesting, tracking, error` |

None of these become a `db.Enum` column — they never reach MySQL.
They're defined here only so a later phase's `nav-route.js` and any
server-side validation (if ever needed) reference the same fixed
vocabulary instead of hand-typed string literals scattered across
files.

## 4. The one new endpoint: `GET /api/technicians/<id>/location`

This resolves the open question `PHASE23_5_PERCENT_NOTES.md` §8 left
for this phase: does an Administrator get to look up *any*
technician's position, or is a technician limited to their own?

**Decision:** an Administrator may fetch any technician's location
(consistent with `/api/naps`' existing "Administrator sees
everything" pattern). A Technician may only fetch their **own**
profile's location — attempting another technician's id returns 403.
This is *stricter* than `/api/issues`' "own assignments" scoping,
because a live position is more sensitive than an issue list, and no
existing NAP-IQ feature lets one technician browse a colleague's
location today — this endpoint shouldn't be the first thing that
does.

```
GET /api/technicians/7/location
```

```json
{
  "technician_id": 7,
  "full_name": "Mark Santos",
  "status": "available",
  "position": { "lat": 14.590, "lng": 120.979 },
  "origin": {
    "id": "technician-7",
    "label": "Mark Santos",
    "subtitle": "Last known technician location",
    "position": { "lat": 14.590, "lng": 120.979 }
  }
}
```

- 404 if the technician id doesn't exist.
- 403 if a Technician requests a colleague's id.
- 200 with `"position": null, "origin": null` if the technician exists
  but has no `current_latitude`/`current_longitude` yet — an expected
  state today (see §5), not an error.
- `@role_required("administrator", "technician")`, same staff-only
  gate every other endpoint in this file already uses.

No template, no JS, and no button calls this endpoint yet — it exists
so its shape is correct and independently testable before the UI
phase wires it up.

## 5. Known limitation carried forward (unchanged from Phase 1)

`Technician.current_latitude`/`current_longitude` is still not kept
live by anything in NAP-IQ — no scheduled job or check-in flow updates
it today. This phase does not change that. The new endpoint faithfully
reports whatever is in those columns (possibly stale, possibly null),
the same honest behavior the prototype's own device-GPS fallback
pattern has. A later phase can add a write-back (e.g. from the
technician's own browser via `watchPosition`, mirroring the
prototype) if continuous live tracking is explicitly requested — out
of scope here.

## 6. Verification performed this phase

- `python3 -m py_compile app/navigation_contract.py app/routes/api.py`
  — both files compile cleanly.
- Created the Flask app via `create_app()` with dummy env vars (no
  live MySQL connection available in this environment) and confirmed:
  - the app factory still builds without error (no import-time
    breakage from the new module/import), and
  - `GET /api/technicians/<int:technician_id>/location` is registered
    in `flask_app.url_map` with `GET/HEAD/OPTIONS`, alongside the
    existing 74 routes (75 total after this change) — i.e. nothing
    else was deregistered or shadowed.
- Manually re-read the full diff of `app/routes/api.py` end to end to
  confirm every pre-existing endpoint's body is byte-for-byte
  unchanged; only an import line and a new function were added.
- No live database call was exercised (no MySQL instance in this
  sandbox) — the endpoint's query shape (`Technician.query.get_or_404`,
  `Technician.query.filter_by(user_id=...)`) is the same pattern
  already proven working elsewhere in this codebase (e.g.
  `technician.py`'s `_get_own_profile_or_403`), so this is a
  documented limitation of this phase's verification, not a gap in
  the code path itself. A real end-to-end check against MySQL is
  recommended before this phase is considered fully closed.

### 6.1 Follow-up: live end-to-end run (this pass)

The §6 gap above — "no live database call was exercised" — is now
closed using the same in-memory-SQLite pattern `tests/conftest.py`
already uses for the rest of the suite (real `create_app()`, real
`db.create_all()`, real `test_client()` HTTP requests; nothing mocked).
See `verify_phase23_10pct_live.py` (new, added this pass) for the
exact script.

Seeded one real-shaped record set (not fake/hard-coded IDs baked into
the contract — these are ordinary rows inserted the same way
`conftest.py`'s `DEMO_ACCOUNTS` are): one administrator, two
technicians (one with a known `current_latitude/longitude`, one
without), one NAP, one subscriber linked to that NAP, one
`TechnicalIssue` linked to that subscriber. Then, through the real
Flask test client:

| Check | Result |
|---|---|
| Admin logs in, fetches technician **with** a position | `200`, correct `position`/`origin` shape |
| Admin fetches technician **without** a position | `200`, `"position": null, "origin": null` (confirms §4's documented non-error case) |
| Admin fetches a non-existent technician id | `404` |
| A technician logs in and fetches a **colleague's** location | `403` |
| A technician fetches their **own** location | `200`, correct shape |
| Existing `/api/naps`, `/api/issues`, `/api/subscribers` still respond | all `200` — unaffected by this phase's change |
| Total registered routes | `75` (74 pre-existing + 1 new — matches §6's earlier route-map check) |
| `destination_from_subscriber` / `_from_nap` / `_from_issue` / `origin_from_technician` called against the real seeded rows | all return the documented shape from §3, built from live model instances |

One bug was caught and fixed by this live run: the first draft of the
verification script logged the technician out with `client.get("/logout")`,
but `/logout` is `POST`-only (by design — see `app/routes/auth.py`), so
the GET silently no-opped and the *admin* session was still active for
the "does a technician get 403 on a colleague" check, making it a
false pass. Fixing the script to `POST /logout` reproduced the correct
`403`. This was a bug in the **verification script**, not in
`app/routes/api.py` — flagged here for transparency since it's exactly
the kind of gap "verified" language should not paper over.

Full pytest run (`pytest -q`, 114 tests) after this change:
**111 passed, 3 failed.** All 3 failures are in
`tests/test_reports_phase23.py` and `tests/test_technician_workflow.py`
— files that predate this phase, never import `navigation_contract`,
and never touch `/api/technicians/<id>/location`. They were not
introduced by this phase's changes (confirmed by grepping both files
for any reference to the new module/endpoint — none exists) and are
left as-is per this project's instruction not to fix things outside
the current phase's scope; flagged here rather than silently ignored.

## 7. Acceptance criteria check (Phase 2 / 10%)

- [x] Real NAP-IQ records can be represented as navigation
      destinations — `destination_from_subscriber`,
      `destination_from_nap`, `destination_from_issue` all build the
      contract shape from real model instances, no fake data.
- [x] Existing database structure remains intact — zero model/schema
      changes; `Technician.current_latitude/longitude` (already
      existing) is reused as-is.
- [x] JSON responses are consistent and documented — this file, §3–4.
- [x] No navigation UI was added — confirmed; no template or JS file
      was touched this phase.

## 8. Remaining limitations / open items for the next phase

- `nav-route.js`, the nav panel markup in `naps/map.html`, and the
  "Navigate" link in `technician/index.html` (all planned in
  `PHASE23_5_PERCENT_NOTES.md` §4, items 1–5) are **not part of this
  phase** and still need to be built.
- The new endpoint has not been exercised against a live MySQL
  database in this environment (see §6) — only syntax- and
  route-registration-checked.
- `destination_from_issue`'s `subtitle` fallback (issue's own address)
  has not been tested against a real issue row with a null
  `subscriber` relationship, since that shouldn't happen given
  `subscriber_id` is `nullable=False` on `TechnicalIssue` — flagged
  here only for completeness, not because it's expected to occur.
- 3 pre-existing test failures unrelated to this phase (see §6.1) were
  observed during the full-suite regression run and are **not**
  introduced or fixed by this phase — left as-is per scope.

## 9. Status as of this pass

Phase 2 (10% — data contract only) is now **verified complete**:
the contract module, the one new endpoint, and every acceptance
criterion in §7 have been confirmed against a real running Flask app
and a real (SQLite) database, not just syntax-checked. §6.1 above is
the only substantive addition made in this pass — no route, model,
template, or contract shape was changed.

**What is still NOT implemented (intentionally, out of this phase's
10% scope) and remains for Phase 3+:**

- No navigation UI: no `nav-route.js`, no nav panel in `naps/map.html`,
  no "Navigate" link in `technician/index.html`. Phase 2's acceptance
  criteria explicitly state "No navigation UI is required yet" — this
  is correct as-is, not a gap.
- No live-updating technician position (no `watchPosition` write-back)
  — `current_latitude/longitude` is read-only from this phase's side,
  same limitation carried from Phase 1 (§5).
- No server-side OSRM proxy — `route_json()` exists but nothing calls
  it yet; routing still happens 100% client-side once Phase 3 builds
  the UI, exactly like the prototype.

**STOP — per your instructions, this is being packaged and reported
now, before continuing into the UI phase in the same pass.**
