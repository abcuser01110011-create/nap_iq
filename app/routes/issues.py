"""
Technical Issues Blueprint
----------------------------
Handles reporting a new technical issue from the GeoMap, viewing a
single issue's details, and (Phase 14) the Administrator's full Issues
list/management view.

Phase 14 decision — Issues list vs. Dispatch Board: the Dispatch Board
(app/routes/dispatch.py) intentionally only ever shows issues that are
still *open* (pending/assigned/in_progress) — that's the right scope
for "what needs a technician right now", but it means an administrator
had no way to browse the full issue history (resolved/closed included)
or search/filter across all of it. This module's new `list_issues()`
fills that gap as its own page rather than widening the Dispatch
Board's scope, so the Dispatch Board stays focused on active dispatch
work. Assign/reassign/cancel actions still live only on the issue
detail page (view_issue) and the Dispatch Board itself — the list page
here is read-only navigation into those.

Phase 14 also tightens technician access on `view_issue`: previously
any technician could open any issue by id, including ones never
assigned to them, exposing another subscriber's name/address/
coordinates with no operational reason to. A technician can now only
open an issue that has (or has ever had) an assignment routed to them;
an administrator's access is unchanged. The GeoMap and its /api/issues
and /api/subscribers feeds (app/routes/api.py) are deliberately left
as-is — those are the shared situational map every technician needs
geographic context from, which is a different kind of access than
drilling into one subscriber's full record, and narrowing it wasn't
part of this round's request.

Phase 20 adds the last unimplemented step of phase_8.pdf's
Pending -> Assigned -> In Progress -> Resolved -> Closed workflow:
an administrator-only POST /issues/<id>/close, only valid once an
issue has reached 'resolved' (i.e. a technician has already completed
their assignment on it — see app/routes/technician.py's
complete_assignment). Also adds a full assignment-history section to
view_issue()/issues/view.html — every Assignment row for the issue,
not just the current open one, so an administrator can see the whole
reassignment/resolution trail including resolution_notes.

Routes:
    GET  /issues/                  -> list_issues  (Administrator: full issue list, search + filters)
    POST /issues/report            -> report_issue  (create an issue from a map click, JSON)
    GET  /issues/<id>              -> view_issue    (issue detail page)
    POST /issues/<id>/close        -> close_issue   (Administrator-only: resolved -> closed)
"""

from flask import Blueprint, render_template, jsonify, request, redirect, url_for, flash, abort, g

from decimal import Decimal

from app.extensions import db
from app.auth import role_required
from app.models import TechnicalIssue, Subscriber, Nap, Assignment, Technician
from app.forms import IssueReportForm
from app.notifications_utils import notify_issue_status_change, notify_new_issue_reported, notify_issue_updated

issues_bp = Blueprint("issues", __name__, url_prefix="/issues")

# "When reporting issues as an admin, make sure to point it in a
# subscriber's exact location — if not, it will not proceed / shows a
# pin error." A reported issue's coordinates must match the selected
# subscriber's own registered coordinates. This tolerance exists only
# to absorb float(JS)-vs-DECIMAL(10,7)(MySQL) rounding on the same
# point (napmap.js uses the same value), not to allow a meaningfully
# different location through — roughly 5 meters at this latitude.
_PIN_LOCATION_TOLERANCE = Decimal("0.00005")

# Phase 7 RBAC: reporting and viewing technical issues is operational
# work done by staff (Administrator / Technician) from the internal
# GeoMap, not a public form — keep both routes staff-only. (Note: if a
# future phase adds customer self-service issue reporting, that should
# be a separate route restricted to "user" rather than opening these.)
_STAFF_ROLES = ("administrator", "technician")

# Kept in sync by hand with dispatch.py's OPEN_ASSIGNMENT_STATUSES —
# same reasoning as that module's own comment on the duplication.
_OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")

# Kept in sync by hand with dispatch.py's / dashboard.py's own
# OPEN_ISSUE_STATUSES — same duplication tradeoff as
# _OPEN_ASSIGNMENT_STATUSES above. Used by report_issue() below to
# decide whether a new report should update an already-open issue
# instead of creating a second, overlapping one for the same
# subscriber (an issue is "open" and eligible to be merged into right
# up until it's resolved/closed).
_OPEN_ISSUE_STATUSES = ("pending", "assigned", "in_progress")


def _populate_dynamic_choices(form):
    """Fills in the Subscriber and NAP dropdown options from the
    database. Done here (not as static choices on the form class)
    because the set of subscribers/NAPs changes over time and must
    always reflect what's actually in MySQL right now."""
    subscribers = Subscriber.query.filter_by(status="active").order_by(Subscriber.full_name).all()
    form.subscriber_id.choices = [(0, "-- Select Subscriber --")] + [
        (s.id, f"{s.subscriber_code} — {s.full_name}") for s in subscribers
    ]

    naps = Nap.query.order_by(Nap.name).all()
    form.nap_id.choices = [(0, "None")] + [(n.id, f"{n.nap_code} — {n.name}") for n in naps]


@issues_bp.route("/")
@role_required("administrator")
def list_issues():
    """Full technical-issues list for an Administrator: every issue
    regardless of status (unlike the Dispatch Board, which only shows
    open ones), with search (issue code, subscriber name/code, issue
    type) and status/priority filtering via query string parameters
    (?q=...&status=...&priority=...) — same pattern as
    subscribers.list_subscribers.
    """
    search_term = request.args.get("q", "").strip()
    status_filter = request.args.get("status", "").strip()
    priority_filter = request.args.get("priority", "").strip()

    query = TechnicalIssue.query

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.join(Subscriber).filter(
            db.or_(
                TechnicalIssue.issue_code.ilike(like_pattern),
                TechnicalIssue.issue_type.ilike(like_pattern),
                Subscriber.full_name.ilike(like_pattern),
                Subscriber.subscriber_code.ilike(like_pattern),
            )
        )

    if status_filter:
        query = query.filter(TechnicalIssue.status == status_filter)

    if priority_filter:
        query = query.filter(TechnicalIssue.priority == priority_filter)

    issues = query.order_by(TechnicalIssue.created_at.desc()).all()

    # One query for all open assignments rather than N+1 per issue row
    # — same approach dispatch.index() already uses.
    open_assignments = Assignment.query.filter(
        Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES)
    ).all()
    assignment_by_issue = {a.technical_issue_id: a for a in open_assignments}

    return render_template(
        "issues/list.html",
        issues=issues,
        assignment_by_issue=assignment_by_issue,
        search_term=search_term,
        status_filter=status_filter,
        priority_filter=priority_filter,
    )


@issues_bp.route("/report", methods=["POST"])
@role_required(*_STAFF_ROLES)
def report_issue():
    """Creates a technical issue from the GeoMap's 'Report an Issue'
    workflow. Called via fetch()/AJAX, so it returns JSON rather than
    a redirect. Latitude/longitude arrive from a map click but, like
    every other field here, are fully re-validated server-side —
    nothing coming from the browser is trusted as-is.

    Pin-error rule: the submitted latitude/longitude must match the
    selected subscriber's own registered location exactly (within a
    small float-rounding tolerance) — an admin can't report an issue
    pinned somewhere other than that subscriber's actual address. A
    mismatch (or a subscriber with no location on file) returns 400
    with `"pin_error": true` and a message under the `latitude` field.
    """
    form = IssueReportForm()
    _populate_dynamic_choices(form)  # must happen before validate_on_submit()

    if form.validate_on_submit():
        # Pin-error guard: the submitted lat/lng must be the selected
        # subscriber's *exact* registered location, not just somewhere
        # nearby on the map. This is re-checked here even though
        # napmap.js already snaps/validates client-side, because
        # nothing coming from the browser is trusted as-is (same rule
        # this route's own docstring already states for every other
        # field).
        subscriber = Subscriber.query.get(form.subscriber_id.data)
        if subscriber is None:
            return (
                jsonify({"status": "error", "errors": {"subscriber_id": ["Selected subscriber was not found."]}}),
                400,
            )

        if subscriber.latitude is None or subscriber.longitude is None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "pin_error": True,
                        "errors": {
                            "latitude": [
                                "Pin error: this subscriber has no registered location on file, "
                                "so an issue can't be pinned for them. Set their location first."
                            ]
                        },
                    }
                ),
                400,
            )

        lat_diff = abs(form.latitude.data - subscriber.latitude)
        lng_diff = abs(form.longitude.data - subscriber.longitude)
        if lat_diff > _PIN_LOCATION_TOLERANCE or lng_diff > _PIN_LOCATION_TOLERANCE:
            return (
                jsonify(
                    {
                        "status": "error",
                        "pin_error": True,
                        "errors": {
                            "latitude": [
                                "Pin error: the reported location must be the subscriber's exact "
                                "registered address. Re-select the subscriber to snap the pin back."
                            ]
                        },
                    }
                ),
                400,
            )

        # Merge-into-existing-issue guard: a subscriber can only ever
        # be pinned at their own exact registered location (enforced
        # above), so a second report filed for a subscriber who
        # already has an open issue would land its marker exactly on
        # top of the first one on the GeoMap -- indistinguishable pins
        # stacked at one point rather than two genuinely separate
        # problems. Instead of inserting a second row here, fold the
        # new report into whichever open (pending/assigned/
        # in_progress) issue that subscriber already has, updating it
        # in place -- one marker per subscriber on the map at any
        # given time, and a technician working the existing ticket
        # sees the latest details rather than a second one appearing
        # underneath it. A subscriber whose only issue(s) are already
        # resolved/closed is treated the same as one with no issue at
        # all: this still creates a fresh row below.
        existing_issue = (
            TechnicalIssue.query.filter(
                TechnicalIssue.subscriber_id == subscriber.id,
                TechnicalIssue.status.in_(_OPEN_ISSUE_STATUSES),
            )
            .order_by(TechnicalIssue.created_at.desc())
            .first()
        )

        if existing_issue is not None:
            existing_issue.issue_type = form.issue_type.data
            existing_issue.description = form.description.data.strip()
            existing_issue.priority = form.priority.data
            existing_issue.address = (form.address.data or "").strip() or None
            existing_issue.latitude = form.latitude.data
            existing_issue.longitude = form.longitude.data
            existing_issue.nap_id = form.nap_id.data or None  # 0 sentinel -> NULL
            # Status/issue_code are left untouched -- this is the same
            # ticket, not a new one, so it keeps its place in the
            # existing pending/assigned/in_progress workflow.
            notify_issue_updated(existing_issue)
            db.session.commit()

            return (
                jsonify(
                    {
                        "status": "success",
                        "updated": True,
                        "message": f"Issue '{existing_issue.issue_code}' was updated with this report.",
                        "issue": {
                            "id": existing_issue.id,
                            "issue_code": existing_issue.issue_code,
                            "issue_type": existing_issue.issue_type,
                            "description": existing_issue.description,
                            "priority": existing_issue.priority,
                            "status": existing_issue.status,
                            "address": existing_issue.address,
                            "latitude": float(existing_issue.latitude),
                            "longitude": float(existing_issue.longitude),
                            "subscriber_id": existing_issue.subscriber_id,
                            "subscriber_name": existing_issue.subscriber.full_name,
                            "subscriber_code": existing_issue.subscriber.subscriber_code,
                            "nap_id": existing_issue.nap_id,
                            "nap_code": existing_issue.nap.nap_code if existing_issue.nap else None,
                            "created_at": existing_issue.created_at.isoformat(),
                        },
                    }
                ),
                200,
            )

        issue = TechnicalIssue(
            issue_type=form.issue_type.data,
            description=form.description.data.strip(),
            priority=form.priority.data,
            status="pending",  # every newly reported issue starts here
            address=(form.address.data or "").strip() or None,
            latitude=form.latitude.data,
            longitude=form.longitude.data,
            subscriber_id=form.subscriber_id.data,
            nap_id=form.nap_id.data or None,  # 0 sentinel -> NULL
        )
        db.session.add(issue)
        db.session.commit()  # issue.id is now populated by MySQL

        # Issue ID is auto-generated from the real primary key, mirroring
        # how the seed data's ISS-#### codes are formatted.
        issue.issue_code = f"ISS-{issue.id:04d}"
        notify_new_issue_reported(issue)
        db.session.commit()

        return (
            jsonify(
                {
                    "status": "success",
                    "updated": False,
                    "message": f"Issue '{issue.issue_code}' was reported successfully.",
                    "issue": {
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
                        "subscriber_name": issue.subscriber.full_name,
                        "subscriber_code": issue.subscriber.subscriber_code,
                        "nap_id": issue.nap_id,
                        "nap_code": issue.nap.nap_code if issue.nap else None,
                        "created_at": issue.created_at.isoformat(),
                    },
                }
            ),
            201,
        )

    return jsonify({"status": "error", "errors": form.errors}), 400


@issues_bp.route("/<int:issue_id>")
@role_required(*_STAFF_ROLES)
def view_issue(issue_id):
    """Displays full details for a single technical issue. For
    administrators, also loads the issue's current open assignment (if
    any) and the technician roster, so the Dispatch panel (Phase 10)
    can be rendered without a separate page load.

    Phase 14: a technician may only open an issue that has (or has
    ever had) an assignment routed to them — everything else 403s.
    This is enforced here rather than by narrowing _STAFF_ROLES so an
    administrator's unrestricted access is untouched.
    """
    issue = TechnicalIssue.query.get_or_404(issue_id)

    if g.user.role == "technician":
        profile = Technician.query.filter_by(user_id=g.user.id).first()
        has_assignment = profile is not None and Assignment.query.filter_by(
            technical_issue_id=issue.id, technician_id=profile.id
        ).first() is not None
        if not has_assignment:
            abort(403)

    assignment = None
    technicians = []
    assignment_history = []

    if g.user.role == "administrator":
        OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")
        assignment = (
            Assignment.query.filter(
                Assignment.technical_issue_id == issue.id,
                Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
            )
            .order_by(Assignment.assigned_at.desc())
            .first()
        )
        technicians = Technician.query.order_by(Technician.full_name).all()

        # Phase 20: every assignment ever routed to this issue (not
        # just the current open one), newest first, so an
        # administrator can see the full reassignment/resolution
        # trail — including resolution_notes left by a technician on
        # a since-completed or since-cancelled assignment.
        assignment_history = (
            Assignment.query.filter(Assignment.technical_issue_id == issue.id)
            .order_by(Assignment.assigned_at.desc())
            .all()
        )

    return render_template(
        "issues/view.html",
        issue=issue,
        assignment=assignment,
        technicians=technicians,
        assignment_history=assignment_history,
    )


@issues_bp.route("/<int:issue_id>/close", methods=["POST"])
@role_required("administrator")
def close_issue(issue_id):
    """Completes phase_8.pdf's Pending -> Assigned -> In Progress ->
    Resolved -> Closed workflow. Only valid once an issue has already
    reached 'resolved' — a technician marking their assignment
    complete (app/routes/technician.py's complete_assignment) is what
    gets it there in the first place; this is a distinct, deliberate
    administrator sign-off on top of that, not something a technician
    does themselves.
    """
    issue = TechnicalIssue.query.get_or_404(issue_id)

    if issue.status != "resolved":
        flash("Only a resolved issue can be closed.", "warning")
        return redirect(url_for("issues.view_issue", issue_id=issue.id))

    issue.status = "closed"
    notify_issue_status_change(issue)
    db.session.commit()

    issue_label = issue.issue_code or f"#{issue.id}"
    flash(f"{issue_label} marked closed.", "success")
    return redirect(url_for("issues.view_issue", issue_id=issue.id))
