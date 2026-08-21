# NAP-IQ — Phase 21 Notes (phase_10.pdf Technician Dispatch Recommendation)

## Round 5 (during Phase 22 work) — egress genuinely on; real `pytest -v` run for the first time; one test bug found and fixed (not an app bug)

This round's network egress was genuinely on (confirmed via `curl -I`
against domains on this environment's own allowlist — `pypi.org`,
`files.pythonhosted.org`, `archive.ubuntu.com`, all `200`;
`example.com`/`google.com`, correctly not on the allowlist, still
`403 host_not_allowed` — that's expected and not a sign anything is
wrong). `pip install -r requirements.txt` succeeded for real, and
`pytest -v` ran for the first time ever on this project — not the
Round 3 `dev_verification/` shim, not a manual trace, the actual
suite.

Result: one failure, in `tests/test_recommendation.py::
test_recommend_excludes_already_assigned_technician`. Traced it
directly (`get_recommendations()` -> the route's own post-filter ->
the rendered template) before touching anything, the same discipline
Round 2 used for the real " AI " bug:

- The route (`dispatch.recommend()`) correctly excludes the
  already-assigned technician from the candidate list — confirmed by
  querying `get_recommendations()` output directly, both before and
  after the exclusion filter.
- The template (`dispatch/recommend.html`) legitimately prints
  `"currently assigned to {{ current_assignment.technician.full_name
  }}"` in its header line — this is documented, intentional behavior
  (see `recommend()`'s own docstring: "Works for an issue with no
  open assignment... just as well as one that's already dispatched").
- The test's assertion, `assert b"Near Tech" not in resp.data`, was
  simply too broad — it fires on that header line just as readily as
  it would on a real regression (the technician wrongly reappearing
  as a candidate card). Confirmed empirically: with the exclusion
  working correctly, `resp.data.count(b"Near Tech")` is exactly `1`
  (the header line only); if the exclusion filter were ever removed,
  it would be `2` (header line + a second candidate card).

**Fixed**: the assertion now reads
`assert resp.data.count(b"Near Tech") == 1`, which distinguishes
"legitimately mentioned once, in context" from "wrongly offered
again as a candidate" — the actual thing this test is supposed to
catch. No `app/` code changed; this was a test-only bug, three
rounds of manual tracing (Rounds 2-4) never caught because the
assertion was never actually executed against a real response until
this round.

Full suite after the fix: **81 passed, 0 failed** (real `pytest -v`,
not a shim). `dev_verification/` (Round 3's zero-egress stopgap) can
now be treated as disposable per its own README, now that a real run
has actually passed — left in place this round since Phase 22 work
was still in progress, but there's no remaining reason to keep it.

No other Phase 1-21 code touched this round.

## Round 4 (this package, nap_iq_phase21_wip_v3.zip re-opened) — still zero egress; Round 2/3 findings independently reconfirmed, nothing new

Checked the egress toggle claim myself before touching anything, the
same way Round 3 did: `https://pypi.org`, `https://files.pythonhosted.org`,
`https://example.com`, and `https://google.com` all returned `403` with
header `x-deny-reason: host_not_allowed`. Same signature Round 3
recorded. This session's own tool configuration confirms it directly —
network egress for this sandbox is off — so this is the "Allow network
egress" toggle Round 3 identified, still off, not sandbox randomness.
`pip install`, real `pytest`, booting the app for screenshots, and a
live MySQL connection are all still genuinely impossible this round,
same root cause as Rounds 2 and 3.

Rather than re-trust Round 2/3's conclusions unchecked, re-verified
both independently this round:
- Re-ran `dev_verification/run_real_verification.py` against the
  actual `app/recommendation.py`/`app/models.py` files (unmodified) —
  same result, `10/10 real-execution checks passed`.
- Re-read `app/templates/dispatch/recommend.html`'s raw bytes directly:
  `b" AI "` → `False`, `b"Artificial Intelligence"` → `False`. The
  Round 2 fix is intact.
- Re-ran `python3 -m py_compile` on `app/recommendation.py`,
  `app/routes/dispatch.py`, `app/forms.py`, `app/models.py`,
  `tests/test_recommendation.py` — clean.
- Checked for a local way around the network block: Flask 3.1.3 is
  preinstalled in this sandbox, but `flask_sqlalchemy`, `flask_limiter`,
  and `pytest` are not, and there's no local MySQL server binary
  available either. No path to a real `pytest -v` run or a live-MySQL
  round-trip exists without egress.

No code changes this round — nothing to fix, `dev_verification/` is
untouched and still not deleted (per its own README: delete only once
a real `pytest -v` passes, which still hasn't happened). The three
outstanding items from Round 3 are unchanged and still blocked on the
same thing: the person needs to enable network egress for this
conversation before any of them can be done for real.

## Round 3 (this package, nap_iq_phase21_wip_v3.zip) — 10 of 15 tests now genuinely executed, not just traced

Zero egress again this round -- confirmed the same way as Round 2, but
more precisely this time: `curl -sI https://pypi.org` (a domain that
*is* on this sandbox's own documented allowlist) returned `HTTP 403`
with header `x-deny-reason: host_not_allowed`, and the same for
`archive.ubuntu.com`, `github.com`, `registry.npmjs.org`, and
`security.ubuntu.com`. That specific error means the **"Allow network
egress" toggle in Settings > Capabilities is off for this
conversation** -- it overrides the allowlist entirely. This isn't a
sandbox-randomness thing like Round 2 speculated; it's a per-
conversation setting the person needs to flip before a future round
can install anything real.

Rather than repeat Round 2's manual-trace-only approach, this round
built a small import-satisfying shim (`dev_verification/`, new, kept
out of `app/` and never imported by it) that lets the REAL
`app/recommendation.py` and `app/models.py` files load and run without
Flask-SQLAlchemy/Flask-WTF actually being installed -- see
`dev_verification/README.md` for exactly what it does and doesn't
verify. This isn't pytest and isn't a substitute for it, but it's a
real step up from reading code and reasoning about it: 10 of the 15
tests in `tests/test_recommendation.py` were reproduced as genuine
executions of the actual production functions (not reimplemented, not
mocked) and all 10 passed:

```
[PASS] test_haversine_zero_distance_for_identical_points
[PASS] test_haversine_known_distance_manila_to_cebu
[PASS] test_haversine_symmetric
[PASS] test_weights_sum_to_one
[PASS] test_availability_score_available_beats_busy
[PASS] test_workload_score_decreases_with_open_assignments
[PASS] test_offline_technicians_excluded_from_recommendations
[PASS] test_closer_technician_ranks_first_when_otherwise_equal
[PASS] test_performance_factor_neutral_below_history_threshold
[PASS] test_performance_factor_computed_once_threshold_met

10/10 real-execution checks passed.
```

The remaining 5 (`test_recommend_route_requires_administrator`,
`test_recommend_route_lists_candidates_for_administrator`,
`test_confirming_recommendation_creates_assignment_with_score`,
`test_manual_assign_still_leaves_dispatch_score_null`,
`test_recommend_excludes_already_assigned_technician`) all need a real
Flask app + CSRF + HTTP routing, which the shim deliberately doesn't
fake (faking that much of Flask/Flask-WTF would just be a worse
reimplementation of them, producing false confidence rather than real
verification) -- those 5 remain manually trace-verified only, same as
Round 2 (re-checked this round, nothing changed: the route wiring,
`AssignTechnicianForm.recommendation_score`, and the fixed
`recommend.html` disclaimer all still match what those 5 tests
assert).

No bugs found this round -- re-ran the Round 2 " AI " substring check
against the current file (`b" AI " in data` -> `False`,
`b"Artificial Intelligence" in data` -> `False`) to confirm that fix
is still intact, and `python3 -m py_compile` is still clean on every
touched file. No code changes this round, only the new
`dev_verification/` harness (additive, not part of `app/`) and this
notes update.

## Round 2 (this package, nap_iq_phase21_wip_v2.zip) — one real bug found and fixed; `pytest -v` still blocked

This sandbox has no egress at all this round — confirmed, not assumed:
`pip install -r requirements.txt` fails the same way it did in Round 1
(no matching distribution for anything), and this round I also tried
`apt-get install python3-flask-sqlalchemy python3-pytest`, which got
as far as actually contacting `archive.ubuntu.com` and then received
**403 Forbidden** on every package. That's a different (and more
informative) failure than Round 1's — it confirms this isn't a
preinstalled-packages gap, it's this session's sandbox having no
egress at all. Worth noting since PHASE20_NOTES.md's Round 7 *did*
have apt access to `archive.ubuntu.com`/`security.ubuntu.com` in that
session — sandbox network access apparently varies round to round, so
it's worth re-attempting `pip install -r requirements.txt pytest &&
pytest -v` at the start of any future round rather than assuming this
round's result still holds.

Since the real suite still can't run, this round did the next best
thing: a careful line-by-line trace of all 15 tests in
`tests/test_recommendation.py` against the actual implementation
(`app/recommendation.py`, `app/routes/dispatch.py`, `app/forms.py`,
`app/models.py`, and both templates), rather than re-asserting the
Round 1 "written and reasoned through" status unchanged. This caught
one real, confirmed bug:

- **Bug: the "not AI" disclaimer on `dispatch/recommend.html`
  contained the literal substring `" AI "`.** The line read
  `...rule-based scoring formula — not AI —...`, i.e. exactly a space,
  `AI`, a space, before the em dash. `test_recommend_route_lists_
  candidates_for_administrator` asserts `b" AI "` is NOT in the
  response body — this would have failed that assertion the moment
  `pytest` actually ran. Confirmed by reading the template's raw bytes
  directly (`b' AI '  in data` -> `True`) before touching anything, so
  this isn't a guess. **Fixed**: reworded to "plain arithmetic over
  fixed weights, not a trained or predictive model" — same meaning
  (still never claims to be AI, per phase_10.pdf), no more standalone
  `"AI"` token anywhere in the rendered page. Re-checked the fixed
  file's raw bytes afterward: `b" AI "` and `b"Artificial
  Intelligence"` are both now absent. This is the one exception to
  "don't rework Phase 1-21 code unless testing turns up a bug" — this
  is exactly that case.
- Also fixed a doc-only inconsistency in this file: "What was built"
  said 13 tests where the codebase and the "Test cases" list below
  both actually have 15 (the list itself was always right; only that
  one summary line was stale).

Everything else traced clean — no other bugs found:
- `app/models.py`'s `Technician`/`TechnicalIssue`/`Assignment` fields
  (`current_latitude`/`current_longitude`, `status` enum values,
  `dispatch_score` as `Numeric(5,2)`, `resolved_issues_count`,
  `assigned_at`/`completed_at`) all match exactly what
  `app/recommendation.py` and the test file's `_seed()` helper assume.
- `AssignTechnicianForm.recommendation_score` (`app/forms.py`) is an
  `Optional` `DecimalField` with `NumberRange(0, 100)` — matches both
  the manual-path tests (field omitted -> `None` -> `dispatch_score`
  stays `NULL`) and the recommendation-path test (field posted as a
  stringified score -> parsed and forwarded).
- `dispatch/index.html` and `issues/view.html`'s new "Recommend"
  links both correctly call `url_for('dispatch.recommend',
  issue_id=...)` — the endpoint name actually registered in
  `app/routes/dispatch.py`.
- `recommend.html`'s per-candidate form posts to `dispatch.reassign`
  when `current_assignment` is set and `dispatch.assign` otherwise,
  carrying `technician_id`, `recommendation_score`, and a real
  `csrf_token()` — matches `test_confirming_recommendation_creates_
  assignment_with_score` and `test_recommend_excludes_already_
  assigned_technician`.
- `role_required("administrator")` on the new route aborts with a
  plain `403` (not a redirect) for a non-admin, matching
  `test_recommend_route_requires_administrator` exactly, and is the
  same decorator every other admin-only route already uses — nothing
  new to verify there.
- `python3 -m py_compile` re-run clean on every touched file
  (`app/recommendation.py`, `app/routes/dispatch.py`, `app/forms.py`,
  `app/models.py`, `tests/test_recommendation.py`) after the fix.

**Screenshot and live-MySQL items: still blocked, for a new reason
worth recording.** Both require actually booting the Flask app
(`dev_seed_server.py` imports `app.create_app`, which imports
`app/extensions.py`, which imports `flask_sqlalchemy` and
`flask_limiter` at module load time) — with zero egress this round,
neither package could be installed, so the app can't even start here,
independent of Playwright being present or not. This is a stronger
(and more precise) statement than Round 1's "not verified this round"
— it's not merely undone, it's confirmed *impossible* to do for real
in a zero-egress sandbox, same root cause as `pytest` above. Next
round with actual egress (per the note above, this varies) should do
all three outstanding items together: `pip install -r
requirements.txt pytest && pytest -v`, then `dev_seed_server.py` +
`dev_screenshot.py` for the 8th screenshot, then the live-MySQL
round-trip.

## Scope

phase_10.pdf, in full: a rule-based technician recommendation system
that helps an Administrator pick a technician for a `technical_issue`,
factoring in availability, current workload, distance from the issue,
and (only when there's enough history) relevant performance — ranked,
shown to the Administrator with the reasoning, and never auto-assigned
without their explicit confirmation.

This phase is scoped to exactly that. It does not touch anything from
Phases 1-20 (verified per code review before this round started, per
PHASE20_NOTES.md — see `Round 7`) except two small, additive, backward-
compatible changes described below.

## What was built

- **`app/recommendation.py`** (new) — the scoring engine itself. Pure
  read-only logic: three DB queries, a documented formula, and a
  `get_recommendations(issue)` function returning a ranked list of
  plain dicts. Read the module's own docstring first — it documents
  the full formula, every weight, both fallback behaviors (unknown
  distance, insufficient performance history), the exact queries, and
  why haversine (straight-line) distance was used instead of a
  routing API. This doc restates the highlights below rather than
  duplicating everything.

- **`GET /dispatch/issues/<issue_id>/recommend`** (new route,
  `app/routes/dispatch.py`) — renders the ranked list
  (`app/templates/dispatch/recommend.html`), one card per candidate,
  each with an "Assign Technician" button. `@role_required("administrator")`,
  same as every other dispatch route.

- **`Assignment.dispatch_score` gets populated** — this column already
  existed in `database/schema.sql` since Phase 9/10 but nothing ever
  wrote to it. `AssignTechnicianForm` (app/forms.py) gained one new
  *optional* hidden field, `recommendation_score`; `assign()` and
  `reassign()` (app/routes/dispatch.py) now pass it straight through
  to `Assignment(dispatch_score=...)`. The manual dispatch board and
  issue-detail-page dropdowns don't set this field, so a manually-
  picked assignment's `dispatch_score` is still `NULL`, exactly as
  before this phase — confirmed by `test_manual_assign_still_leaves_dispatch_score_null`.

- **Two entry points** into the new page, both Administrator-only,
  both linking to the same route:
  - Dispatch board (`dispatch/index.html`) — a "Recommend" button per
    open-issue row, next to the existing manual dropdown.
  - Issue detail page (`issues/view.html`) — a "Recommend a
    Technician" button in the Dispatch panel, shown for any open
    issue (`pending`/`assigned`/`in_progress`).

- **`tests/test_recommendation.py`** (new, 15 tests) — see "Test
  cases" below.

## The workflow, mapped to phase_10.pdf's diagram

```
Technical Issue          -> the `issue` argument to get_recommendations()
Find available technicians -> Technician.query, offline rows dropped
Calculate relevant factors -> the four per-candidate scores (below)
Calculate recommendation score -> the weighted total (below)
Rank suitable technicians  -> sorted desc by total_score in get_recommendations()
Show recommendations       -> GET /dispatch/issues/<id>/recommend
Administrator confirms     -> clicking "Assign Technician" on that page
Create assignment          -> the *existing* assign()/reassign() routes
```

The last two steps are deliberately not new code. The recommendation
page's "Assign Technician" button is a plain HTML form POSTing to the
same `assign()`/`reassign()` routes the manual dropdown already uses
— same CSRF protection, same `@role_required`, same tested code path.
Nothing in this phase can create an `assignments` row without that POST
actually happening, and that POST only happens when the Administrator
clicks a real button on a real page they were shown. See
`app/routes/dispatch.py`'s module docstring (the Phase 21 section) for
the full reasoning.

"Choose Another Technician" (the UI spec's second button) isn't a
separate button/route — the recommendation page already lists every
candidate ranked, each with their own "Assign Technician" button, so
picking someone other than the top pick is just clicking a different
card.

## The scoring algorithm

Four factors, each scored 0-100, combined with fixed weights that sum
to 1.0 (so the total is always 0-100):

| Factor | Weight | What it measures |
|---|---|---|
| Availability | 15% | `available`=100, `busy`=40 (`offline` excluded entirely, not scored) |
| Workload | 30% | `max(0, 100 - open_assignments*25)` — 0 open=100 ... 4+ open=0 |
| Distance | 35% | `max(0, 100 - (distance_km/50)*100)` — haversine distance, 50km+=0 |
| Performance | 20% | Neutral 50 until 3+ completed jobs on record; then a 70/30 blend of average-resolution-speed and resolved-issue-volume |

```
total_score = 0.15*availability + 0.30*workload + 0.35*distance + 0.20*performance
```

Distance and workload carry the most weight since they're the most
directly actionable question ("who can get there and take this on
soonest") — availability and performance are secondary tie-breakers.
Weights are plain module-level constants in `app/recommendation.py`,
easy to retune in one place if a future round wants a different
balance.

**Not AI.** Per phase_10.pdf's explicit instruction, nothing in this
feature is described as artificial intelligence anywhere in the code,
UI copy, or these notes — it's arithmetic over four fixed factors, and
every number is shown on the recommendation page itself, not hidden
behind the score.

## How distance is calculated

Great-circle (haversine) distance in kilometers between
`technicians.current_latitude/current_longitude` (the technician's
last known location) and the issue's coordinates — `technical_issues.
latitude/longitude` if the issue report itself has them, else falling
back to the issue's linked NAP's coordinates (`naps.latitude/
longitude`, always present on a NAP row), since an issue is normally
at or very near its subscriber's NAP. Straight-line, not driving
distance — there's no routing/mapping API wired into this app (Leaflet
is only used for display, see Phase 6/20), and straight-line is an
honest, explainable proxy given what data NAP-IQ actually has. If
neither the technician's location nor the issue's/NAP's location is
known, the distance factor falls back to a neutral score (50) and the
recommendation page says "Unknown" rather than silently guessing.

## Database queries

No schema change was needed — `assignments.dispatch_score
(DECIMAL(5,2))` already existed. Three read queries per
`get_recommendations()` call, same "one query, not N+1, group in
Python" pattern `app/routes/dispatch.py:index()` and
`app/routes/reports.py:index()` already use:

1. `Technician.query.all()`, filtered to non-`offline` in Python.
2. One `Assignment.query` for every row with `status IN
   ('assigned','accepted','in_progress')`, grouped by
   `technician_id` — current open workload.
3. One `Assignment.query` for every row with `status = 'completed'`,
   grouped by `technician_id` — completed-job history for the
   performance factor. Average resolution time is computed in Python
   (`completed_at - assigned_at`), same as `reports.py`'s existing
   Technician Workload report does, so this stays portable between
   SQLite (tests) and MySQL without a dialect-specific
   `TIMESTAMPDIFF`/`julianday` expression.

## How Administrator override works

The recommendation page is advisory only — it makes no assignment by
itself. Every candidate's "Assign Technician" button is a real HTML
form (with a CSRF token) that POSTs straight to the pre-existing
`dispatch.assign` / `dispatch.reassign` routes, exactly as if the
Administrator had used the manual dropdown instead. The Administrator
can:
- Assign the top-ranked pick.
- Assign any other listed candidate instead (every candidate is shown,
  not just the top one) — this is "Choose Another Technician".
- Ignore the recommendation page entirely and use the pre-existing
  manual dropdown on the dispatch board or issue page, unchanged.

In every case, the actual database write happens in the same
`assign()`/`reassign()` code that existed before this phase, gated
behind the same role check and CSRF token as always.

## Test cases

`tests/test_recommendation.py`, 13 tests, two groups:

**Pure formula tests (no Flask app, no DB):**
1. `test_haversine_zero_distance_for_identical_points` — same point -> 0km.
2. `test_haversine_known_distance_manila_to_cebu` — sanity-checks the
   formula against a real, independently-known distance (~570km).
3. `test_haversine_symmetric` — distance(A,B) == distance(B,A).
4. `test_weights_sum_to_one` — pins the "total is always 0-100" guarantee.
5. `test_availability_score_available_beats_busy` — 100 vs 40.
6. `test_workload_score_decreases_with_open_assignments` — 100/75/50/0/0
   at 0/1/2/4/50 open assignments; never negative.

**Integration tests (Flask test client + in-memory SQLite, same
approach as the rest of this suite — see `conftest.py`):**
7. `test_offline_technicians_excluded_from_recommendations` — an
   `offline` technician never appears in the results.
8. `test_closer_technician_ranks_first_when_otherwise_equal` — with
   availability/workload/performance held equal, the nearer technician
   outranks one 147km away (past the 50km distance cap).
9. `test_performance_factor_neutral_below_history_threshold` — 2
   completed jobs (below the 3-job minimum) -> neutral score, `performance_known=False`.
10. `test_performance_factor_computed_once_threshold_met` — 3 fast
    (2h avg) completed jobs -> `performance_known=True`, score > neutral.
11. `test_recommend_route_requires_administrator` — `tech1` hitting the
    route gets a 403 (same RBAC pattern as every other admin-only route).
12. `test_recommend_route_lists_candidates_for_administrator` — 200,
    candidate's name present, and explicitly asserts the page never
    describes the feature as "AI"/"Artificial Intelligence".
13. `test_confirming_recommendation_creates_assignment_with_score` —
    posting the recommendation form's exact fields to the existing
    `assign` route creates the `assignments` row with `dispatch_score`
    set to the recommended value and the issue's status moving to
    `assigned`.
14. `test_manual_assign_still_leaves_dispatch_score_null` — the
    pre-existing manual path (no `recommendation_score` in the POST)
    is unchanged: `dispatch_score` stays `NULL`.
15. `test_recommend_excludes_already_assigned_technician` — once an
    issue has an open assignment, that technician is dropped from
    their own issue's recommendation list (mirrors the manual Reassign
    dropdown's existing exclusion).

Could not be run in this sandbox this round — no network access and
`flask_sqlalchemy`/`flask_wtf`/`pymysql`/`pytest` aren't preinstalled
here, so `pip install -r requirements.txt` failed
(`ERROR: No matching distribution found for Flask==3.0.3`, same for
every other dependency). All new/changed Python files were verified
with `python3 -m py_compile` (clean) and the haversine formula's
specific numeric outputs (identical/known/distant-point cases) were
independently hand-checked with a standalone reimplementation before
being written into the test file's assertions — but the actual
`pytest -v` run itself is an outstanding item for a sandbox with
network access or a pre-provisioned venv. See "Not verified this
round" below.

## Not touched this round

No Phase 1-20 code was modified except the two additive,
backward-compatible changes described above
(`AssignTechnicianForm.recommendation_score`, and
`assign()`/`reassign()` now forwarding it into
`Assignment.dispatch_score`) — both leave every existing call path's
behavior identical to before when the new field is absent, which is
exactly what the pre-existing manual dispatch board and issue-detail
forms still send.

## Not verified this round (outstanding)

- **`pytest -v` itself still hasn't been run**, three rounds in a row
  now, every time because the sandbox had zero egress. Round 3 is the
  most precise diagnosis yet: `curl` against domains on this
  environment's own allowlist (`pypi.org`, `archive.ubuntu.com`, etc.)
  returned `x-deny-reason: host_not_allowed`, which means the person's
  **Settings > Capabilities > "Allow network egress" toggle is off**
  for this conversation -- not sandbox randomness, a setting to flip.
  In its place, Round 3 built `dev_verification/` (see its own
  README) and got 10 of the 15 tests to genuinely execute against the
  real `app/recommendation.py`/`app/models.py` code and pass -- a real
  step up from Round 2's read-only trace, but still not `pytest`
  itself, and the 5 route/CSRF-dependent tests remain trace-only. A
  round with egress on should still run `pip install -r
  requirements.txt pytest && pytest -v` for real and treat
  `dev_verification/` as disposable once it does.
- **No visual/CSS check of the new page** (`dispatch/recommend.html`)
  — blocked for the same reason: the real app can't boot without
  Flask-SQLAlchemy/Flask-Limiter installed. `dev_seed_server.py` +
  `dev_screenshot.py` are still in the project root, unchanged, ready
  for a round with egress.
- **No live-MySQL run of this specific feature** — same blocker
  (no egress to install `pymysql` or stand up MySQL this round).
  `dispatch_score` (`DECIMAL(5,2)`) already existed in
  `database/schema.sql` before this phase and needed no migration,
  but an actual round-trip write-then-read of a real recommendation
  score against real MySQL still hasn't been done.
- No `phase_11.pdf` or later spec has been provided yet — nothing
  about a next phase is assumed here.

## Continuation prompt (paste this to resume)

```
Continue developing my NAP-IQ Flask + MySQL system.
Upload: nap_iq_phase21_wip_v3.zip (includes PHASE7-21_NOTES.md
history, TESTING.md, SECURITY_CHECKLIST.md, tests/,
phase20_screenshots/, dev_verification/). Phases 1-20 are
complete/verified by code review. Phase 21 (phase_10.pdf's technician
dispatch recommendation feature) has been built and verified across
three rounds:
  - Round 2 found and fixed one real bug (a stray " AI " substring in
    dispatch/recommend.html's disclaimer text).
  - Round 3 confirmed, precisely, that zero egress across all three
    rounds has been caused by this conversation's Settings >
    Capabilities > "Allow network egress" toggle being off (not
    sandbox randomness) -- check/flip that toggle before starting.
    Round 3 also built dev_verification/ (a shim that loads the REAL
    recommendation/models code without needing Flask-SQLAlchemy
    installed) and got 10 of the 15 tests in
    tests/test_recommendation.py to genuinely execute and pass. See
    PHASE21_NOTES.md's Round 2/Round 3 sections and
    dev_verification/README.md for exactly what is and isn't proven.

Still outstanding, now that egress should hopefully be on:
  - Run the REAL suite for real: `pip install -r requirements.txt
    pytest && pytest -v`, all 15 tests, and fix anything that fails
    (including the 5 route/CSRF tests dev_verification/ couldn't
    reach). Once this passes, delete dev_verification/ -- it was only
    ever a zero-egress stopgap.
  - No screenshot of app/templates/dispatch/recommend.html exists yet
    — extend phase20_screenshots/ the same way PHASE20_NOTES.md's
    Round 6/7 did (dev_seed_server.py + dev_screenshot.py, still in
    the project root).
  - No live-MySQL round-trip of Assignment.dispatch_score being
    written/read for a real recommendation-driven assignment.

Do not rework anything from Phases 1-21 unless testing actually turns
up a bug. Keep the same patterns already in the codebase
(role_required decorators, CSRF-protected POST forms, the
shared-Bootstrap-modal pattern, PHASE<N>_NOTES.md per phase — start a
PHASE22_NOTES.md if this is genuinely a new phase of work).
```
