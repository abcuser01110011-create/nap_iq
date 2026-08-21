# Translation Project — Phase 4 (20%): Navigation UI Foundation

Source prototype: `napV4-route line` (2) — `src/components/navigation/NavigationCard.tsx`
Target: `nap_iq_phase23_15pct_FULL_PROJECT` (Flask + SQLAlchemy + MySQL + Jinja + Bootstrap + Leaflet)

## What this phase actually implements

A floating **Navigation Card** on the GeoMap page (`/naps/map`), translated from
the prototype's `NavigationCard.tsx` into vanilla JS + Bootstrap — UI shell
only, no routing/GPS/demo-travel logic yet (that's out of scope for this
phase; see "Not implemented" below).

### New file
- `app/static/js/nav-card.js` — renders the card into `#navigationCard`.
  Reads from the **existing** `window.NapIQNavigation` destination store
  (shipped in Phase 23 / `nav-destination.js`) instead of keeping its own
  copy of state, so the new floating card and the existing sidebar
  "Navigation destination" panel always agree with each other.

### Modified files (additive, backward compatible)
- `app/templates/naps/map.html` — wrapped `#napMap` in a new
  `.napmap-shell` div (for CSS positioning only) and added the
  `#navigationCard` container + a `<script>` tag for `nav-card.js`.
  Nothing existing was removed or restructured; `#napMap` itself,
  the sidebar panel, filters, modals, and legend are all untouched.
- `app/static/css/napmap.css` — appended CSS for `.nav-card` and its
  sub-elements. No existing rules were changed.

### Dev-only (not shipped as an app feature)
- `smoke_test_phase4.py` — ad-hoc script (in-memory SQLite, not
  MySQL) that logs in as an admin and asserts the GeoMap page still
  renders 200 with both the old and new markup present. Not part of
  `tests/` / the pytest suite; just how this phase was checked.

## What the card shows right now

- **Destination summary** — type badge, label, subtitle, lat/lng — for
  whatever is currently selected via `NapIQNavigation` (i.e. via an
  existing "Set as destination" popup button on a NAP/issue/subscriber
  marker; that flow is unchanged from Phase 23).
- **Status badge** — "Idle" (no destination) or "Awaiting route"
  (destination selected, no route computed).
- **Route status placeholder** — explicit "no route calculated yet /
  routing isn't available in this build" message. **No fabricated
  distance, ETA, or route line is ever shown.**
- **Controls container** (`#navCardControls`) — currently holds only an
  italic note that future controls (demo travel, device GPS, retry,
  origin picker) will appear there. No disabled/fake buttons.
- **Collapse/expand** — mirrors the prototype's minimized-pill
  behavior; a small pill in the bottom-right shows "Idle" /
  "Destination selected" when collapsed.
- **Clear destination** button — real, functional, calls the same
  `NapIQNavigation.clearDestination()` the sidebar panel already used.

## Acceptance criteria check

- [x] Navigation card appears in the existing map page.
- [x] It does not break existing NAP/issue map controls (verified via
      smoke test + full pytest run — see below).
- [x] No fake route is displayed as a real route (route section is
      text-only placeholder copy, no numbers).
- [x] Empty/idle state is handled cleanly (explicit "no destination
      selected" message, distinct from the "destination selected, no
      route yet" message).

## Verification performed

1. `node --check` on all three JS files (`nav-destination.js`,
   `nav-card.js`, `napmap.js`) — pass.
2. Jinja parse of `naps/map.html` — pass.
3. `smoke_test_phase4.py` against an in-memory SQLite DB: GET
   `/naps/map` as an authenticated administrator returns 200 and both
   old markup (sidebar panel, Add NAP button, Report Issue button,
   `#napMap`) and new markup (`.napmap-shell`, `#navigationCard`,
   `data-role`) are present.
4. Full existing pytest suite (`tests/`): **111 passed**, 3 failed.
   The 3 failures were reproduced against the untouched, unmodified
   `nap_iq_phase23_15pct_FULL_PROJECT.zip` baseline and are **pre-existing,
   unrelated to this phase** (`test_reports_phase23.py::test_new_issue_reported_notification_staff_route`,
   `test_new_issue_reported_notification_customer_route`,
   `test_technician_workflow.py::test_reports_page_shows_technician_workload`).
5. Rendered the real page with Playwright (screenshots): idle state,
   destination-selected state (simulated via a realistically-shaped
   destination object, the same shape `napmap.js` builds from real
   NAP/issue/subscriber rows), and the collapsed pill state. Confirmed
   the floating card and the existing sidebar panel update in sync
   from the same store.

## Not implemented (explicitly out of scope this phase, per the phase spec)

- Real road routing (OSRM or otherwise) — `RouteDetails.tsx` equivalent
- Progress tracking / demo travel simulation
- Device GPS tracking
- "Retry route" action
- Origin selection (`OriginPicker.tsx` equivalent)

These are reserved for later phases; `#navCardControls` and
`#navCardRouteStatus` are stable, documented hook points
(`window.NapIQNavCard.elements()`) for them to build on without
rewriting this file.

## Remaining limitations

- The card is currently always rendered for any authenticated user
  who can reach `/naps/map` (administrators and technicians, per
  `_VIEW_ROLES` in `app/routes/naps.py`); it does not yet hide itself
  for roles that shouldn't navigate (e.g. it will render for both
  roles with only a title-text difference, matching the prototype's
  own role handling, but this hasn't been product-reviewed).
- No persistence of collapse/expand state across page reloads
  (in-memory only, resets on refresh) — matches the prototype's own
  behavior (React state, not persisted either).
