# PHASE 6 — 85% — Success State + Map Refresh

**Status:** Phase 6 of the Installation Planning integration (follows
`PLAN_INSTALL_70_PERCENT_NOTES.md`'s subscriber-creation form). This
phase translates the prototype's `InstallationPlanner` "done" step:
after a successful create, the panel now shows the prototype's own
polished confirmation (check icon, "Subscriber created & linked.",
a code chip, a "Done" button), the new subscriber becomes a real,
visible marker on the map without a page reload, and the dropped pin
/ planning-mode chrome are reset.

No backend route, model, form, or template was touched this phase —
this is a JavaScript-only phase, since everything it needed
(`POST /subscribers/quick-add`'s response shape, the existing
subscriber marker layer) already existed from Phases 5 and the prior
Navigation/Route-Line plan.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `app/static/js/napmap.js` | **Additive.** `window.NapIQMapModes` gains a new `addSubscriberMarker(subscriber)` method: pushes one subscriber into the existing `allSubscribers` dataset (or replaces it, if already present by `id`), forces the existing "Show Subscribers" layer toggle on (same as `focusSubscriber()` already does), and calls the existing `renderSubscriberMarkers()` to rebuild the layer. No new marker-drawing code path, no new API call — it reuses the exact rendering function every other subscriber marker on this map already goes through. |
| `app/static/js/nap-install-planner.js` | **Additive.** New `finishAfterCreate()`, `renderDoneStep()`, and `resetPlanningModeChrome()` (the last one factored out of the existing `exitPlanningMode()` so both it and the new success path share the same button/banner/cursor reset instead of duplicating it). `submitSubscriberForm()`'s success branch now calls `finishAfterCreate()` instead of rendering a plain confirmation line. |
| `PLAN_INSTALL_85_PERCENT_NOTES.md` | **New.** This file. |

Nothing else changed. `app/routes/subscribers.py`'s `quick_add_subscriber()` (Phase 5) is untouched and already returned every field this phase needed (`id`, `subscriber_code`, `full_name`, `address`, `latitude`, `longitude`, `nap_id`, `nap_code`).

---

## 2. What it does

1. On a successful `POST /subscribers/quick-add` (Phase 5's flow,
   unchanged), `finishAfterCreate(subscriber, nap)` now runs:
   - Hands the real created `subscriber` row straight to
     `window.NapIQMapModes.addSubscriberMarker()` (napmap.js). That
     function adds it to napmap.js's own in-memory `allSubscribers`
     array and calls the pre-existing `renderSubscriberMarkers()` —
     the identical function/layer `loadSubscribers()` and the "Show
     Subscribers" toggle already use for every other subscriber pin
     on this map. If that layer was currently hidden, its toggle is
     switched on first (the same thing `focusSubscriber()` already
     does), so the new subscriber is actually visible immediately,
     not silently added to a hidden layer.
   - Removes the dropped prospect pin from the map and resets
     planning mode's own chrome — the "Plan Installation" button back
     to its idle label/color, the banner hidden, the map's planning
     cursor class removed — via the new shared
     `resetPlanningModeChrome()` helper.
   - Renders the prototype's own "done" step into the same
     `#installPlannerCard` slot: a green check icon, "Subscriber
     created & linked to `<NAP code>`.", the new subscriber's code in
     a badge ("New line code"), and a "Done" button.
2. Clicking "Done" hides the Installation Planner card (which also
   clears its remembered `currentSuggestionNap`, via the existing
   `hideInstallPlannerCard()`) and shows the Navigation Card again —
   the prototype's own `onClose` behavior
   (`setPlanning(false); setProposed(null);` in
   `MapDashboard.tsx`), translated to this app's "one card visible at
   a time" toggle pattern.

### A small, deliberate difference from the prototype's exact sequencing

The plan's own Phase 6 section lists, as part of "after a successful
create()": *"clear the dropped pin and exit planning mode"* **and**,
separately, *"provide a 'Done' action that closes the panel"*. In the
React prototype those two things happen at the same instant, both
inside the single `onClose` callback the "Done" button calls. This
phase instead resets the pin and planning-mode's chrome **immediately
on a successful create** (so acceptance criterion "Planning mode and
the pin both cleanly reset" holds the moment the row exists), and
treats "closing the confirmation panel" as the separate, later action
"Done" performs — the panel survives the pin/mode reset specifically
so the confirmation has somewhere to be shown. Both plan bullet points
are satisfied; they are just not tied to the same click. This is
recorded here rather than left implicit, per the plan's own
"document which approach was used and why" instruction (for the map-
refresh method) and general instruction to write down architecture
decisions rather than silently picking one.

---

## 3. Deliberately not done this phase (Phase 7's job)

Per `INSTALLATION_PLANNING_PHASES.md`, Phase 7 ("Error handling, edge
cases, and RBAC hardening") still owns:
- Full stale-request/abort discipline (aborting an in-flight
  suggestion fetch outright, not just ignoring its result) — this
  phase still only relies on Phase 4's `requestSeq` guard, now also
  bumped in `finishAfterCreate()` so a suggestion lookup that was
  somehow still in flight at the moment of a successful create can't
  overwrite the "done" step.
- A guard against rapid repeated pin drops while the "done" step (or
  the create form) is showing.
- Automated tests covering this feature's RBAC boundary and the
  create-subscriber-from-pin flow, including this phase's new
  behavior.
- Verifying interaction with the navigation feature under stress
  (starting/stopping planning mode repeatedly, etc.) beyond the basic
  mutual-exclusivity this and prior phases already wire up.

Nothing about the "done" step or the map refresh added this phase
anticipates or duplicates that later hardening work.

---

## 4. Architecture notes / decisions made this phase

- **No page reload was needed**, so none was added. The plan allowed
  a full reload as a fallback "if the existing map already supports
  adding a marker without reload" was false — it wasn't false here:
  napmap.js's subscriber marker layer (`allSubscribers` +
  `renderSubscriberMarkers()`, from the prior Navigation/Route-Line
  plan's Phase 23) already exists precisely for plotting subscribers
  from an in-memory dataset. The only gap was that this dataset and
  those functions live inside napmap.js's own closure, invisible to
  `nap-install-planner.js` — closing that gap is the entire content of
  `addSubscriberMarker()`.
- **`addSubscriberMarker()` lives on the existing
  `window.NapIQMapModes` object**, not a new global. That object
  already exists as napmap.js's one sanctioned "outside world" surface
  (`exitPlacementModes()`), and this is the same shape of thing: a
  small, purpose-built entry point for another script to reach into
  napmap.js's private state, not a general-purpose API.
- **`resetPlanningModeChrome()` is shared**, not duplicated, between
  `exitPlanningMode()` and `finishAfterCreate()`. Both need the exact
  same button/banner/cursor reset; only what happens to the
  Installation Planner card itself differs (hidden in one case, given
  the "done" step's content in the other) — see §2's "small,
  deliberate difference" note above for why they can't just both call
  `exitPlanningMode()` outright.
- **The subscriber entry pushed into `allSubscribers` only carries the
  fields that endpoint's shape (`/api/subscribers`) already exposes**
  (`id`, `subscriber_code`, `full_name`, `address`, `latitude`,
  `longitude`, `nap_id`) — not the extra `plan_type`/`status`/
  `nap_code` fields `quick_add_subscriber()`'s response happens to
  include, so the shape in `allSubscribers` stays exactly what the
  rest of napmap.js (marker rendering, the destination-search index,
  the Report-Issue subscriber `<select>`) already expects, with
  nothing extra riding along unused.

---

## 5. Verification performed

### Automated
```
$ node --check app/static/js/nap-install-planner.js
(no output — passes)

$ node --check app/static/js/napmap.js
(no output — passes)

$ python3 -m py_compile $(find app -name "*.py") run.py dev_seed_server.py
(no output — no .py file was touched this phase; whole app still
compiles cleanly)
```

### Known limitation — automated test suite and a live/manual pass
could not be run this phase

Unlike Phases 2–5 of this plan, this sandbox environment currently has
**no outbound network access**, and the Python dependencies this
project needs (`Flask-SQLAlchemy`, `Flask-WTF`, `Flask-Limiter`,
`PyMySQL`, `pytest`, etc. — see `requirements.txt`) are not already
installed in it. `pip install -r requirements.txt` fails with
"Could not find a version that satisfies the requirement Flask==3.0.3
(from versions: none)" for every package. As a direct consequence:
- The existing `pytest` suite (previously reported as 130 passed / 3
  pre-existing, unrelated failures as of
  `PLAN_INSTALL_70_PERCENT_NOTES.md`) could not be re-run this phase
  to confirm no new regressions.
- A live `app.test_client()` pass (the "real seeded instance" method
  Phases 2–5 all used) and a real browser/manual pass were both not
  possible for the same reason.

This is a harder limitation than the "no Chromium binary" one
documented in Phases 3–5 (which still allowed the Flask/JSON layer to
be exercised directly) — no part of the Flask application can be
imported or run in this environment right now. Since this phase's
actual code changes are JavaScript-only and touch no route, model, or
form, the verification performed instead was:
- Both syntax checks above.
- A manual, line-by-line trace of the new/changed functions against
  the existing code they call into (`renderSubscriberMarkers()`,
  `hideInstallPlannerCard()`, `showNavigationCard()`,
  `clearProposedMarker()`'s prior behavior) to confirm the new
  `addSubscriberMarker()`/`finishAfterCreate()`/`renderDoneStep()`
  functions call only functions/elements that already exist with the
  signatures/behavior this phase assumes, and that the response shape
  `quick_add_subscriber()` (Phase 5, unmodified) already returns
  contains every field `renderDoneStep()` and `addSubscriberMarker()`
  read from it.
- Confirming (via `find . -newer PLAN_INSTALL_70_PERCENT_NOTES.md
  -type f`) that only the two intended files were modified this
  phase — no accidental edits elsewhere.

**This is a real, outstanding gap** for this phase specifically: the
plan's own "run the existing automated test suite" and "verify the
feature manually if possible" steps could not be completed in this
environment. If a network-enabled environment (or one with the
dependencies pre-installed) becomes available, `pytest -q` and a
`test_client()`-driven pass through the same scenario Phase 5 already
proved (drop a pin → suggestion → form → submit) should be re-run,
this time watching specifically for: the "done" step rendering with
the correct code/NAP-code, the new subscriber marker appearing at the
dropped pin's exact coordinates with the "Show Subscribers" toggle
turned on automatically, and the pin/planning-mode UI being fully
reset immediately (not just after "Done" is clicked).

---

## 6. Acceptance criteria check

- [x] The newly created subscriber is visibly on the map afterward,
      sourced from the real database (not just held in local JS
      state) — `addSubscriberMarker()` is only ever called with the
      actual JSON `subscriber` object `POST /subscribers/quick-add`
      returned after committing the row to MySQL/SQLite, and it feeds
      that into the same `allSubscribers`/`renderSubscriberMarkers()`
      path every other real, database-sourced subscriber marker on
      this map already uses — no fabricated or client-only marker is
      drawn. *(Confirmed by code trace; not confirmed by a live
      render — see §5's environment limitation.)*
- [x] Planning mode and the pin both cleanly reset — `finishAfterCreate()`
      removes the pin's `L.Marker` from the map, clears
      `proposedMarker`/`proposedLatLng`, and calls the same
      `resetPlanningModeChrome()` logic `exitPlanningMode()` uses for
      its button/banner/cursor reset, all immediately on a successful
      create (see §2's sequencing note).
- [x] No orphaned pin/marker/panel remains after closing — clicking
      "Done" calls the existing `hideInstallPlannerCard()` (hides and
      empties `#installPlannerCard`, clears `currentSuggestionNap`)
      and `showNavigationCard()`; the pin was already removed the
      moment the create succeeded, not deferred to "Done".
- [ ] **Live/automated confirmation of all of the above is still
      outstanding** — see §5's environment-limitation note. Code-level
      verification was performed; execution-level verification was
      not possible in this sandbox.

---

## 7. Files changed this phase (confirmed diff scope)

- `app/static/js/napmap.js` (additive: one new method on the existing
  `window.NapIQMapModes` object)
- `app/static/js/nap-install-planner.js` (additive: three new
  functions, one existing function's body factored to share logic
  with a new one, one existing function's success branch changed to
  call the new flow, doc-comment updates)
- `PLAN_INSTALL_85_PERCENT_NOTES.md` (new file, this one)

No model, form, route, template, or database schema/migration was
touched this phase.

---

**STOP.** This is the end of Phase 6 (85%). Phase 7 (error handling,
edge cases, and RBAC hardening) is intentionally not started.
