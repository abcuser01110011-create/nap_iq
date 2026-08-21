# PHASE 4 — 55% — Installation Planner Panel: Suggestion Step

**Status:** Phase 4 of the Installation Planning integration (follows
`PLAN_INSTALL_40_PERCENT_NOTES.md`'s planning-mode toggle and
pin-drop). This phase adds the **suggestion panel** that appears once
a pin is dropped: the real nearest NAP with real open capacity (via
the Phase 2 data contract), or an honest "none available" message.
**No subscriber-creation form yet** — per the plan's explicit
instruction for this phase.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `app/templates/naps/map.html` | **Additive.** One new admin-gated container, `#installPlannerCard`, added right after `#navigationCard` — same `.nav-card` positioning class (same bottom-right slot), starts `d-none`. |
| `app/static/js/nap-install-planner.js` | **Additive.** New functions for fetching the Phase 2 endpoint and rendering the suggestion card (loading / success / no-NAP / error states), plus wiring so `enterPlanningMode()`/`exitPlanningMode()` toggle the Navigation Card's visibility and `placeProposedMarker()` triggers a lookup. No Phase 3 function was removed or had its behavior changed — only new code was added and two 1-line additions were made inside existing functions to call the new hide/show logic. |
| `PLAN_INSTALL_55_PERCENT_NOTES.md` | **New.** This file. |

Nothing else changed. No Python file, no route, no model, and no
database schema was touched this phase — same as Phase 3, this is a
frontend-only addition. The Phase 2 endpoint (`GET
/api/naps/nearest-available`) is called, not modified.

---

## 2. What it does

- The moment planning mode is entered (Phase 3's toggle button),
  the **Navigation Card hides** — mirroring the prototype's
  `{!planning && <NavigationCard/>}` check, which depends only on
  `planning`, not on whether a pin has been dropped yet.
- The Installation Planner card (`#installPlannerCard`) stays empty
  and hidden until a pin is actually placed — mirroring
  `{planning && proposed && <InstallationPlanner/>}`, which needs
  both.
- The instant a pin is dropped or moved, the panel shows a brief
  loading state, then calls
  `GET /api/naps/nearest-available?lat=<pin lat>&lng=<pin lng>`
  (Phase 2, unmodified) and renders exactly what it returns:
  - **Success:** the nearest NAP's code, name, address, distance in
    km, and open slot count, plus a "Use this NAP & add subscriber"
    button.
  - **`no_nap_available`:** the honest "No NAP with available slots
    near this location." message — the same wording the prototype
    itself shows for its `!suggestion` case.
  - **Network/server error:** a distinct, honest error message (not
    a silent failure and not a fabricated result).
- Both cards live in the **same physical slot** (`.nav-card`'s fixed
  bottom-right position) and are kept mutually exclusive purely by
  toggling `d-none` on whichever one shouldn't show — `nav-card.js`
  itself was not touched; this module only ever flips the container
  class from the outside.
- Re-dropping/moving the pin re-fetches and re-renders the panel each
  time, same as the prototype recomputing `nearestAvailableNap(pos)`
  on every new `proposed` value.
- Exiting planning mode (Cancel, or toggling the button off) clears
  the pin, hides and empties the Installation Planner card, and shows
  the Navigation Card again.

---

## 3. "Use this NAP & add subscriber" button — intentionally inert

The button required by this phase's acceptance criteria is rendered
in the success state, but has **no click handler** and is `disabled`
with a small "Coming in a later phase" note underneath. This is a
deliberate choice, not an oversight: Phase 5 is what turns this into
the actual subscriber-creation form, and the plan explicitly says
"Do not yet implement the subscriber-creation form" for this phase.
Disabling it (rather than leaving it clickable-but-silent) was chosen
so it never reads as a broken button — it visibly and honestly
communicates "not wired up yet" rather than doing nothing when
clicked.

---

## 4. Stale-response handling — what this phase does and doesn't do

The plan explicitly assigns full "stale-response protection" (the
same discipline as the navigation feature's Phase 5/18 guarding) to
**Phase 7**, not this one. However, without *any* guard at all, a
real and visible bug would already exist this phase: if a user drops
a pin, then quickly drops it again elsewhere before the first lookup
resolves, the first (now-stale) response arriving after the second
could overwrite the correct, newer suggestion on screen.

To avoid shipping that bug while still leaving the *real* hardening
(request cancellation, covering every intermediate state, tests) to
Phase 7 as instructed, a minimal guard was added: a `requestSeq`
counter is incremented on every new lookup, and a response is only
rendered if it's still the most recent request issued *and* planning
mode / the pin are still active. This is a correctness guard for a
bug that would otherwise exist today, not new scope — Phase 7 will
still need to add the fuller discipline (aborting in-flight fetches,
etc.) that the plan describes for it.

---

## 5. Verification performed

### Automated
```
$ node --check app/static/js/nap-install-planner.js
(no output — passes)

$ python3 -m py_compile $(find app -name "*.py") run.py dev_seed_server.py
(no output — whole app, unchanged this phase, still compiles cleanly)
```

Jinja template parse check on `naps/map.html` completed with no
`TemplateSyntaxError`.

Full existing test suite (regression check — this phase added no new
automated tests of its own, since it added no new server route; the
Phase 2 endpoint it calls already has its own tests):
```
$ pytest -q
3 failed, 130 passed
  FAILED tests/test_reports_phase23.py::test_new_issue_reported_notification_staff_route
  FAILED tests/test_reports_phase23.py::test_new_issue_reported_notification_customer_route
  FAILED tests/test_technician_workflow.py::test_reports_page_shows_technician_workload
```
Same 3 pre-existing failures already documented in
`PLAN_INSTALL_25_PERCENT_NOTES.md` §5 (Reports/notifications module,
untouched by this phase) — no new failures introduced. 130 passed
here vs. 121 in Phase 2's notes reflects the 9 tests Phase 2 itself
added plus normal suite growth since; nothing from this phase's
changes is in that count since no new test file was added.

### Manual, against the real app (`dev_seed_server.py`, real SQLite
data, real HTTP requests via `requests`/`curl` — logged in as the
real seeded `admin1`/`tech1` accounts):

```
GET /naps/map as admin1 -> 200
  #installPlannerCard present: True
  <div id="installPlannerCard" class="nav-card d-none">
  #navigationCard present: True
  <div id="navigationCard" class="nav-card" data-role="administrator">
  (confirms both share the identical .nav-card positioning class —
  same slot — and installPlannerCard starts hidden)

GET /naps/map as tech1 -> 200
  #installPlannerCard present: False   (Jinja-gated out entirely)
  #navigationCard present: True         (unaffected, still renders for tech)

GET /api/naps/nearest-available?lat=14.281&lng=121.415 (NAP active, in range)
  -> 200 {"status": "success", "nap": {"nap_code": "NAP-0100", ...},
          "distance_km": 0.0, "available_ports": 8, ...}

Set the one seeded NAP's status to "maintenance" directly in the DB,
then repeated the same request:
GET /api/naps/nearest-available?lat=14.281&lng=121.415
  -> 200 {"status": "no_nap_available", "nap": null,
          "distance_km": null, "available_ports": null, ...}
  (confirms the honest no-NAP branch is real, not just a documented
  contract — the JS's renderNoNapAvailable() path was written against
  this exact shape.)

NAP status was then restored to "active" before continuing, so the
seed data used by the rest of this phase's checks and by the test
suite run above matches its original state.
```

### Known limitation — no browser screenshot this phase

As noted in `PLAN_INSTALL_40_PERCENT_NOTES.md` §5, Playwright's
Chromium download is blocked in this environment
(`cdn.playwright.dev` is outside the network allowlist) and no other
browser binary is available. This phase's actual rendered appearance
(the suggestion card's layout, the loading spinner, the mutual
hide/show transition between the Navigation Card and the Installation
Planner card) has been verified by code inspection and by confirming
the exact HTML/JSON each piece consumes and produces — not by driving
a real browser. Same honest flag as last phase: this is an
environment limitation, not a defect, but it means the visual
polish/layout has not been eyeballed in an actual browser yet.

---

## 6. Acceptance criteria check

- [x] The suggestion shown is always the real nearest NAP with real
      open capacity, from real data — never hard-coded. Confirmed:
      the JS only ever renders fields taken directly from the Phase 2
      JSON response; no NAP/distance/slot value is invented client-side.
- [x] The "no NAP available" case is handled honestly, matching the
      prototype's behavior — confirmed against a real `no_nap_available`
      response in §5.
- [x] Panel does not visually collide with the existing navigation
      card — confirmed both share the identical `.nav-card` slot and
      are toggled mutually exclusively (`hideNavigationCard()` /
      `showNavigationCard()`), mirroring the prototype's own
      `{!planning && ...}` / `{planning && proposed && ...}` pattern.
- [ ] **Visual/browser confirmation still outstanding** — see §5's
      limitation note (same as Phase 3).

---

## 7. Files changed this phase (confirmed diff scope)

- `app/templates/naps/map.html` (additive: one new container div)
- `app/static/js/nap-install-planner.js` (additive: new functions +
  two 1-line calls added inside existing Phase 3 functions)
- `PLAN_INSTALL_55_PERCENT_NOTES.md` (new file, this one)

No `.py` file, no route, no model, no other template, and no `.css`
file was touched this phase.

---

**STOP.** This is the end of Phase 4 (55%). Phase 5 (the
subscriber-creation form) is intentionally not started.
