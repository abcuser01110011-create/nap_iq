# Phase 11 (55%) — Real device GPS origin — implementation notes

## Scope of this phase (per phases.pdf)

> Translate the prototype's browser geolocation functionality.
> Implement: request device location; permission handling; tracking
> state; GPS error state; stop tracking; current-device origin; route
> calculation from the device position. Use
> `navigator.geolocation.watchPosition()`. Handle: permission denied;
> unavailable location; timeout; unsupported browser. Do not claim
> GPS is active when it is not. The UI must clearly distinguish:
> Manual origin, Device GPS. Do not permanently save every GPS update
> to MySQL.

Only this. Nothing from Phase 12 (live GPS route *progress* — nearest-
point-on-route math, percentage, remaining distance/ETA recalculated
as the device moves along the route) was started. This phase only
gets a device fix in as the route **origin**; Phase 12 owns turning
device movement into route *progress*.

## Files changed this phase

| File | Status |
|---|---|
| `app/static/js/nav-gps-origin.js` | **New** — the device GPS origin module |
| `app/static/js/nav-origin.js` | Modified (additive) — `setOriginPoint()` accepts an optional `source`; confirmed-origin badge distinguishes "Device GPS" from "Origin"; new `#navOriginGpsControls` container |
| `app/templates/naps/map.html` | Modified (additive) — one new `<script>` tag, after `nav-origin-picker.js` |
| `app/static/css/napmap.css` | Modified (additive) — a small pulsing "live GPS" indicator dot |
| `phase11_screenshots/*.png` | New — screenshots covering the full tracking/error/override lifecycle |

Nothing else was touched. `nav-destination.js`, `nav-card.js`,
`nav-routing.js`, `nav-demo-travel.js`, `nav-technician-marker.js`,
`nav-origin-picker.js`, `napmap.js`, and every backend file are
unchanged.

## What was implemented

### 1. Requesting device location + permission handling

Clicking **"Use my device location"** calls
`navigator.geolocation.watchPosition()` (per the phase spec — not a
single `getCurrentPosition()` call). The browser's native permission
prompt is triggered by that call; this module never bypasses or fakes
it, it only reacts to the outcome.

Before starting, it cancels any in-progress manual map pick
(`window.NapIQNavOriginPicker.cancelPicking()`) and exits Add
NAP/Report Issue placement mode
(`window.NapIQMapModes.exitPlacementModes()`), matching the mutual-
exclusion rule those two modes already enforce between themselves —
only one origin-acquisition flow is ever active at once.

### 2. Explicit tracking state machine

Five distinct, honestly-labeled states, never collapsed into one
generic "on/off":

- **unsupported** — `navigator.geolocation` doesn't exist at all.
- **idle** — not tracking, no error.
- **requesting** — `watchPosition()` called, no fix received yet
  (shown with a spinner: "Requesting your device location…").
- **tracking** — at least one real fix received; shows a pulsing
  "Live GPS tracking active" indicator with the fix's accuracy.
- **error** — with a specific reason (see below), plus a **Retry**
  button.

### 3. GPS error state, with a distinct message per cause

`GeolocationPositionError` codes 1/2/3 each get their own honest
message, never one generic "GPS failed" string:

- **1 (permission denied)** — "Location permission was denied. Allow
  location access for this site in your browser settings, then try
  again."
- **2 (position unavailable)** — "Your device's location is currently
  unavailable. Check that location services are turned on."
- **3 (timeout)** — "Timed out waiting for a location fix. Try again,
  ideally with a clearer view of the sky."
- **No `navigator.geolocation` at all** — "This browser does not
  support device location (Geolocation API unavailable)."

A failed/denied fix also clears any watch that might still be running
in the background, so the UI never keeps claiming "tracking" after an
error.

### 4. Stop tracking

**"Stop GPS tracking"** calls `navigator.geolocation.clearWatch()` and
returns the UI to idle — but, per the phase's own "current-device
origin" requirement, it deliberately leaves the *last* GPS-derived
point in the origin store rather than clearing it. Stopping the live
watch is not the same operation as clearing the origin (the existing
Clear ✕ button in `nav-origin.js`'s confirmed-state panel, unchanged,
is still how the origin itself gets removed).

### 5. Current-device origin → real route calculation

Every accepted fix that represents genuine movement is pushed into
`window.NapIQNavOrigin.setOriginPoint()` with `source: "device-gps"`.
`nav-routing.js`'s existing `napiq:origin-changed` listener (added in
Phase 5, **not touched this phase**) already turns that into a real
OSRM driving-route request with zero code changes on its side — this
phase's whole job was getting a real device fix *into* the origin
store in the right shape; the routing engine downstream was already
built to accept it.

### 6. Distinguishing Manual origin from Device GPS

- `nav-origin.js`'s confirmed-origin badge now reads the origin's
  `source`: `"manual-latlng"` / `"manual-map"` still show the
  original green **"Origin"** badge (pre-existing, unchanged); a
  `"device-gps"`-sourced origin shows a distinct blue **"Device GPS"**
  badge with a satellite icon.
- `nav-gps-origin.js` additionally shows its own live **"Live GPS
  tracking active"** indicator (pulsing dot) directly under the
  picker controls whenever a watch is actually running right now —
  so the UI distinguishes not just "was this origin ever GPS-derived"
  but "is a live sensor updating it at this very moment".
- Switching to a manual origin (lat/lng form or map pick) while GPS
  tracking is active automatically stops the watch and reverts the
  badge/indicator — the origin-changed listener recognizes an origin
  it did *not* just push itself and calls `stopTracking()`.

### 7. Reducing chatter from GPS jitter

A stationary device can still emit fixes that wobble by a few meters.
Re-broadcasting every single one as a new origin would fire a new
OSRM request for a route that hasn't meaningfully changed. This
module only pushes a fix into the origin store if it's the first fix
of the session, or at least 15m (haversine distance) from the last
*pushed* fix — a plain distance check, not a fabricated smoothing
algorithm. The displayed accuracy/status still updates on every raw
fix; only the origin-store push (and therefore the OSRM re-request)
is throttled. (Real route-*progress* noise handling — "do not let
noisy GPS readings make progress jump backward and forward" — is
explicitly Phase 12's job, since there's no progress concept for GPS
to feed yet.)

### 8. No backend calls, no saved location history

`nav-gps-origin.js` makes zero `fetch()`/`XMLHttpRequest` calls of any
kind. Every fix lives only in this module's own in-memory variable
and, once pushed, in `nav-origin.js`'s in-memory store — both are
lost on reload, same as every other origin source in this project.
Nothing is written to `technicians.current_latitude/current_longitude`
or any other table. `clearWatch()` is called on Stop, on error, and on
`beforeunload`, so the browser itself stops polling the device too.

## Verification performed

1. **`node --check`** passed on `nav-gps-origin.js` and the modified
   `nav-origin.js`.
2. **`python3 -m py_compile`** passed on every `.py` file in `app/`
   (nothing backend touched).
3. **Jinja parse check** on `naps/map.html` — passed.
4. **Offline Playwright harness**, same approach as Phases 9/10: the
   real, unmodified `nav-destination.js`, `napmap.js`,
   `nav-origin.js`, `nav-origin-picker.js`, the new
   `nav-gps-origin.js`, `nav-card.js`, `nav-routing.js`,
   `nav-demo-travel.js`, and `nav-technician-marker.js` were loaded in
   headless Chromium via a local static file server (this sandbox has
   no route to the real MySQL/Flask app, a real device's GPS, or
   `router.project-osrm.org`), with `/api/naps`, `/api/issues`,
   `/api/subscribers`, and the OSRM endpoint stubbed with realistic
   responses (a genuine road-following polyline), and
   `navigator.geolocation` replaced with a scripted fake that
   delivers controlled fixes/errors on demand. The script then drove
   the real navigation code end-to-end and asserted on real DOM/state:
   - "Use my device location" button shown, idle, before any request
     — **passed**
   - Clicking it enters `requesting`, then `tracking` once the fake
     delivers a fix, with the origin becoming `source: "device-gps"`
     and the "Device GPS" badge appearing — **passed**
   - That real device fix triggers a real OSRM route request and the
     Route Details panel reaches `status: "ready"` with the exact
     stubbed distance/duration — **passed**
   - A second fix at the *same* coordinates (GPS jitter) does **not**
     replace the origin (same origin `id` before/after) — **passed**
   - A third fix ~1.7km away (real movement) **does** push a new
     origin (`id` changes) — **passed**
   - "Stop GPS tracking" returns to the idle button, but the origin
     stays `source: "device-gps"` (not cleared) — **passed**
   - Manually setting a lat/lng origin afterward reverts the badge to
     green "Origin", removes the "Device GPS"/live-tracking text, and
     the GPS module itself is left idle — **passed**
   - After clearing the origin, permission-denied, position-
     unavailable, and timeout each render their own distinct message
     and a Retry button (verified per-error, `#navGpsRetryBtn`
     re-triggers each time) — **passed**
   - A separate page with `navigator.geolocation` entirely absent
     shows the honest "does not support device location" message
     instead of a generic error — **passed**
   - Zero unexpected console errors (only the same expected
     `tile.openstreetmap.org` 403s every prior phase's offline harness
     has documented — this sandbox has no egress there; irrelevant to
     this module and not present in the real deployed app)

   A real ordering bug was caught and fixed by this harness before
   screenshots were taken: `setOriginPoint()` fires
   `napiq:origin-changed` *synchronously*, so this module's own
   listener for that event (used to detect "something else changed
   the origin, stop tracking") was seeing its own just-pushed fix as
   stale on the very first call and immediately calling
   `stopTracking()` on itself. Fixed by recording the pushed
   coordinates *before* calling `setOriginPoint()` instead of after.

   Screenshots in `phase11_screenshots/`:
   - `01_idle_gps_button.png` — idle state, "Use my device location" button
   - `02_requesting_location.png` — brief requesting/loading frame
   - `03_tracking_device_gps_origin.png` — tracking active, "Device GPS" badge, real OSRM route drawn from the GPS origin
   - `04_route_from_gps_origin.png` — Route Details panel showing the real distance/duration from the device-origin route
   - `05_origin_updates_on_real_movement.png` — origin/route update after a real (>15m) movement fix
   - `06_stopped_origin_persists.png` — after Stop, origin stays device-GPS-sourced
   - `07_manual_origin_after_gps.png` — manual override reverts the badge and stops any live indicator
   - `08_error_permission_denied.png` — permission-denied error + Retry
   - `09_error_unavailable.png` — position-unavailable error + Retry
   - `10_error_timeout.png` — timeout error + Retry
   - `11_unsupported_browser.png` — no Geolocation API at all

## Remaining limitations (honest, per this phase's own boundaries)

- **No live route-progress from GPS movement yet.** This phase only
  gets a device fix in as the route *origin*. Turning continued
  device movement into route percentage / remaining distance /
  remaining ETA — with noise-tolerant nearest-point-on-route math —
  is Phase 12's job and hasn't been started.
- **No assigned-technician GPS auto-start.** This is a manual,
  user-initiated "Use my device location" button, same as the manual
  map picker; nothing auto-starts GPS tracking on page load or on
  assignment (out of scope per this phase and per the global
  instruction against adding anything not in the current phase).
- **Not tested against a real browser's real GPS hardware or a live
  MySQL-backed server / the real `router.project-osrm.org` endpoint**
  — same sandbox limitation every prior phase has documented.
  Verification instead exercised the real, unmodified UI/routing code
  end-to-end with a scripted `navigator.geolocation` fake and a
  realistic stubbed OSRM response via headless Chromium.
- **No manual mouse/keyboard pass by an actual person on a real
  device.** The Playwright run exercises real clicks and real
  DOM/state assertions (including a genuine bug it caught and this
  phase fixed), but isn't a substitute for someone trying it with
  their own phone's GPS on the real running application.

## Try it (once merged into a running app)

Open `/naps/map`, select a destination, then in the "Navigation
origin" panel click **"Use my device location"**. Your browser will
prompt for location permission; once granted, your position becomes
the route origin (badge: "Device GPS") and a real OSRM driving route
is calculated to the destination automatically. Moving updates the
origin (and re-routes) once you've moved more than ~15m. **Stop GPS
tracking** freezes the origin at your last known position without
clearing it. Denying permission, losing signal, or timing out each
show a specific, honest error with a **Retry** button.
