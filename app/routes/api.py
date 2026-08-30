"""
API Blueprint
--------------
Read-only JSON endpoints consumed by client-side JavaScript. Kept
separate from the `naps` blueprint (which renders HTML pages) so that
data endpoints and page endpoints don't mix in the same file as the
project grows.

Phase 15: `/api/issues` is now scoped for a Technician to only the
issues that have (or have ever had) an assignment routed to them —
the same rule Phase 14 already applied to the `issues.view_issue`
detail page, extended here to its GeoMap feed so a technician's map
only plots pins for issues that are actually theirs. Administrator
access is unchanged (every issue, as before).

Phase 16: `/api/subscribers` is now scoped for a Technician too,
resolving the tradeoff Phase 15 flagged instead of deciding
silently — a Technician now only sees subscribers tied to their own
assignments (via any technical issue that has ever had an assignment
routed to them), the same ownership rule `/api/issues` already uses.
**Accepted consequence (confirmed, not a bug):** a Technician can no
longer use the shared "Report an Issue" map form
(napmap.js's `loadSubscribers()`/`populateSubscriberDropdown()`) to
report a brand-new issue against a subscriber they have no existing
assignment for — that self-service path (verified in Phase 9) is now
effectively Administrator-only for previously-unassigned subscribers.
This was a deliberate, confirmed choice: full scoping was preferred
over preserving that reporting path. Administrator access is
unchanged (every active subscriber, as before).

Installation Planning integration, Phase 2 (25%):
`nearest_available_nap_json()` (below) is the one new endpoint this
phase adds -- a read-only, administrator-only lookup that returns the
nearest NAP with available capacity for a raw `lat`/`lng` point (a
dropped map pin with no `ServiceRequest` behind it yet), reusing
`app.nap_recommendation.recommend_naps()` exactly as
`service_request_recommend_nap_json()` already does for the
ServiceRequest-based flow. See that function's own docstring for the
full contract, and PLAN_INSTALL_25_PERCENT_NOTES.md for why a new
endpoint was needed rather than reusing the existing
service-request-scoped one.
"""

from flask import Blueprint, jsonify, g, abort, request

from app.auth import role_required
from app.models import Nap, TechnicalIssue, Subscriber, Technician, Assignment, ServiceRequest
from app.nap_recommendation import recommend_naps
from app.navigation_contract import technician_location_json

api_bp = Blueprint("api", __name__, url_prefix="/api")

# Phase 7 RBAC: these endpoints exist to feed the internal GeoMap and
# dashboard with subscriber/NAP/issue data, so they carry the same
# staff-only restriction as the pages that call them.
_STAFF_ROLES = ("administrator", "field_assistant")


@api_bp.route("/naps")
@role_required(*_STAFF_ROLES)
def naps_json():
    """Returns every NAP record as JSON for the Leaflet GeoMap.

    All statuses (active/inactive/full/maintenance) are included in a
    single response — the GeoMap page loads this once and applies its
    status/port filters entirely on the client side, so it doesn't need
    to re-fetch every time a filter checkbox changes.

    Phase 17: unlike `/api/issues` and `/api/subscribers`, this feed is
    deliberately left unscoped for a Technician — every NAP, same as
    an Administrator. This is a confirmed, intentional exception: the
    GeoMap is the shared situational view every technician needs full
    geographic context from (which NAPs exist and where, regardless of
    whose assignment they're on), a different kind of access than the
    naps.list_naps()/naps.view_nap() list/detail pages, which Phase 17
    *does* narrow to a technician's own assigned NAPs. Same reasoning
    Phase 14 already applied to leaving this feed's issue/subscriber
    counterparts alone at the time (before Phases 15/16 revisited and
    scoped those two specifically).

    NAPs with no latitude/longitude are skipped since they can't be
    plotted on the map.

    NAP detail panel (GeoMap slide-in): each NAP now also includes a
    `connected_lines` array — one entry per subscriber attached to
    that NAP (`nap.subscribers`) — so the panel doesn't need a second
    request per marker. Each entry carries the subscriber's code and
    name plus a `payment_status` derived from that subscriber's most
    recent payment (`subscriber.payments[0]`, already ordered newest
    first by `Payment.payment_date.desc()` on the relationship):
    "confirmed" -> "Paid", "pending" -> "Pending", "overdue" ->
    "Overdue", "voided" -> "Voided". A subscriber with no payment
    history yet gets "No payment" rather than a guessed status.
    """
    naps = Nap.query.order_by(Nap.name.asc()).all()

    payment_status_labels = {
        "confirmed": "Paid",
        "pending": "Pending",
        "overdue": "Overdue",
        "voided": "Voided",
    }

    def _connected_lines(nap):
        lines = []
        for subscriber in nap.subscribers:
            latest_payment = subscriber.payments[0] if subscriber.payments else None
            payment_status = (
                payment_status_labels.get(latest_payment.status, latest_payment.status)
                if latest_payment
                else "No payment"
            )
            lines.append(
                {
                    "subscriber_id": subscriber.id,
                    "subscriber_code": subscriber.subscriber_code,
                    "full_name": subscriber.full_name,
                    "payment_status": payment_status,
                }
            )
        return lines

    def _slot_usage(nap):
        """`nap.used_ports`/`available_ports` are stored counters that
        are only ever written by the NAP add/edit forms
        (app/routes/naps.py) — every route that actually links a
        subscriber to a NAP (add_subscriber(), quick_add_subscriber(),
        assign_nap()) explicitly leaves them untouched (see
        app/routes/subscribers.py's quick_add_subscriber() docstring),
        so they drift from reality as soon as a subscriber is
        connected: the GeoMap panel was showing "0 used" for a NAP
        with 3 connected lines.

        Rather than bolting bookkeeping onto every one of those write
        paths (and risking missing the next one), the GeoMap feed
        derives slot usage directly from the actual linked
        subscribers, the same source of truth `connected_lines`
        already uses. A subscriber counts as occupying a physical
        port unless they've been fully disconnected — "active",
        "inactive" (e.g. suspended for non-payment), and
        "pending_review" all still have a live drop cable into the
        NAP; only "disconnected" frees the slot back up.
        """
        used = sum(1 for s in nap.subscribers if s.status != "disconnected")
        total = nap.total_ports or 0
        return used, max(total - used, 0)

    data = []
    for nap in naps:
        if nap.latitude is None or nap.longitude is None:
            continue
        used_ports, available_ports = _slot_usage(nap)
        data.append(
            {
                "id": nap.id,
                "nap_code": nap.nap_code,
                "name": nap.name,
                "address": nap.address,
                "latitude": float(nap.latitude),
                "longitude": float(nap.longitude),
                "total_ports": nap.total_ports,
                "used_ports": used_ports,
                "available_ports": available_ports,
                "status": nap.status,
                "connected_lines": _connected_lines(nap),
            }
        )
    return jsonify(data)


@api_bp.route("/issues")
@role_required(*_STAFF_ROLES)
def issues_json():
    """Returns technical issues as JSON for the GeoMap's issue
    markers/layer. Like /api/naps, this returns the full matching
    dataset (every status and priority) in one call — status/priority
    filters on the GeoMap are applied client-side against this
    response.

    Phase 15: for a Technician, only issues with (or that have ever
    had) an assignment routed to them are returned — same ownership
    rule Phase 14 applied to issues.view_issue. An Administrator still
    gets every issue, unchanged.

    Subscriber name/code and NAP code are included directly (via the
    ORM relationships) so the popup doesn't need a second request per
    marker.
    """
    query = TechnicalIssue.query

    if g.user.role == "field_assistant":
        profile = Technician.query.filter_by(user_id=g.user.id).first()
        if profile is None:
            query = query.filter(TechnicalIssue.id.in_([]))  # no linked profile -> no issues are "theirs"
        else:
            assigned_issue_ids = (
                Assignment.query.filter_by(technician_id=profile.id)
                .with_entities(Assignment.technical_issue_id)
                .subquery()
            )
            query = query.filter(TechnicalIssue.id.in_(assigned_issue_ids))

    issues = query.order_by(TechnicalIssue.created_at.desc()).all()

    data = [
        {
            "id": issue.id,
            "issue_code": issue.issue_code,
            "issue_type": issue.issue_type,
            "description": issue.description,
            "priority": issue.priority,
            "status": issue.status,
            "address": issue.address,
            "latitude": float(issue.latitude),
            "longitude": float(issue.longitude),
            "subscriber_id": issue.subscriber_id,
            "subscriber_name": issue.subscriber.full_name if issue.subscriber else None,
            "subscriber_code": issue.subscriber.subscriber_code if issue.subscriber else None,
            "nap_id": issue.nap_id,
            "nap_code": issue.nap.nap_code if issue.nap else None,
            "created_at": issue.created_at.isoformat(),
        }
        for issue in issues
        if issue.latitude is not None and issue.longitude is not None
    ]
    return jsonify(data)


@api_bp.route("/subscribers")
@role_required(*_STAFF_ROLES)
def subscribers_json():
    """Returns active subscribers as lightweight JSON, used to populate
    the Subscriber dropdown on the Report Issue form and to auto-fill
    that form's Address field when a subscriber is selected.

    Only active subscribers are returned — reporting a new issue
    against an inactive/disconnected subscriber isn't a meaningful
    workflow at this stage, though nothing stops that being revisited
    later if needed.

    Phase 16: for a Technician, further narrowed to only subscribers
    tied to one of their own assignments (via any technical issue
    that has, or has ever had, an assignment routed to them) — same
    ownership rule /api/issues already applies. This was a confirmed,
    deliberate choice superseding Phase 15's decision to leave this
    endpoint unscoped; the accepted tradeoff is that a Technician can
    no longer report a new issue (from the shared GeoMap "Report an
    Issue" form) against a subscriber they aren't already assigned
    to. An Administrator still sees every active subscriber.
    """
    query = Subscriber.query.filter_by(status="active")

    if g.user.role == "field_assistant":
        profile = Technician.query.filter_by(user_id=g.user.id).first()
        if profile is None:
            query = query.filter(Subscriber.id.in_([]))  # no linked profile -> no subscribers are "theirs"
        else:
            assigned_subscriber_ids = (
                Assignment.query.filter_by(technician_id=profile.id)
                .join(TechnicalIssue, Assignment.technical_issue_id == TechnicalIssue.id)
                .with_entities(TechnicalIssue.subscriber_id)
                .subquery()
            )
            query = query.filter(Subscriber.id.in_(assigned_subscriber_ids))

    subscribers = query.order_by(Subscriber.full_name).all()
    data = [
        {
            "id": s.id,
            "subscriber_code": s.subscriber_code,
            "full_name": s.full_name,
            "address": s.address,
            "latitude": float(s.latitude) if s.latitude is not None else None,
            "longitude": float(s.longitude) if s.longitude is not None else None,
            "nap_id": s.nap_id,
        }
        for s in subscribers
    ]
    return jsonify(data)


@api_bp.route("/personnel")
@role_required("administrator")
def personnel_json():
    """Lightweight JSON feed of `technicians` table rows -- which
    holds both technician and field_assistant profiles (see
    Technician.personnel_type) -- used by the GeoMap's "+ Tickets"
    quick-create modal to populate its Assigned Team (field
    assistants) and Technician pickers. `?type=technician` or
    `?type=field_assistant` narrows to one or the other; omitted
    returns both. Administrator-only, matching every other route that
    manages dispatch staffing (app/routes/dispatch.py)."""
    personnel_type = request.args.get("type")
    query = Technician.query
    if personnel_type in ("technician", "field_assistant"):
        query = query.filter_by(personnel_type=personnel_type)

    people = query.order_by(Technician.full_name).all()
    return jsonify(
        [
            {
                "id": p.id,
                "full_name": p.full_name,
                "status": p.status,
                "personnel_type": p.personnel_type,
            }
            for p in people
        ]
    )


@api_bp.route("/tickets/next-code")
@role_required("administrator")
def tickets_next_code_json():
    """Returns a preview of the ticket code the "+ Tickets" quick-create
    modal's next Service Order or Trouble Ticket will get, formatted
    "SO 00001" / "TN 00001" (5-digit, zero-padded, one ahead of the
    current row count). Display-only: the actual record created by
    quick_add_request()/report_issue() still gets its real code from
    its own primary key once the row exists, same as every other
    auto-increment id in this app -- this just lets the modal show the
    admin what to expect before they hit Create, without reserving a
    number (so submitting out of order, or not at all, never leaves a
    gap the preview promised).

    `?category=SO` or `?category=TN` selects which table to count;
    anything else 400s. Administrator-only, matching every other route
    that feeds this modal (personnel_json, plans_json above).
    """
    category = (request.args.get("category") or "").upper()
    if category == "SO":
        next_number = ServiceRequest.query.count() + 1
    elif category == "TN":
        next_number = TechnicalIssue.query.count() + 1
    else:
        abort(400)
    return jsonify({"category": category, "code": f"{category} {next_number:05d}"})


@api_bp.route("/naps/next-code")
@role_required("administrator")
def naps_next_code_json():
    """Returns a display-only preview of the NAP code the GeoMap's
    "+ Tickets" > "Add NAP" quick-create form will suggest, formatted
    "N-001" (3-digit, zero-padded, one ahead of the current NAP row
    count) -- same "preview, not a reservation" contract as
    tickets_next_code_json() above. The Add NAP ticket this feeds
    (service_requests.quick_add_nap_request()) never creates a real
    Nap row itself, so this is purely informational for whoever fills
    out the ticket; the NAP eventually created on-site gets its real
    nap_code the normal way, same as any other NAP.
    """
    next_number = Nap.query.count() + 1
    return jsonify({"code": f"N-{next_number:03d}"})


@api_bp.route("/service-requests/<int:request_id>/recommend-nap")
@role_required("administrator")
def service_request_recommend_nap_json(request_id):
    """Phase 22 (phase_11.pdf requirement 8, "display the result on
    the GeoMap"): read-only JSON feed for the GeoMap's
    `?recommend_request_id=` view (see naps.geomap() and
    napmap.js's focusNapRecommendationFromQueryParam()) — the customer
    location plus the same ranked candidate list
    service_requests/recommend_nap.html already shows, so the map can
    plot both without duplicating app/nap_recommendation.py's
    filter/sort logic in JavaScript.

    Administrator-only, matching every other route in
    app/routes/service_requests.py — unlike /api/naps, /api/issues,
    and /api/subscribers above, this feed was never scoped to
    Technicians in the first place (service requests are an
    Administrator-only module, Phase 15), so there's no Technician
    case to carry forward here.

    404s for an unknown request id (unlike naps.geomap()'s own
    `?issue_id=`/`?recommend_request_id=` params, which are left
    unvalidated) since this endpoint's whole job is to look the
    request up and return its data — there's nothing useful to return
    for an id that doesn't exist, and the caller (napmap.js) already
    only calls this when a `recommend_request_id` was actually passed
    in the URL.
    """
    service_request = ServiceRequest.query.get_or_404(request_id)

    if service_request.latitude is None or service_request.longitude is None:
        return jsonify({"status": "error", "message": "This service request has no customer location set."}), 400

    recommendations = recommend_naps(service_request.latitude, service_request.longitude)

    return jsonify(
        {
            "status": "success",
            "service_request_id": service_request.id,
            "customer_latitude": float(service_request.latitude),
            "customer_longitude": float(service_request.longitude),
            "recommended_nap_id": recommendations[0]["nap"].id if recommendations else None,
            "candidates": [
                {
                    "nap_id": row["nap"].id,
                    "nap_code": row["nap_code"],
                    "name": row["name"],
                    "distance_km": row["distance_km"],
                    "available_ports": row["available_ports"],
                    "total_ports": row["total_ports"],
                    "status": row["status"],
                    "latitude": row["latitude"],
                    "longitude": row["longitude"],
                    "is_recommended": row["is_recommended"],
                }
                for row in recommendations
            ],
        }
    )


@api_bp.route("/naps/nearest-available")
@role_required("administrator")
def nearest_available_nap_json():
    """Installation Planning integration, Phase 2 (25%) — the
    nearest-available-NAP-for-a-point data contract.

    Translates the napV4-route-line prototype's
    `nearestAvailableNap(pos)` / `napUsage(napId)` (see
    `src/store/AppStore.tsx`) into a read-only Flask lookup driven by
    a raw map coordinate — a dropped "proposed installation" pin that
    has no `ServiceRequest` row behind it (unlike
    `service_request_recommend_nap_json()` above, which requires an
    existing request id). See PLAN_INSTALL_10_PERCENT_NOTES.md §5 for
    why this feature intentionally does not create or require a
    ServiceRequest.

    Reuses `app.nap_recommendation.recommend_naps()` verbatim — same
    function Phase 22's service-request flow already calls, no
    second copy of the filter/sort/distance logic. That function
    already accepts plain `(latitude, longitude)` arguments (it was
    never actually coupled to `ServiceRequest` rows; only its one
    existing caller happened to source its coordinates from one), so
    nothing needed to change in `app/nap_recommendation.py` itself —
    this route is the only new code this phase adds.

    Query parameters:
        lat  -- required, float, -90..90
        lng  -- required, float, -180..180

    Administrator-only: this endpoint exists solely to back the
    admin-only "Plan Installation" feature described in the
    Installation Planning integration plan (Phase 3+ gates the UI
    control itself to `current_user.role == 'administrator'`,
    mirroring the prototype's `role === 'admin'` check) — restricting
    the data contract to the same role now means there is no window,
    even before the UI ships in Phase 3, where a non-administrator
    could reach this lookup directly. This is narrower than
    `/api/naps` and `/api/technicians/<id>/location` above (both
    `_STAFF_ROLES`), which is a deliberate difference, not an
    oversight — those feed views every staff role legitimately needs;
    this one only exists to support an administrator-only workflow.

    Response shapes (mirroring the prototype's `{ nap, distanceKm }`
    suggestion object, plus the fields requirement 8's later UI step
    will need so nothing has to be looked up twice):

    Success (a suitable NAP exists) -- 200:
        {
          "status": "success",
          "point": {"lat": 14.6001, "lng": 121.0001},
          "nap": {
            "id": 12,
            "nap_code": "NAP-014",
            "name": "Gatid Junction",
            "address": "Purok 3, Gatid",
            "latitude": 14.6000,
            "longitude": 121.0000
          },
          "distance_km": 0.18,
          "available_ports": 3
        }

    No suitable NAP nearby -- 200 (NOT an error; an empty candidate
    pool is an expected, valid result -- same "no available NAP" case
    `recommend_naps()`'s own docstring documents, translated from the
    prototype's `!suggestion` branch, which renders "No NAP with
    available slots near this location." rather than treating it as a
    failure):
        {
          "status": "no_nap_available",
          "point": {"lat": 14.6001, "lng": 121.0001},
          "nap": null,
          "distance_km": null,
          "available_ports": null
        }

    Missing/invalid lat or lng -- 400:
        {"status": "error", "message": "..."}

    No database write happens in this route, matching every other
    endpoint in this file and `recommend_naps()`'s own read-only
    guarantee. No new database table or column was added for this
    contract -- same computed-on-the-fly lookup
    `app/nap_recommendation.py`'s module docstring already documents
    for its own function.
    """
    lat_raw = request.args.get("lat")
    lng_raw = request.args.get("lng")

    if lat_raw is None or lng_raw is None:
        return jsonify({"status": "error", "message": "Both 'lat' and 'lng' query parameters are required."}), 400

    try:
        latitude = float(lat_raw)
        longitude = float(lng_raw)
    except ValueError:
        return jsonify({"status": "error", "message": "'lat' and 'lng' must be numbers."}), 400

    if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        return jsonify({"status": "error", "message": "'lat' must be between -90 and 90, and 'lng' between -180 and 180."}), 400

    recommendations = recommend_naps(latitude, longitude, limit=1)

    if not recommendations:
        return jsonify(
            {
                "status": "no_nap_available",
                "point": {"lat": latitude, "lng": longitude},
                "nap": None,
                "distance_km": None,
                "available_ports": None,
            }
        )

    top = recommendations[0]
    nap = top["nap"]

    return jsonify(
        {
            "status": "success",
            "point": {"lat": latitude, "lng": longitude},
            "nap": {
                "id": nap.id,
                "nap_code": nap.nap_code,
                "name": nap.name,
                "address": nap.address,
                "latitude": top["latitude"],
                "longitude": top["longitude"],
            },
            "distance_km": top["distance_km"],
            "available_ports": top["available_ports"],
        }
    )


@api_bp.route("/technicians/<int:technician_id>/location")
@role_required(*_STAFF_ROLES)
def technician_location_json_route(technician_id):
    """Phase 23 (10%, navigation data contract): read-only feed for a
    single technician's current position, resolving the scoping
    question PHASE23_5_PERCENT_NOTES.md §8 left open.

    Decision made here: an Administrator may look up *any* technician
    (matches /api/naps and /api/issues' existing Administrator-sees-
    everything pattern), but a Technician may only look up their *own*
    profile — not a colleague's. This is stricter than /api/issues'
    "own assignments" rule because a live position is more sensitive
    than an issue list, and nothing in the existing product lets one
    technician browse another's location today.

    Returns 404 for an unknown technician id, and a `position: null`
    JSON body (200, not an error) when the technician exists but has
    no `current_latitude`/`current_longitude` yet — that's an expected,
    common state (see PHASE23_5_PERCENT_NOTES.md §8: this column isn't
    kept live by anything today), not a failure.

    No navigation UI calls this yet (Phase 23's 10% step is data-
    contract only, no UI) — this endpoint exists so the shape is
    already correct and testable before nav-route.js is written.
    """
    technician = Technician.query.get_or_404(technician_id)

    if g.user.role == "field_assistant":
        own_profile = Technician.query.filter_by(user_id=g.user.id).first()
        if own_profile is None or own_profile.id != technician.id:
            abort(403)

    return jsonify(technician_location_json(technician))
