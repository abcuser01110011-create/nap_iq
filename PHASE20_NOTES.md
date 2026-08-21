# NAP-IQ — Phase 20 Notes (phase_8.pdf Technician Module)

## Round 7 (this package, nap_iq_phase20_wip_v7.zip) — both outstanding items closed out

Both items on Round 6's to-do list are now genuinely done, not just
diagnosed. Phase 20 has no known outstanding items after this round.

### 1. Visual/CSS eyeball check — done

Fixed `dev_screenshot.py`'s logout helper (was JS-`form.submit()`ing
the sidebar's POST `/logout` form and racing the next `login()` call;
now clicks the real button and waits for navigation + the next page's
username field before returning), then ran it against a freshly
seeded SQLite dev server and captured all 7 planned screenshots —
included in this zip under `phase20_screenshots/`:

- `01_reports_workload.png` — Technician Workload & Performance report
- `02_issue_detail_history.png` — Assignment History table with a
  genuinely long `resolution_notes` value; wraps cleanly, no overflow
- `03_technician_index.png` — technician dashboard; the icon-only
  "View on Map" pin button (Round 5's aria-label fix) now actually
  renders visibly since Bootstrap Icons loads from the local vendor
  copy instead of failing to load from a blocked CDN
- `04_technician_history.png` — populated history table
- `05_technician_history_empty.png` — "no profile linked" warning
  branch (tech2, no `Technician` row)
- `06_technician_index_no_profile.png` — same branch on the dashboard
- `07_geomap_focus.png` — `?issue_id=` focus: popup, marker, and
  filter panel all render correctly under real Leaflet CSS; the map
  tile area itself is blank only because `tile.openstreetmap.org`
  isn't on this sandbox's egress allowlist (confirmed via server log —
  every `/static/vendor/...` and app asset returned 200/304; only the
  external OSM tile requests 403'd) — a sandbox limitation, not an app
  bug, and irrelevant to a real deployment with normal internet access.

No visual bugs found in any of the 7. `dev_seed_server.py` and
`dev_screenshot.py` remain in this zip at the project root (dev-only,
never imported by `app/`) in case a future round wants to re-check
something visually.

### 2. Live MySQL run — done, for real

`apt-get update && apt-get install -y mysql-server` worked cleanly
this round (`archive.ubuntu.com`/`security.ubuntu.com` are on this
sandbox's allowlist — confirmed, and worth remembering for future
rounds instead of re-treating this as blocked). Concretely, this
round:

- Installed MySQL 8.0.46, started it, set the `root` password to match
  `.env`'s `MYSQL_PASSWORD`.
- Loaded `database/schema.sql` then `database/seed.sql` against a
  fresh `nap_iq` database — both ran with **zero errors**. Confirmed
  `resolution_notes` (Phase 20's own column) is present in the
  `assignments` table as created by `schema.sql` — the file didn't
  need updating.
- Ran the **actual** `run.py` entrypoint (not a test harness) — real
  `mysql+pymysql://` connection string from `app/config.py`, real
  Flask-WTF CSRF protection, real Flask-Limiter — against this live
  database. Confirmed via a bare Python shell that `create_app()`
  connects and `User.query.count()` returns the 5 seeded accounts.
- Drove a full Playwright-through-real-Chromium run of the core Phase
  20 workflow against this live server:
  1. Logged in as `tech2` (seeded with an `in_progress` assignment on
     `ISS-0003`) — confirmed the dashboard shows it.
  2. Opened the shared notes modal via "Mark Complete", filled
     `resolution_notes`, submitted — confirmed the assignment leaves
     the open-assignments list.
  3. Confirmed `ISS-0003` + the submitted notes now appear on
     `/technician/history`.
  4. Logged in as `admin1`, opened `/issues/3` — confirmed it now
     shows status **Resolved** and the "Close Issue" button (only
     shown for resolved issues) is present. Clicked it (with the
     `confirm()` dialog auto-accepted) — confirmed the page now shows
     **Closed**.
  5. Loaded `/reports/` — confirmed the Technician Workload table
     renders real technician names pulled from live MySQL.
  6. Separately confirmed CSRF is actually enforced in this config
     (not just under the SQLite test harness's `WTF_CSRF_ENABLED`
     toggle): a raw `curl` POST to `/login` with no CSRF token got a
     genuine `400`.
  - Verified final state directly via the `mysql` CLI afterward:
    `technical_issues.status = 'closed'` for issue 3,
    `assignments.status = 'completed'` with `resolution_notes` set for
    its assignment — matches what the UI showed at every step.
- No app code needed any changes to make this work — `schema.sql`,
  `app/config.py`'s MySQL URI construction, and every Phase 20 route
  worked against real MySQL exactly as already written.

The one-off script used to drive this (`mysql_e2e_check.py`) was not
kept in this zip — its findings are fully captured above and it was a
throwaway verification tool, not a reusable test. `tests/` still only
contains the SQLite-based pytest suite (66 passed, 0 failed, per
Round 6 — unaffected by this round, no test files touched this round).

### Not touched this round

No Phase 1–19 code, no already-shipped Phase 20 code (including
Round 6's vendoring change), and no test files were modified this
round — only the one bug fix in `dev_screenshot.py`'s `logout()`
helper (a dev-only script, not shipped app code) and the addition of
`phase20_screenshots/`.



## Round 6 (this package, nap_iq_phase20_wip_v6.zip) — sixth WIP round

Picked up from v5's "Outstanding" list. This sandbox's network egress
allowlist does NOT include `cdn.jsdelivr.net`/`cdnjs.cloudflare.com`
(confirmed again), but it DOES include the npm registry
(`registry.npmjs.org` etc.) — v5's notes hadn't tried that. So:

1. **CSS/visual eyeball blocker — actually unblocked, not just
   diagnosed.** Ran `npm pack bootstrap@5.3.3 bootstrap-icons@1.11.3
   leaflet@1.9.4` (real npm registry, allowed), extracted the real
   `dist/` output of each, and vendored the needed files into
   `app/static/vendor/`:
   - `vendor/bootstrap/css/bootstrap.min.css` (+ .map),
     `vendor/bootstrap/js/bootstrap.bundle.min.js` (+ .map)
   - `vendor/bootstrap-icons/font/bootstrap-icons.min.css` +
     `font/fonts/*` (woff/woff2 — paths verified to match the CSS's
     relative `url(...)` references)
   - `vendor/leaflet/leaflet.css`, `leaflet.js` (+ .map),
     `images/*.png` (marker/layers icons — paths verified against the
     CSS's `url(images/...)` references)
   - Updated all 4 templates that pulled from the two blocked CDNs
     (`base.html`, `dashboard_base.html`, `dashboard/index.html`,
     `naps/map.html`) to use `url_for('static', filename='vendor/...')`
     instead. Full pytest suite re-run afterward: still **66 passed, 0
     failed** — no template broke.
   - This also makes the app resilient to CDN outages/allowlist issues
     generally now, not just this one sandbox limitation (the concern
     v5's notes flagged as "worth doing either way").
   - **Not yet done: the actual visual screenshots.** Built
     `dev_seed_server.py` (seeds a richer on-disk SQLite DB — multiple
     technicians/issues, one deliberately long `resolution_notes`
     string to check real column wrapping, tech2 with no `Technician`
     profile row to hit the empty-state branch — then runs a real dev
     server on `127.0.0.1:5055`) and `dev_screenshot.py` (Playwright:
     log in, visit the Workload report / issue detail assignment
     history / technician history (populated + empty) / GeoMap
     `?issue_id=` focus, screenshot each). Got 2 of 7 screenshots
     captured (`01_reports_workload.png`, `02_issue_detail_history.png`
     — both in `/home/claude/screens/` in that session's container, NOT
     included in this zip) before the script's logout step (JS
     `form.submit()` on the sidebar's POST-based `/logout` form,
     between role switches) started timing out on the next page's
     login-form locator — looked like the session wasn't reliably
     cleared before the next `login()` call ran, not a problem with the
     vendored assets themselves. Didn't debug further this round.
     Both scripts are included in this zip at the project root
     (`dev_seed_server.py`, `dev_screenshot.py`) — they're dev-only
     tools, never imported by `app/`, safe to delete once this is
     resolved or keep for future visual checks.
2. **MySQL — still not attempted with a real install this round.**
   Confirmed `archive.ubuntu.com` and `security.ubuntu.com` (i.e.
   `apt install mysql-server` would likely work) are on this sandbox's
   allowlist, unlike the CDN hosts — this wasn't tried in any prior
   round. Didn't act on it this round; flagging it as the more
   promising path forward instead of continuing to treat live MySQL as
   categorically blocked.

No Phase 1-19 code, and nothing already-shipped in Phase 20, was
reworked this round — only the CDN→vendor swap in the 4 templates
above, plus the two new standalone dev scripts.


## Status: pytest green; GeoMap click-through verified for real; CSS eyeball still blocked by sandbox network policy; live MySQL still outstanding

This is the **fifth** WIP package of Phase 20. The first
(`nap_iq_phase20_wip.zip`) covered resolution notes plumbing only. The
second wrote code for Outstanding items 1–6 but never executed
anything. The third actually ran the suite, fixed everything it
turned up, and did as much manual verification as a browser-less
sandbox allowed. The fourth had a real (headless Chromium) browser
available and used it to genuinely execute `napmap.js` end-to-end
instead of code-reviewing it. This round (v4 -> this package) made the
small accessibility fix that round's click-through turned up, confirmed
the CSS-eyeball item is still blocked (not by lack of a browser this
time, but by this sandbox's network egress allowlist — see below), and
confirmed no MySQL server is available here either. See "What happened
this round" below before reading the older item-by-item write-up
further down.

## What happened this round

0. **`technician/index.html`'s "View on Map" link — `aria-label`
   added.** The one follow-up the previous round's real click-through
   turned up: the icon-only link now has both `title="View issue
   location on GeoMap"` (unchanged) and
   `aria-label="View issue location on GeoMap"` (new), so it degrades
   gracefully — for screen readers always, and visually too if
   Bootstrap Icons' font ever fails to load — instead of being a
   silent, unlabeled dead spot. Confirmed the template still parses
   (Jinja `get_template()`) and full suite is still **66 passed, 0
   failed** afterward. No test asserted on the old markup, so nothing
   else needed updating.
1. **Real GeoMap click-through — done, passed.** The sandbox this
   round had no internet access, so the CDN-hosted Leaflet/Bootstrap
   assets (`map.html`, `base.html`, `dashboard_base.html` all pull
   them from `cdn.jsdelivr.net` / `cdnjs.cloudflare.com`) couldn't
   load as-is. Rather than fall back to code review again, a minimal
   instrumented stand-in for the ~5 `L.*` calls `napmap.js` actually
   makes (`L.map`, `L.tileLayer`, `L.layerGroup`, `L.marker`,
   `L.divIcon`) was written and swapped in for just those two CDN
   URLs via Playwright's request interception, so the **real,
   unmodified** `napmap.js` ran against a live seeded SQLite dev
   server. Logging in as `tech1`, following the same
   `/naps/map?issue_id=<id>` link `technician/index.html`'s
   "View on Map" button already points at, produced (captured
   straight from the running code, not asserted):
   - `data-focus-issue-id="1"` rendered correctly.
   - `focusIssueFromQueryParam()` found the issue and called
     `focusIssue()`.
   - `map.flyTo([14.281, 121.415], 18)` fired with the issue's exact
     coordinates and zoom 18.
   - `marker.openPopup()` fired on the marker titled
     `"ISS-0100 - No Internet"` — confirmed to be the correct issue's
     *current* marker object (not the NAP marker, not a stale one
     from the earlier `renderAll()` pass).
   - Zero console errors.
   This matches `focusIssueFromQueryParam()`/`focusIssue()`'s intended
   behavior exactly. The default-checked status/priority filters meant
   this particular run didn't exercise the "force a filter checkbox
   on" branch — worth a follow-up run with an issue whose
   status/priority isn't already checked by default, to see that
   branch actually flip a checkbox, though the code for it is a
   straight copy of the already-shipped `selectNap()` pattern.
   - **Minor finding, not a blocker:** the "View on Map" link
     (`technician/index.html`) is icon-only (`<i class="bi
     bi-geo-alt">`, no visible text, just a `title` attribute). With
     Bootstrap Icons unavailable it rendered as a zero-size element —
     Playwright couldn't even click it directly (had to navigate its
     `href`). If that icon font ever fails to load for a real user
     (flaky CDN, ad-blocker, offline), this button becomes an
     invisible, unlabeled dead spot with no `aria-label` fallback.
     Cheap follow-up: add `aria-label="View issue location on
     GeoMap"` to the `<a>`. Not fixed this round per the "don't rework
     unless the click-through turns up a bug" instruction — this is a
     robustness/accessibility observation, not something that broke.
2. **CSS/visual eyeball — still not done, and now diagnosed more
   precisely.** This round's sandbox actually had general internet
   egress enabled (unlike the fully offline sandbox two rounds ago) —
   but it sits behind an allowlisting proxy, and neither
   `cdn.jsdelivr.net` (Bootstrap/Bootstrap Icons) nor
   `cdnjs.cloudflare.com` (Leaflet) is on that allowlist:
   `curl -I https://cdn.jsdelivr.net/...` returns `HTTP/2 403` with
   `x-deny-reason: host_not_allowed`, same for `cdnjs.cloudflare.com`.
   So this still can't be worked around with a stub the way GeoMap's
   *behavior* could last round — Bootstrap's real CSS *is* the visual
   layout in question, and a stand-in would just show a guess at
   styling, not the app's actual rendering. No new screenshots taken
   this round for that reason (unstyled ones would add nothing beyond
   what the last two rounds already confirmed from raw HTML/DOM).
   **Two ways to unblock this next session:** (a) allow
   `cdn.jsdelivr.net` and `cdnjs.cloudflare.com` in the sandbox's
   network egress settings before the next session starts, or
   (b) vendor Bootstrap 5.3.3 + Bootstrap Icons 1.11.3 + Leaflet 1.9.4
   locally into `app/static/vendor/` — this needs the real npm/CDN
   package contents, which this assistant can't fetch itself under the
   current network policy either, so it would need to arrive as an
   upload (e.g. zipped `dist/` folders) rather than be generated here.
   Vendoring would also make the app resilient to CDN outages/
   allowlist issues generally, not just unblock this one test — worth
   doing either way if this keeps coming up.
3. **Not done**: real MySQL run — still only ever SQLite. Checked for
   a local MySQL server this round (`mysql`/`mysqld` binaries, a
   listener on `127.0.0.1:3306`) — none present in this sandbox
   either. Same standing caveat as every prior phase.

### 2026-08-17 — pytest failures found and fixed

- `tests/test_rbac_matrix.py` — a duplicated `@pytest.mark.parametrize`
  decorator on `test_unauthenticated_redirects_to_login_with_next`
  caused a collection error before any test in the file could run.
  Removed the duplicate.
- `tests/test_technician_workflow.py::test_technician_history_page_renders_empty_state`
  — logged in as `tech1` without ever creating a `Technician` profile
  row, so it exercised the "no profile linked" warning branch instead
  of the true empty-assignments-list branch it was named for. The
  route was correct; fixed the test to seed a linked profile with zero
  closed assignments.
- `tests/conftest.py`'s shared `login()` helper hardcoded
  `follow_redirects=False` while also accepting `**kwargs`, so any
  caller passing `follow_redirects=True` (all over `test_login.py`,
  `test_account_status.py`, `test_rate_limiting.py`) crashed with a
  duplicate-keyword `TypeError`. Pre-existing bug, unrelated to Phase
  20 — this looks like it's the first time this suite has actually
  been run at all. Fixed with `kwargs.setdefault(...)`.
- `test_login.py`'s `payment_collector` case asserted the old "no
  dashboard yet" message, but `app/auth.py`'s `ROLE_HOME_ENDPOINT`
  shows Phase 10 already gave `payment_collector` a real dashboard
  (`collector.index`). The app was correct; the test was stale.
  Updated the assertion to match Phase 10's actual, shipped behavior.
- `test_account_status.py::_set_status` wrapped its DB update in a
  *second*, nested `app.app_context()`. Confirmed with an isolated
  repro that this creates a distinct SQLAlchemy scoped session whose
  commit reaches the DB but never invalidates the *outer* session's
  identity map — the one Flask's test client actually reuses across
  requests, because the `app` fixture keeps a single app context open
  for the whole test. Result: the "deactivate mid-session" and
  "reactivate" tests saw a stale cached `User` object with the old
  status. This is a test-fixture artifact, not a production bug (a
  real request gets its own fresh context every time). Fixed by
  having `_set_status` reuse the already-active context instead of
  nesting a new one.

All four fixes landed in test files only (one of them was a stale
assertion, not a helper bug) — no Phase 20 application code needed
any changes; everything written in the previous round was correct as
written.

## Why this phase exists

`phase_8.pdf` (the user's spec, "Technician module") was compared
against the already-shipped code (Phases 1–19). Five concrete gaps
were identified — see the first WIP round's notes for the full
list. All five now have code written against them (this round); none
of it has been executed yet.

## What's actually done and written in this zip

Carried over from the first WIP round (unchanged this round):
- `database/schema.sql` / `app/models.py` — `assignments.resolution_notes`.
- `app/forms.py` — `ResolutionNotesForm`.
- `app/routes/technician.py` — `save_notes()`, `complete_assignment()`
  now requiring resolution notes, `history()` (route only, no
  template yet — fixed this round, see below).
- `app/templates/dashboard_base.html` — technician sidebar
  "Assignment History" link.
- `app/templates/technician/index.html` — Subscriber/NAP columns,
  "View on Map" buttons, Notes/Mark Complete shared modal.

New this round (Outstanding items 1–6 from the first round's notes):

1. **`app/templates/technician/history.html`** — created. Table of
   the signed-in technician's completed/cancelled assignments
   (subscriber, NAP, outcome badge, assigned/completed timestamps,
   resolution notes), plus the same "no profile linked" empty state
   pattern `technician/index.html` uses. `technician.history()` should
   no longer 500.

2. **GeoMap `issue_id` focus support**:
   - `app/routes/naps.py`'s `geomap()` reads an optional `?issue_id=`
     query param and passes it to the template as `focus_issue_id`
     (not validated against the DB — an unknown/foreign id is meant
     to just match nothing client-side, same "deliberately
     unrestricted" spirit as the rest of this route).
   - `app/templates/naps/map.html` exposes it as a
     `data-focus-issue-id` attribute on `#napMap`.
   - `app/static/js/napmap.js` adds `focusIssueFromQueryParam()` /
     `focusIssue()`, called once after the initial `renderAll()` in
     `init()`. Mirrors the existing `selectNap()` pattern: forces the
     issue's status + priority filter checkboxes (and the "Show
     Issues" layer toggle) on if needed, re-renders, then
     `map.flyTo(...)` and opens the marker's popup via
     `issueMarkersById`.
   - The "View on Map" buttons in `technician/index.html` (already
     linking to `naps.geomap(issue_id=...)` since the first WIP round)
     should now do something.

3. **Resolved → Closed transition**:
   - `POST /issues/<id>/close` added to `app/routes/issues.py` as
     `close_issue()` — `@role_required("administrator")`, only valid
     when `issue.status == 'resolved'` (flashes a warning and no-ops
     otherwise), fires `notify_issue_status_change()` same as the
     other transitions in this app.
   - `app/templates/issues/view.html` — "Close Issue" button added
     inside the existing admin-only Dispatch panel, shown only when
     `issue.status == 'resolved'`, with a `confirm()` prompt matching
     the existing "Cancel Dispatch" button's pattern.

4. **Assignment history on the admin issue detail page** (distinct
   from item 1's technician-facing history):
   - `issues.view_issue()` now also queries *every* `Assignment` row
     for the issue (not just the current open one, which is still
     loaded separately for the Dispatch panel), newest first, as
     `assignment_history`.
   - `app/templates/issues/view.html` renders it as its own
     admin-only table (technician, status badge, assigned/completed
     timestamps, resolution notes) below the Dispatch panel.

5. **Technician Workload & Performance report**:
   - `app/routes/reports.py`'s `index()` adds a third report block:
     per technician, open-assignment counts broken out by each status
     in `OPEN_ASSIGNMENT_STATUSES`, total open count, existing
     `resolved_issues_count`, and average resolution time. Average is
     computed in Python from `completed_at - assigned_at` over that
     technician's `completed` assignments (deliberately not a SQL
     `AVG(TIMESTAMPDIFF(...))`, to stay portable between the SQLite
     test suite and real MySQL, per the original Outstanding note).
     Sorted busiest-first (most open work).
   - `app/templates/reports/index.html` — new card/table for this,
     same visual style as the existing Issues/NAP Utilization cards.
     Links each technician's name to `technicians.view_technician`.

6. **Tests**:
   - New `tests/test_technician_workflow.py` — covers: history page
     empty state and populated state; `complete_assignment` rejecting
     a POST with no `resolution_notes` (assignment/issue status stay
     unchanged) and accepting one with notes (status/issue transition
     + notes persisted); `close_issue` 403ing a non-administrator,
     no-op'ing from a non-`resolved` status, and succeeding from
     `resolved`; the "Close Issue" button's conditional visibility;
     the issue-detail assignment-history table rendering resolution
     notes; `naps.geomap` rendering `data-focus-issue-id` correctly
     both with and without `?issue_id=`; the workload report
     rendering a seeded technician's row.
   - `tests/test_rbac_matrix.py` — added `/technician/history` and
     `/reports/` to `ROUTE_MATRIX` (the latter was a pre-existing gap
     in the matrix, not a Phase 20 route, but cheap and directly
     relevant to double-check while touching this file).
   - No existing test in the inherited suite (`test_rbac_matrix.py`,
     `test_scoped_access.py`, etc.) POSTs to `complete_assignment`, so
     nothing needed updating there for the new required-field
     behavior — the first WIP round's note about that turned out not
     to apply to this particular suite; the new coverage for it lives
     entirely in the new test file above.

All touched Python files pass `python3 -m py_compile` as of this
package (`app/routes/naps.py`, `app/routes/issues.py`,
`app/routes/reports.py`, `app/routes/technician.py` [unchanged this
round but re-checked], `tests/test_technician_workflow.py`,
`tests/test_rbac_matrix.py`).

## Outstanding — the actual to-do list for next session

1. **Eyeball the CSS/visual side** of the pages checked via raw/
   unstyled rendered HTML rather than real Bootstrap styling so far —
   the Technician Workload report's sorting/badges, the Assignment
   History table's column wrapping with a genuinely long
   `resolution_notes` value, the history page's empty state. The HTML
   structure and content are confirmed correct (three rounds running
   now), but actual visual layout (wrapping, spacing, responsiveness)
   still hasn't been seen properly rendered. Confirmed this round:
   the blocker isn't "no browser" or "no internet" generically — it's
   specifically that `cdn.jsdelivr.net` and `cdnjs.cloudflare.com`
   aren't on the sandbox's network egress allowlist (`403
   host_not_allowed`). Fix either by allowing those two hosts in the
   sandbox's network settings, or by uploading vendored copies of
   Bootstrap 5.3.3 (+ Bootstrap Icons 1.11.3) and Leaflet 1.9.4 to
   drop into `app/static/vendor/` — this assistant can't fetch the
   real package contents itself under the current network policy
   either, so vendoring needs the files supplied, not generated.
2. Same standing caveat as every prior phase: still not run against
   live MySQL, only ever SQLite. Confirmed again this round: no
   `mysql`/`mysqld` binaries and nothing listening on `127.0.0.1:3306`
   in this sandbox.

## Not touched

Everything from Phases 1–19 except what's listed above, and except
the one-attribute `aria-label` addition to `technician/index.html`
made this round. Nothing else in `app/routes/dispatch.py`,
`app/routes/naps.py` (beyond `geomap()`), `app/routes/technicians.py`,
or their templates was touched.

---

## Continuation prompt (paste this to resume)

```
Continue developing my NAP-IQ Flask + MySQL system.
Upload: nap_iq_phase20_wip_v7.zip (includes PHASE7-20_NOTES.md history,
TESTING.md, SECURITY_CHECKLIST.md, tests/, phase20_screenshots/).

Phases 1-19 are complete/verified by code review. Phase 20 (phase_8.pdf's
Technician-module gaps) is now COMPLETE and fully verified — read
PHASE20_NOTES.md in full before doing anything, especially "Round 7" at
the top. Short version: pytest is green (66 passed, 0 failed, against a
freshly-built Linux venv). Bootstrap/Bootstrap Icons/Leaflet are vendored
locally in app/static/vendor/ (no more CDN dependency). Both items that
were previously outstanding are now done:

1. Visual/CSS eyeball check — done. All 7 planned pages were screenshotted
   under the real vendored Bootstrap/Leaflet CSS via a real headless
   Chromium run against a seeded dev server; images are in
   phase20_screenshots/. No visual bugs found.
2. Live MySQL — done. mysql-server was installed in the sandbox
   (archive.ubuntu.com/security.ubuntu.com are allowlisted), schema.sql +
   seed.sql loaded with zero errors, and the real run.py app was driven
   through the full technician-completes-assignment -> issue resolves ->
   admin closes issue -> workload report workflow via a real browser
   against live MySQL, with a final mysql CLI check confirming the DB
   state matched what the UI showed. CSRF was also confirmed enforced
   outside the test harness (raw curl POST /login with no token -> 400).

There is no known outstanding item for Phase 20 right now. If you're
starting a new phase, treat phase_8.pdf's spec as fully implemented and
verified, and read PHASE18/19/20_NOTES.md for full context before writing
any new code. If instead you're asked to re-verify something or a bug
report comes in, this is the first phase where that would be investigating
a regression rather than closing a known gap.

Do not rework anything from Phases 1-20 unless testing actually turns up
a bug. Keep the same patterns already in the codebase (role_required
decorators, CSRF-protected POST forms, the shared-Bootstrap-modal
pattern, PHASE<N>_NOTES.md per phase — start a PHASE21_NOTES.md if this
is genuinely a new phase of work).
```

