# NAP-IQ — Phase 23 Notes (phase_12.pdf: Reports, Notifications, final UI/UX)

## Scope

phase_12.pdf, in full: seven operational reports (each independently
filterable), five notification events (three pre-existing, two new
this phase — "New issue reported" and "Payment requiring
confirmation"), and a final UI/UX consistency pass across the whole
app. This phase needed no database schema changes (no new columns) —
see `app/routes/reports.py`'s own docstring for why the seven reports
are organized as tabs on one page rather than seven separate routes.

This file covers three sessions' worth of work on this phase, since
the reports template and the test/notes/packaging work were split
across sessions by an unusually persistent sandbox restriction (see
below). Where something was done in an earlier session and not
touched since, that's noted explicitly rather than re-claimed as this
session's work.

## Egress and test-run status — three sessions running

Network egress has been off in **all three** sessions that touched
this phase, confirmed each time via a live check rather than assumed:
`curl -I https://pypi.org` and `pip install Flask-SQLAlchemy` both
returned `403 host_not_allowed` this session, and `pip install -r
requirements.txt` failed outright (`Could not find a version that
satisfies the requirement Flask==3.0.3 — no matching distribution`).
Only bare Flask 3.1.3 + Jinja2 3.1.6 + python-dotenv are
pre-installed — no Flask-SQLAlchemy, Flask-WTF, Flask-Limiter,
PyMySQL, or pytest, and no raw `sqlalchemy` either. This means the
real app has never been importable, `pytest -v` has never been
runnable, and none of this phase's new code has executed against a
real database in any of the three sessions. **This is the single
biggest gap in this phase's verification** — everything below reports
exactly which fallback level was reached instead, per the project
convention of never claiming a pass/fail count that wasn't actually
observed.

Verification actually performed, across all three sessions:

- **`python3 -m py_compile`** — clean on every changed/new `.py` file
  every session: `app/routes/reports.py`,
  `tests/test_reports_phase23.py`, plus every file read while
  cross-checking notification/payment/issue logic (`app/models.py`,
  `app/forms.py`, `app/notifications_utils.py`,
  `app/routes/issues.py`, `app/routes/customer.py`,
  `app/routes/payments.py`, `app/routes/collector.py`,
  `tests/conftest.py`).
- **`node --check`** — clean on `app/static/js/napmap.js` (both the
  session that added the loading-indicator fix and this session's
  re-check).
- **Bare-Jinja2 parse** (`jinja2.Environment(...).parse()`) of
  `app/templates/reports/index.html` — clean (session 2 and
  re-confirmed session 3).
- **Mocked-context `render_template()` call** — a standalone Flask
  app was built (not `create_app()` — that needs Flask-SQLAlchemy/
  Flask-WTF, unavailable) registering dummy routes for every real
  endpoint the template calls, with the exact URL converters and
  parameter names the real blueprints use (verified by grepping each
  route file for a matching `def`), plus plain-object stand-ins for
  ORM rows matching `app/models.py`'s actual columns. All 7 report
  tabs rendered cleanly against it — no `UndefinedError`, no missing
  `url_for` endpoint, no attribute error — both when this was first
  built (session 2) and re-run from scratch this session to confirm
  nothing regressed. **This is still short of a real render**: it
  never executes `app/routes/reports.py`'s own query-building
  functions, never round-trips a real query string through
  `request.args`, and never exercises Flask-WTF/CSRF at all.
- **Manual/static trace of `tests/test_reports_phase23.py` against
  the real route, form, and model code** (this session, in place of
  actually running it — see "Bugs found this session" below). This
  is not a substitute for execution and is called out as such in the
  testing checklist below.
- **Not done in any of the three sessions**: an actual `pytest -v`
  run, a live-database round-trip (SQLite or MySQL), a real browser
  render, or a real `create_app()` import. If a future session has
  working egress, `pip install -r requirements.txt` and `pytest -v`
  should be the very first thing run — this has now been blocked for
  three sessions in a row and is the one piece of real evidence this
  phase is still missing.

## Bugs found this session (via static trace, not execution)

`tests/test_reports_phase23.py` was written in session 2 and marked
explicitly unverified. This session, in lieu of being able to run it,
each test was manually traced line-by-line against the real route/
form/model code it exercises (the same rigor as the mocked-render
check, applied to the test file instead of the template). Two real
bugs were found and fixed as a result — both would have failed the
first time the suite actually ran:

1. **Invalid `issue_type` form values.** Two tests posted
   `"issue_type": "no_signal"` and `"issue_type": "slow_speed"` to
   `/issues/report` and `/customer/report-issue`. The real
   `ISSUE_TYPE_CHOICES` in `app/forms.py` are
   `"No Internet"` / `"Slow Internet"` / `"Fiber/Cable Problem"` /
   `"NAP Problem"` / `"Connection Problem"` / `"Other"` — neither
   submitted value is a valid `SelectField` choice, so
   `form.validate_on_submit()` would have returned `False`, no issue
   would have been created, and both notification-count assertions
   would have failed. Fixed by using the real choice strings.
2. **Capitalization mismatch in a rendered-text assertion.** The
   Service Request Report's type column wraps
   `{{ r.request_type|replace('_', ' ') }}` in a `text-capitalize`
   **CSS** class — visual only, doesn't change the response bytes.
   Unlike the Issues and Payments tables, which apply Jinja's
   `|capitalize` filter server-side, this cell's raw rendered text
   stays lowercase (`"new installation"`, `"upgrade"`). The filter
   test asserted the capitalized form (`b"New installation"`,
   `b"Upgrade"`), which would never match. Fixed to assert on the
   actual lowercase rendered text.

No other issues were found in the trace — form field names, route
paths, `RecordPaymentForm`/`IssueReportForm`/`CustomerIssueReportForm`
choices, `Notification` category/audience values, and the
status-transition logic in `payments.edit_payment()` all matched the
real code as written.

## What was built

- **`app/routes/reports.py`** (session 1, unchanged since) — all 7
  phase_12.pdf reports (Technical Issue, NAP Inventory, NAP Port
  Availability, Subscriber, Service Request, Payment, Technician
  Workload), each independently filterable via its own namespaced
  query params (`iss_*`, `inv_*`, `port_*`, `sub_*`, `sr_*`, `pay_*`,
  `wl_*`). Preserves 100% of the original 3 reports' behavior.
- **`app/templates/reports/index.html`** (session 1, unchanged since)
  — Bootstrap `nav-tabs` page, plain GET links to `?report=<key>`
  (deliberately not JS tab-pane toggling — only the active tab's data
  is queried per request), one panel per report matching exactly what
  its `_build_*_report()` context provides.
- **`app/notifications_utils.py`** (pre-existing, unchanged this
  phase) — `notify_new_issue_reported()` and
  `notify_payment_pending_confirmation()`, both administrator-facing
  only, called from `issues.report_issue()`, `customer.report_issue()`,
  `payments.add_payment()`/`edit_payment()`, and
  `collector.record_payment()`.
- **`app/static/js/napmap.js`** (session 2) — added a loading
  indicator to `focusNapRecommendationFromQueryParam()` using the
  page's existing `mapAlertArea`/`showAlert()` pattern (a dismissible
  "Loading NAP recommendation…" alert, closed in a `finally` block).
  `handleReportIssueSubmit`'s spinner was confirmed already present
  and left untouched.
- **`tests/test_reports_phase23.py`** (session 2, bugfixed session 3)
  — 200/403 coverage for all 4 new reports, one narrowing-filter test
  per new report, the unknown-`report=` fallback to `issues`, and the
  5 notification tests phase_12.pdf's event list requires (new-issue
  staff route, new-issue customer route, payment-pending on create by
  collector, payment-pending on create by administrator,
  payment-pending only fires on the transition into 'pending', not on
  edits that leave it there).

## Database query notes

No schema changes this phase. Every report query goes through
existing SQLAlchemy relationships/columns; the only new query shapes
are the four new reports' own filters (see `reports.py`'s docstring
for the per-report field mapping, e.g. Payment's "Type" filter maps
to `payment_method` since this schema has no separate payment "type"
column).

## UI/UX checklist (phase_12.pdf's third section)

- [x] Sidebar — single "Reports" link stays meaningful with 7 reports
      as tabs rather than 7 new nav entries (spot-checked prior
      session, re-confirmed by inspection this session).
- [x] Buttons, colors — reuses existing `text-bg-*` badge-color
      mappings from `payments/list.html`, `subscribers/list.html`,
      `service_requests/list.html`, `naps/list.html` rather than
      introducing new ones.
- [x] Empty states — standard `text-center text-muted py-4` +
      `bi-* display-6` pattern on every report tab.
- [x] Tables — `table-hover align-middle`, consistent header/badge
      conventions with the rest of the app.
- [x] Typography/spacing/forms/modals/responsive design — spot-checked
      consistent in an earlier session; nothing new introduced this
      phase that would regress it.
- [x] Loading states — `handleReportIssueSubmit`'s spinner confirmed
      already present (no change needed); the recommend-nap JSON feed
      fetch (`focusNapRecommendationFromQueryParam()`) was missing one
      and now has a dismissible loading alert, fixed session 2.
- [ ] **Not verified in a real browser.** Every item above was
      confirmed by reading the code/templates and via the mocked-
      context render check, never by actually loading the page. A
      real browser/Playwright pass (like Phase 22's screenshots) has
      not happened for this phase in any of the three sessions.
- Per the PDF's own instruction, no unnecessary features were added
  beyond what was asked (no CSV/PDF export, no new nav items).

## Testing checklist

- [x] `python3 -m py_compile` — clean on every changed/new `.py` file.
- [x] `node --check` — clean on `app/static/js/napmap.js`.
- [x] Jinja2 syntax parse — clean on `reports/index.html`.
- [x] Mocked-context `render_template()` — all 7 report tabs render
      cleanly against dummy routes + plain-object stand-ins.
- [x] `tests/test_reports_phase23.py` written, covering every case
      phase_12.pdf/the prior continuation prompt asked for.
- [x] That test file manually/statically traced line-by-line against
      the real route/form/model code — 2 real bugs found and fixed
      (see "Bugs found this session" above).
- [ ] **`tests/test_reports_phase23.py` has never actually been run.**
      Static tracing catches wrong literal values and API mismatches;
      it does NOT catch everything real execution would (subtle ORM
      behavior, SQLite-specific quirks, Flask-WTF CSRF interactions,
      session/cookie handling, timing issues). Treat this file as
      "should pass" rather than "passes" until `pytest -v` actually
      runs it.
- [ ] **Full suite (`pytest -v`) has never been run this phase**, nor
      in the two prior sessions — blocked by no network egress in all
      three sandboxes. Real pass/fail count still outstanding.
- [ ] No live-database (SQLite or MySQL) round-trip this phase.
- [ ] No real browser render this phase.

## Not verified (outstanding)

- A real `pytest -v` run of the full suite, including the new
  `tests/test_reports_phase23.py` — blocked by sandbox network egress
  in all three sessions on this phase. **This is the top priority for
  the next session if egress is available.**
- A live SQLite or MySQL round-trip against the real app.
- A real browser render of the Reports page (all 7 tabs) and the
  GeoMap loading-indicator fix.
- Whether the two bugs fixed via static trace this session are the
  only ones in the test file — static tracing is thorough but not
  exhaustive; a real pytest run may still surface something this
  process missed.
