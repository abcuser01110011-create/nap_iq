# PHASE 2 — 25% — Nearest-Available-NAP-for-a-Point Data Contract

**Status:** Phase 2 of the Installation Planning integration (follows
`PLAN_INSTALL_10_PERCENT_NOTES.md`'s audit/architecture work). This
phase adds the **data contract only** — one new read-only JSON
endpoint. **No installation-planning UI was added.** No existing
route, model, form, template, or JS file was modified.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `app/routes/api.py` | **Additive.** One new import (`request`, previously unused in this file), one new module-docstring paragraph, one new route: `GET /api/naps/nearest-available`. Every existing route/function in this file is unchanged. |
| `tests/test_installation_planning_25pct.py` | **New.** 9 integration tests against the new route (auth, validation, and response-shape coverage). |
| `PLAN_INSTALL_25_PERCENT_NOTES.md` | **New.** This file. |

Nothing else changed.

---

## 2. Why a new endpoint, not a reuse of the existing one

Phase 1's audit found `GET /api/service-requests/<id>/recommend-nap`
(`service_request_recommend_nap_json()`), which already wraps
`recommend_naps()` and returns JSON. It does **not** fit this exact
input/output shape, though, because:

- It requires an **existing `ServiceRequest` row** (`<id>` in the
  URL) and 404s if it doesn't exist — this feature's whole premise
  (per `PLAN_INSTALL_10_PERCENT_NOTES.md` §5) is that a dropped pin
  has **no** `ServiceRequest` behind it yet, and per the
  architecture decision, never will.
- It reads its coordinates from that row's `latitude`/`longitude`
  columns, not from raw query-string input.
- Its response shape carries `service_request_id` and a full
  candidate list, shaped for the recommend-nap admin page's needs —
  not the single-suggestion shape `nearestAvailableNap(pos)` needs.

Per the plan's instruction ("Add or update an API endpoint only if
one doesn't already fit this exact input/output shape"), a new,
narrowly-scoped endpoint was added: `GET /api/naps/nearest-available`.
It sits in the same file, next to the route it mirrors, and both call
the exact same `recommend_naps()` function — **no distance/
availability logic was duplicated.**

---

## 3. The contract

### Endpoint
`GET /api/naps/nearest-available?lat=<float>&lng=<float>`

### Auth
`@role_required("administrator")` — narrower than `/api/naps` and
`/api/technicians/<id>/location` (both open to `_STAFF_ROLES` =
administrator + technician). This is deliberate: this endpoint exists
solely to back the admin-only "Plan Installation" feature (Phase 3+
gates the UI control to `current_user.role == 'administrator'`,
mirroring the prototype's `role === 'admin'` check exactly). Scoping
the data contract to the same role now — even before the UI exists —
means there is no window where a technician could reach this lookup
directly just because the route existed first. Verified by
`test_technician_forbidden` (403) and `test_requires_login`
(redirect to `/login`).

### Input
| Param | Type | Required | Validation |
|---|---|---|---|
| `lat` | float | yes | -90..90 |
| `lng` | float | yes | -180..180 |

Missing, non-numeric, or out-of-range values → `400` with
`{"status": "error", "message": "..."}`. Covered by
`test_missing_params_returns_400`, `test_non_numeric_params_returns_400`,
`test_out_of_range_params_returns_400`.

### Output — success (a suitable NAP exists), `200`:
```json
{
  "status": "success",
  "point": {"lat": 14.6101, "lng": 121.0101},
  "nap": {
    "id": 1,
    "nap_code": "NAP-900",
    "name": "Manual Check NAP",
    "address": "Brgy. Duhat",
    "latitude": 14.61,
    "longitude": 121.01
  },
  "distance_km": 0.02,
  "available_ports": 2
}
```
(Real captured output from a manual run — see §5.)

### Output — no suitable NAP nearby, `200` (not an error):
```json
{
  "status": "no_nap_available",
  "point": {"lat": 14.6001, "lng": 121.0001},
  "nap": null,
  "distance_km": null,
  "available_ports": null
}
```
An empty candidate pool is treated as a normal, honest result —
mirroring the prototype's `!suggestion` branch (which renders "No NAP
with available slots near this location." rather than an error) and
`recommend_naps()`'s own docstring, which already documents an empty
list as expected, not a failure. Covered by
`test_no_nap_available_is_a_clean_200_not_an_error` and
`test_maintenance_status_nap_excluded`.

### Mapping to prototype fields
| Prototype (`nearestAvailableNap`/`napUsage`) | This contract |
|---|---|
| `suggestion.nap.code` | `nap.nap_code` |
| `suggestion.nap.label` | `nap.name` |
| `suggestion.nap.barangay` | `nap.address` (target has no separate barangay column — see Phase 1 notes §3/§4) |
| `suggestion.distanceKm` | `distance_km` |
| `napUsage(nap.id).available` | `available_ports` |
| `!suggestion` (null case) | `status: "no_nap_available"`, all value fields `null` |

### What was reused vs. added
- **Reused, unmodified:** `app.nap_recommendation.recommend_naps(latitude, longitude, limit=1)` — the exact same function `service_request_recommend_nap_json()` already calls. It already accepted plain `(latitude, longitude)` arguments (never actually coupled to `ServiceRequest`, only its one prior caller sourced coordinates from one), so **no change was needed in `app/nap_recommendation.py` at all.**
- **Added:** the one new route, which does parameter parsing/validation and JSON shaping only — no filtering, sorting, or distance math of its own.
- **No new database table or column.** Same read-only, computed-on-the-fly guarantee `app/nap_recommendation.py`'s module docstring already documents.

---

## 4. Acceptance criteria check

- [x] Given any real latitude/longitude, the correct nearest NAP with
      open capacity (or "none") is returned using real database
      data — verified by `test_returns_nearest_nap_with_capacity`,
      `test_full_nap_excluded_even_if_nearest`,
      `test_maintenance_status_nap_excluded`, and the manual run in
      §5 (real in-memory SQLite rows, real HTTP request/response
      cycle via Flask's test client — no mocked data).
- [x] No duplicate distance/availability logic is introduced —
      `recommend_naps()` is called, not reimplemented (§3).
- [x] JSON response is consistent and documented — §3, this file.
- [x] No installation-planning UI is required yet, and none was
      added — confirmed by the diff in §6.

---

## 5. Manual verification performed

Ran the real Flask app (via `create_app`) against a fresh in-memory
SQLite database, logged in as the seeded `admin1` account, and hit
the new route with a real HTTP request through Flask's test client
(same mechanism `tests/conftest.py`'s `client` fixture uses — a real
WSGI request/response cycle, not a unit-level function call):

```
GET /api/naps/nearest-available?lat=14.6101&lng=121.0101
  -> 200 { "status": "success", "nap": {"nap_code": "NAP-900", ...},
           "distance_km": 0.02, "available_ports": 2, ... }

GET /api/naps/nearest-available?lat=1.0&lng=1.0
  -> 200 { "status": "success", "nap": {"nap_code": "NAP-900", ...},
           "distance_km": 13193.61, ... }
  (only one NAP exists in this seed; correctly still returned, since
  neither recommend_naps() nor the prototype's nearestAvailableNap()
  apply a maximum-distance cutoff — nearest-available is unconditional
  by design in both.)
```

Automated:
```
$ pytest tests/test_installation_planning_25pct.py -v
9 passed

$ pytest tests/test_nap_recommendation.py tests/test_rbac_matrix.py tests/test_scoped_access.py -q
53 passed
```

Full-suite regression check (pre-existing, unrelated to this phase):
```
$ pytest -q
3 failed, 121 passed
  FAILED tests/test_reports_phase23.py::test_new_issue_reported_notification_staff_route
  FAILED tests/test_reports_phase23.py::test_new_issue_reported_notification_customer_route
  FAILED tests/test_technician_workflow.py::test_reports_page_shows_technician_workload
```
These 3 failures are in the Reports/notifications module
(`test_reports_phase23.py`, `test_technician_workflow.py`) — neither
touches `app/routes/api.py`, `app/nap_recommendation.py`, nor
anything this phase changed. Reported honestly as a pre-existing
condition, not caused by this phase's change.

```
$ python3 -m py_compile app/routes/api.py
(no output — compiles cleanly)
$ python3 -m py_compile $(find app -name "*.py")
(no output — whole app compiles cleanly)
```

---

## 6. Confirmed diff scope

Only files touched this phase:
- `app/routes/api.py` (additive: 1 import, 1 docstring paragraph, 1 new route/function)
- `tests/test_installation_planning_25pct.py` (new file)
- `PLAN_INSTALL_25_PERCENT_NOTES.md` (new file, this one)

No `.html`, `.css`, or other `.js` file was touched. No installation-planning UI exists yet — that is Phase 3's job.

---

**STOP.** This is the end of Phase 2 (25%). Phase 3 ("Plan
Installation" map mode) is intentionally not started.
