# Phase 10 (50%) — Navigation marker / technician position — implementation notes

## Scope of this phase (per phases.pdf)

> Implement the moving technician position from the prototype. Add a
> dedicated technician/navigation marker to the existing Leaflet map.
> The marker must: represent the current navigation position; move
> along the route during demo travel; update independently of
> NAP/issue markers; disappear/reset appropriately. Do not change the
> database technician's permanent location merely because demo travel
> is running. Distinguish demo navigation position from technician
> last-known database position.

Only this. Nothing from Phase 11/12 (device GPS) or later phases was
started.

## Files changed this phase

| File | Status |
|---|---|
| `app/static/js/nav-technician-marker.js` | **New** — the dedicated navigation/technician marker |
| `app/templates/naps/map.html` | Modified (additive) — one new `<script>` tag, after `nav-demo-travel.js` |
| `app/static/css/napmap.css` | Modified (additive) — marker wrapper + a "running" pulse animation |
| `phase10_screenshots/*.png` | New — screenshots of the marker across the demo-travel lifecycle |

Nothing else was touched. `nav-card.js`, `nav-routing.js`,
`nav-demo-travel.js`, `nav-origin.js`, `nav-origin-picker.js`,
`nav-destination.js`, `napmap.js`, and every backend file (including
`app/models.py`'s `Technician.current_latitude/current_longitude`)
are unchanged.

## What was implemented

### 1. A dedicated marker, in its own Leaflet pane

`nav-technician-marker.js` creates one `L.marker` in a new
`napiqTechnicianPane` (z-index 475 — above Phase 6's route line/475
endpoint markers, below the default `markerPane` NAP/issue/subscriber
markers use), so it can never visually cover an existing marker and
never interferes with `markerLayer` / `issueMarkerLayer` /
`subscriberMarkerLayer`, which this file never references.

### 2. Follows Phase 9's real route-following position

The module only listens to Phase 9's `napiq:demo-travel-changed`
event and calls `marker.setLatLng()` with whatever position Phase 9
already computed by interpolating along the real OSRM polyline. This
file does zero movement math of its own — it is a pure renderer of an
already-correct position, so it can't introduce a straight-line
shortcut Phase 9 avoided.

### 3. Distinct icon, distinct from every other marker

A circular badge (not the NAP rounded-rectangle, issue triangle,
subscriber person-glyph, or origin-picker teardrop) with a
direction-of-travel arrow that rotates based on the bearing between
consecutive positions, plus a small black "DEMO" ribbon printed on
the icon itself. Status-based coloring matches the Nav Card's own
badge colors (grey=idle, blue=running, amber=paused, green=complete)
so the map marker and the card agree at a glance.

### 4. Distinguishing demo position from the DB's last-known position

Inspected the target first, as required: `grep -rn
"current_latitude" app/` shows `technicians.current_latitude` /
`current_longitude` (the DB last-known position) is only ever read by
`app/recommendation.py` (dispatch scoring) and
`app/navigation_contract.py`'s read-only `technician_origin()` JSON
helper — **no existing code anywhere in the app draws it as a map
marker**, so there was nothing to visually reconcile against yet.
That boundary is still made explicit for later phases: the marker's
popup always says *"Demo travel — Simulated preview position — not a
technician's saved location"*, never "technician's current location."
`nav-technician-marker.js` makes no `fetch()`/API calls of any kind —
it cannot write to `technicians.current_latitude/current_longitude`
even by accident, because it never touches the network or the DB at
all.

### 5. Lifecycle (disappear / reset appropriately)

- No ready route yet, or `idle` with `position === null` (Phase 9's
  `hardReset()`, fired on destination/origin change) → marker is
  fully removed from the map.
- Demo `reset()` (Phase 9 puts the simulated position back at the
  route's own origin rather than clearing it) → marker stays visible,
  sitting at the route origin. Matches this phase's own acceptance
  criterion "Reset returns marker to origin."
- `running` / `paused` / `complete` → marker follows / freezes / sits
  at the destination, exactly mirroring Phase 9's state.

### 6. Popup (click-to-inspect, not clutter)

Clicking the marker opens a small popup with live status, percent
complete, and remaining distance/ETA — all read directly from Phase
9's `getState()`, nothing fabricated. The popup content updates via
`setPopupContent()` on every change instead of re-binding, so an
already-open popup is never yanked shut by a background update.

## Verification performed

1. **`node --check`** passed on the new JS file.
2. **`python3 -m py_compile`** passed on every `.py` file in `app/`
   (nothing backend touched, confirmed no accidental breakage —
   `Technician.current_latitude/current_longitude` is untouched).
3. **Jinja parse check** on `naps/map.html` (Jinja2
   `Environment.get_template`) — passed.
4. **Offline Playwright harness**, same approach as Phase 9's own
   verification: the real, byte-for-byte unmodified `nav-destination.js`,
   `napmap.js`, `nav-origin.js`, `nav-origin-picker.js`, `nav-card.js`,
   `nav-routing.js`, `nav-demo-travel.js`, and the new
   `nav-technician-marker.js` were loaded in a headless Chromium via a
   local static file server (this sandbox has no route to the real
   MySQL/Flask app or `router.project-osrm.org`), with only
   `/api/naps`, `/api/issues`, `/api/subscribers`, and the OSRM
   endpoint stubbed with realistic responses (a genuine road-following
   polyline, not a straight line). The script then drove the actual,
   real navigation code end-to-end and asserted on real DOM/state, not
   just visuals:
   - Marker absent while no route exists — **passed**
   - Marker appears the moment demo travel starts — **passed**
   - Marker position actually changes between two animation frames
     while running (i.e., it's really moving, not static) — **passed**
   - Marker position is frozen (bit-for-bit identical) while paused —
     **passed**
   - Marker reaches the exact destination lat/lng at 100% completion
     — **passed**
   - Marker remains present, at the route's origin coordinates, after
     Reset — **passed**
   - Marker is fully removed after the destination changes (no stale
     marker left behind) — **passed**
   - Zero unexpected console errors (some 403s from OpenStreetMap
     tile requests are expected — this sandbox has no egress to
     `tile.openstreetmap.org`; irrelevant to marker logic and not
     present in the real deployed app, which does have internet
     access)
   Screenshots in `phase10_screenshots/`:
   - `01_route_ready_no_marker.png` — route ready, no marker yet (demo not started)
   - `02_running.png` — marker following the route, ~visible near origin just after Start
   - `03_running_popup.png` — popup open: "Demo travel — Simulated preview position — not a technician's saved location. Running · 13% complete. Remaining: 1.3 km · 7 min"
   - `04_paused.png` — marker frozen mid-route
   - `05_complete.png` — marker at the destination, 100%
   - `06_reset_at_origin.png` — marker back at the route's own origin point, idle
   - `07_cleared_after_destination_change.png` — marker fully gone after switching destinations

## Remaining limitations (honest, per this phase's own boundaries)

- **No live device GPS.** This marker only reacts to Phase 9's
  demo-travel position. Phase 11/12 own device GPS; this file exposes
  a generic `render({status, position, progressPercent,
  remainingDistanceMeters, remainingDurationSeconds})` function so a
  later phase can drive the same marker from a real GPS position
  without this file changing.
- **No assigned-technician name/photo on the marker yet.** That
  context (Phase 13/14, dispatch integration) doesn't exist in the
  navigation store yet, so the popup says "Demo travel," not a real
  technician's name.
- **Not tested against a live MySQL-backed server or the real
  `router.project-osrm.org` endpoint** — same sandbox limitation
  Phase 9 documented; verification instead exercised the real,
  unmodified UI/routing code end-to-end with realistic stubbed
  responses via headless Chromium.
- **No manual mouse/keyboard pass by an actual person** — the
  Playwright run exercises real clicks and real DOM/state assertions,
  but isn't a substitute for someone clicking through it once by hand
  on the real running application.

## Try it (once merged into a running app)

Open `/naps/map`, select a destination and set an origin so a route
becomes Ready, then click **Start demo** in the Navigation Card. A
circular blue "DEMO" marker appears and moves along the real road
route as it plays. Click the marker for a live status popup. **Pause**
freezes it in place, **Resume** continues, **Reset** snaps it back to
the route's starting point, and changing the destination removes it
entirely.
