# Phase 15 (75%) — Dispatch-to-navigation flow

## What this phase implements

The plan asks for the *complete* operational flow — Complaint →
Technician assignment → Job → Navigate → Route → Travel progress —
using existing NAP-IQ database state, with RBAC respected at every
step. Every individual link in that chain already existed from
earlier phases (dispatch in `app/routes/dispatch.py`, "my job" in
`technician/index.html`, the Navigate action from Phase 14, OSRM
routing/demo-travel/GPS from Phases 5–12). What this phase adds is:

1. **Proof the chain actually holds together end to end**, against
   the real routes and real DB state, not just each link in
   isolation — new integration tests (below).
2. **One small, genuinely-missing UI link**: the Dispatch Board
   (Administrator) had no way to preview a dispatched job's
   destination — only the technician's own "My Work" page (Phase 14)
   and the issue detail page (Phase 13) did.
3. **Explicit, automated proof of the RBAC boundary** the plan calls
   out by name — "Collector/customer must not gain technician-only
   navigation controls accidentally" — rather than relying on it
   being true by construction.

### 1. Navigate link on the Dispatch Board

`app/templates/dispatch/index.html`: once an issue's "Current
Assignment" cell shows a technician, a small **Navigate** link now
sits under the status line, using the identical
`navigate_type=issue&navigate_id=<id>` pattern every other Navigate
link in this app already uses (Phase 13). Guarded the same way as
every other one: only rendered when the issue actually has
coordinates. Purely a read — it does not touch `Assignment`,
`dispatch_score`, or any dispatch route; it's built from
`assignment_by_issue`, a dict the route already constructs.

This is the last remaining "Job" checkpoint on the plan's flow
diagram that didn't yet have a Navigate entry point next to it — an
administrator dispatching a technician can now immediately preview
where that job actually is, from the same screen, without a second
page load.

### 2. Integration tests (`tests/test_dispatch_navigation.py`, new)

- `test_full_dispatch_to_navigation_flow` — seeds a *pending*
  (unassigned) issue, logs in as `admin1`, dispatches it via the real
  `POST /dispatch/issues/<id>/assign` (asserts exactly **one**
  `Assignment` row exists afterward, `status == "assigned"`), logs in
  as `tech1`, confirms the Navigate link with the correct
  `navigate_id` appears on `/technician/`, follows it to
  `/naps/map?navigate_type=issue&navigate_id=<id>` (asserts the
  `data-navigate-type`/`data-navigate-id` attributes are correctly
  populated), then re-checks the `Assignment` table is still exactly
  one row, unchanged — proving navigation never creates or mutates an
  assignment, per the plan's explicit "Do not create duplicate
  assignment records" acceptance criterion.
- `test_dispatch_board_offers_navigate_link_once_assigned` — confirms
  the new board link (above) actually renders for a dispatched issue.
- `test_collector_and_customer_cannot_reach_navigation_or_dispatch` —
  logs in as both `collector1` and `customer1` and asserts **403**
  on: `GET /naps/map`, `GET /naps/map?navigate_type=issue&navigate_id=`,
  `GET /dispatch/`, `GET /technician/`,
  `POST /dispatch/issues/<id>/assign`, and `GET /issues/<id>` — then
  confirms no `Assignment` row was created by any of those attempts.
  This is the direct, automated version of the plan's own
  "Collector/customer: must not gain technician-only navigation
  controls accidentally" line.
- `test_technician_cannot_navigate_to_a_job_not_assigned_to_them` —
  `tech2` (no assignment on the seeded issue) still gets 403 from the
  issue detail page (Phase 14's own ownership scoping, re-confirmed
  intact) and sees no Navigate link for that job on their own "My
  Work" page.

### 3. `tests/test_rbac_matrix.py` — two new entries

Added `/naps/map` (`{"administrator", "technician"}`, mirroring
`naps.py`'s `_VIEW_ROLES`) and `/dispatch/`
(`{"administrator"}`) to `ROUTE_MATRIX`. This automatically extends
the existing generic 403/200/redirect-to-login checks — already
run against every demo account for every route in the matrix — to
cover the GeoMap (the navigation entry point itself) and the
Dispatch Board, which had no direct-URL RBAC coverage before this
phase despite both being central to this phase's flow.

## Files changed

- `app/templates/dispatch/index.html` — Navigate link on assigned
  rows (read-only, additive)
- `tests/test_dispatch_navigation.py` — **new file**, 4 tests
- `tests/test_rbac_matrix.py` — 2 new `ROUTE_MATRIX` entries

No models, no database schema, no existing route signatures, no
dispatch/recommendation scoring logic, and no `@role_required`
decorators were changed. `dispatch.assign` / `dispatch.reassign` /
`dispatch.cancel` are byte-for-byte unchanged — the new tests only
call them the same way the existing Dispatch Board form already does
(same fields, same CSRF convention already disabled in
`TestConfig` for this suite, same redirect-on-success behavior).

## Tests performed

Real `pytest -v` run (network egress open this session — same
genuine dependency install as the last two phases, not a shim):

```
121 passed, 3 failed
```

The 3 failures are the same pre-existing, unrelated ones flagged in
`PHASE14_70_PERCENT_NOTES.md`
(`test_reports_phase23.py::test_new_issue_reported_notification_staff_route`,
`test_reports_phase23.py::test_new_issue_reported_notification_customer_route`,
`test_technician_workflow.py::test_reports_page_shows_technician_workload`)
— in the issue-reporting/reports modules, untouched by this phase.
Passed count rose from 111 (Phase 14) to 121: the 4 new
dispatch-navigation tests + the RBAC matrix's 2 new route entries,
each of which runs 3 parametrized checks (403-for-disallowed-roles,
200-for-allowed-roles, redirect-for-unauthenticated) = 4 + 6 = 10 new
passing tests, matching 111 → 121.

Also re-ran, individually and verbosely, just the new/changed files
(`tests/test_dispatch_navigation.py` + `tests/test_rbac_matrix.py`):
37/37 passed.

Static checks: `python3 -m py_compile` across all of `app/` (clean,
unchanged from Phase 14 since no `.py` files besides the ones already
compiled last phase were touched — `dispatch/index.html` is the only
non-test file this phase edits), and a Jinja
`Environment().parse()` pass on `dispatch/index.html` specifically.

## Known limitations

- As in Phase 14, no live MySQL server or browser is available in
  this sandbox this round, so the Dispatch Board's new Navigate link
  was verified via the real Flask test client (asserting the exact
  HTML link text appears in the rendered response) rather than a
  live click-through screenshot. Same Playwright-CDN-not-on-allowlist
  constraint as last phase.
- This phase's tests use SQLite (via the existing
  `tests/conftest.py` in-memory fixture, the same approach every
  other test file in this suite already uses), not a live MySQL
  server. No MySQL-specific SQL was touched by this phase's changes.
- Per the plan's own scope for this phase, no further OSRM
  routing/demo-travel/GPS behavior was added or changed — this phase
  is entirely about the dispatch → navigate seam and its RBAC
  boundary, which is what its acceptance criteria actually ask for.
