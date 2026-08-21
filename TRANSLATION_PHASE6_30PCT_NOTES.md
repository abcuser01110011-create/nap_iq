# Phase 6 (30%) — Route line on the existing Leaflet map — translation notes

## Scope of this phase (per phase_6.pdf)

> Draw the route line on the existing Leaflet map. Integrate the route geometry
> into the target's existing Leaflet map. Do not create a second Leaflet map.
> Add a dedicated route layer to the existing map.

Only this. Nothing from a future phase was started, per the instructions at the
bottom of the PDF.

## What changed this phase

One file: **`nap_iq/app/static/js/nav-routing.js`**. Nothing else — not
`nav-card.js`, not `nav-origin.js`, not `napmap.css`, not `map.html` — was
touched, because nothing else needed to change to satisfy this phase's spec.

### 1. Dedicated route layer (`L.layerGroup`)

Route rendering was rebuilt from a single bare polyline (Phase 5) into a
proper dedicated layer, translated from the prototype's `GeoMap.tsx`:

- **Two dedicated Leaflet panes**, created once against the real map instance
  the first time they're needed:
  - `napiqRoutePane` — zIndex 460 (mirrors the prototype's `navigation-route`
    pane)
  - `napiqRouteEndpointsPane` — zIndex 470 (mirrors `navigation-endpoints`)

  Both sit **above** Leaflet's default `overlayPane` (400) but **below** its
  default `markerPane` (600) — the pane this app's existing NAP / issue /
  subscriber `L.marker` layers already render into (standard Leaflet
  behavior, not something this phase changed). That ordering is what
  guarantees the route can never visually cover a marker, regardless of the
  order layers happen to be added in, without this phase needing to touch or
  even know the internals of how napmap.js builds those marker layers.

- **Route line styling** — a dark, semi-transparent "casing" polyline under a
  bright primary-blue line on top, both `interactive: false` so they never
  intercept clicks meant for markers underneath. This is the same two-layer
  technique the prototype uses (`GeoMap.tsx`'s stacked `<Polyline>`s), with
  the accent color swapped from the prototype's sky-blue (`#38bdf8`) to this
  app's existing Bootstrap primary (`#0d6efd`, already used elsewhere in
  `napmap.css` / `nav-card.js`) so it's visually consistent with the rest of
  the NAP-IQ UI rather than importing the prototype's dark-HUD palette
  wholesale.

- **Endpoint markers** — a small circle at the route's start and a larger one
  at its end (sky-blue ring for origin, solid blue for destination),
  positioned at the OSRM route's own snapped-to-road first/last points —
  same convention as the prototype's `routePositions[0]` / destination
  `CircleMarker`s.

- Everything above lives in **one `L.layerGroup`**, added/removed as a single
  unit.

### 2. Update / disappear / replace behavior

- **Updates when the route changes**: every new OSRM response calls
  `drawPolyline()`, which clears any existing layer group first, then builds
  and adds a fresh one. Confirmed by test (see below): re-setting the origin
  never produces more than one layer group on the map at a time — the old
  one is always removed before the new one is added, so re-routing replaces
  the line instead of stacking a second one on top, per the acceptance
  criteria.
- **Disappears when navigation is cleared**: `clearPolyline()` is called (and
  removes the whole layer group) whenever the destination is cleared, the
  origin is cleared, or a route request errors — this logic already existed
  in Phase 5's `maybeAutoRequest()` / error handler and needed no change;
  it now cleans up the richer layer group instead of a single polyline.
- **Fit/bounds behavior**: once a route resolves, `fitRouteBounds()` calls
  the real map's `fitBounds()` over the route's own points, with the same
  padding/maxZoom/animation the prototype's `RouteController` uses
  (`padding: [72, 72]`, `maxZoom: 16`, animated).

### 3. Filter / marker compatibility

The route layer group never references, iterates, or mutates the NAP /
issue / subscriber marker layers or the status/priority/port filter
checkboxes — it only ever calls `addLayer` / `removeLayer` on
`window.NapIQMap` with layers it created itself. So toggling any existing
map filter or layer checkbox has no effect on the route (it isn't part of
what those filters iterate over), and the route likewise never touches
anything those filters manage.

## The one thing still not finished — same blocker as Phase 5

**`window.NapIQMap` is still not set anywhere**, because **`napmap.js`
(where the real Leaflet map is created) has not been part of any delta
package supplied to this translation project across Phase 4, Phase 5, or
this phase.** Per this project's own rules — inspect the real target file
before changing it, never guess at code that hasn't been seen, never risk
creating a second map — this phase did not touch or fabricate that file.

Everything in this note is written, tested, and ready to activate the
moment `napmap.js` adds one line right after it creates the map (only the
local variable name needs substituting):

```js
window.NapIQMap = map;
```

No other change is needed on either side. `nav-routing.js` already checks
for `window.NapIQMap` on every relevant event and will create its panes,
draw its layer group, and fit bounds automatically once that line exists.

**Practical effect on the live app right now:** the Navigation Card
(distance, ETA, loading/ready/error states, retry, manual origin entry —
all Phase 5 work) continues to work exactly as before. The route line itself
will not yet be visible on the live `/naps/map` page until the one-line
change above is made in the real `napmap.js`.

## Verification performed this phase

`napmap.js`, the real Flask app, and its MySQL database were not available
in this delta-only environment, so the real `/naps/map` page could not be
loaded end-to-end. Two things were done instead:

1. **Automated functional test** (`test_phase6.js`, not part of the app —
   a throwaway harness) — mocks a minimal Leaflet (`L.polyline`,
   `L.circleMarker`, `L.layerGroup`, `L.latLngBounds`, panes) and a minimal
   `window.NapIQMap`, then runs the real, unmodified `nav-routing.js` and
   asserts:
   - no route layer exists before both an origin and destination are set;
   - exactly one layer group (casing + line + 2 endpoint markers) is added
     once OSRM resolves, using the two dedicated panes;
   - `fitBounds` is called once, with the documented padding;
   - re-setting the origin (a re-route) always leaves exactly one layer
     group on the map — the old one is discarded, not stacked;
   - clearing the origin removes the layer group entirely.

   All checks passed.

2. **Interactive demo page** (`demo/phase6_demo.html`, also not part of the
   app) — loads the real, unmodified `nav-card.js` / `nav-origin.js` /
   updated `nav-routing.js` against a real Leaflet map (via CDN, opens in
   any browser with internet access) with a few demo NAP/issue markers and
   buttons to set a destination, set an origin, move the origin (re-route),
   and clear. This is the closest thing to a live check available without
   `napmap.js`/the app itself, and is meant for manual review — open it
   locally and click through the buttons to see the route layer draw, fit
   bounds, restyle on re-route, and clear.

`node --check` was also run against the modified file (and the untouched
`nav-card.js` / `nav-origin.js`, for regression safety) — no syntax errors.

## Remaining limitations (unchanged from what Phase 5 already flagged, plus one)

- **Route line not yet visible on the real page** until `napmap.js` sets
  `window.NapIQMap` (above) — the one item this phase could not close out.
- Everything Phase 5 already listed as out of scope (GPS movement / demo
  travel simulation, origin search beyond manual lat/lng entry) remains out
  of scope — this phase did not touch that.
- No change was made to `map.html`, `napmap.css`, `nav-card.js`, or
  `nav-origin.js` — none of Phase 6's requirements needed one.
