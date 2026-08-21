# PHASE 3 — 40% — "Plan Installation" Map Mode

**Status:** Phase 3 of the Installation Planning integration (follows
`PLAN_INSTALL_10_PERCENT_NOTES.md`'s architecture decision and
`PLAN_INSTALL_25_PERCENT_NOTES.md`'s data contract). This phase adds
**UI only**: an admin-only "Plan Installation" toggle and pin-drop
interaction. No suggestion panel, no subscriber creation. Per the
plan's own instruction, nothing beyond this phase's scope was added.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `app/templates/naps/map.html` | **Additive.** One new admin-gated button (`#planInstallModeBtn`, next to Add NAP / Report an Issue) and one new admin-gated mode banner (`#planInstallModeBanner`), both wrapped in `{% if current_user and current_user.role == 'administrator' %}`. One new admin-gated `<script>` tag loading the new JS module below. |
| `app/static/js/nap-install-planner.js` | **New.** Self-contained IIFE module implementing planning-mode enter/exit, pin drop/move/clear, and the mutual-exclusion handshake with the existing placement modes. |
| `app/static/js/napmap.js` | **Additive, 3 small edits.** `enterAddMode()` and `enterIssueMode()` each gained one guarded call (`if (window.NapIQInstallPlanner) window.NapIQInstallPlanner.exitPlanningMode();`), and `window.NapIQMapModes.exitPlacementModes()` gained the same guarded call. No existing line was removed or altered. |
| `app/static/css/napmap.css` | **Additive.** One new cursor rule (`#napMap.plan-install-mode-cursor`) and two new rule blocks for the marker wrapper and its tooltip, appended after the existing `nav-origin-tooltip` block. Nothing above it was touched. |
| `PLAN_INSTALL_40_PERCENT_NOTES.md` | **New.** This file. |

Nothing else changed. No Python file, no route, no model, and no
database schema was touched this phase — this is a pure frontend/
template addition, matching the plan's "no NAP recommendation logic
or subscriber creation yet" scope for Phase 3.

---

## 2. What it does

- A magenta **"Plan Installation"** button appears in the map's
  top-right floating control group, but **only for administrators**
  (Jinja-gated — the button, its banner, and the whole JS file are
  absent from the HTML entirely for a technician; confirmed in §5).
- Clicking it enters **planning mode**: the button turns into an
  outline-danger "Cancel Plan Installation" button, an info-colored
  banner appears ("Tap anywhere on the map to drop a prospect pin for
  a potential subscriber location."), and the map cursor becomes a
  crosshair.
- Clicking anywhere on the map while in planning mode drops a
  **magenta diamond pin** with a small house glyph — a shape *and*
  color used by no other marker on this map (NAP: teardrop/varies by
  status; Issue: triangle; Subscriber: purple circle; Customer-
  recommendation: purple teardrop; Navigation origin: emerald
  teardrop-with-checkmark). The pin carries a permanent tooltip
  showing its coordinates, and the banner text updates to
  "Prospect pinned at `<lat, lng>`. Click elsewhere to move it, or
  Cancel to clear."
- Clicking elsewhere while a pin is already down **moves** it (same
  "click again to reposition" convention Add-NAP/Report-Issue already
  use) rather than dropping a second pin.
- Clicking **Cancel** (or the toggle button again) clears the pin and
  exits planning mode cleanly — button, banner, and cursor class all
  revert; the marker and its tooltip are removed from the map, not
  just hidden.
- **No suggestion panel appears** and **no subscriber is created** —
  both deliberately deferred to Phases 4 and 5.

---

## 3. Mutual exclusion with existing placement modes

Per the plan's acceptance criteria ("the two must not conflict or be
confusable if both are ever active" / "no conflict with the existing
navigation origin-picker's own click mode"), Plan Installation mode
was wired into the **existing** yield chain rather than adding an
uncoordinated fourth click handler:

- **Entering planning mode** (`nap-install-planner.js`'s
  `enterPlanningMode()`) calls `window.NapIQMapModes.exitPlacementModes()`
  (exits Add-NAP/Report-Issue if either is active) and
  `window.NapIQNavOriginPicker.stopPicking()` (exits the navigation
  feature's manual origin picker if active) — the exact same two calls
  `nav-origin-picker.js`'s own `startPicking()` already makes, so
  Plan Installation mode joins the chain as a peer, not a special
  case.
- **The reverse direction** was previously missing (Add-NAP,
  Report-Issue, and the origin picker had no way to know Plan
  Installation mode existed, since it didn't exist yet). This phase
  closes that gap: `napmap.js`'s `enterAddMode()`, `enterIssueMode()`,
  and `NapIQMapModes.exitPlacementModes()` (called by
  `nav-origin-picker.js`'s `startPicking()`) now each also call
  `window.NapIQInstallPlanner.exitPlanningMode()`, guarded by
  `if (window.NapIQInstallPlanner)` — a no-op for a technician, since
  the module is never loaded for that role at all.
- Net effect: starting **any one** of the four modes (Add NAP, Report
  Issue, manual origin pick, Plan Installation) now cleanly exits
  **all three others**, in both directions, with no new global state
  beyond what each module already owned.

This mirrors exactly how `nav-origin-picker.js`'s own file header
documents its integration with the two modes that existed before it —
Plan Installation mode is now a third participant in that same
pattern, not a parallel, disconnected one.

---

## 4. Visual distinctness (acceptance criterion)

| Marker | Shape | Color |
|---|---|---|
| NAP | Rounded teardrop | Status color (green/gray/orange/red) |
| Issue | Triangle | Priority color |
| Subscriber | Circle | Purple `#6f42c1` |
| Customer recommendation (Phase 22) | Teardrop | Purple `#6f42c1` |
| Navigation origin (Phase 8) | Teardrop with checkmark | Emerald `#10b981`/amber pending |
| **Plan Installation prospect (this phase)** | **Diamond with house glyph** | **Magenta `#d63384`** |

No shape or color is reused from any existing marker, including the
one it is most likely to be confused with at a glance (the navigation
origin picker's own teardrop pin) — both the outline shape and the
fill color differ.

---

## 5. Verification performed

### Automated
```
$ python3 -m py_compile $(find app -name "*.py") run.py dev_seed_server.py
(no output — whole app, including files this phase did not touch, compiles cleanly)

$ node --check app/static/js/napmap.js
$ node --check app/static/js/nap-install-planner.js
(no output — both pass)
```

Jinja template parse check (`Environment(loader=FileSystemLoader(...)).get_template("naps/map.html")`)
completed with no `TemplateSyntaxError`.

### Manual, against the real app (`dev_seed_server.py`, real SQLite
data, real HTTP requests via `requests` — logged in as the real seeded
`admin1`/`tech1` accounts, not mocked):

```
GET /naps/map as admin1  -> 200
  #planInstallModeBtn present:      True
  #planInstallModeBanner present:   True
  nap-install-planner.js <script>:  True
  #addNapModeBtn (pre-existing, unaffected): True

GET /naps/map as tech1   -> 200
  #planInstallModeBtn present:      False
  #planInstallModeBanner present:   False
  nap-install-planner.js <script>:  False
  #addNapModeBtn (pre-existing, unaffected): True

GET /static/js/nap-install-planner.js -> 200 (served correctly)

GET /api/naps/nearest-available?lat=14.281&lng=121.415 (Phase 2, regression check)
  -> 200 {"status": "success", "nap": {"nap_code": "NAP-0100", ...},
          "distance_km": 0.0, "available_ports": 8, ...}
  (unchanged from Phase 2 — confirms this phase did not touch the
  data contract or break it)
```

This confirms: the control is genuinely absent from the technician's
rendered HTML (not just hidden by CSS/JS), the admin sees it, the new
JS file loads, and the Phase 2 endpoint still works exactly as before.

### Known limitation — no browser screenshot this phase

I was not able to produce an actual browser screenshot (click-through
of the pin-drop interaction, the banner text change, the marker
rendering) in this environment: Playwright's Chromium download is
blocked here (`cdn.playwright.dev` is outside this environment's
network allowlist), and no other browser binary is available to drive
headlessly. This is an environment limitation, not a defect in the
feature — the HTTP-level checks in this section confirm the correct
HTML/JS/CSS is served and correctly gated, but the actual click
interaction (pin placement, marker icon rendering, mode-toggle
button/banner state changes, and the mutual-exclusion handoff with
Add NAP / Report Issue / the origin picker) has only been verified by
code inspection, not by driving a real browser. Flagging this
honestly rather than fabricating a screenshot. A follow-up with
Playwright/Chromium available (or a manual check in a real browser)
is recommended before treating this phase as fully closed.

---

## 6. Acceptance criteria check

- [x] Only an administrator sees or can activate "Plan Installation"
      — confirmed in §5 (absent from technician's HTML entirely).
- [x] A pin can be dropped and cleared without affecting any existing
      map layer — `nap-install-planner.js` only ever touches its own
      `proposedMarker`; it never calls into `renderAll()`,
      `markerLayer`, `issueMarkerLayer`, `subscriberMarkerLayer`, or
      `recommendationLayer`. Verified by code inspection (not yet by
      browser interaction — see §5's limitation note).
- [x] No conflict with the existing navigation origin-picker's own
      "click the map to pick a point" mode — §3's mutual-exclusion
      handshake, verified by code inspection.
- [ ] **Not yet verified by an actual browser session** — see §5.

---

## 7. Files changed this phase (confirmed diff scope)

- `app/templates/naps/map.html` (additive: button, banner, script tag)
- `app/static/js/nap-install-planner.js` (new file)
- `app/static/js/napmap.js` (additive: 3 guarded calls, no removals)
- `app/static/css/napmap.css` (additive: 3 new rule blocks, no removals)
- `PLAN_INSTALL_40_PERCENT_NOTES.md` (new file, this one)

No `.py` file, no route, no model, no template other than
`naps/map.html`, and no other `.js`/`.css` file was touched.

---

**STOP.** This is the end of Phase 3 (40%). Phase 4 (the Installation
Planner suggestion panel) is intentionally not started.
