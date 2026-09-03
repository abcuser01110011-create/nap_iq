"""
NAP Management Blueprint
---------------------------
Implements the CRUD (Create, Read, Update, and status-based "soft
delete") workflow for Network Access Points.

Phase 17: `list_naps()` and `view_nap()` are now scoped for a
Technician to only the NAPs tied to a technical issue that has (or
has ever had) an assignment routed to them — same "ownership" rule
already applied to `issues.view_issue` (Phase 14) and the
`/api/issues` / `/api/subscribers` feeds (Phases 15/16). `geomap()`
and `/api/naps` (api.py's `naps_json()`) are deliberately left
unrestricted — see the comment on `naps_json()` in app/routes/api.py
for why. Administrator access to every route in this file is
unchanged.

Routes:
    GET  /naps/                    -> list_naps      (view all, search + filter)
    GET  /naps/map                 -> geomap          (GeoMap page)
    GET  /naps/add                 -> add_nap         (show add form)
    POST /naps/add                 -> add_nap         (process add form)
    POST /naps/quick-add           -> quick_add_nap   (create NAP from a map click, JSON)
    GET  /naps/<id>                -> view_nap        (view NAP details)
    POST /naps/<id>/deactivate     -> deactivate_nap  (soft-deactivate)
    POST /naps/<id>/activate       -> activate_nap    (reactivate)
"""

from flask import Blueprint, render_template, redirect, url_for, request, flash, jsonify, g, abort

from app.extensions import db
from sqlalchemy import func
from app.auth import role_required
from app.models import (
    Nap, AppSettings, Plan, Technician, Assignment, TechnicalIssue, Subscriber,
    ServiceRequest,
)
from app.forms import NapForm, MapQuickAddNapForm
from app.nap_status import sync_nap_status, slot_usage

naps_bp = Blueprint("naps", __name__, url_prefix="/naps")

# Phase 7 RBAC: viewing NAP data is operational information both
# Administrators and Technicians need day-to-day (e.g. a technician
# checking port availability at a site). Creating, editing, and
# (de)activating NAPs is infrastructure-changing and stays
# Administrator-only.
_VIEW_ROLES = ("administrator", "field_assistant")
_MANAGE_ROLES = ("administrator",)


# Priority levels, most to least severe. Drives the cascade in
# _default_focus_nap_id() below: a level is only consulted at all if
# every *more* severe level has zero open issues NAP-wide (see that
# function's docstring for the full rule).
_FOCUS_PRIORITY_CASCADE = ("critical", "high", "medium", "low")


def _default_focus_nap_id():
    """Picks which NAP the GeoMap should center on by default (no
    explicit ?issue_id=/?navigate_*=/?recommend_request_id= override),
    so opening or reloading the page always lands somewhere useful
    instead of the same fixed DEFAULT_CENTER/DEFAULT_ZOOM every time.

    Rule: rank NAPs by their count of currently-open ('pending',
    'assigned', or 'in_progress' — i.e. not yet 'resolved'/'closed')
    'critical' priority issues, and focus whichever NAP has the most.
    Critical outranks every other priority level by definition, so a
    NAP is never passed over in favor of one that merely has more
    issues overall of a lower priority. Resolved/closed issues don't
    count toward this at all — a NAP whose problems have already been
    fixed has nothing left that needs attention, so it shouldn't keep
    winning the focus slot just because of history; the map's own
    issue-priority/status filters default to this same "open only" set
    for exactly this reason (see map.html's
    issueFilterResolved/issueFilterClosed starting unchecked), so the
    NAP this function picks is one that would actually show a visible
    open marker of the winning priority once it's centered.

    Ties (more than one NAP sharing the same highest open count at a
    given priority level — e.g. NAP A had 2 open critical issues and
    got them repaired down to 0 right as NAP B separately reached 2)
    are broken by whichever of the tied NAPs logged its earliest
    still-open issue *of that priority* first: the NAP whose oldest
    open TechnicalIssue.created_at (at that priority) is furthest back
    wins, on the reasoning that a site with a longer-standing
    unresolved problem has been waiting for attention longer. If that
    still ties exactly (identical timestamps), the lowest NAP id
    breaks it, purely for a stable, repeatable answer rather than one
    that could flip on every reload.

    Cascade: if literally no NAP has any open critical issue right now
    (every NAP is tied at a count of zero), critical has nothing to
    rank by, so the same count-then-earliest-report logic is applied
    to the next priority level down ('high') instead — and, in turn,
    to 'medium' and then 'low' if those also come up empty. The first
    priority level (in critical -> high -> medium -> low order) that
    has *any* open issue anywhere decides the focus NAP; levels below
    it are never consulted once a level has produced a winner.

    Returns None (no default focus; the map falls back to
    DEFAULT_CENTER/DEFAULT_ZOOM in napmap.js) only when no NAP has any
    open issue of any priority at all.
    """
    for priority in _FOCUS_PRIORITY_CASCADE:
        counts = (
            db.session.query(
                TechnicalIssue.nap_id,
                func.count(TechnicalIssue.id).label("open_count"),
            )
            .filter(
                TechnicalIssue.priority == priority,
                TechnicalIssue.status.notin_(("resolved", "closed")),
                TechnicalIssue.nap_id.isnot(None),
            )
            .group_by(TechnicalIssue.nap_id)
            .all()
        )
        if not counts:
            # No open issue at this priority anywhere -> fall through
            # to the next (less severe) priority level.
            continue

        max_count = max(cnt for _nap_id, cnt in counts)
        tied_nap_ids = [nap_id for nap_id, cnt in counts if cnt == max_count]
        if len(tied_nap_ids) == 1:
            return tied_nap_ids[0]

        earliest = (
            db.session.query(
                TechnicalIssue.nap_id,
                func.min(TechnicalIssue.created_at).label("earliest_at_priority"),
            )
            .filter(
                TechnicalIssue.priority == priority,
                TechnicalIssue.status.notin_(("resolved", "closed")),
                TechnicalIssue.nap_id.in_(tied_nap_ids),
            )
            .group_by(TechnicalIssue.nap_id)
            .order_by(
                func.min(TechnicalIssue.created_at).asc(), TechnicalIssue.nap_id.asc()
            )
            .first()
        )
        return earliest[0] if earliest else tied_nap_ids[0]

    return None


def _own_nap_ids_for(g_user):
    """Returns the set of NAP ids tied to a technical issue that has
    (or has ever had) an assignment routed to the signed-in
    Technician. `None` if `g_user` has no linked Technician profile at
    all — callers should treat that the same as an empty set (no NAP
    is "theirs"). Same ownership-subquery shape as api.py's
    `issues_json()`/`subscribers_json()`, just walked one hop further
    (assignment -> issue -> nap) to reach a NAP id instead of an issue
    or subscriber id."""
    profile = Technician.query.filter_by(user_id=g_user.id).first()
    if profile is None:
        return set()

    assigned_issue_ids = (
        Assignment.query.filter_by(technician_id=profile.id)
        .with_entities(Assignment.technical_issue_id)
        .subquery()
    )
    nap_ids = (
        TechnicalIssue.query.filter(TechnicalIssue.id.in_(assigned_issue_ids))
        .filter(TechnicalIssue.nap_id.isnot(None))
        .with_entities(TechnicalIssue.nap_id)
        .distinct()
        .all()
    )
    return {row[0] for row in nap_ids}


@naps_bp.route("/")
@role_required(*_VIEW_ROLES)
def list_naps():
    """Displays all NAPs, with optional search (by code or name) and
    status filtering via query string parameters (?q=...&status=...).

    Physical records are never deleted, so this list also shows
    inactive/maintenance NAPs unless the admin filters them out —
    this keeps historical infrastructure records visible.

    Phase 17: for a Technician, further narrowed to only NAPs tied to
    one of their own assignments (via any technical issue that has,
    or has ever had, an assignment routed to them) — same ownership
    rule already used elsewhere (issues.view_issue, /api/issues,
    /api/subscribers). An Administrator still sees every NAP.
    """
    search_term = request.args.get("q", "").strip()
    status_filter = request.args.get("status", "").strip()

    query = Nap.query

    if g.user.role == "field_assistant":
        query = query.filter(Nap.id.in_(_own_nap_ids_for(g.user)))

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.filter(
            db.or_(Nap.nap_code.ilike(like_pattern), Nap.name.ilike(like_pattern))
        )

    if status_filter:
        query = query.filter(Nap.status == status_filter)

    naps = query.order_by(Nap.name.asc()).all()

    return render_template(
        "naps/list.html",
        naps=naps,
        search_term=search_term,
        status_filter=status_filter,
    )


@naps_bp.route("/map")
@role_required(*_VIEW_ROLES)
def geomap():
    """Renders the interactive GeoMap page. The page itself contains no
    NAP data server-side — it fetches everything from GET /api/naps
    on load and renders markers with Leaflet.js.

    Phase 20 (phase_8.pdf technician item #6, "Issue location on
    GeoMap"): accepts an optional `?issue_id=` query param — e.g. from
    the "View on Map" button on a technician's own assignment row
    (technician/index.html) — and passes it through to the template
    as `focus_issue_id` so napmap.js can pan/zoom to that issue and
    open its popup once the issue feed has loaded. Deliberately not
    validated against the database here (no 404 for a bad/foreign id)
    since this route stays intentionally unrestricted the same way
    the rest of the map is (see the module docstring) — an unknown id
    simply matches nothing client-side and the map just loads normally.

    Phase 22 (phase_11.pdf requirement 8, "display the result on the
    GeoMap"): accepts an optional `?recommend_request_id=` query
    param — the "View on GeoMap" link on
    service_requests/recommend_nap.html — mirroring `?issue_id=`
    exactly: passed through unvalidated as `recommend_request_id`, and
    it's `napmap.js`'s job (via `GET /api/service-requests/<id>/
    recommend-nap`) to fetch the actual customer location + ranked
    NAP candidates and plot them once loaded. Same "unknown/foreign id
    simply matches nothing, no crash" reasoning as `issue_id` above.

    Phase 13 (65%, navigation destination panels): accepts an optional
    pair `?navigate_type=nap|subscriber|issue&navigate_id=<id>` — the
    "Navigate" button on naps/view.html, subscribers/view.html, and
    issues/view.html — passed through unvalidated as `navigate_type`/
    `navigate_id`, same convention as `issue_id`/`recommend_request_id`
    above. napmap.js's `focusNavigationFromQueryParam()` looks the
    entity up in the dataset it already loaded (allNaps/allSubscribers/
    allIssues), builds the same destination object the "Set as
    destination" popup buttons build, and hands it to
    `NapIQNavigation.setDestination()` — so a NAP/subscriber/issue
    reached this way behaves identically to one selected from a
    marker popup. An unrecognized `navigate_type` or unknown/foreign
    id simply selects nothing; the map still loads normally.

    Phase 34 (admin "Navigate" on a completed Service Request): adds
    `service_request` as a fourth accepted `navigate_type` — the
    "Navigate" button on service_requests/form.html's read-only view,
    shown once a request is 'completed' (installation/add_nap tickets
    don't reach the technical_issues table, so they were never
    reachable via `navigate_type=issue`). Service requests aren't
    preloaded into any in-memory dataset the way NAPs/subscribers/
    issues are, so unlike the other three, napmap.js fetches this
    one's location on demand (from the existing
    GET /api/service-requests/<id>/recommend-nap endpoint) instead of
    looking it up client-side — see focusNavigationFromQueryParam()'s
    "service_request" branch.

    Phase 14 (70%, technician dispatch integration): also resolves the
    signed-in user's own Technician profile id (if any) and passes it
    to the template as `own_technician_id`, so `nav-technician-origin.js`
    can offer "Use my last known location" (backed by the existing
    `/api/technicians/<id>/location` endpoint from the Phase 23 10%
    data contract) as a third navigation-origin option, alongside the
    manual map picker and device GPS. Deliberately server-scoped to
    "my own profile only" here (rather than trusting a client-supplied
    id) — an Administrator, who has no linked Technician profile,
    simply gets `None` and the control doesn't render at all, exactly
    like `/api/technicians/<id>/location` already restricts a
    Technician to their own id.

    Phase 33 (default GeoMap focus): when none of the explicit
    destination params above are present, the page also passes
    `focus_nap_id` — the NAP with the most currently-open 'critical'
    priority issues attached to it (falling back to 'high', then
    'medium', then 'low' if no NAP has any open critical issue at all
    — see `_default_focus_nap_id()`), ties broken by earliest-reported
    still-open issue at whichever priority level decided it — so a
    plain visit/reload/re-login always opens already centered on
    whichever site actually has the most unresolved problems right
    now, instead of the same fixed city-wide default view every time.
    """
    issue_id = request.args.get("issue_id", type=int)
    recommend_request_id = request.args.get("recommend_request_id", type=int)
    navigate_type = request.args.get("navigate_type", "").strip()
    navigate_id = request.args.get("navigate_id", type=int)
    if navigate_type not in ("nap", "subscriber", "issue", "service_request"):
        navigate_type = ""

    own_technician_id = None
    if g.user.role == "field_assistant":
        own_profile = Technician.query.filter_by(user_id=g.user.id).first()
        if own_profile is not None:
            own_technician_id = own_profile.id

    # Installation Planning integration, Phase 5 (70%): the "Plan
    # Installation" form step's plan-type field is an <input
    # list="..."> whose suggestions originally came only from the
    # database's own distinct existing Subscriber.plan_type values —
    # not a hard-coded PLAN_FEES-style list copied from the prototype
    # (see PLAN_INSTALL_10_PERCENT_NOTES.md §4). Now that Settings >
    # App Settings > Plans (app/models.py's `Plan` model) exists as an
    # admin-curated list, that list is unioned in too rather than
    # replacing the old source outright — so a plan name already in
    # use on an existing subscriber keeps being suggested even if an
    # administrator hasn't (yet) added it to the curated list, and the
    # curated list's names show up even before any subscriber has ever
    # used them. Only computed for administrators, since only they
    # ever see the Plan Installation control this datalist backs.
    subscriber_plan_types = []
    if g.user.role == "administrator":
        existing_plan_types = {
            row[0]
            for row in db.session.query(Subscriber.plan_type)
            .filter(Subscriber.plan_type.isnot(None), Subscriber.plan_type != "")
            .distinct()
            .all()
        }
        curated_plan_names = {p.name for p in Plan.query.all()}
        subscriber_plan_types = sorted(existing_plan_types | curated_plan_names)

    # Settings > App Settings > Default GeoMap Filters: only decides
    # what the Layers/Filters dropdown controls below are initially
    # set to when this page renders. See AppSettings' docstring in
    # app/models.py — every control stays fully interactive; this
    # never overrides what a person picks for themselves this visit.
    geomap_settings = AppSettings.get_current()

    # Default GeoMap focus: land on the NAP with the most critical
    # issues on every fresh visit/reload (see _default_focus_nap_id()
    # above), unless this visit already has a more specific explicit
    # destination requested via one of the query params above — those
    # always take priority since they're a deliberate "take me to X"
    # link, not just a default landing spot.
    #
    # The NAP's own latitude/longitude are looked up and passed
    # through too (as focus_nap_lat/focus_nap_lng) so napmap.js can set
    # the map's *initial* L.map(...).setView() straight to this NAP's
    # location/zoom before any marker data has even loaded, instead of
    # opening at DEFAULT_CENTER/DEFAULT_ZOOM first and only then
    # flying to the focus NAP once the API response comes back — the
    # visible "zooms out to the whole city, then flies back in" flash
    # that caused.
    focus_nap_id = None
    focus_nap_lat = None
    focus_nap_lng = None
    if not issue_id and not recommend_request_id and not (navigate_type and navigate_id):
        focus_nap_id = _default_focus_nap_id()
        if focus_nap_id is not None:
            focus_nap = Nap.query.get(focus_nap_id)
            if focus_nap is not None:
                focus_nap_lat = focus_nap.latitude
                focus_nap_lng = focus_nap.longitude
            else:
                focus_nap_id = None

    return render_template(
        "naps/map.html",
        focus_issue_id=issue_id,
        focus_nap_id=focus_nap_id,
        focus_nap_lat=focus_nap_lat,
        focus_nap_lng=focus_nap_lng,
        recommend_request_id=recommend_request_id,
        navigate_type=navigate_type,
        navigate_id=navigate_id,
        own_technician_id=own_technician_id,
        subscriber_plan_types=subscriber_plan_types,
        geomap_settings=geomap_settings,
    )


@naps_bp.route("/add", methods=["GET", "POST"])
@role_required(*_MANAGE_ROLES)
def add_nap():
    """Shows and processes the Add NAP form.

    Phase 15: on the initial GET, Total Ports is pre-filled from the
    admin-configurable `default_nap_total_ports` setting (see
    app/routes/settings.py) — a starting suggestion, not a hard rule,
    so it's only applied `if not form.is_submitted()`; a POST always
    uses whatever the administrator actually typed/submitted, exactly
    as before.
    """
    form = NapForm()
    form.nap_id = None  # no existing record to exclude during uniqueness check
    if not form.is_submitted():
        form.total_ports.data = AppSettings.get_current().default_nap_total_ports

    if form.validate_on_submit():
        nap = Nap(
            nap_code=form.nap_code.data.strip(),
            name=form.name.data.strip(),
            address=(form.address.data or "").strip() or None,
            latitude=form.latitude.data,
            longitude=form.longitude.data,
            total_ports=form.total_ports.data,
            used_ports=form.used_ports.data,
            available_ports=form.total_ports.data - form.used_ports.data,
            status=form.status.data,
        )
        db.session.add(nap)
        db.session.commit()
        flash(f"NAP '{nap.nap_code}' was added successfully.", "success")
        return redirect(url_for("naps.list_naps"))

    return render_template("naps/form.html", form=form, mode="add", nap=None)


@naps_bp.route("/quick-add", methods=["POST"])
@role_required(*_MANAGE_ROLES)
def quick_add_nap():
    """Creates a NAP from the GeoMap's 'Add NAP' workflow.

    Called via fetch()/AJAX from napmap.js, not a normal page
    navigation, so it returns JSON instead of a redirect. The request
    carries latitude/longitude captured from a map click, but those
    values (and everything else) are re-validated here exactly like
    any other form submission — a browser-supplied coordinate is never
    trusted just because it "looks like" it came from a map click.
    """
    form = MapQuickAddNapForm()

    if form.validate_on_submit():
        nap = Nap(
            nap_code=form.nap_code.data.strip(),
            name=form.name.data.strip(),
            address=(form.address.data or "").strip() or None,
            latitude=form.latitude.data,
            longitude=form.longitude.data,
            total_ports=form.total_ports.data,
            used_ports=0,  # a brand-new NAP has nothing connected to it yet
            available_ports=form.total_ports.data,
            status=form.status.data,
        )
        db.session.add(nap)
        db.session.commit()

        return (
            jsonify(
                {
                    "status": "success",
                    "message": f"NAP '{nap.nap_code}' was created successfully.",
                    "nap": {
                        "id": nap.id,
                        "nap_code": nap.nap_code,
                        "name": nap.name,
                        "address": nap.address,
                        "latitude": float(nap.latitude),
                        "longitude": float(nap.longitude),
                        "total_ports": nap.total_ports,
                        "used_ports": nap.used_ports,
                        "available_ports": nap.available_ports,
                        "status": nap.status,
                    },
                }
            ),
            201,
        )

    # form.errors is a dict of {field_name: [messages]} — sent back as-is
    # so the frontend can show each message under its matching input.
    return jsonify({"status": "error", "errors": form.errors}), 400


@naps_bp.route("/<int:nap_id>")
@role_required(*_VIEW_ROLES)
def _nap_port_assignments(nap):
    """Maps port_number -> Subscriber for this NAP's occupied slots,
    using each subscriber's actual technician-recorded port_number
    (the value entered on the mobile Job Detail screen and saved to
    Assignment.port_number when their installation was completed —
    see api_v1/technician.py's _validate_port_number()) instead of a
    display-only sequential guess.

    Looked up via the subscriber's service_requests -> the most
    recently assigned Assignment on each that actually recorded a
    port_number (a subscriber can have more than one service request
    over time -- e.g. a later upgrade/relocation -- so the newest
    recorded port wins).

    A subscriber with no recorded port_number at all (added directly
    through Subscribers -> Add Subscriber, bypassing the technician
    install flow entirely) falls back to the next free slot in id
    order, same as this page's previous behavior, so every occupied
    subscriber still shows up exactly once and two subscribers can
    never collide on the same displayed port.
    """
    occupied_subs = [s for s in nap.subscribers if s.status != "disconnected"]
    occupied_subs.sort(key=lambda s: s.id)

    subscriber_ids = [s.id for s in occupied_subs]
    recorded_ports = {}
    if subscriber_ids:
        rows = (
            db.session.query(ServiceRequest.subscriber_id, Assignment.port_number)
            .join(Assignment, Assignment.service_request_id == ServiceRequest.id)
            .filter(
                ServiceRequest.subscriber_id.in_(subscriber_ids),
                Assignment.port_number.isnot(None),
            )
            .order_by(Assignment.assigned_at.desc())
            .all()
        )
        # rows are newest-assignment-first; setdefault so each
        # subscriber keeps only their most recently recorded port.
        for subscriber_id, port_number in rows:
            recorded_ports.setdefault(subscriber_id, port_number)

    assignments = {}
    unplaced = []
    for sub in occupied_subs:
        port = recorded_ports.get(sub.id)
        if port is not None and 1 <= port <= nap.total_ports and port not in assignments:
            assignments[port] = sub
        else:
            unplaced.append(sub)

    free_slots = (p for p in range(1, nap.total_ports + 1) if p not in assignments)
    for sub, port in zip(unplaced, free_slots):
        assignments[port] = sub

    return assignments


def view_nap(nap_id):
    """Displays full details for a single NAP.

    Phase 17: a Technician may only open a NAP tied to one of their
    own assignments — everything else 403s. Enforced here rather than
    by narrowing _VIEW_ROLES so an administrator's unrestricted access
    is untouched, same shape as issues.view_issue's Phase 14 check.

    Used/Available Ports and the per-port table below are computed
    live (slot_usage() + _nap_port_assignments()) rather than read off
    the stored nap.used_ports/available_ports columns, which every
    other page already treats as stale/unmaintained bookkeeping (see
    app/nap_status.py's module docstring and the matching comment on
    subscribers.py's assign_nap()) — this page was the one place still
    trusting them, which is why it could show "Used Ports: 0" for a
    NAP with subscribers already connected.
    """
    nap = Nap.query.get_or_404(nap_id)

    if g.user.role == "field_assistant" and nap.id not in _own_nap_ids_for(g.user):
        abort(403)

    used_ports, available_ports = slot_usage(nap)
    port_assignments = _nap_port_assignments(nap)

    return render_template(
        "naps/view.html",
        nap=nap,
        used_ports=used_ports,
        available_ports=available_ports,
        port_assignments=port_assignments,
    )


@naps_bp.route("/resync-status", methods=["POST"])
@role_required(*_MANAGE_ROLES)
def resync_status():
    """One-off backfill for NAPs that existed before `nap.status` was
    wired up to auto-follow real slot occupancy (see
    app/nap_status.py) -- those rows can still show "active" while
    actually full, because nothing recalculated them retroactively
    when this fix shipped. Re-syncing every NAP once here catches
    those up; every write path going forward keeps itself in sync on
    its own, so this button is safe to click as often as needed but
    shouldn't normally need clicking more than once."""
    naps = Nap.query.all()
    changed = 0
    for nap in naps:
        before = nap.status
        sync_nap_status(nap)
        if nap.status != before:
            changed += 1
    db.session.commit()

    if changed:
        flash(f"Re-synced NAP status: {changed} NAP(s) updated to match actual slot occupancy.", "success")
    else:
        flash("Re-synced NAP status: everything already matched actual slot occupancy.", "info")
    return redirect(request.referrer or url_for("naps.list_naps"))


@naps_bp.route("/<int:nap_id>/deactivate", methods=["POST"])
@role_required(*_MANAGE_ROLES)
def deactivate_nap(nap_id):
    """Soft-deactivates a NAP by setting its status to 'inactive'.
    The record itself is never physically deleted."""
    nap = Nap.query.get_or_404(nap_id)
    nap.status = "inactive"
    db.session.commit()
    flash(f"NAP '{nap.nap_code}' has been deactivated.", "success")
    return redirect(request.referrer or url_for("naps.list_naps"))


@naps_bp.route("/<int:nap_id>/activate", methods=["POST"])
@role_required(*_MANAGE_ROLES)
def activate_nap(nap_id):
    """Reactivates a previously deactivated NAP by setting its status
    back to 'active'."""
    nap = Nap.query.get_or_404(nap_id)
    nap.status = "active"
    # Re-derive rather than trust "active" outright -- a NAP taken
    # down for maintenance may have been (and still be) fully occupied
    # by its real, linked subscribers the whole time.
    sync_nap_status(nap)
    db.session.commit()
    flash(f"NAP '{nap.nap_code}' has been reactivated.", "success")
    return redirect(request.referrer or url_for("naps.list_naps"))