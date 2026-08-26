"""
Nearest Available NAP Recommendation Engine (Phase 22 — phase_11.pdf)
------------------------------------------------------------------------
Given a customer/proposed-installation location (a `service_requests`
row's `latitude`/`longitude` — see Phase 22's addition to that table
in database/schema.sql and app/models.py), returns every NAP that can
actually take a new connection right now, nearest first, so an
Administrator can pick one for the request without manually
cross-checking every NAP's status and port count by hand.

WHAT THIS IS
==============
A transparent, rule-based filter-then-sort — not a scoring formula
like app/recommendation.py's technician engine (phase_10.pdf), because
phase_11.pdf doesn't ask for one: it asks for the *nearest suitable*
NAP, where "suitable" is a hard yes/no (active status, ports actually
free), not a weighted trade-off between competing factors. So this
module deliberately does NOT produce a 0-100 "score" the way
app/recommendation.py does — there is nothing to weigh once the
unsuitable candidates are removed, only a distance to sort the
remainder by. Reuses `app.recommendation.haversine_km` for the actual
great-circle math rather than redefining it — same formula, same
constants, one source of truth for "great-circle distance in km"
across both recommendation features.

THIS MODULE NEVER WRITES TO THE DATABASE
===========================================
`recommend_naps()` is read-only, same guarantee
app/recommendation.py's `get_recommendations()` makes for the
technician engine. Setting `ServiceRequest.requested_nap_id` (the one
irreversible-ish step — it can always be changed again later, but it's
still a deliberate administrator action, not something this module
does on its own) happens only in app/routes/service_requests.py's
`assign_nap()`, which requires a real POST with a CSRF token from an
Administrator. See that route's docstring for exactly how the
"Administrator confirms -> Create assignment" step of phase_11.pdf's
workflow diagram is wired up — same pattern Phase 21 already
established for technician dispatch.

THE WORKFLOW, MAPPED TO phase_11.pdf'S DIAGRAM
==================================================
    Technical Issue                  -> N/A for this feature (a
                                         service_request, not a
                                         technical_issue)
    Capture customer coordinates     -> ServiceRequestForm.latitude /
                                         .longitude (Phase 22 addition,
                                         see app/forms.py)
    Retrieve active NAPs             -> Nap.query.filter_by(status="active")
    Check available ports            -> nap.available_ports
    Exclude NAPs with no available
      ports                          -> filtered out in Python, below
    Calculate distance                -> haversine_km() (imported from
                                         app.recommendation)
    Sort suitable NAPs by distance    -> ascending, nearest first
    Recommend the nearest suitable
      NAP                             -> rows[0], flagged is_recommended
    Show recommendations              -> GET /service-requests/<id>/recommend-nap
                                         (app/routes/service_requests.py)
    Display on the GeoMap             -> GET /naps/map?recommend_request_id=<id>
                                         (see app/routes/naps.py's geomap()
                                         and app/static/js/napmap.js's
                                         focusNapRecommendationFromQueryParam())

CANDIDATE POOL (REQUIREMENTS 2-4)
====================================
Three independent filters, all required before a NAP is even a
candidate:
    1. `status == 'active'` — an 'inactive', 'full', or 'maintenance'
       NAP is never suitable regardless of what its port count says
       (a 'full' NAP's `available_ports` should already read 0, but
       this filter is applied on `status` directly rather than
       inferred from ports, so a NAP an administrator has manually
       flagged 'maintenance' — physically present but not accepting
       new drops — is excluded too, even if `available_ports` happens
       to still show a nonzero count).
    2. `available_ports > 0` — the maintained-by-the-application-layer
       column already used everywhere else in this app (see
       app/models.py's `Nap` docstring and app/routes/naps.py); a NAP
       with zero free ports can't take a new connection no matter how
       close it is.
    3. Within `AppSettings.nap_connection_radius_meters`, if that
       admin-configured setting is nonzero (Settings > App Settings >
       "Max Connection Radius") — a NAP farther than this from the
       customer location is excluded the same way a full/inactive NAP
       is, not merely sorted last. `0` (the default) disables this
       filter entirely.
All three must pass — a NAP failing any is dropped before distance is
even computed for it.

DISTANCE (REQUIREMENT 5)
===========================
Great-circle (haversine) distance in kilometers between the request's
`(latitude, longitude)` and each candidate NAP's `(latitude,
longitude)` — `naps.latitude`/`longitude` are `NOT NULL` columns (see
database/schema.sql), so unlike app/recommendation.py's technician
distance factor, there is no "unknown NAP location" fallback case to
handle here; every candidate NAP always has a real coordinate to
measure from. Straight-line, not driving distance — same reasoning as
app/recommendation.py's DISTANCE factor: there's no routing/mapping
API wired into this app, and straight-line is an honest, explainable
proxy given what data NAP-IQ actually has.

RANKING (REQUIREMENTS 6-7)
=============================
Candidates are sorted by `distance_km` ascending — nearest first. Ties
(two NAPs at the exact same computed distance, e.g. same coordinates
seeded twice) break by `nap_code` ascending so ordering is always
deterministic, never by insertion/id order. The first row (`rows[0]`,
if any) is the recommendation and is flagged `is_recommended=True` in
its dict; every other row is still returned (not just the top pick)
so the Administrator can see — and choose — the full suitable pool,
same "show everyone, not just the winner" choice
app/recommendation.py's technician engine already makes.

DATABASE QUERIES
===================
Exactly one query: `Nap.query.filter_by(status="active").all()`,
filtered to `available_ports > 0` in Python. A NAP roster is small
(low tens of rows for this app's scale — same assumption
app/recommendation.py's technician roster query already makes), so
filtering the port count in Python alongside the status filter keeps
this to the one query rather than adding a second WHERE clause; no
new index was needed.

RETURN SHAPE
==============
`recommend_naps()` returns a list of plain dicts, nearest first, each
containing everything requirement 8's UI list asks for so nothing is
computed twice by the template:
    nap              -> the Nap ORM object itself
    nap_code         -> nap.nap_code
    name             -> nap.name
    distance_km      -> float, rounded to 2 decimal places
    available_ports  -> int
    total_ports       -> int
    status           -> nap.status (always 'active' here, but included
                         so the template/JSON feed never has to reach
                         back into `row["nap"].status` separately)
    latitude         -> float
    longitude        -> float
    is_recommended   -> True for rows[0] only, False otherwise
"""

from app.models import Nap, AppSettings
from app.recommendation import haversine_km


def _effective_available_ports(nap):
    """Real available capacity for `nap`, derived from actually-linked
    subscribers rather than the stored `available_ports` column.

    BUGFIX: `nap.used_ports`/`available_ports` are only ever written
    by the NAP add/edit forms (app/routes/naps.py) -- every route
    that actually links a subscriber to a NAP (add_subscriber(),
    quick_add_subscriber(), assign_nap()) leaves them untouched, so
    they drift from reality the moment a subscriber is connected any
    other way. `/api/naps` (app/routes/api.py's `_slot_usage()`)
    already works around exactly this drift for the GeoMap's own
    "used/open" display and its over-100% utilization badge --
    without this fix, `recommend_naps()` could still treat a NAP the
    map itself shows as full (e.g. "200%") as having an open slot,
    drawing a connector line to it and offering it as the suggestion
    in Plan Installation mode even though it can't actually take a
    new connection. This mirrors that same derivation here so both
    features agree on what "full" means.

    A subscriber occupies a port unless fully disconnected --
    "active", "inactive" (e.g. suspended for non-payment), and
    "pending_review" all still have a live drop cable into the NAP;
    only "disconnected" frees the slot back up.
    """
    used = sum(1 for s in nap.subscribers if s.status != "disconnected")
    total = nap.total_ports or 0
    return max(total - used, 0)


def recommend_naps(customer_latitude, customer_longitude, limit=None):
    """Returns a ranked list of recommendation dicts for a customer
    location, nearest suitable NAP first. Empty list if no NAP is
    currently both active and has an available port (requirement's
    "No available NAP" test case) — this is a normal, expected result,
    not an error; callers should render a plain "no suitable NAP right
    now" message rather than treating an empty list as a failure.

    Purely a read — see the module docstring's "THIS MODULE NEVER
    WRITES TO THE DATABASE" section.

    `limit`: if given, only the top N rows are returned (mirrors
    app/recommendation.py's `get_recommendations(limit=...)` parameter
    for the same reason — most callers want the full suitable pool,
    but a future widget might only want the single nearest one).

    Max Connection Radius (Settings > App Settings): a third candidate
    filter alongside status/available_ports, added to
    `AppSettings.nap_connection_radius_meters` — see that column's
    docstring in app/models.py. A NAP farther than the configured
    radius from `(customer_latitude, customer_longitude)` is dropped
    from the candidate pool the same way a full/inactive NAP is,
    before distance-sorting, so it can never be the recommendation no
    matter how few closer NAPs exist. `0` (the default) disables this
    filter entirely, matching that column's "opt-in, no behavior
    change until configured" contract.
    """
    radius_m = AppSettings.get_current().nap_connection_radius_meters or 0

    candidates = [
        nap
        for nap in Nap.query.filter_by(status="active").all()
        if _effective_available_ports(nap) > 0
    ]

    rows = []
    for nap in candidates:
        distance_km = haversine_km(
            customer_latitude, customer_longitude, nap.latitude, nap.longitude
        )
        if radius_m > 0 and (distance_km * 1000) > radius_m:
            continue
        rows.append(
            {
                "nap": nap,
                "nap_code": nap.nap_code,
                "name": nap.name,
                "distance_km": round(distance_km, 2),
                "available_ports": _effective_available_ports(nap),
                "total_ports": nap.total_ports,
                "status": nap.status,
                "latitude": float(nap.latitude),
                "longitude": float(nap.longitude),
            }
        )

    rows.sort(key=lambda row: (row["distance_km"], row["nap_code"]))

    for i, row in enumerate(rows):
        row["is_recommended"] = i == 0

    if limit is not None:
        rows = rows[:limit]

    return rows
