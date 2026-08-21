# PHASE 1 — 10% — Installation Planning: Prototype Audit + Integration Architecture

**Status:** Phase 1 of the NAP-IQ Installation Planning integration
(follows the completed 20-phase Navigation/Route-Line plan and the
completed Phase 22 nearest-available-NAP recommendation engine).
This phase is **audit and architecture-decision only**. No behavior
changed. No route, model, template, or JS file was modified.

---

## 1. What this phase adds

| File | Change |
|---|---|
| `PLAN_INSTALL_10_PERCENT_NOTES.md` | **New.** This file. |

Nothing else changed. No code was written this phase — only
inspection of the prototype and the target, and the architecture
decision documented below.

---

## 2. Prototype inspected

Source: `napV4-route line (2)/src/`

| Prototype file | What it contains |
|---|---|
| `components/planning/InstallationPlanner.tsx` | Three-step panel (`suggest` → `form` → `done`) rendered when `planning && proposed` is true. Calls `nearestAvailableNap(proposed)`, then on submit calls `addSubscriber(data, napId)`. |
| `store/AppStore.tsx` — `nearestAvailableNap(pos)` | In-memory candidate = every NAP with `napUsage(nap.id).available > 0` (no `status` check — the prototype's sample NAPs have no inactive/maintenance state), sorted by haversine distance, returns the nearest or `null`. |
| `store/AppStore.tsx` — `napUsage(napId)` | `{ used, total, available }` computed by counting `subscribers` whose `napId` matches, against `nap.totalSlots`. |
| `store/AppStore.tsx` — `addSubscriber(data, napId)` | Pushes a new in-memory `Subscriber` with `id: 'sub-' + Date.now()` and `code: `${nap.code}-${letter}`` where `letter` is `String.fromCharCode(65 + existingCountForThisNap)` (A, B, C, ... per NAP). No persistence — a page refresh loses it. |
| `data/sampleData.ts` — `PLAN_FEES` | Hard-coded `Record<PlanType, number>` — 4 plan names → flat peso fee. |
| `data/sampleData.ts` — `BARANGAYS` | Hard-coded array of 12 barangay name strings. |
| `pages/MapDashboard.tsx` | Owns `planning` (bool) and `proposed` (`LatLng \| null`) state. A purple "Plan installation" FAB shows only `role === 'admin' && !planning`. While `planning`, a banner reads "Tap anywhere on the map to drop a prospect pin" (or "Prospect pinned..." once `proposed` is set) with an exit (X) button. `GeoMap`'s `onMapClick` sets `proposed`. `{planning && proposed && <InstallationPlanner .../>}` and `{!planning && <NavigationCard />}` are mutually exclusive — only one of the two cards ever shows. |

---

## 3. Target inspected

| Target file | Relevant finding |
|---|---|
| `app/nap_recommendation.py` | Phase 22's `recommend_naps(customer_latitude, customer_longitude, limit=None)` — **already does** exactly what `nearestAvailableNap()` does, and more rigorously: filters `status == "active"` **and** `available_ports > 0` (the prototype only checks capacity, not status), computes `haversine_km` (reused from `app.recommendation`, single source of truth), sorts nearest-first with a deterministic `nap_code` tiebreaker, and returns the *full* suitable pool with `is_recommended` flagged on row 0. **Purely read-only.** Its docstring already says it's designed to be reused, not reimplemented. |
| `app/routes/service_requests.py` | `recommend_nap(request_id)` (GET, read-only) and `assign_nap(request_id)` (POST, CSRF-protected, re-validates NAP status/ports server-side before writing) are the existing "advisory page + separate confirm route" pair built around `recommend_naps()`. Both require an existing `ServiceRequest` row with `latitude`/`longitude` already set — there is no existing entry point that calls `recommend_naps()` from a bare lat/lng with no `ServiceRequest` in play yet. |
| `app/routes/subscribers.py` | `add_subscriber()` — full `SubscriberForm` (CSRF via Flask-WTF), builds a `Subscriber` row directly. **No auto-generated subscriber code today** — `subscriber_code` is a required, manually-typed `StringField` (`app/forms.py`), validated only for uniqueness (`validate_subscriber_code`). There is currently no "code generation scheme" elsewhere in the app to reuse for Phase 5 — this is a gap the prototype has (`{napCode}-{letter}`) and the target does not; Phase 5 will need to either adopt a similar deterministic scheme or otherwise decide how the code is produced. Documented here so Phase 5 doesn't have to rediscover it. |
| `app/models.py` | `Subscriber`: `subscriber_code`, `full_name`, `address` (free-text `String(255)`, **no dedicated barangay column**), `latitude`/`longitude` (nullable), `contact_number`, `email`, `plan_type` (free-text `String(50)`, **no plan-fee column, no enum**), `nap_id` (FK, nullable), `status` (active/inactive/disconnected), `installed_at`. `Nap`: `nap_code`, `name`, `address`, `latitude`/`longitude` (non-null), `total_ports`/`used_ports`/`available_ports`, `status` (active/inactive/full/maintenance). `ServiceRequest`: `request_type`, `subscriber_id` (nullable), `requested_nap_id` (nullable), `status`, `latitude`/`longitude` (Phase 22 addition, nullable), `notes`. |
| `app/forms.py` — `SubscriberForm` | `address` is a `TextAreaField` placeholder text is `"Street, Barangay, City/Municipality, Province"` — barangay is expected to live *inside* the free-text address, not as its own field. `plan_type` is an unconstrained `StringField(max=50)` — no fixed plan list or fee table exists anywhere in the target (`grep -rn plan_fee` and `grep -rln BARANGAYS/barangay` across `app/` both come back empty except that one placeholder string). |
| `app/auth.py` | `role_required(*roles)` — the one RBAC decorator used everywhere (`@role_required("administrator")`, `@role_required("administrator", "technician")`). Unauthenticated → redirect to login; wrong role → HTTP 403. This is the exact mechanism to gate a new admin-only route/control with — no new RBAC pattern is needed. |
| `app/routes/naps.py` — `geomap()` | `_VIEW_ROLES = ("administrator", "technician")`, `_MANAGE_ROLES = ("administrator",)`. `geomap()` itself is `@role_required(*_VIEW_ROLES)` (both roles can view the map); NAP-mutating routes (`add_nap`, `quick_add_nap`, `edit_nap`, `(de)activate_nap`) are `@role_required(*_MANAGE_ROLES)` (admin only). **Note for later phases:** the existing "Add NAP" / "Report an Issue" buttons in `naps/map.html` are *not* currently Jinja-gated by role (they render for both admin and technician; only the backend route rejects a technician's submission with a 403). The Installation Planning control should do better than this existing pattern and be Jinja-gated (`{% if current_user.role == 'administrator' %}`) to match the prototype's `role === 'admin'` check exactly, not just rely on the backend. |
| `app/templates/naps/map.html` + `app/static/js/napmap.js` | Already hosts three mutually-exclusive map-click "placement modes" that yield to each other: Add-NAP mode, Report-Issue mode, and the navigation feature's manual origin-picker (`nav-origin-picker.js`). `napmap.js`'s `enterAddMode()` explicitly calls `exitIssueMode()` and `NapIQNavOriginPicker.stopPicking()` before activating — "only one placement mode is active at a time" is an established, reusable pattern. A future "Plan Installation" mode (Phase 3) must join this same yield-to-each-other chain rather than introduce a fourth, uncoordinated click handler. The existing navigation card (`nav-card.js`) and the Phase 22 recommend-NAP display already share this same map/page, so screen space and z-index precedent exist to follow. |

---

## 4. Integration map: prototype concept → NAP-IQ equivalent

| Prototype concept | NAP-IQ equivalent | Notes |
|---|---|---|
| `nearestAvailableNap(pos)` | **Reuse** `app.nap_recommendation.recommend_naps(lat, lng, limit=1)` (or the full list, showing `rows[0]`) | The prototype's function is a strict subset of what `recommend_naps()` already does (capacity-only vs. capacity+status), so there is nothing to reimplement — only a Phase 2 task of exposing it from a raw lat/lng (it already accepts raw lat/lng args; it does not require a `ServiceRequest` row at all — the `ServiceRequest`-shaped caller in `service_requests.py` is just one consumer of a function that already takes plain coordinates). |
| `napUsage(napId)` | Already folded into `recommend_naps()`'s per-row `available_ports`/`total_ports` — no separate lookup needed. | — |
| `addSubscriber(data, napId)` | **Reuse** the existing `Subscriber` model + the existing `SubscriberForm`/`add_subscriber()` validation path (CSRF, uniqueness check), not a second ad hoc insert. | See §5 for the create-path decision. |
| `PLAN_FEES` | Target's existing free-text `plan_type` field. No fee table exists in the target at all (fees are not modeled anywhere — not on `Subscriber`, not on `Nap`, not in a separate config). **Decision:** do not introduce a new `PLAN_FEES`-equivalent config structure in Phase 1–8 of this plan; a plan-type text field mirrors what the rest of the app already does with `plan_type`, and inventing a fee table would be new scope beyond "integrate the pin → suggest → create flow" that this plan describes. If a fixed plan list turns out to be needed for a `<select>` in Phase 5, it will be sourced from *existing* `Subscriber.plan_type` distinct values in the database, not hard-coded from the prototype's 4 sample plans. |
| `BARANGAYS` | Target's existing free-text `address` field (`"Street, Barangay, City/Municipality, Province"`). No dedicated barangay column/table exists. **Decision:** no new `BARANGAYS` list or column is introduced; Phase 5's address input reuses the existing free-text `address` field, exactly as every other subscriber-creation path in this app already does. |
| `role === 'admin'` toggle | `app.auth.role_required("administrator")` on the backend route(s), plus a Jinja `{% if current_user.role == 'administrator' %}` guard on the control itself (stricter than the existing Add-NAP/Report-Issue buttons — see §3). | — |
| `planning` / `proposed` state, mutual exclusivity with `NavigationCard` | A new JS "planning mode" in `napmap.js`, added to the existing yield-to-each-other chain (Add-NAP / Report-Issue / origin-picker), and a new Bootstrap panel that only shows while planning mode is active and a pin is dropped — mutually exclusive with the existing navigation card in the same floating-panel slot, mirroring `{planning && <InstallationPlanner/>}` / `{!planning && <NavigationCard/>}`. | Deferred to Phase 3/4 — not built this phase. |

---

## 5. Architecture decision: Subscriber-direct vs. ServiceRequest-first

**Decision: this feature will create a `Subscriber` row directly (via
the existing `SubscriberForm`/`Subscriber` model), matching the
prototype's immediate `addSubscriber()` call. It will *not* create a
`ServiceRequest` first.**

### Trade-off considered

**Option A — Subscriber-direct (chosen).**
- Matches the prototype's actual behavior exactly: drop a pin, see a
  suggestion, fill a short form, get a subscriber immediately linked
  to a NAP. There is no "pending request" concept in the prototype's
  flow at all.
- Reuses the existing `Subscriber` model and the existing
  `add_subscriber()` validation/CSRF logic (Phase 12) — no new
  database writes to a table this feature doesn't need.
- Keeps the two entry points cleanly separated by what they represent:
  a `ServiceRequest` is *a request that something happen* (subject to
  approve/reject/schedule, Phase 15-17's workflow); this new feature is
  *the administrator directly provisioning a subscriber* they've
  already decided to install, from a location they just picked on the
  map. Nothing about the prototype's flow implies an approval step —
  the admin drops the pin *because* they've already decided to
  install.

**Option B — ServiceRequest-first (rejected for this feature).**
- Would create a `ServiceRequest` (type `new_installation`, with
  `latitude`/`longitude` set) and route it through the existing
  `recommend_nap()`/`assign_nap()` pair from Phase 22, only creating
  the `Subscriber` later (via some other, still-nonexistent, "approve
  and provision" step).
- Rejected because: (a) it does not match what the prototype actually
  does — the prototype's `addSubscriber()` is a direct, immediate
  write, with no intermediate approval object; inventing an approval
  step here would be new scope beyond "translate this prototype
  feature," not requested by this plan; (b) it would require *also*
  inventing the "ServiceRequest → Subscriber" provisioning step that
  does not exist anywhere in the target today, which is strictly more
  new code than reusing the existing direct-create path; (c) it risks
  the exact "duplicate database records" problem the global
  instructions warn against — a `ServiceRequest` row that immediately
  and automatically becomes a `Subscriber` row is a `ServiceRequest`
  that never actually functions as a request (no one ever
  approves/rejects/schedules it), which would leave a confusing
  half-used table.

### Why this does not duplicate or conflict with the existing
Phase 22 ServiceRequest/nap_recommendation flow

The existing flow (`ServiceRequest` → `recommend_nap()` →
`assign_nap()`) stays **completely untouched and fully intact**. It
continues to serve its actual purpose: a customer-submitted or
staff-logged *request* (new installation, disconnection, relocation,
upgrade) that goes through `pending → approved/rejected → scheduled →
completed`, with a NAP recommendation as one step inside that
workflow, for a request that **already exists** as a database row.

This new feature is a *second, faster, additive* entry point for the
same underlying idea — "given a location, which NAP should serve
it?" — for the specific case where an administrator is standing at
the map with a location already in mind and wants to provision a
subscriber immediately, with no prior `ServiceRequest` in the
system at all (e.g. a walk-in customer, a field survey pin, a
proactive expansion decision). It reuses `recommend_naps()` (the same
function, unmodified) as its suggestion engine, but never touches the
`service_requests` table. An administrator who *does* want the
request/approval workflow still has it, unchanged, via
Service Requests → Add → (eventually) Recommend NAP → Assign NAP.

Both paths converge on the same place — a `Subscriber` row linked to
a `Nap` via `nap_id` — by two different, equally valid administrator
workflows, exactly as the plan's "ADDITIONAL, faster entry point for
the same underlying idea, not a replacement for either" instruction
requires.

---

## 6. Files that will be changed in later phases (planned, not yet touched)

| Phase | File(s) | Nature of change |
|---|---|---|
| 2 (25%) | `app/nap_recommendation.py` | Additive only, if `recommend_naps()` needs a thin wrapper/alias for a raw-lat/lng call site name — it already accepts raw lat/lng, so this may end up being a no-op beyond documentation. |
| 2 (25%) | `app/routes/api.py` (or a new small route) | New read-only JSON endpoint, only if no existing endpoint already returns this exact shape from a raw lat/lng. |
| 3 (40%) | `app/templates/naps/map.html` | Additive: one new admin-gated button + one new mode banner, joining the existing Add-NAP/Report-Issue/origin-picker yield chain. |
| 3 (40%) | `app/static/js/napmap.js` (or a new small JS module, following the `nav-origin-picker.js` precedent) | Additive: new "planning mode" state + pin marker, coordinated with existing modes. |
| 4 (55%) | `app/templates/naps/map.html` and/or a new partial | Additive: suggestion panel, mutually exclusive with the existing navigation card. |
| 5 (70%) | New route in `app/routes/naps.py` or `app/routes/subscribers.py` (TBD in Phase 5, reusing `SubscriberForm`) | Additive: the create-subscriber-from-pin endpoint, CSRF-protected, admin-only, reusing existing validation. |
| 6 (85%) | `app/static/js/napmap.js` | Additive: success state, marker refresh. |
| 7 (95%) | Tests under `tests/`, various | Additive: new RBAC/flow tests. |
| 8 (100%) | Various, cleanup only | Removal of anything unused introduced in Phases 2-7; no new features. |

No file above has been modified yet. This phase changed nothing
except adding this notes file.

---

## 7. Acceptance criteria check

- [x] No existing functionality is broken — nothing was changed except
      adding this notes file (verified: `git status`-equivalent below).
- [x] No React runtime is added to the Flask application — nothing
      was added at all this phase.
- [x] Prototype-to-target architecture is clearly mapped — §4.
- [x] The relationship between this new feature and the existing
      ServiceRequest/nap_recommendation.py flow is explicitly
      resolved, not left ambiguous — §5.

## 8. Verification performed

```
$ python3 -m py_compile app/routes/service_requests.py app/routes/subscribers.py \
      app/routes/naps.py app/nap_recommendation.py app/models.py app/forms.py app/auth.py
(no output — all compile cleanly, unchanged from baseline)
```

Only file added this phase: `PLAN_INSTALL_10_PERCENT_NOTES.md`. No
`.py`, `.html`, `.js`, or `.css` file in the target was modified.

---

**STOP.** This is the end of Phase 1 (10%). Phase 2 (the
nearest-available-NAP-for-a-point data contract) is intentionally not
started — per your instructions, only Phase 1's audit/architecture
work is included in this delivery.
