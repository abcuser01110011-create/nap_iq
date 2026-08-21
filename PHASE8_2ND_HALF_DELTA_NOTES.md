# Phase 8 — manual origin picker — second half (delta)

Applies on top of the already-adapted first half (see
`PHASE8_ORIGIN_PICKER_ADAPTED_NOTES.md`, already in your project — not
re-included here since it's unchanged). This delta contains only the
files actually modified this round.

## Files in this zip

| File | Status |
|---|---|
| `app/static/js/nav-origin.js` | Modified |
| `app/static/js/nav-origin-picker.js` | Modified |
| `app/static/css/napmap.css` | Modified (additive) |
| `app/static/js/napmap.js` | **Unchanged**, included only so the delta is drop-in-complete; its Phase 8 hooks (`enterAddMode()`/`enterIssueMode()` yielding to the picker, `window.NapIQMapModes.exitPlacementModes()`) were already correct from the first half and were re-verified live, not re-written. |
| `app/templates/naps/map.html` | **Not included** — nothing needed to change in it this round. |
| `verify_phase8_2nd_half_live.py` | New — the live Playwright check described below. |
| `phase8_2nd_half_screenshots/*.png` | New — output of that check. |

## 1. Reconciling the map-click picker with the lat/lng form

There's no separate "Phase 5 lat/lng origin form" in this project —
that was the original delta's own prerequisite, and it doesn't exist
here (see the first-half notes). The actual lat/lng entry point is the
small form already living inside `nav-origin.js`. Previously that form
only rendered while no origin was set, and vanished the moment one
existed — so map-click and lat/lng entry could never influence each
other's *visible state*, only the same underlying store.

Now:
- The form renders in **both** the empty and confirmed states,
  pre-filled with the current origin's coordinates.
- `nav-origin.js` exposes two new methods:
  `NapIQNavOrigin.previewCoordinates(lat, lng)` and
  `NapIQNavOrigin.refreshCoordinateFields()`. The picker calls the
  first the instant a map click drops a pending marker, so the fields
  show that point live before it's even confirmed; it calls the
  second on every cancel path, so a discarded pick doesn't leave stale
  numbers behind — the fields fall back to whatever the store actually
  holds. Neither ever overwrites a field the user is actively typing
  into (checked via `document.activeElement`).
- Submitting valid coordinates always calls the existing `setOrigin()`
  — which already replaced `selectedOrigin` and re-broadcast
  regardless of whether one existed before — so typing new numbers
  over an already-picked point moves the marker; no separate "edit"
  code path was needed.

## 2. napmap.js coordination — re-verified, not re-built

The first half's `enterAddMode()`/`enterIssueMode()` → picker
`stopPicking()`, and `window.NapIQMapModes.exitPlacementModes()` →
picker `startPicking()`, integration was already correct. This round
re-confirmed it with a real click-through (see verification below:
starting a pick, then clicking "Add NAP", cancels the pick) rather
than re-implementing anything.

## 3. Polish

- **Coordinate tooltip**: both the pending (amber) and confirmed
  (emerald) origin markers now carry a permanent Leaflet tooltip
  showing their lat/lng, via a new `bindCoordTooltip()` helper in
  `nav-origin-picker.js`. Styled in `napmap.css`
  (`.nav-origin-tooltip`, `.nav-origin-tooltip-pending`).
- **Destination cleared while a point is pending**: this project's
  destination selection (`nav-destination.js`) is a popup-button
  click, not a map-click placement mode like Add NAP / Report Issue —
  it never actually contends with the picker's map-click listener or
  DOM, so there was no live bug to reproduce here. `napiq:destination-
  changed` is still wired defensively per the instruction: if a manual
  origin pick is pending (unconfirmed) when the destination is
  cleared, it's cancelled cleanly.
- **Keyboard/Esc accessibility**: Confirm/Cancel/Pick were already
  native `<button>`s (Enter/Space worked), but `#navOriginPickerControls`
  is torn down and rebuilt on every render, which silently dropped
  focus. Each user-initiated action (start picking, a map click
  landing a pending point, confirm, cancel, Esc) now explicitly
  refocuses the button that makes sense next — most importantly, the
  Confirm button is focused the instant a point becomes pending, so a
  keyboard user can immediately Tab to Cancel or press Escape without
  hunting for it. The status region also carries
  `aria-live="polite"` so state changes are announced either way.

## 4. Verification

- `node --check` passed on both changed JS files.
- Every `getElementById()` id referenced was cross-checked against
  every id actually produced by `nav-origin.js`/`nav-origin-picker.js`
  — no mismatches (the two "referenced but not defined in these two
  files" hits, `napMap` and `navOriginPanel`, are template-provided
  containers, as before).
- Every `CustomEvent` name dispatched was cross-checked against every
  listener across `nav-origin.js`, `nav-origin-picker.js`,
  `napmap.js`, and `nav-destination.js` — no mismatches.
- **This time the sandbox had PyPI access**, so — unlike the first
  half — this could go beyond static checks: Flask, Flask-SQLAlchemy,
  Flask-WTF, Flask-Limiter, and Playwright (with a real Chromium
  binary) were installed, and `verify_phase8_2nd_half_live.py` runs
  the actual app (SQLite-backed, real routes, real templates) behind a
  real headless browser and drives the full flow:
  1. Load `/naps/map` as `admin1`; confirm the lat/lng form is present
     alongside the "Pick on map" button in the empty state.
  2. Click "Pick on map", click the map; confirm the pending marker,
     amber tooltip, Confirm/Cancel buttons, and **live-updated lat/lng
     fields** all appear, and that keyboard focus lands on Confirm.
  3. Confirm the point; check the form is now pre-filled with the
     confirmed position and the tooltip switched to the confirmed
     (emerald) style.
  4. Type new coordinates into the form and submit; confirm the
     existing marker **moved** rather than a second one appearing.
  5. Pick again, drop a point, press **Escape**; confirm the pending
     state is cleared and the lat/lng fields revert to the still-
     confirmed (moved) origin, not the discarded pick.
  6. Start picking, then click "Add NAP"; confirm the origin pick is
     cancelled by the mode switch, re-verifying the napmap.js
     integration live.
  All checks passed (`verify_phase8_2nd_half_live.py`'s JSON output —
  every boolean `true`, no unexpected console errors). Screenshots for
  each step are in `phase8_2nd_half_screenshots/`.

**Not verified:** MySQL specifically (the live check uses SQLite, same
tradeoff as this project's own `verify_phase23_15pct_live.py`), and no
manual mouse/keyboard pass by an actual person — the Playwright run
exercises real clicks, real Escape key events, and real DOM state, but
it isn't a substitute for someone clicking through it once by hand.

## Try it

Open `/naps/map`. In the "Navigation origin" section: click "Pick on
map," click the map — the amber pending marker's tooltip and the
Lat/Lng fields update together. Click "Use this point" (or press Esc
to back out — try it, focus is already on Confirm so Escape works
immediately). Once confirmed, edit the Lat/Lng fields and submit to
move the same marker instead of creating a new one. Starting "Add NAP"
or "Report an Issue" cancels an in-progress pick, and vice versa,
unchanged from the first half.
