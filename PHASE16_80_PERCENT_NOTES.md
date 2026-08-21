# PHASE 16 — 80% — Prototype UI Parity

**Status: implemented. Verified against the real markup + real CSS in an
isolated static preview (see §5) rather than a live Flask/MySQL server —
network egress was off this round, so `pip install -r requirements.txt`
could not complete (`flask_sqlalchemy` etc. are not present in this
sandbox and PyPI was unreachable) and the app could not actually be
booted. See §6 for exactly what that does and doesn't cover.**

---

## 1. Scope

This phase is a **visual polish pass only**, per the plan: bring the
navigation experience (nav-card.js, nav-routing.js, nav-origin.js,
nav-origin-picker.js, nav-gps-origin.js, nav-technician-origin.js,
nav-demo-travel.js, nav-technician-marker.js, nav-route-progress.js /
nav-gps-route-progress.js — everything shipped in Phases 4–15) visually
closer to the prototype's `NavigationCard.tsx` / `RouteDetails.tsx` /
`OriginPicker.tsx`, using NAP-IQ's existing Bootstrap design system
rather than the prototype's Tailwind/dark-HUD styling.

**No JS behavior, DOM ids, event names, or markup structure changed.**
Every `nav-*.js` file's rendering logic, state machine, and public
surface (`window.NapIQNavCard`, `window.NapIQNavigation`,
`window.NapIQNavOrigin`, `window.NapIQNavDemoTravel`, etc.) is
byte-for-byte unchanged except for the one cosmetic class addition
described in §3.

## 2. Files changed

| File | Change |
|---|---|
| `app/static/css/napmap.css` | **Additive.** New "Phase 16" section appended: elevated card/pill shadows, gradient header, thin scrollbar, progress-bar restyle, monospace coordinate tightening, entrance-animation keyframes, a tablet breakpoint (577–991px) that didn't exist before, and a phone bottom-sheet refinement. Also restores the standard Bootstrap 5 `.min-w-0` utility (see §4 — this class was missing from this project's vendored Bootstrap build and several existing nav-\*.js files depend on it). Nothing above the new section was touched. |
| `app/static/js/nav-card.js` | **Additive, one line of substance.** The outer `<div class="card ...">` rendered by `renderExpandedCard()` and `renderCollapsedPill()` now also carries a `nav-card-enter` class (styled in the CSS above) so the card fades/slides in on every render — the Bootstrap-native stand-in for the prototype's `framer-motion` entrance animation on `NavigationCard`. A short comment was added to the file's header docblock noting this. No other line changed. |
| `PHASE16_80_PERCENT_NOTES.md` | **New.** This file. |
| `phase16_screenshots/` | **New.** Two illustrative screenshots — see §5. |

`app/templates/naps/map.html` was **not** changed — the existing
`#navigationCard` container and script-load order already support
everything above without modification.

## 3. What actually changed, visually

- **Elevation.** `.nav-card`'s Bootstrap `.card` now gets a real
  two-layer shadow (`0 14px 34px … / 0 3px 10px …`) and slightly larger
  corner radius instead of Bootstrap's flat `.shadow-sm`, so it reads as
  a floating panel over the map rather than an inline card — closer to
  the prototype's `shadow-2xl` HUD without adopting its dark theme.
- **Collapsed pill** gets the matching elevated treatment so
  expand/collapse doesn't feel like switching between two different
  visual systems.
- **Header** gets a very subtle white→off-white gradient and a hairline
  blue-tinted bottom border instead of a flat white bar.
- **Entrance motion.** `nav-card-enter` (0.22s fade + translateY(8px),
  disabled under `prefers-reduced-motion`) plays each time nav-card.js
  rebuilds the card — on destination change, expand/collapse, and every
  re-render other modules trigger via `napiq:navcard-rendered`.
- **Progress bars** (route completion in nav-routing.js, demo travel /
  GPS progress) are now thinner (0.5rem) and fully rounded instead of
  Bootstrap's default square-cornered 1rem bar.
- **Coordinate readouts** (`.font-monospace` lat/lng pairs used
  throughout nav-routing.js, nav-origin.js, nav-card.js,
  nav-destination.js) are slightly smaller/tighter so they read as
  secondary technical detail, not competing with labels — matching the
  prototype's muted mono coordinate styling.
- **Thin scrollbar** on the card body instead of the browser default,
  echoing the prototype's `.thin-scroll`.
- **Responsive — tablet (577–991px):** new; previously the card jumped
  straight from a fixed 340px to full-width at 576px with nothing in
  between. Now it steps down to 300px with a shorter max body height.
- **Responsive — phone (≤576px):** the card was already full-width; it
  now also gets top-only rounded corners (reads as a bottom sheet, not
  a floating box with two exposed bottom corners), the stat/coordinate
  rows get explicit row-gap so they don't visually collide, and demo
  travel's button row wraps into a proper 2-up grid instead of five
  buttons squeezed onto one line.
- **Very narrow phones (≤360px):** the four-stat route-details grid
  (distance / duration / ETA / remaining) drops to one column so none
  of the numbers get clipped.

## 4. Bug found and fixed during this pass

Building the illustrative preview (§5) surfaced a real, pre-existing
layout bug: `nav-card.js`, `nav-destination.js`, and `nav-origin.js` all
use Bootstrap 5's `.min-w-0` utility class to let a flex child (the
title/label side of a header or summary row) shrink and truncate
instead of pushing its non-shrinking sibling (a status badge, a clear
button) past the card's own edge. **This project's vendored
`bootstrap.min.css` does not define `.min-w-0`** — confirmed by
grepping the vendored file, which has `.text-truncate` but no
`.min-w-0` rule at all. Without it, `min-width` stays at the flexbox
default (`auto`), the title never actually shrinks, and the sibling
badge/button gets shoved outside the card's rounded border instead of
wrapping or truncating.

This was visible in the preview as the admin heading ("Live Technician
Tracking") plus the "Awaiting route" status badge overflowing the
340px card. Fixed by adding the standard Bootstrap 5 definition
(`.min-w-0 { min-width: 0 !important; }`) to `napmap.css`, which
retroactively fixes every existing call site in all three files with a
single CSS rule — no JS changes needed. Confirmed fixed in the
before/after preview screenshots (before/after not shipped — only the
final, fixed state is in `phase16_screenshots/`, to avoid shipping a
screenshot of a bug that no longer exists in this build).

## 5. Verification performed

Network egress was off this round (confirmed: `pip install -r
requirements.txt` failed to reach PyPI, and `flask_sqlalchemy` /
`pytest` / a MySQL server are not present in this sandbox), so the
actual Flask app could not be started and a real end-to-end screenshot
against live data was not possible.

Instead, verification used the **real, unmodified files**:

1. The real `app/static/css/napmap.css` (with this phase's additions).
2. The real vendored `bootstrap.min.css` / `bootstrap-icons` this
   project already ships (not a CDN — egress is off).
3. A standalone HTML page containing **the exact markup strings**
   `nav-card.js` / `nav-routing.js` / `nav-demo-travel.js` render
   (copied from their source, with representative sample data standing
   in for what would normally come from `window.NapIQNavigation`,
   OSRM, and the demo-travel/GPS progress stores), reproducing the
   "destination selected → route ready → demo travel running" state.
4. Rendered with Playwright/Chromium at a desktop width (1360px) and a
   phone width (390px, iPhone-class) to check the new tablet/phone
   responsive rules and the elevated card/pill styling.

This is **illustrative, not a live-data screenshot** — both images are
labeled as such directly on the image and in their filenames — but it
does exercise the real CSS file and the real per-module markup shapes,
which is how the `.min-w-0` bug above was actually found (it would not
have been visible from code review alone).

`node --check app/static/js/nav-card.js` passes. `python3 -m py_compile`
across `app/` passes (no Python was touched this phase, but re-run for
safety). CSS brace-balance checked programmatically (83 open / 83
close).

Screenshots:
- `phase16_screenshots/01_navcard_desktop_parity_illustrative.png`
- `phase16_screenshots/02_navcard_mobile_bottomsheet_illustrative.png`

## 6. What this phase does **not** claim

- Does **not** claim the app was run live, that MySQL-backed data was
  rendered, or that a browser hit an actual `/naps/map` route this
  round — egress was off, so none of that was possible. This mirrors
  how earlier rounds in this project (e.g. `PHASE21_NOTES.md`) have
  explicitly reported egress on/off status rather than implying a live
  run happened when it didn't.
- Does **not** touch OSRM routing, GPS, demo travel, dispatch, RBAC, or
  any backend/API logic — those are all Phases 5–15 and are unchanged.
- Does **not** add new navigation features. Everything visible in the
  screenshots is a state Phases 4–15 already produce; this phase only
  restyled it.
- Full live browser verification (real login, real map, real OSRM
  route, resize to actual tablet/phone breakpoints against the running
  app) is still outstanding and should be the first thing done in a
  session where egress/DB access is available, before Phase 17.

## 7. Acceptance criteria check

| Criterion | Status |
|---|---|
| Navigation UI feels like the prototype (elevated floating panel, soft entrance motion, tight info density) | Done, in the Bootstrap idiom — see §3 |
| Existing NAP-IQ interface still feels like the same application (light Bootstrap theme kept, no Tailwind/dark HUD introduced) | Done |
| No duplicate navigation systems exist | Confirmed — no new containers, ids, or JS modules added; only CSS + one class on an existing element |
| Responsive behavior is acceptable (desktop / tablet / phone) | Improved — new explicit tablet breakpoint added, phone layout hardened (bottom-sheet corners, button wrap, narrow-phone single-column stats) |

## Known limitations

- Not verified against a live server this round (see §6).
- Tablet/phone breakpoints were chosen from the existing 576px
  convention already used elsewhere in `napmap.css`, not from a design
  spec — worth a real-device check once the app can be run live.
- The `.min-w-0` fix (§4) is scoped to restoring the missing utility
  class; it was not audited for whether other Bootstrap utility classes
  might be missing from the same vendored build. Worth a quick audit in
  a later hardening phase (18 is explicitly scoped for this kind of
  thing).
