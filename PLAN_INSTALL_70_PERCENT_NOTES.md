# PHASE 5 — 70% — Installation Planner Panel: Subscriber Creation Step

**Status:** Phase 5 of the Installation Planning integration (follows
`PLAN_INSTALL_55_PERCENT_NOTES.md`'s suggestion panel). This phase
translates the prototype's `InstallationPlanner` "form" step and its
`create()` function into a real, database-backed subscriber-creation
flow: the previously-inert "Use this NAP & add subscriber" button now
opens a short form, and submitting it creates one real `Subscriber`
row, linked to the suggested NAP, at the dropped pin's coordinates.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `app/forms.py` | **Additive.** New `MapQuickInstallSubscriberForm` — a lightweight sibling of `SubscriberForm`, the same relationship `MapQuickAddNapForm` already has to `NapForm`. |
| `app/routes/subscribers.py` | **Additive.** New `POST /subscribers/quick-add` route (`quick_add_subscriber()`), admin-only, JSON in/out — mirrors `naps.quick_add_nap()`'s shape exactly. `add_subscriber()`/`edit_subscriber()`/`list_subscribers()`/`view_subscriber()` are all untouched. |
| `app/routes/naps.py` | **Additive.** `geomap()` now also computes and passes `subscriber_plan_types` (distinct existing `Subscriber.plan_type` values) to the template, for the new plan-type input's suggestions. |
| `app/templates/naps/map.html` | **Additive.** One new `<datalist id="installPlannerPlanTypes">`, admin-gated, next to `#installPlannerCard`. |
| `app/static/js/nap-install-planner.js` | **Additive.** The suggestion card's "Use this NAP & add subscriber" button is now wired up (was inert since Phase 4); new functions render the form step and POST it to the new endpoint. |
| `PLAN_INSTALL_70_PERCENT_NOTES.md` | **New.** This file. |

No database schema change. No existing route's behavior changed.

---

## 2. What it does

1. Clicking "Use this NAP & add subscriber" on the suggestion card
   (Phase 4) replaces the panel's content with a short form:
   **Subscriber code**, **Subscriber name**, **Barangay / address**,
   **Plan type** — exactly the fields the plan's Phase 5 section asks
   for. No `contact_number`/`email` field, matching that section's
   field list and the prototype's own form step (see
   `MapQuickInstallSubscriberForm`'s docstring for why those two
   columns are simply left `NULL` rather than filled with a fabricated
   placeholder the way the prototype's demo data does).
2. Plan type is a free-text input with `<input list="...">`
   suggestions pulled from the real, existing distinct
   `Subscriber.plan_type` values already in the database (no
   `PLAN_FEES`-style hard-coded list) — any value can still be typed.
   Barangay/address reuses the same free-text field the rest of the
   app already uses (no `BARANGAYS`-style hard-coded list either).
3. Clicking "Create & link to `<NAP code>`" POSTs to
   `POST /subscribers/quick-add` with the form fields, the dropped
   pin's latitude/longitude, and the suggested NAP's id — CSRF-
   protected with the same `X-CSRFToken` header pattern
   `napmap.js`'s `quickAddForm` already uses for `/naps/quick-add`.
4. The server (`quick_add_subscriber()`) re-validates everything —
   required fields, subscriber-code uniqueness (identical check to
   `SubscriberForm.validate_subscriber_code`), and, separately, that
   the target NAP still exists and still has active/available
   capacity (it could have changed between the suggestion being shown
   and the form being submitted) — before creating anything.
5. On success, a real `Subscriber` row is created: `subscriber_code`,
   `full_name`, `address`, `latitude`, `longitude`, `plan_type` from
   the form; `nap_id` from the suggested NAP; `status='active'`. The
   panel then shows a plain confirmation line with the new
   subscriber's code.
6. On any validation error, NAP-capacity conflict, or network failure,
   the real error message(s) are shown inline and the Create button
   is re-enabled so the admin can fix the field and retry.

---

## 3. Deliberately not done this phase (next phase's job)

Per `INSTALLATION_PLANNING_PHASES.md`, Phase 6 ("Success state + map
refresh") owns:
- The prototype's polished "done" step (code-chip styling, a "Done"
  button).
- Adding the new subscriber's marker to the map without a reload.
- Clearing the dropped pin and exiting planning mode after a
  successful create.

This phase's success state is intentionally just a plain confirmation
line — proving the real database write happened — and leaves the pin,
planning mode, and map markers exactly as they were, for Phase 6 to
finish. Nothing here anticipates that phase's UI.

Phase 7 ("Error handling, edge cases, and RBAC hardening") still owns:
full stale-request/abort discipline, guarding against rapid repeated
pin drops while the create form is open, and automated tests for this
new endpoint's RBAC boundary and create flow. This phase's server-side
NAP re-validation (§2 step 4) is a correctness necessity for a real
create endpoint, not a substitute for that later hardening pass.

---

## 4. Architecture notes / decisions made this phase

- **`subscriber_code` stays manually typed, not auto-generated.** The
  target has no code-generation scheme anywhere to reuse (documented
  since `PLAN_INSTALL_10_PERCENT_NOTES.md` §3) — `add_subscriber()`'s
  own form requires the admin to type a code and only checks
  uniqueness. Inventing a generation scheme here (e.g. the
  prototype's `${napCode}-${letter}`) would be a *second* scheme the
  rest of the app doesn't have, which the plan explicitly rules out.
  `MapQuickInstallSubscriberForm` reuses the exact same
  required-and-unique rule instead.
- **No NAP port bookkeeping is touched on create.** Checked first:
  neither the existing `add_subscriber()` route nor Phase 22's
  `assign_nap()` adjusts `nap.used_ports`/`available_ports` when
  linking a subscriber/request to a NAP — that bookkeeping is
  maintained elsewhere in the app (the NAP edit form), not
  automatically derived from subscriber counts. This route matches
  that existing behavior rather than introducing new, divergent
  bookkeeping logic unprompted.
- **New route lives in `subscribers_bp`, not `naps_bp`.** It creates a
  `Subscriber` row, so it's grouped with the rest of subscriber CRUD,
  the same way `quick_add_nap()` (creates a `Nap`) lives in `naps_bp`
  alongside NAP CRUD.

---

## 5. Verification performed

### Automated
```
$ node --check app/static/js/nap-install-planner.js
(no output — passes)

$ python3 -m py_compile $(find app -name "*.py") run.py dev_seed_server.py
(no output — whole app compiles cleanly)

$ python3 -c "... app.jinja_env.get_template('naps/map.html') ..."
map.html parses OK
```

Full existing test suite (regression check):
```
$ pytest -q
3 failed, 130 passed
  FAILED tests/test_reports_phase23.py::test_new_issue_reported_notification_staff_route
  FAILED tests/test_reports_phase23.py::test_new_issue_reported_notification_customer_route
  FAILED tests/test_technician_workflow.py::test_reports_page_shows_technician_workload
```
Same 3 pre-existing failures already documented since
`PLAN_INSTALL_25_PERCENT_NOTES.md` §5 (Reports/notifications module,
untouched by this or any Installation Planning phase) — no new
failures introduced. This phase added no new automated tests of its
own (full RBAC/flow test coverage for this feature is Phase 7's
scope, per the plan), but was manually exercised end-to-end below
against a real, seeded, in-process instance of the actual app (not a
mock) via Flask's test client, real HTTP requests, real session
cookies, and real CSRF tokens read out of the actual rendered pages.

### Manual, against a real seeded instance (real SQLite DB, real
`app.test_client()` HTTP requests, real `admin1`/`tech1` accounts,
real CSRF tokens read from the actual rendered `<meta name="csrf-
token">` tag on each page — not hand-crafted):

```
GET /naps/map as admin1 -> 200
  #installPlannerCard present: True
  #installPlannerPlanTypes datalist present: True
  Datalist contains a real seeded plan_type value ("Home 25 Mbps"): True

POST /subscribers/quick-add as admin1, blank required fields
  -> 400 {"status": "error", "errors": {
       "full_name": ["Subscriber name is required."],
       "subscriber_code": ["Subscriber code is required."]}}

POST /subscribers/quick-add as admin1, valid data, real seeded NAP
  -> 201 {"status": "success",
          "message": "Subscriber 'SUB-1001' was created and linked to NAP-0100.",
          "subscriber": {"id": 2, "subscriber_code": "SUB-1001",
                          "nap_id": 1, "nap_code": "NAP-0100",
                          "latitude": 14.2811, "longitude": 121.4149, ...}}
  Confirmed directly against the database afterward:
    row exists: True, nap_id matches: True,
    latitude/longitude match the values submitted exactly.

POST /subscribers/quick-add as admin1, subscriber_code re-used
  -> 400 {"status": "error",
          "errors": {"subscriber_code": ["This subscriber code is already in use. Choose a different one."]}}

NAP's available_ports set to 0 / status set to "full" directly in the
DB, then the same NAP re-submitted:
POST /subscribers/quick-add as admin1
  -> 409 {"status": "error",
          "errors": {"nap_id": ["This NAP no longer has available capacity. Drop the pin again to get an updated suggestion."]}}
  (NAP status/ports restored afterward before continuing)

POST /subscribers/quick-add with no CSRF token at all -> 400 (rejected
  by the app's global CSRFProtect, same as every other POST route)

GET /naps/map as tech1 -> 200
  #installPlannerCard / #planInstallModeBtn present: False
  (Jinja-gated out entirely, same as every other Phase 3/4 admin-only
  control on this page)

POST /subscribers/quick-add as tech1 (a real, valid, freshly-
CSRF-tokenned request — not just an unauthenticated one)
  -> 403
  Confirmed directly against the database: no "Sneaky"/SUB-3000 row
  was created. Non-administrators cannot reach this endpoint by
  posting to it directly, not just by the button being hidden.
```

### Known limitation — no browser screenshot this phase

Same environment limitation flagged in
`PLAN_INSTALL_40_PERCENT_NOTES.md` §5 and
`PLAN_INSTALL_55_PERCENT_NOTES.md` §5: no Chromium/browser binary is
available in this environment (`cdn.playwright.dev` is outside the
network allowlist), so this phase's actual rendered form (spacing,
the plan-type datalist dropdown, the loading-spinner button state)
has been verified by code inspection and by driving the real
Flask/JSON layer underneath it end-to-end (§5 above) — not by
visually inspecting it in a real browser.

---

## 6. Acceptance criteria check

- [x] Submitting the form creates one real Subscriber row in the
      database, linked to the correct NAP, at the correct
      coordinates — confirmed against the actual DB row in §5.
- [x] CSRF protection is enforced, same as every other form in the
      app — confirmed: a request with no CSRF token is rejected (400)
      by the same global `CSRFProtect` every other POST route uses.
- [x] No duplicate/second subscriber-creation code path is created
      where the existing one already does the same validation —
      `MapQuickInstallSubscriberForm` mirrors `SubscriberForm`'s
      relevant fields/validators (the same relationship
      `MapQuickAddNapForm` has to `NapForm`, an already-established
      pattern in this codebase), and the route's `Subscriber(...)`
      construction matches `add_subscriber()`'s field-by-field shape.
- [x] Existing subscriber creation elsewhere in the app (e.g. from
      Subscribers → Add Subscriber) is completely unaffected —
      `add_subscriber()`/`edit_subscriber()` were not modified at
      all this phase; full regression suite still shows the same 3
      pre-existing, unrelated failures and nothing new.
- [ ] **Visual/browser confirmation still outstanding** — see §5's
      environment-limitation note (same as Phases 3 and 4).

---

## 7. Files changed this phase (confirmed diff scope)

- `app/forms.py` (additive: one new form class)
- `app/routes/subscribers.py` (additive: one new route + two import lines)
- `app/routes/naps.py` (additive: one new query + one new template arg)
- `app/templates/naps/map.html` (additive: one new `<datalist>`)
- `app/static/js/nap-install-planner.js` (additive: new functions + wiring the previously-inert button)
- `PLAN_INSTALL_70_PERCENT_NOTES.md` (new file, this one)

No model, no database schema/migration, and no other template or
route file was touched this phase.

---

**STOP.** This is the end of Phase 5 (70%). Phase 6 (the "done" step,
map marker refresh, and clearing/exiting planning mode) is
intentionally not started.
