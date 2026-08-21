# PHASE 23.5% — napV4-route line (2) Integration: Audit + Architecture

**Status:** Phase 1 of the napV4-route-line integration — audit and
architecture only. **No application behavior changes in this phase.**
No routes, models, templates, or JS files were modified. This file is
the only new artifact.

---

## 1. What "napV4-route line (2)" actually is

The uploaded prototype (`napV4-route line/`) is a full standalone React
+ TypeScript + Leaflet single-page app (React Router, Context-based
stores, Tailwind, framer-motion, lucide-react icons) that reimplements
an entire NAP-IQ-like product from scratch with in-memory sample data
(`src/data/sampleData.ts`) — subscribers, NAPs, complaints, payments,
technicians, collectors, dispatch scoring, and more.

Per your instructions, **we are not porting the whole prototype.** The
part of the prototype that is actually new relative to the existing
Flask app — the part worth extracting — is its **live technician
navigation / route-line feature**:

- `src/store/NavigationStore.tsx`
- `src/components/navigation/NavigationCard.tsx`
- `src/components/navigation/OriginPicker.tsx`
- `src/components/navigation/RouteDetails.tsx`
- the route-drawing additions inside `src/components/map/GeoMap.tsx`

This is a turn-by-turn "route line" overlay: pick a destination
(subscriber / NAP / assigned issue), pick a starting point (a mapped
address or live device GPS), fetch a real driving route from the
public OSRM routing API, draw it on the Leaflet map, and either
simulate travel along it ("demo travel") or track a live device
position against it.

Everything else in the prototype (its own auth, its own subscriber/NAP/
complaint/payment CRUD, its own dispatch scoring, its own role
switcher) **already exists in NAP-IQ in a more mature, database-backed
form** (see §3). Those parts of the prototype are reference material
only — confirmation that NAP-IQ's existing modules already cover the
same ground — not things to be rebuilt.

## 2. Target architecture (as it exists today, Phase 23)

Flask app factory (`app/__init__.py`) + Blueprints, SQLAlchemy models
(`app/models.py`), MySQL, Jinja templates (`app/templates/`), Bootstrap
5 + Bootstrap Icons, Leaflet (vendored under
`app/static/vendor/leaflet/`), Flask-WTF CSRF, session-cookie auth with
`@role_required(...)` RBAC (`app/auth.py`).

The existing interactive map (`naps.geomap()` → `GET /naps/map` →
`app/templates/naps/map.html` → `app/static/js/napmap.js`, ~1094 lines,
vanilla IIFE JS, no framework) already does, live against MySQL:

- Renders NAP markers (colored by status) and technical-issue markers
  (colored by priority) from `GET /api/naps` and `GET /api/issues`
  (`app/routes/api.py`).
- NAP search, status/port filters, issue status/priority filters — all
  client-side against the fetched JSON, same pattern the prototype's
  `AppStore.search()` uses.
- "Add NAP" click-to-place mode, "Report an Issue" click-to-place mode,
  quick-add modals with server-side validation.
- `?issue_id=` query param support: a technician's "View on Map" link
  (`technician/index.html`) opens the map already panned/zoomed to
  their assigned issue's marker with its popup open
  (`focusIssueFromQueryParam()` in napmap.js).
- `?recommend_request_id=` query param support: Phase 22's NAP
  recommendation flow plots a customer pin + ranked NAP candidates
  fetched from `GET /api/service-requests/<id>/recommend-nap`.

The existing dispatch/technician subsystem already covers what the
prototype's `AppStore.scoreTechnicians()` / `DispatchModal.tsx` do, and
goes further:

- `app/recommendation.py` — a documented, transparent 4-factor
  weighted scoring engine (availability, workload, proximity via
  haversine, past performance) used by `dispatch.recommend()`.
- `app/routes/dispatch.py` — `index()` (dispatch board),
  `recommend(issue_id)`, `assign(issue_id)`, `reassign(issue_id)`,
  `cancel(assignment_id)`.
- `app/routes/technician.py` — a technician's own "my jobs" view
  (`index()`, equivalent to the prototype's `TechnicianJobs.tsx`),
  `history()`, and per-assignment `accept` / `start` / `save_notes` /
  `complete` actions.
- `Technician.current_latitude` / `current_longitude` **already exist
  as real DB columns** on the `technicians` table — this is the exact
  field the route-line feature needs as a routing origin fallback, and
  it does not need to be invented.
- `Assignment` already links a `TechnicalIssue` to a `Technician` with
  a `status` lifecycle (`assigned → accepted → in_progress →
  completed/cancelled`) — this is the real-data equivalent of the
  prototype's `Complaint.assignedTechId`.

**Conclusion:** NAP-IQ's dispatch/assignment/scoring/map-marker
foundation is already more capable and more real (actual MySQL data,
actual RBAC-scoped queries, actual audit trail) than the prototype's
in-memory version of the same ideas. Nothing there needs to be
replaced. The one genuinely new capability is the **route line**
itself — none of NAP-IQ's existing map code draws a driving route, an
origin picker, live progress, or a moving technician marker.

## 3. Integration map — prototype → NAP-IQ equivalent

| Prototype piece | NAP-IQ equivalent (existing) | Verdict |
|---|---|---|
| `store/AppStore.tsx` (role, naps, subscribers, complaints, payments, technicians, CRUD) | Flask session/RBAC (`app/auth.py`) + `app/models.py` + blueprints in `app/routes/*` (`naps.py`, `subscribers.py`, `issues.py`, `payments.py`, `technicians.py`, `dispatch.py`) backed by MySQL | **Already exists, more mature. Do not port.** |
| `store/AppStore.tsx: scoreTechnicians()` | `app/recommendation.py` (4-factor, documented, DB-driven) | **Already exists, more mature. Do not port.** |
| `store/AppStore.tsx: search()` | `napmap.js` NAP search box (`#napSearchInput`) + list-page search params (`naps.list_naps`, etc.) | **Already exists in the NAP scope. Not a blocker for this feature.** |
| `store/MapUI.tsx` (layers, focus, panel/dispatch modal state) | `napmap.js` module-scope state (`allNaps`, `markersById`, layer-toggle checkboxes, Bootstrap modals for quick-add / report-issue) | **Already exists as plain JS state; the route-line JS module will follow the same pattern (its own small state object) instead of introducing a store abstraction.** |
| `store/NavigationStore.tsx` (destination, origin, OSRM route, demo travel, device GPS, progress) | **Nothing today.** | **New. This is the actual "route line" feature to add — see §4.** |
| `components/map/GeoMap.tsx` (base map + markers) | `naps/map.html` + `napmap.js` (`L.map`, `markerLayer`, `issueMarkerLayer`, `recommendationLayer`) | **Already exists. The route line will be added as one more Leaflet layer group inside the existing map, not a new map.** |
| `components/map/GeoMap.tsx` (route polyline + endpoint circles + moving technician marker, `RouteController`/`MapController` fit/fly behavior) | **Nothing today.** | **New — additive Leaflet layers/panes on the existing `map` object in napmap.js.** |
| `components/navigation/NavigationCard.tsx` (collapsible panel, destination `<select>`, status header) | **Nothing today.** | **New — a Bootstrap off-canvas / card panel, following `quickAddModal`'s existing side-panel pattern in `naps/map.html`.** |
| `components/navigation/OriginPicker.tsx` (manual address autocomplete vs. device GPS toggle) | **Nothing today**, but `napmap.js`'s existing subscriber/NAP datasets (`allSubscribers`, `allNaps`) are exactly the data an origin autocomplete would search — no new data source needed. | **New UI, existing data source.** |
| `components/navigation/RouteDetails.tsx` (distance/ETA metrics, progress bar, demo start/pause/reset, "use device" button) | **Nothing today.** | **New.** |
| `components/modals/DispatchModal.tsx` | `dispatch/recommend.html` + `dispatch.assign()` | **Already exists, more mature (real scoring, real CSRF form POST). Do not port; route-line's destination picker will read the technician an issue is *already* assigned to via the existing `Assignment` row instead of re-implementing assignment.** |
| `components/modals/ResolutionProofModal.tsx` | `technician.complete_assignment()` + `save_notes()` (resolution notes, no photo upload in NAP-IQ today) | **Already exists in simplified form (text notes only). Out of scope for the route-line phase — no change proposed.** |
| `pages/TechnicianJobs.tsx` | `app/routes/technician.py: index()` / `technician/index.html` | **Already exists. This is where the route-line's "Navigate" entry point will be added (a button next to the existing "View on Map" link, using the assignment's issue coordinates as the destination).** |
| `pages/MapDashboard.tsx` layer toggle / legend / planning FAB chrome | `naps/map.html`'s filter cards, legend row, "Add NAP" / "Report an Issue" buttons | **Already exists. Route-line adds one more optional layer toggle and its own panel, not a redesign.** |
| React Router (`BrowserRouter`, `Routes`) | Flask routing / Jinja `{% extends %}` / `url_for()` | **Confirmed: no client-side router will be introduced. `?issue_id=` (already supported by `naps.geomap()`) is the mechanism a "Navigate" link will reuse to hand off a destination into the map page.** |
| `data/sampleData.ts` (hard-coded NAPs/subscribers/technicians/complaints) | MySQL via SQLAlchemy (`app/models.py`), served through `/api/naps`, `/api/issues`, `/api/subscribers`, and a new read-only technician-location feed (Phase 2) | **Confirmed: no hard-coded prototype data will be copied into NAP-IQ. All route-line inputs (technician position, destination position) will come from the database via existing or new read-only JSON endpoints.** |

### State/data mapping detail

| Prototype state | NAP-IQ source of truth |
|---|---|
| `NavigationDestination` (`type`, `position`, `complaintId`) | A `TechnicalIssue` row (`latitude`/`longitude`, `id`), a `Subscriber` row (`latitude`/`longitude`), or a `Nap` row (`latitude`/`longitude`) — all already exposed by `/api/issues`, `/api/subscribers`, `/api/naps`. |
| `technicianPosition` (live/demo) | `Technician.current_latitude` / `current_longitude` as the starting fallback; OSRM-returned route points thereafter (client-side only, never written back to the DB in this phase). |
| `NavigationOrigin` "manual" suggestions (subscriber/NAP addresses) | Same `/api/subscribers` and `/api/naps` feeds `napmap.js` already loads into `allSubscribers` / `allNaps` — no new query needed. |
| `role` (admin/technician/collector) | `g.user.role` (`administrator`/`technician`/`payment_collector`/`user`), already enforced server-side by `@role_required` on every relevant route/blueprint. |
| Route (`points`, `distanceMeters`, `durationSeconds`) | Fetched client-side from the public OSRM endpoint (`router.project-osrm.org`), exactly as the prototype does — this is not NAP-IQ application data, so it does not touch MySQL. Kept in a small JS module-scope object, mirroring how `napmap.js` already holds `allNaps`/`allIssues` in memory. |
| Assigned technician for a destination | `Assignment.technician_id` for the issue's current open assignment (already queried in `dispatch.py`/`technician.py`) — the route-line feature will read this, never assign on its own. |

## 4. Files that will actually change in later phases

This phase changes **nothing** except adding this notes file. The plan
for the phases that implement the route line:

**Additive only — nothing below is a rewrite of an existing file's
existing behavior; each is either a brand-new file or an append to an
existing one guarded behind new, opt-in markup/IDs.**

1. `app/static/js/nav-route.js` *(new)* — the route-line logic:
   destination/origin state, OSRM fetch, Leaflet route polyline +
   technician marker layers, demo-travel interval, device GPS
   `watchPosition`. Direct JS translation of
   `NavigationStore.tsx` + the route-drawing parts of `GeoMap.tsx`,
   without React — plain functions and a module-scope state object,
   matching `napmap.js`'s existing style exactly.
2. `app/static/css/nav-route.css` *(new, optional)* — small,
   Bootstrap-variable-driven styling for the nav panel, if Bootstrap
   utility classes alone aren't enough.
3. `app/templates/naps/map.html` *(append only)* — a new collapsible
   panel (Bootstrap offcanvas/card, following the existing
   `quickAddModal` pattern) containing the destination `<select>` and
   origin picker markup, plus one `<script>` tag for `nav-route.js`.
   No existing block, id, or markup is removed.
4. `app/static/js/napmap.js` *(small additive hook only)* — expose the
   already-loaded `map`, `allNaps`, `allIssues`, `allSubscribers`
   objects to `nav-route.js` (e.g. a tiny `window.NapMap` handle set
   once at the end of `init()`), so the new module can reuse the
   existing datasets instead of re-fetching them. No existing function
   is modified in place.
5. `app/routes/technician.py` *(append only)* — a "Navigate" link
   added to `technician/index.html` next to the existing "View on Map"
   link, reusing the existing `naps.geomap(issue_id=...)` URL (no new
   route needed — `issue_id` already flows through).
6. `app/routes/api.py` *(new endpoint only, Phase 2)* — a read-only
   `GET /api/technicians/<id>/location` (or similar) if
   `Technician.current_latitude/longitude` needs to be fetched
   on-demand for a role other than the technician's own map (exact
   shape to be confirmed against RBAC rules in Phase 2, since
   `/api/naps` and `/api/issues` currently apply different Technician
   scoping rules that this new endpoint must not accidentally
   loosen).

No model changes are anticipated — `Technician.current_latitude` /
`current_longitude` already exist and are sufficient for the origin
fallback; the route itself is never persisted to MySQL, matching the
prototype's own design (it's a live, ephemeral OSRM response).

## 5. Explicit non-goals (confirmed against your constraints)

- No React runtime, bundler, or `node_modules` is introduced into the
  Flask app.
- No existing Flask route, model, template, or JS function is deleted
  or rewritten in place because the prototype "does it differently."
- No hard-coded NAP/subscriber/technician/complaint/coordinate data
  from `data/sampleData.ts` is copied into NAP-IQ. Every marker and
  every routing origin/destination in the eventual implementation
  traces back to `/api/naps`, `/api/issues`, `/api/subscribers`, or
  `Technician.current_latitude/longitude` in MySQL.
- Existing auth, RBAC (`@role_required`), CSRF (Flask-WTF,
  `csrf-token` meta tag already read by `napmap.js`'s own fetches),
  SQLAlchemy models, Flask routes, Jinja templates, Bootstrap styling,
  and the existing Leaflet installation are all reused as-is.
- The existing dispatch/scoring/assignment system
  (`app/recommendation.py`, `app/routes/dispatch.py`) is treated as
  authoritative and is not replaced by the prototype's simpler
  in-memory scorer.

## 6. Acceptance criteria check (Phase 1)

- [x] No existing functionality is broken — zero application files
      were modified.
- [x] No React runtime is added to the Flask application.
- [x] Prototype-to-target architecture is clearly mapped (§3).
- [x] Existing Flask/Leaflet architecture remains the foundation (§2,
      §4).

## 7. Verification performed this phase

- Unzipped and inspected both projects' full source trees
  (`node_modules` excluded from all analysis and from this package).
- Read every prototype file listed in the Phase 1 instructions in
  full: `App.tsx`, `types/index.ts`, `store/AppStore.tsx`,
  `store/MapUI.tsx`, `store/NavigationStore.tsx`,
  `components/map/GeoMap.tsx`, all of `components/navigation/*`,
  `components/panels/PanelHost.tsx`, `components/modals/DispatchModal.tsx`,
  `pages/MapDashboard.tsx`.
- Read the target's `app/routes/api.py`, `app/routes/naps.py` (in
  part), `app/routes/dispatch.py` (route list), `app/routes/technician.py`
  (route list), `app/models.py` (all model class definitions),
  `app/recommendation.py` (module docstring/design), `app/auth.py`
  (RBAC mechanics), `app/templates/naps/map.html`,
  `app/static/js/napmap.js` (structure + init flow),
  `app/templates/technician/index.html` (existing map hand-off link),
  `requirements.txt`, and confirmed `app/static/vendor/leaflet` is
  already vendored.
- No syntax/build check was run because no code was changed — this
  phase produced documentation only. A `python -m py_compile` /
  `flask routes` sanity check will be part of Phase 2's own
  acceptance step, once `nav-route.js` and the template/route edits
  actually land.

## 8. Known limitations / open questions for Phase 2

- **Technician-location read access for non-owning roles.** `/api/naps`
  and `/api/issues` apply different Technician-scoping rules (naps:
  unscoped; issues: scoped to own assignments). Before adding a
  technician-location endpoint, Phase 2 needs to confirm whether an
  Administrator viewing the route line for *any* technician is
  in-scope, or whether a Technician should only ever navigate using
  their *own* `current_latitude/longitude` (in which case no new
  endpoint is needed at all — the value can be inlined into
  `technician/index.html` server-side instead of fetched via a new
  API).
- **OSRM's public router (`router.project-osrm.org`) is a rate-limited
  demo instance**, exactly as it is in the prototype. This phase does
  not change that; a self-hosted OSRM instance is out of scope unless
  requested.
- **`Technician.current_latitude/longitude` is not kept live today** —
  nothing in NAP-IQ currently updates it on a schedule. The route-line
  feature can use it as a one-time starting point (same as the
  prototype's own device-GPS fallback pattern), but continuous live
  fleet tracking (the prototype's `watchPosition` device mode) will
  only update the *browser's own* position, not this DB column, unless
  a later phase is explicitly asked to add that write-back.
