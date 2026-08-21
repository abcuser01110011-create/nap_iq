# Phase 8 — Manual origin picker — adapted onto this project's actual navigation code

## 1. Why this isn't a straight file copy

You supplied two zips:

- `nap_iq_PHASE8_50pct_manual_origin_picker.zip` — a delta meant to
  apply on top of a "Phase 5–7" navigation stack: `nav-card.js`,
  `nav-origin.js`, `nav-routing.js`, an OSRM road-routing engine, and
  a `napiq:origin-changed` listener already wired into all of that.
- `nap_iq_phase23_15pct_FULL_PROJECT.zip` — this project, whose actual
  navigation feature (`nav-destination.js`, Phase 23, 15%) is a
  completely different, simpler build: destination selection only,
  explicitly "no road routing, no GPS, no demo travel" per
  `PHASE23_15_PERCENT_NOTES.md`. There is no `nav-card.js`,
  `nav-origin.js`, `nav-routing.js`, or routing engine anywhere in
  this project — `map.html` only ever loaded `nav-destination.js` and
  `napmap.js`.

The Phase 8 delta's prerequisite files simply don't exist here, so it
could not be applied as a drop-in patch — doing so would have added
JS files wired to hook points, DOM ids, and a routing engine that
this project never built. Per your instruction, this delivery instead
**adapts the Phase 8 origin-picker feature itself** (pick a starting
point by clicking the map; temporary marker; confirm/cancel; clear)
onto this project's real architecture.

## 2. What was added

| File | Status | Change |
|---|---|---|
| `app/static/js/nav-origin.js` | **New** | Origin store + "Navigation origin" sidebar panel, modeled on `nav-destination.js`'s own store+panel pattern. Supports manual lat/lng entry (its own small form) and `setOriginPoint()` for the map-click picker. Fires `napiq:origin-changed` and `napiq:navorigin-panel-rendered`. |
| `app/static/js/nav-origin-picker.js` | **New** | The actual Phase 8 map-click picker, ported from the original delta: arms a one-time map click listener, drops a temporary pin+flag marker, confirm/cancel, keeps a solid marker in sync with whatever the store holds. Renders into `nav-origin.js`'s `#navOriginPickerControls` instead of the original delta's `nav-card.js` hook points. |
| `app/static/js/napmap.js` | **Modified (additive)** | Exposes `window.NapIQMap` (the previously closure-private Leaflet instance) and fires `napiq:map-ready`, so the picker can actually find and use the map — the original delta's blocker ("`napmap.js` not supplied") no longer applies. Also added: `enterAddMode()` / `enterIssueMode()` now cancel an active origin pick, and a new `window.NapIQMapModes.exitPlacementModes()` lets the picker cancel Add-NAP / Report-Issue mode back — closing the "no coordination with napmap.js's click-to-place modes" gap the original delta explicitly flagged as unsolved. |
| `app/static/css/napmap.css` | **Modified (additive)** | `#napMap.origin-pick-mode-cursor`, `.nav-origin-marker-pending` (reuses this project's existing `nap-pending-pulse` keyframes), `.nav-origin-marker-wrap`. |
| `app/templates/naps/map.html` | **Modified (additive)** | New "Navigation origin" section in the same sidebar card as "Navigation destination" (`<hr>` + label + `#navOriginPanel`). Two new `<script>` tags, loaded after `napmap.js`. |

No existing route, model, template block, or JS function was removed.
`nav-destination.js`, `app/navigation_contract.py`, and every existing
map feature (Add NAP, Report Issue, NAP/issue/subscriber layers,
destination selection) are untouched in behavior.

## 3. Design differences from the original Phase 8 delta

- **Origin shape is flat**, matching `nav-destination.js`'s
  `position: {lat, lng}` convention — the original delta nested
  coordinates the same way for `setOriginPoint()` but kept a
  top-level `.lat`/`.lng` for backward compatibility with a Phase 5
  lat/lng form that doesn't exist in this project, so that
  compatibility shim was dropped.
- **One render target, not two.** The original delta split the
  picker's UI across `nav-card.js`'s `#navCardOriginPickerStatus` and
  `#navCardPickOriginBtnHost`. Since there's no `nav-card.js` here,
  `nav-origin.js` provides a single `#navOriginPickerControls`
  container (present in both its empty and confirmed states) and
  fires `napiq:navorigin-panel-rendered` after every rebuild —
  `nav-origin-picker.js` listens for that instead of the original
  `napiq:navcard-rendered`.
- **Placement-mode coordination now actually works.** The original
  delta's notes explicitly listed "no coordination with napmap.js's
  Add NAP / Report Issue modes" as unfinished, because `napmap.js` had
  never been supplied to that translation project. It has been here,
  so `enterAddMode()`/`enterIssueMode()` and the picker's
  `startPicking()` now mutually cancel each other, matching the
  existing "only one placement mode at a time" rule those two modes
  already enforced between themselves.
- **No routing engine.** Neither the original delta's "second half"
  scope nor this adaptation add OSRM/road routing — there wasn't one
  in this project before, and adding one wasn't part of what you
  asked for. `nav-origin.js` stores and displays the origin so a
  future routing phase (see `nav-destination.js`'s own note about
  "future navigation code") can read `NapIQNavOrigin.getOrigin()` /
  `NapIQNavigation.getDestination()` and listen for both
  `-changed` events.

## 4. What was verified

- `node --check` passed on all three changed/added JS files.
- Every DOM id referenced via `getElementById()` in `nav-origin.js`
  and `nav-origin-picker.js` cross-checked against the ids each file
  (or `map.html`) actually produces — confirmed no mismatches.
- Every `CustomEvent` name dispatched cross-checked against every
  listener across `nav-origin.js`, `nav-origin-picker.js`, and
  `napmap.js` — confirmed no mismatches.
- Every `window.NapIQ*` global cross-checked between where it's
  defined and where it's referenced, with load-order guards
  (`if (window.X)`) at every reference that could plausibly run
  before its definition exists.
- `app/templates/naps/map.html` parsed cleanly with Jinja2's parser
  (structural check only — no live render, see below).
- `app/static/css/napmap.css` brace-balance checked.

**Not verified:** against a live Flask server / real database. This
sandbox has no network access, and the project's own Python
dependencies (`flask_wtf`, etc.) aren't installed and couldn't be
fetched, so the existing `verify_phase23_15pct_live.py`-style
end-to-end check could not be run this time. Recommend running it (or
just opening `/naps/map` in dev) after applying this before treating
it as fully confirmed — the static/logic checks above give high
confidence the wiring is correct, but they're not a substitute for
seeing it click in a real browser against a real map.

## 5. Try it

Once verified live: open `/naps/map`, look for the new "Navigation
origin" section under "Navigation destination" in the left sidebar
card. Click "Pick on map," then click anywhere on the map — a dashed
amber/emerald pin+flag marker appears; "Use this point" confirms it
(marker turns solid), "Cancel" or `Esc` discards it. Starting an
Add-NAP or Report-Issue placement cancels an in-progress origin pick,
and vice versa. Typing valid coordinates into the Lat/Lng fields and
submitting sets the origin the same way.
