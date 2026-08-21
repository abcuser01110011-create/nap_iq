# PHASE 17 — 85% — Search → Destination → Route

**Status: implemented for the scope defined in this phase. Verified by
static syntax/brace checks against the real files plus an illustrative
Playwright screenshot (real CSS, sample data) — network egress was off
this round, so `pip install -r requirements.txt` could not reach PyPI
and the Flask/MySQL app could not actually be booted. See §5.**

---

## 1. Scope (from the phase plan)

> Extend [the existing search] so that selecting a search result can
> optionally: 1) focus the map; 2) open the entity; 3) select it as a
> navigation destination; 4) launch navigation. Support NAP search,
> subscriber search, complaint search. Do not remove existing search
> behavior. Do not make search automatically start navigation without
> an explicit user action.

Nothing outside this — no OSRM/routing changes, no GPS changes, no
dispatch changes, no UI-parity restyling beyond what this feature
itself needed. Phases 1–16 (audit through UI parity) are unchanged.

## 2. Files changed

| File | Change |
|---|---|
| `app/static/js/napmap.js` | `handleSearchInput()` rewritten to search `allNaps` **and** `allIssues` **and** `allSubscribers` (previously NAP-only) and render a combined, capped, type-badged result list. New helper functions `findSearchMatches()`, `focusSearchResult()`, `buildDestinationForSearchResult()`. `selectNap()`, `focusIssue()`, `focusSubscriber()`, `buildDestinationFromNap()`, `buildDestinationFromIssue()`, `buildDestinationFromSubscriber()` — all pre-existing from Phases 13/15/23(15%) — are **reused as-is, unchanged**, not duplicated. |
| `app/templates/naps/map.html` | Search card label changed from "Search NAP" to "Search"; input placeholder updated to mention NAP/subscriber/complaint. `#napSearchInput`/`#napSearchResults` element ids are untouched, so nothing else that references them broke. |
| `app/static/css/napmap.css` | **Additive** section appended at the end (matching the Phase 16 pattern of appending rather than editing existing rules): a `cursor: default` override for the new two-target result row (so the row itself no longer looks like one giant button now that it contains two independently clickable controls), and one small custom badge color (`.napiq-badge-subscriber`, `#6f42c1`) matching the existing subscriber marker's purple since Bootstrap has no built-in "purple" badge utility. Nothing above the new section was touched. |
| `PHASE17_85_PERCENT_NOTES.md` | New. This file. |
| `phase17_screenshots/` | New. One illustrative screenshot, see §5. |

No backend/Python/API changes. `allNaps`, `allIssues`, and
`allSubscribers` were already fetched in full on page load by
`init()` (Phases pre-dating this one) — this phase only changed how
that already-loaded, already-real data is *searched and rendered*,
client-side. No new database records, no new endpoints, no schema
changes.

## 3. How it works

**Matching.** `findSearchMatches(query)` filters the three in-memory
arrays independently (case-insensitive `includes()`, same approach the
old NAP-only search used):
- NAP: `nap_code` or `name`
- Subscriber: `full_name`, `subscriber_code`, or `address` — and only
  if the subscriber actually has `latitude`/`longitude` (some do not;
  a search result must be focusable, so those are skipped, matching
  how `focusSubscriber()` already assumes coordinates exist)
- Complaint (technical issue): `issue_code`, `subscriber_name`, or
  `address`

Each category is capped at 4 results (`SEARCH_RESULTS_PER_TYPE`) to
keep the dropdown short; results are grouped NAP → Subscriber →
Complaint. This is a simple, documented cap, not a hidden limitation —
a query matching more than 4 of one type just doesn't show the rest,
same tradeoff the old NAP-only search already made at a flat cap of 8.

**Rendering.** Each result row now has two independent controls,
because the acceptance criteria explicitly requires that routing (or
even destination-setting) never happens just from typing a query or
skimming the list:

- **Row body (`data-search-focus-index`)** — clicking the entity's
  name/badge calls `focusSearchResult()`, which dispatches to the
  *existing* `selectNap()` / `focusIssue()` / `focusSubscriber()`
  functions. These already: force the right status/layer toggle on so
  the marker is guaranteed visible, re-render, `flyTo` the entity, and
  open its real popup. This is exactly what the old NAP-only search
  already did for a NAP — now available for all three types, and nothing
  about the destination is changed by this click.
- **Destination button (`data-search-dest-index`, the
  <i class="bi-signpost-split"></i> icon)** — the one explicit,
  deliberate action. It runs the same focus/open as above, then calls
  `buildDestinationForSearchResult()` (dispatching to the existing
  `buildDestinationFromNap/Issue/Subscriber()` helpers already used by
  the in-popup "Set as destination" button and by the `?navigate_type=`
  query-param flow from Phase 13) and hands the result to
  `window.NapIQNavigation.setDestination()`.

Both handlers call `event.stopPropagation()`/close the dropdown so a
click on one control can't be misread as the other.

**Why this satisfies "no automatic navigation start."**
`NapIQNavigation.setDestination()` only *arms* a destination — it does
not by itself call OSRM or request a route. Route calculation
(`nav-routing.js`, Phase 5) only fires once both a destination **and**
an origin exist, and an origin still requires its own explicit action
(manual pin, typed coordinates, or device GPS — Phases 8/11). So even
the destination button here can't accidentally "launch navigation" in
the sense of starting a route; it only reaches the same armed state
the pre-existing popup button already produced. This mirrors this
project's own precedent — `focusNavigationFromQueryParam()`'s doc
comment says a NAP/issue/subscriber reached via a link is, from that
point on, "indistinguishable... from one picked by hand on the map",
which is the same standard applied here.

## 4. What was deliberately not done

- No fuzzy/ranked search — still simple substring matching, same
  algorithm class as the pre-existing NAP search, just applied to more
  fields/types. A smarter ranking wasn't part of this phase's scope.
- No backend `/api/search` endpoint. Everything needed was already
  loaded client-side; adding a server round-trip for this would be a
  bigger change than "extend the existing search," and the plan's
  global instructions ask for additive, minimal changes.
- Technician-scoped visibility is inherited for free: `allIssues` and
  `allSubscribers` are already whatever `/api/issues`/`/api/subscribers`
  returned for the logged-in role (Phase 15/16 RBAC scoping, described
  in `app/routes/api.py`), so a Technician's search results are
  automatically limited to their own assigned issues/subscribers with
  zero new code here — this phase didn't touch that scoping and
  doesn't need to.
- No change to the collapsed/expanded navigation card
  (`nav-card.js`) itself — arming a destination via search updates it
  exactly the same way arming one via a popup button already did
  (through the existing `napiq:destination-changed` event), so it
  didn't need touching.

## 5. Verification performed

Network egress was off this round (`pip install -r requirements.txt`
could not reach PyPI; `flask_sqlalchemy`/`pytest`/a MySQL server are
not present in this sandbox), so the real Flask app could not be
booted and a live-data, live-server screenshot was not possible —
same constraint noted in Phase 16's notes.

Checks that were run against the real files:

1. `node --check app/static/js/napmap.js` — passes.
2. CSS brace balance on `app/static/css/napmap.css` — 86 open / 86
   close, matched.
3. `python3 -m py_compile` across every file under `app/` — passes (no
   Python was touched this phase; re-run for safety).
4. Grepped the codebase for other references to the search box's
   label text/ids (`napSearchInput`, `napSearchResults`, "Search NAP")
   to confirm nothing else depends on the exact label wording that
   changed — only `naps/map.html` itself referenced it; a separate,
   unrelated top-nav search bar in `dashboard_base.html`
   ("Search NAPs, subscribers, issues…") is a distinct, pre-existing
   element this phase did not touch.
5. Built an **illustrative** static preview page using the real,
   unmodified `napmap.css`, the real vendored Bootstrap/Bootstrap
   Icons this project ships (not a CDN — egress is off), and the
   exact HTML string shape `handleSearchInput()` now renders (copied
   from source, with representative sample NAP/subscriber/complaint
   data standing in for what would normally come from the three
   real API responses). Rendered with Playwright/Chromium.

   `phase17_screenshots/phase17_search_dropdown_desktop_illustrative.png`
   — labeled directly on the image as illustrative — shows a query
   ("cruz") matching one subscriber, one complaint, and two NAPs, each
   with its type badge and the two click targets described in §3.

This exercises the real CSS and the real per-row markup shape (which
is what actually matters for whether the two click targets read as
distinct and whether the new subscriber badge color/contrast works),
but it does **not** demonstrate a live browser hitting `/naps/map`,
live MySQL-backed search results, or an actual click-through end to
end. That would need a live Flask/MySQL server, which egress being off
prevented this round, same limitation Phase 16 already flagged.

## 6. Remaining limitations

- Not verified against a live server/browser this round (see §5) —
  code-level and static-render verification only.
- Search is still simple substring matching across a small, fixed
  field set per type; no ranking, no fuzzy matching, no debounce
  beyond the existing `input`-event handler.
- The per-type cap (4 results each) is a fixed constant, not
  user-configurable or reflected in a "N more results" affordance.

## 7. Acceptance criteria check

- [x] Search result can become a navigation destination — via the new
      explicit destination button, for all three entity types.
- [x] Map focuses correctly — reuses the existing, already-correct
      `flyTo`/popup logic for all three types.
- [x] Correct entity panel opens — the entity's real popup (NAP,
      subscriber, or complaint), same as every other focus path in
      this file.
- [x] User explicitly controls when routing begins — `setDestination()`
      only arms a destination; route calculation still requires a
      separately, explicitly chosen origin (Phases 5/8/11), unchanged.
- [x] Existing search behavior not removed — NAP search by code/name,
      the dropdown container, and its filter/re-render side effects
      are all intact; only extended.

STOP — no Phase 18 work included. Awaiting the next phase prompt.
