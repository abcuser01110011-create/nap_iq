# Phase 9 (45%) — Demo travel state machine — implementation notes

## Scope of this phase (per phases.pdf)

> Translate the prototype's demo-travel behavior. Implement the states: idle,
> running, paused, complete. Use the actual route geometry. When demo travel
> starts: technician position moves along the actual route; progress
> increases; route progress updates; remaining distance decreases; remaining
> ETA decreases. Do not move in a straight line. Use route geometry to
> interpolate movement along the road route. Implement: Start demo, Pause
> demo, Resume, Reset, Replay after completion.

Only this. Nothing from Phase 10 ("technician marker on the map"), Phase 11/12
(device GPS), or later phases was started.

## Files changed this phase

| File | Status |
|---|---|
| `app/static/js/nav-demo-travel.js` | **New** — the demo-travel state machine |
| `app/static/js/nav-routing.js` | Modified (additive) — Route Details Panel now shows real demo progress instead of the static 0% Phase 7 placeholder; one new integration event dispatched |
| `app/templates/naps/map.html` | Modified (additive) — one new `<script>` tag, after `nav-routing.js` |
| `app/static/css/napmap.css` | Modified (additive) — a few lines of styling for the new controls block |
| `phase9_screenshots/*.png` | New — screenshots of all four states (see below) |

Nothing else was touched. `nav-card.js`, `nav-origin.js`, `nav-origin-picker.js`,
`nav-destination.js`, `napmap.js`, and every backend file are unchanged.

## What was implemented

### 1. The state machine (`nav-demo-travel.js`)

Four explicit states — `idle`, `running`, `paused`, `complete` — translated
from the prototype's demo-travel slice of `NavigationStore.tsx`:

- **Start** — snapshots the currently *ready* route from
  `window.NapIQNavRouting.getState()` (the real OSRM response already stored
  by Phase 5/6/7), builds a cumulative-distance table over its actual polyline
  points, and begins a `requestAnimationFrame` loop.
- **Pause** — freezes progress (banks elapsed time), cancels the animation
  frame. Time does not advance while paused.
- **Resume** — continues from the exact banked progress, not from zero.
- **Reset** — stops any run and returns to `idle` with the simulated position
  back at the route's own origin point (not cleared to nothing), per the
  phase's acceptance criteria.
- **Replay** — only valid from `complete`; re-snapshots the current ready
  route and restarts from the beginning.

### 2. Real-geometry interpolation, not a straight line

Movement is computed by walking a cumulative-distance table built from the
actual OSRM polyline vertices (`route.points`, already road-snapped by
Phase 5/6), then linearly interpolating within the single short road segment
the current simulated distance falls in. At no point is a straight line drawn
between origin and destination — the technician position always follows the
same vertices the route line itself is drawn from (Phase 6's Leaflet layer).

### 3. Progress / remaining distance / remaining ETA

All three are derived, every frame, from the same real numbers already on
the route object:

- `progressRatio` = simulated distance traveled ÷ total route distance
  (from OSRM's `distance`).
- `remainingDistanceMeters` = total distance × (1 − progress).
- `remainingDurationSeconds` = OSRM's real `duration` × (1 − progress).

Nothing here is fabricated independently of the real route — it is all
arithmetic on the actual OSRM response.

### 4. Controls: Start / Pause / Resume / Reset / Replay

A small control block, translated from the prototype's demo-travel buttons,
is appended into the existing Navigation Card's `#navCardControls` container
(the same container Phase 8's origin form already lives in — this module
appends after it, never replaces it). Buttons are correctly enabled/disabled
per state (e.g. Pause only enabled while running, Replay only enabled once
complete), and the block only appears once a real, ready road route exists —
matching this project's "no fake controls for something that doesn't exist
yet" rule already established in earlier phases.

### 5. Route Details Panel now shows real progress (nav-routing.js)

Phase 7 built a "route completion percentage placeholder" frozen at 0% and a
"Remaining" metric always equal to the totals, explicitly because no progress
tracking existed yet. This phase makes both of those honest and live:

- With no demo run started, they behave **exactly as Phase 7 shipped them** —
  0%, remaining = totals, "Placeholder only…" caption.
- While a demo run is active, they show the real percentage, a caption with
  the real remaining distance/ETA, and (on completion) a green "complete" bar
  and "Demo travel complete — destination reached." message.

This required two small, additive changes to `nav-routing.js`:
`completionPlaceholderHtml()` and `readyMetricsHtml()` now read
`window.NapIQNavDemoTravel.getState()`; nothing about the OSRM request,
error handling, retry, or Phase 6 polyline-drawing logic was touched.

### 6. Integration events (new, both additive)

- `napiq:demo-travel-changed` — dispatched by `nav-demo-travel.js` (throttled
  to ~6-7/sec while running, always dispatched immediately on state
  transitions) so `nav-routing.js` can refresh the Route Details Panel.
- `napiq:route-status-changed` — dispatched by `nav-routing.js` at the end of
  its own `render()`. **This one exists because of a real bug caught during
  verification** (see below): without it, the demo-travel controls never
  appeared after an *async* OSRM response arrived, because `nav-routing.js`'s
  own re-render in that path didn't previously notify anything.

### 7. Cleanup on destination/origin change

If the destination or origin changes while a demo run is active, the run is
fully stopped and the module resets to a clean `idle` state (no dangling
`requestAnimationFrame`, no stale "complete" badge for a route that no longer
applies). This is the minimum correctness this phase's own feature needs —
not the fuller edge-case pass Phase 18 owns.

## Bug found and fixed during this phase's own verification

While screenshotting the real files in an offline harness, the demo-travel
controls did not appear even though the route was `ready`. Root cause:
`nav-routing.js`'s `render()` is called both synchronously (e.g. from the
`napiq:navcard-rendered` event nav-demo-travel.js listens to) **and**
directly from inside the OSRM fetch's `.then()` callback once the async
response arrives — and only the first path was ever announced to other
modules. Fixed by adding the `napiq:route-status-changed` event described
above. Re-verified after the fix (see below) — this is now resolved.

## Verification performed

1. **`node --check`** passed on both changed JS files
   (`nav-demo-travel.js`, `nav-routing.js`).
2. **`python3 -m py_compile`** passed on every `.py` file in `app/` (nothing
   backend was touched, confirmed no accidental breakage).
3. **Jinja parse check** on `naps/map.html` (Jinja2 `Environment.get_template`)
   — passed.
4. **DOM id / event cross-check** — every `getElementById()` call in the new
   file matched an id it actually renders; every `CustomEvent` dispatched
   has a real listener somewhere in the codebase.
5. **Deterministic algorithmic test** (Node, no network/browser needed): the
   real `nav-demo-travel.js` was loaded into a sandboxed context with a fully
   controllable fake clock, fake `requestAnimationFrame`, and a synthetic
   4-point route. 32 assertions covering the full lifecycle — start, halfway
   progress, pause (time frozen), resume, completion (100%, 0 remaining,
   position at the last point), replay, reset (back to origin), hard-reset on
   destination change, and start() failing gracefully with no ready route —
   **all 32 passed**.
6. **Visual verification against the real, unmodified project files.** This
   sandbox has no internet access (confirmed: `pip install flask_sqlalchemy`
   fails with no matching distribution, and the live app can't boot without
   it), so a real MySQL/Flask-served page and a genuine call to
   `router.project-osrm.org` were not possible here. Instead, a standalone
   HTML harness (not part of the shipped app — see "Not included in the zip"
   below) loaded the **real, byte-for-byte unmodified** `nav-card.js`,
   `nav-destination.js`, `nav-origin.js`, `nav-routing.js`,
   `nav-demo-travel.js`, and `napmap.css` outside of Flask, with only
   `window.fetch` swapped for a synthetic-but-realistic OSRM-shaped JSON
   response (a genuine road-following polyline, not a straight line) so
   `nav-routing.js`'s own real request/parsing/render code would run
   unmodified. A headless Chromium (Playwright, already available in this
   sandbox with its browser binary pre-installed) then drove the actual UI:
   Start → Pause → Resume → Complete → Replay → Reset, screenshotting each
   state. Screenshots are in `phase9_screenshots/`:
   - `01_idle_ready_route.png` — route ready, demo travel Idle, Start enabled
   - `02_running.png` — 21% complete, "Demo travel in progress — 863 m
     remaining, about 4 min left.", Pause enabled
   - `03_paused.png` — 25% complete (frozen), "Demo travel paused", Resume
     enabled
   - `04_complete.png` — 100%, green bar, "Demo travel complete — destination
     reached.", Replay enabled
   - `05_replay_running.png` — restarted from 0%, running again
   - `06_reset_idle.png` — back to 0%, Idle badge, all buttons back to their
     idle enabled/disabled state

## Not included in the zip

The offline screenshot harness itself (a temporary standalone HTML page plus
copies of the real JS/CSS files, used only to drive a headless browser
without network access) is a verification tool, not a project file — it was
not added to `nap_iq/`. Only its **output** (`phase9_screenshots/*.png`) is
included, alongside the real, unmodified files it exercised.

## Remaining limitations (honest, per this phase's own boundaries)

- **No technician marker is drawn on the map.** This is Phase 10's explicit
  scope ("Navigation marker / technician position"), not this phase's. The
  simulated position is fully computed and exposed
  (`window.NapIQNavDemoTravel.getState().position` /
  `.getPosition()`) so Phase 10 can render it without any change to this
  file.
- **Demo playback speed is a deliberate implementation choice, not something
  the spec pins down.** The phase text doesn't specify how fast the demo
  should move, only that it must follow the real geometry and that
  progress/remaining values must be correct. Real-time playback of a
  multi-minute route would be unusable for a live preview, so playback is
  time-compressed (route duration ÷ 40, clamped to 6–45 seconds) — documented
  in the file's own comments so a later phase can retune it without guessing
  at the reasoning.
- **Not tested against a live MySQL-backed server or the real
  `router.project-osrm.org` endpoint** — this sandbox has no network egress.
  `nav-routing.js`'s own OSRM request code is completely unchanged from
  Phase 5-7 (already verified live in those phases' own notes), and this
  phase's verification instead focused on what's new: the state machine
  itself (deterministic Node test) and its real integration with the actual
  unmodified UI code (headless-browser screenshot pass, network call only
  swapped for a synthetic-but-realistic OSRM response).
- **No manual mouse/keyboard pass by an actual person** — the Playwright run
  exercises real clicks and real DOM state, but it isn't a substitute for
  someone clicking through it once by hand on the real running application.

## Try it (once merged into a running app)

Open `/naps/map`, select a destination (NAP, subscriber, or complaint) and
set an origin so a route becomes Ready. A new "Demo travel" section appears
below the origin form with **Start demo**. Click it — the Route Details
Panel's completion bar and "Remaining" figures start moving for real, based
on the actual route. **Pause** freezes it, **Resume** continues from the same
point, **Reset** returns to 0% at the route's start, and after it reaches
100%, **Replay** starts it again from the beginning.
