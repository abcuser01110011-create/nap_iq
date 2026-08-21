# PHASE 7 — 95% — Error Handling, Edge Cases, and RBAC Hardening

**Status:** Phase 7 of the Installation Planning integration (follows
`PLAN_INSTALL_85_PERCENT_NOTES.md`'s success-state/map-refresh phase).
Per `INSTALLATION_PLANNING_PHASES.md`, this phase does not add any new
user-facing capability — it works through the plan's own edge-case
checklist, item by item, testing and fixing what needs it.

Most of the checklist turned out, on inspection, to already be handled
correctly by Phases 3–6. **One real, concrete bug** was found and
fixed: a slow `POST /subscribers/quick-add` response could resolve
*after* the admin had already moved on (dropped a new pin, cancelled,
or exited planning mode), and would then corrupt whatever the admin
was currently looking at. Everything else below was traced against the
existing code and confirmed already correct, with new automated tests
added to lock in the RBAC and validation behavior specifically, since
those had no dedicated coverage yet.

---

## 1. The bug found and fixed

### Symptom
`submitSubscriberForm()`'s success handler always called
`finishAfterCreate(subscriber, nap)`, unconditionally, on whatever
`POST /subscribers/quick-add` returned — with no check for whether the
pin/card/mode it was about to manipulate were still the ones the
create request had actually been submitted for.

Concretely, this went wrong if, between clicking "Create & link to
`<NAP>`" and the server responding, the admin did any of:
- **dropped a new pin** (still in planning mode) — `finishAfterCreate()`
  would then call `map.removeLayer(proposedMarker)` where
  `proposedMarker` is now the *new* pin (the same `L.Marker` instance
  is reused/moved, not recreated — see `placeProposedMarker()`), tearing
  the admin's new pin off the map. It would also reset planning mode's
  chrome and overwrite the new suggestion/form step already on screen
  with the *old* request's "done" step — silently discarding whatever
  the admin was in the middle of doing with the new pin.
- **cancelled / exited planning mode** — `finishAfterCreate()` would
  call `renderInstallPlannerCard()` (inside `renderDoneStep()`), which
  un-hides `#installPlannerCard` — resurrecting the Installation
  Planner card and its "done" confirmation *after* the admin had
  already dismissed it and switched back to the Navigation Card.

Both are real, demonstrable state-corruption bugs — exactly the kind
of thing this phase's "rapid repeated pin drops" and "interaction with
the existing navigation feature" checklist items ask to be tested for.
Note that the underlying `Subscriber` row is created successfully in
either case — this was a **UI-state** bug, not a data-integrity one;
the risk was a confusing/incorrect screen, not a lost or corrupted
database row.

### Fix
`app/static/js/nap-install-planner.js`'s `submitSubscriberForm()` now
captures `requestSeq` (the same counter Phase 4 already introduced for
the suggestion-fetch stale-response guard, and the same counter
`clearProposedMarker()`/`fetchSuggestion()` already bump on every pin
move, clear, or mode exit) at the moment the POST is sent
(`submitSeq`), and re-checks it once the response arrives:

- **Stale success** (the pin/session moved on, but the row really was
  created): `window.NapIQMapModes.addSubscriberMarker(subscriber)` is
  still called unconditionally — the real database row must always
  end up on the map — but `finishAfterCreate()`'s pin-removal,
  chrome-reset, and "done"-step rendering are all skipped, since none
  of those belong to whatever the admin has since moved on to.
- **Stale failure** (validation error, NAP-capacity-gone, network
  error): nothing on screen is touched at all — the card/button ids
  `showFormErrors()`/`restoreCreateButton()` would write to may by now
  belong to a completely different pin's suggestion or form. The
  failure is only logged (`console.warn`/`console.error`) for
  diagnostics.
- **Not stale** (the ordinary case — nothing changed while the request
  was in flight): behavior is exactly what Phases 5–6 already shipped,
  unchanged.

This is the same `requestSeq !== seq` idiom `app/static/js/nav-routing.js`
already uses for its own stale-response guarding (see that file's
`requestRoute()`) — no new pattern was invented, and no `AbortController`
was introduced, since the existing codebase's own established
discipline for this exact problem is a sequence counter, not aborting
the underlying `fetch()`.

**File changed:** `app/static/js/nap-install-planner.js` (additive:
one new local variable, staleness checks added to the existing
`.then()`/`.catch()` handlers; no function signatures changed, no
other file touched).

---

## 2. Checklist items traced and confirmed already correct (no change needed)

| Checklist item | Trace | Verdict |
|---|---|---|
| Dropping a pin where no NAP has capacity | `fetchSuggestion()` renders `renderNoNapAvailable()` on the API's own `no_nap_available` status (Phase 4); already covered server-side by `test_installation_planning_25pct.py::test_no_nap_available_is_a_clean_200_not_an_error`. No fabricated fallback NAP is ever shown. | OK, no change |
| Cancelling at the **suggestion** step | `exitPlanningMode()` (Cancel banner button or toggling the mode button off) calls `resetPlanningModeChrome()` + `clearProposedMarker()` (which also hides the card and bumps `requestSeq`, invalidating any in-flight suggestion fetch via the existing `mySeq !== requestSeq \|\| !planningActive \|\| !proposedLatLng` check) + `showNavigationCard()`. | OK, no change |
| Cancelling at the **form** step | Same `exitPlanningMode()` path — the form step is just whatever's currently rendered inside `#installPlannerCard`, which `clearProposedMarker()`'s `hideInstallPlannerCard()` empties and hides regardless of which step was showing. No dangling form-only state exists outside that card. | OK, no change |
| Cancelling **before submit** (form filled in, Create not yet clicked) | No request is in flight yet at this point, so there's nothing to race — `exitPlanningMode()`'s reset above applies identically. | OK, no change |
| Submitting the form with invalid/missing data | `MapQuickInstallSubscriberForm` (already `DataRequired`/`Length`/`NumberRange`-validated per field since Phase 5) rejects with a real `{field: [messages]}` body (400), which `showFormErrors()` renders and `restoreCreateButton()` re-enables the button for. **New this phase:** `tests/test_installation_planning_95pct.py` adds explicit coverage (missing name/code/latitude/nap_id, out-of-range latitude, an over-length name) that didn't exist as automated tests before. | OK, now test-covered |
| Rapid repeated pin drops (suggestion lookup) | `fetchSuggestion()`'s own `mySeq !== requestSeq` guard (Phase 4) already discards a stale suggestion response rather than rendering it over a newer one. | OK, no change |
| Rapid repeated pin drops / cancel (create request) | **This was the real bug — see §1.** Now fixed via the same `requestSeq` counter, extended to `submitSubscriberForm()`. | **Fixed this phase** |
| A non-administrator hitting the create endpoint directly | `POST /subscribers/quick-add` is `@role_required("administrator")` (unchanged since Phase 5) — an unauthenticated request is redirected to `/login` (302); an authenticated Technician, Customer, or Payment Collector gets a 403 from `role_required()` itself, not a redirect loop or a silently-rendered form. This was already true from Phase 5, but had **no automated test** before this phase. **New this phase:** `tests/test_installation_planning_95pct.py` adds `test_requires_login`, `test_technician_forbidden`, `test_customer_forbidden`, `test_payment_collector_forbidden`, each asserting both the response code and that `Subscriber.query.count() == 0` afterward (nothing was created despite the attempt). | OK, now test-covered |
| Closing/reopening planning mode repeatedly | `setup()` (bottom of `nap-install-planner.js`) runs exactly once, on `DOMContentLoaded` — every event listener it attaches (`planInstallModeBtn` click, `planInstallModeCancelBtn` click, the map's `click` handler) is bound exactly once for the page's lifetime, not re-bound on every `enterPlanningMode()`/`exitPlanningMode()` call. `placeProposedMarker()` reuses the same `L.Marker` instance via `setLatLng()` when one already exists rather than creating a new one each click, so no duplicate pins accumulate. `enterPlanningMode()`/`exitPlanningMode()` are both idempotent (`if (planningActive) return;` / the `!planningActive` early-return branch), so double-toggling can't leave the button/banner/cursor in an inconsistent state. Traced with no bug found. | OK, no change |
| Interaction with the navigation feature | Confirmed **bidirectionally wired** since Phase 3: `enterPlanningMode()` calls both `NapIQMapModes.exitPlacementModes()` and `NapIQNavOriginPicker.stopPicking()` before activating; `NapIQMapModes.exitPlacementModes()` (napmap.js) and `NapIQNavOriginPicker.startPicking()`/`nav-gps-origin.js`'s "Use My Location" (which also call `exitPlacementModes()`) all in turn call `window.NapIQInstallPlanner.exitPlanningMode()`. `nav-card.js` itself never touches `#navigationCard`'s own `d-none` class, so there is no separate code path fighting over that container's visibility besides `nap-install-planner.js`'s own `hideNavigationCard()`/`showNavigationCard()`. The one place this chain could still be undermined — a stale create response re-showing the Installation Planner card after the admin had switched back to the Navigation Card — is exactly **the bug fixed in §1.** | OK (bug was here — now fixed) |

---

## 3. New automated tests added this phase

`tests/test_installation_planning_95pct.py` (new file) — 16 tests
against the real Flask app + in-memory SQLite (same
`app.test_client()` style every other file in `tests/` already uses,
via the shared `tests/conftest.py` fixtures):

- **RBAC** (4 tests): unauthenticated → 302; Technician, Customer,
  Payment Collector → 403. Each also asserts zero rows were created.
- **Invalid/missing data** (6 tests): missing full name, missing
  subscriber code, missing latitude, missing `nap_id`, out-of-range
  latitude, an over-length full name — each asserts a 400 with the
  specific field named in `errors`, and zero rows created.
- **NAP validity re-check at submit time** (3 tests): a NAP with zero
  `available_ports` (409), a NAP whose `status` isn't `active` (409),
  a `nap_id` that doesn't exist at all (400) — mirroring the route's
  own re-validation-not-trust-the-client documented behavior.
- **Duplicate subscriber code** (1 test): rejected exactly like
  `SubscriberForm`'s own uniqueness check, existing row left untouched.
- **Successful create** (1 test): a real row is created, linked to the
  correct NAP, at the exact submitted coordinates — and, matching
  `add_subscriber()`'s own documented behavior exactly, the NAP's own
  `available_ports`/`used_ports` are left untouched by this route (this
  route does not do capacity bookkeeping, same as the existing
  Subscribers → Add Subscriber flow and Phase 22's `assign_nap()`).
- **Regression check** (1 test): `POST /subscribers/add`
  (`add_subscriber()`, completely unmodified since before this
  integration began) still creates a subscriber normally — confirming
  this phase (and the four before it) introduced no regression to the
  pre-existing subscriber-creation flow.

`GET /api/naps/nearest-available`'s own RBAC and parameter-validation
tests already exist in `tests/test_installation_planning_25pct.py`
(Phase 2) and are not duplicated here.

---

## 4. Verification performed

### Automated (syntax only — see the environment limitation below)
```
$ node --check app/static/js/nap-install-planner.js
(no output — passes)

$ node --check app/static/js/napmap.js
(no output — passes)

$ python3 -m py_compile $(find app -name "*.py") $(find tests -name "*.py") run.py dev_seed_server.py
(no output — passes, including the new test file)
```

### Known limitation — the automated test suite still could not be
### executed, and no live/browser pass was possible, in this sandbox

This is the same hard limitation documented in
`PLAN_INSTALL_85_PERCENT_NOTES.md` §5, unchanged in this environment:
`pip install -r requirements.txt` still fails with "Could not find a
version that satisfies the requirement Flask==3.0.3 (from versions:
none)" for every dependency (`Flask-SQLAlchemy`, `Flask-WTF`,
`Flask-Limiter`, `PyMySQL`, `pytest`, etc.) — there is no outbound
network access in this sandbox, and none of these packages are
pre-installed. As a direct, verified consequence:
```
$ python3 -c "from app import create_app"
ModuleNotFoundError: No module named 'flask_wtf'
```
`app/__init__.py` itself cannot be imported, which means:
- **`pytest -q` could not be run** — not for the new
  `test_installation_planning_95pct.py` file, and not for the existing
  suite (previously reported as 130 passed / 3 pre-existing, unrelated
  failures as of `PLAN_INSTALL_70_PERCENT_NOTES.md`), so no automated
  confirmation of "no new regressions" was possible this phase either.
- **No `app.test_client()` pass** and **no real browser/Playwright
  pass** were possible for the same reason — Playwright itself is
  importable in this sandbox, but it drives a *running* server, and no
  part of this Flask application can be started here.
- **No screenshot could be captured this phase.** Every prior phase's
  screenshot (`phase22_screenshots/`, etc.) was produced by
  `dev_screenshot.py` against a live `127.0.0.1` Flask server; that
  path is unavailable here for the same reason `test_client()` is.
  Rather than fabricate one, none is included this phase — this is a
  real, honestly-reported gap, not an oversight.

**What was done instead**, matching the same substitute-verification
approach Phase 6 used:
- Both syntax checks above (JS and the full Python tree, new test file
  included).
- A manual, line-by-line trace of §2's checklist against the actual
  existing code (function bodies, not just comments) to confirm each
  item's claimed behavior is real.
- A code-level trace of the new staleness guard's three branches
  (stale-success, stale-failure, not-stale) against
  `finishAfterCreate()`, `addSubscriberMarker()`, `showFormErrors()`,
  and `restoreCreateButton()`'s actual current implementations, to
  confirm the guard calls only functions that exist with the
  signatures assumed.
- A manual review of every new test in
  `tests/test_installation_planning_95pct.py` against
  `MapQuickInstallSubscriberForm`'s actual validators
  (`app/forms.py`), `quick_add_subscriber()`'s actual response shapes
  (`app/routes/subscribers.py`), and `SubscriberForm`'s actual fields —
  confirming each assertion matches what the real code does, field by
  field, rather than what was assumed.
- Confirming (via `find . -newer PLAN_INSTALL_85_PERCENT_NOTES.md
  -type f`) that only the intended files were touched this phase.

**This is a real, outstanding gap**, same as last phase: if a
network-enabled environment (or one with dependencies pre-installed)
becomes available, `pytest -q` should be run to confirm the 16 new
tests in this file actually pass as traced, that the existing suite
still shows no new regressions, and a `dev_screenshot.py`-style pass
(or a manual browser session) should exercise the specific scenario
this phase's fix addresses: drop a pin, click Create, then — before
the response returns — drop a second pin or click Cancel, and confirm
the second pin/the Navigation Card survive untouched while the first
subscriber still appears on the map once its create resolves.

---

## 5. Acceptance criteria check

- [x] Non-administrators cannot create a subscriber through this
      feature by any route, including direct requests to the
      underlying endpoint — confirmed by existing `role_required`
      enforcement (unchanged) plus this phase's new
      `test_requires_login`/`test_technician_forbidden`/
      `test_customer_forbidden`/`test_payment_collector_forbidden`.
      *(Tests written and manually traced against the real
      route/decorator; not yet executed — see §4's environment
      limitation.)*
- [x] No known critical defects — the one found (stale create
      response corrupting pin/chrome/card state) is fixed this phase;
      no other defect was found across the full checklist trace in §2.
- [x] No regression to any existing feature, including navigation
      (Phases 1–20) and the existing ServiceRequest-based NAP
      recommendation flow — no file belonging to either was touched
      this phase; the one code change is scoped entirely inside
      `submitSubscriberForm()`'s response handlers, which only this
      feature calls. `test_regular_add_subscriber_route_still_works`
      additionally locks in that the pre-existing Subscribers → Add
      Subscriber flow specifically is unaffected.
- [x] Test results are reported honestly, including environment
      limitations — see §4. Every claim above is marked as either
      "confirmed by code trace" or "execution not possible in this
      sandbox"; nothing is reported as passed that wasn't actually run.

---

## 6. Files changed this phase (confirmed diff scope)

- `app/static/js/nap-install-planner.js` (the stale-create-response
  guard: one new local variable in `submitSubscriberForm()`, staleness
  branches added to its existing `.then()`/`.catch()` handlers, header
  doc-comment updated with a new Phase 7 section)
- `tests/test_installation_planning_95pct.py` (new file — 16 tests)
- `PLAN_INSTALL_95_PERCENT_NOTES.md` (new file, this one)

No model, form, route, template, database schema/migration, or other
JavaScript file was touched this phase. `app/routes/subscribers.py`,
`app/forms.py`, and `app/static/js/napmap.js` are all unmodified since
Phase 6 — the checklist trace in §2 confirmed their existing behavior
was already correct rather than requiring changes.

---

**STOP.** This is the end of Phase 7 (95%). Phase 8 (final integration
+ cleanup) is intentionally not started.
