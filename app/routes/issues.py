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

Phase 36 — Tickets tab was showing trouble tickets (technical_issues,
created from the GeoMap's "Report Issue" / "+ Tickets" > Trouble
Ticket flow) only. A Service Order created from the same "+ Tickets"
modal (New Installation / Relocation / Upgrade / Disconnection / Add
NAP) already got dispatched to a field assistant's mobile Assignments
list via `_dispatch_field_assistant()` in
app/routes/service_requests.py, but never showed up anywhere in this
admin-facing Tickets table — the *only* place it was visible besides
the technician's phone was the separate Service Requests screen. Admin
had no single list confirming "yes, that ticket I just created is in
the system". `list_issues()` below now merges `service_requests` rows
into the same table alongside `technical_issues` rows, normalized into
a plain-dict "ticket row" shape (`_ticket_row_from_issue()` /
`_ticket_row_from_service_request()`) so issues/list.html can render
both kinds with one loop. Search/status/priority filtering is done in
Python over the merged, already-small admin ticket list rather than
two separate SQL queries, since the two source tables don't share a
status vocabulary (see `_SERVICE_REQUEST_STATUS_BADGE_CLASSES` below).
Each ticket's row still links to its own real detail page — the
existing issues.view_issue() for a trouble ticket, or the existing
service_requests.edit_request() (already used as a read-only detail
view elsewhere) for a service order — nothing about those pages
changes.

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
from app.models import TechnicalIssue, Subscriber, Nap, Assignment, Technician, ServiceRequest, Plan
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

# Phase 36: same status -> badge-class mapping service_requests/list.html
# already uses for its own status pills, reused here so a Service Order
# row shown in the merged Tickets table gets the exact same color
# treatment it already has on the Service Requests screen. Kept as its
# own dict (rather than importing one from service_requests.py) since
# that module doesn't expose it as a shared constant today.
_SERVICE_REQUEST_STATUS_BADGE_CLASSES = {
    "pending": "disp-badge-high",
    "approved": "disp-badge-assigned",
    "scheduled": "disp-badge-medium",
    "completed": "disp-badge-resolved",
    "closed": "disp-badge-closed",
    "rejected": "disp-badge-critical",
}


def _ticket_row_from_issue(issue, assignment):
    """Normalizes a TechnicalIssue (+ its current open Assignment, if
    any) into the plain-dict "ticket row" shape issues/list.html loops
    over. See this module's Phase 36 docstring note for why this
    exists."""
    subscriber_name = issue.subscriber.full_name if issue.subscriber else ""
    subscriber_code = issue.subscriber.subscriber_code if issue.subscriber else ""
    assigned_name = assignment.technician.full_name if assignment and assignment.technician else None

    return {
        "kind": "trouble_ticket",
        "code": issue.issue_code or f"#{issue.id}",
        "type_label": issue.issue_type,
        "priority": issue.priority,
        "status": issue.status,
        "status_label": issue.status.replace("_", " ").capitalize(),
        "status_badge_class": f"disp-badge-{issue.status}",
        "assigned_name": assigned_name,
        "created_at": issue.created_at,
        "detail_url": url_for("issues.view_issue", issue_id=issue.id),
        "search_blob": " ".join(
            filter(
                None,
                [
                    issue.issue_code,
                    issue.issue_type,
                    subscriber_name,
                    subscriber_code,
                    issue.nap.nap_code if issue.nap else "",
                    issue.status.replace("_", " "),
                    issue.priority,
                    assigned_name or "",
                ],
            )
        ).lower(),
    }


def _ticket_row_from_service_request(service_request, assignment):
    """Same as `_ticket_row_from_issue()` above but for a ServiceRequest
    (a "Service Order" ticket — New Installation / Relocation / Upgrade
    / Disconnection / Add NAP). ServiceRequest has no persisted ticket
    code column (see models.py), so one is derived from its real id --
    same "SO"-prefixed style the "+ Tickets" modal's next-code preview
    already uses (app/routes/api.py's tickets_next_code_json), just
    hyphenated to match TechnicalIssue.issue_code's "ISS-0004" look.
    """
    request_type = service_request.request_type or ""
    type_label = "NAP Installation" if request_type == "add_nap" else request_type.replace("_", " ").title()

    subscriber_name = (
        service_request.subscriber.full_name if service_request.subscriber else (service_request.full_name or "")
    )
    subscriber_code = service_request.subscriber.subscriber_code if service_request.subscriber else ""
    assigned_name = assignment.technician.full_name if assignment and assignment.technician else None

    return {
        "kind": "service_order",
        "code": f"SO-{service_request.id:04d}",
        "type_label": type_label,
        "priority": service_request.priority,
        "status": service_request.status,
        "status_label": service_request.status.capitalize(),
        "status_badge_class": _SERVICE_REQUEST_STATUS_BADGE_CLASSES.get(service_request.status, "disp-badge-low"),
        "assigned_name": assigned_name,
        "created_at": service_request.created_at,
        "detail_url": url_for("issues.view_service_order", request_id=service_request.id),
        "search_blob": " ".join(
            filter(
                None,
                [
                    f"SO-{service_request.id:04d}",
                    type_label,
                    subscriber_name,
                    subscriber_code,
                    service_request.status,
                    service_request.priority or "",
                    assigned_name or "",
                ],
            )
        ).lower(),
    }


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
    """Full ticket list for an Administrator: every trouble ticket
    (technical_issues) *and* every service order (service_requests) —
    i.e. everything ever created from the GeoMap's "Report Issue" /
    "+ Tickets" flows — regardless of status (unlike the Dispatch
    Board, which only shows open trouble tickets), with search (ticket
    code, subscriber name/code, ticket type) and status/priority
    filtering via query string parameters (?q=...&status=...&priority=...)
    — same pattern as subscribers.list_subscribers.

    Phase 36: previously only queried TechnicalIssue, so a Service
    Order created via the "+ Tickets" modal was dispatched to a field
    assistant's mobile app but never showed up here — see this
    module's Phase 36 docstring note above for the full reasoning. The
    two source tables don't share a status vocabulary (technical_issues:
    pending/assigned/in_progress/resolved/closed vs. service_requests:
    pending/approved/scheduled/completed/rejected/closed), so both are
    fetched in full and filtering is done in Python over the merged,
    already-small admin ticket list rather than as two divergent SQL
    WHERE clauses.
    """
    search_term = request.args.get("q", "").strip()
    status_filter = request.args.get("status", "").strip()
    priority_filter = request.args.get("priority", "").strip()

    issues = TechnicalIssue.query.order_by(TechnicalIssue.created_at.desc()).all()
    service_requests = ServiceRequest.query.order_by(ServiceRequest.created_at.desc()).all()

    # One query for all open assignments rather than N+1 per row --
    # same approach dispatch.index() already uses. Split by which
    # source column is set (Assignment always sets exactly one of the
    # two -- see models.py's Assignment docstring).
    open_assignments = Assignment.query.filter(
        Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES)
    ).all()
    assignment_by_issue = {a.technical_issue_id: a for a in open_assignments if a.technical_issue_id}
    assignment_by_request = {a.service_request_id: a for a in open_assignments if a.service_request_id}

    tickets = [
        _ticket_row_from_issue(issue, assignment_by_issue.get(issue.id)) for issue in issues
    ] + [
        _ticket_row_from_service_request(sr, assignment_by_request.get(sr.id)) for sr in service_requests
    ]

    if search_term:
        term = search_term.lower()
        tickets = [t for t in tickets if term in t["search_blob"]]

    if status_filter:
        tickets = [t for t in tickets if t["status"] == status_filter]

    if priority_filter:
        tickets = [t for t in tickets if t["priority"] == priority_filter]

    tickets.sort(key=lambda t: t["created_at"], reverse=True)

    # "Add Requests" dropdown (issues/list.html): surfaces issues a
    # subscriber reported themselves -- via the customer web portal
    # (app/routes/customer.py's report_issue()) or the mobile app
    # (api_v1/customer.py's report_issue()) -- and that are still
    # sitting untouched in 'pending'. Self-reported issues always
    # carry a photo (both of those routes require one); an issue
    # created here from the GeoMap's "Report Issue" / "+ Tickets" flow
    # never does -- see photo_filename's comment on the TechnicalIssue
    # model -- so that's used as the signal rather than adding a new
    # column just to tag the source. Once staff move a request past
    # 'pending' (assigned/in_progress/etc.) it drops off this list on
    # its own, since it's already been seen and is easy to find in the
    # main ticket table below by then.
    pending_requests = sorted(
        (
            {
                "id": issue.id,
                "issue_code": issue.issue_code,
                "subscriber_name": issue.subscriber.full_name if issue.subscriber else "",
                "issue_type": issue.issue_type,
                "created_at": issue.created_at,
            }
            for issue in issues
            if issue.status == "pending" and issue.photo_filename
        ),
        key=lambda r: r["created_at"],
        reverse=True,
    )

    return render_template(
        "issues/list.html",
        tickets=tickets,
        search_term=search_term,
        status_filter=status_filter,
        priority_filter=priority_filter,
        pending_requests=pending_requests,
    )


def _dispatch_field_assistant(issue, assigned_team_id):
    """Phase 30: the technical_issue counterpart of
    app/routes/service_requests.py's `_dispatch_field_assistant()` --
    see that function's docstring. Creates an `Assignment` row for the
    field assistant chosen in the "+ Tickets" modal's "Assigned Team"
    dropdown so this trouble ticket immediately appears on that field
    assistant's mobile Assignments dashboard, instead of only being
    dispatchable later from the Dispatch Board. Silently does nothing
    if no assigned team was chosen, or if the id doesn't resolve to a
    real Technician.

    The dropdown now lists every technician *and* field assistant (not
    just field assistants), so the match below is no longer restricted
    to personnel_type="field_assistant" -- any valid Technician id
    picked in that dropdown gets dispatched.
    """
    if not assigned_team_id:
        return
    technician = Technician.query.filter_by(id=assigned_team_id).first()
    if technician is None:
        return
    db.session.add(
        Assignment(
            technical_issue_id=issue.id,
            technician_id=technician.id,
            status="assigned",
        )
    )
    issue.status = "assigned"


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
            #
            # Bug fix: an Assigned Team picked on *this* submission was
            # previously dropped entirely on the merge path -- only the
            # brand-new-issue branch below ever called
            # _dispatch_field_assistant(), so re-reporting for a
            # subscriber who already had an open issue silently folded
            # the new report's text into that issue but never created
            # the Assignment the admin just picked in the modal. The
            # field assistant would never see the job, with no error
            # shown -- the request still came back "success". Only
            # dispatches if the issue doesn't already have an open
            # assignment (this merge path isn't the Reassign action;
            # an issue that's already dispatched keeps its existing
            # assignment untouched, same as before this fix).
            current_open_assignment = Assignment.query.filter(
                Assignment.technical_issue_id == existing_issue.id,
                Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES),
            ).first()
            already_dispatched = current_open_assignment is not None
            newly_dispatched = False
            # Set whenever an Assigned Team was picked on *this*
            # submission but couldn't be applied because the issue
            # already has an open assignment -- previously this was
            # dropped with no indication at all (see the "Bug fix"
            # note above this block): the response still said
            # "success" and the admin had no way to tell their pick
            # was ignored. Now surfaced in the message below so the
            # admin knows to use Reassign (on the Dispatch board or
            # this issue's own page) instead, if that's what they
            # actually wanted.
            ignored_team_pick = None
            if not already_dispatched:
                assigned_team_id = request.form.get("assigned_team_id")
                if assigned_team_id:
                    _dispatch_field_assistant(existing_issue, assigned_team_id)
                    newly_dispatched = existing_issue.status == "assigned"
            else:
                assigned_team_id = request.form.get("assigned_team_id")
                if assigned_team_id and str(current_open_assignment.technician_id) != str(assigned_team_id):
                    picked = Technician.query.get(assigned_team_id)
                    ignored_team_pick = picked.full_name if picked else "the selected field assistant"
            notify_issue_updated(existing_issue)
            db.session.commit()

            message = f"Issue '{existing_issue.issue_code}' was updated with this report."
            if newly_dispatched:
                message += " A field assistant was dispatched."
            elif ignored_team_pick:
                current_name = current_open_assignment.technician.full_name if current_open_assignment.technician else "its current assignee"
                message += (
                    f" Note: this ticket already has an open assignment ({current_name}), "
                    f"so {ignored_team_pick} was NOT dispatched — use Reassign if you want to "
                    "change who's on it."
                )

            return (
                jsonify(
                    {
                        "status": "success",
                        "updated": True,
                        "message": message,
                        # True whenever the merge path above skipped a
                        # newly-picked Assigned Team because the
                        # ticket was already dispatched -- lets the
                        # GeoMap modal (tickets.js) show this as a
                        # warning toast instead of the plain success
                        # one, same "pin_error"-style flag pattern
                        # already used elsewhere in this route.
                        "assignment_ignored": ignored_team_pick is not None,
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
        _dispatch_field_assistant(issue, request.form.get("assigned_team_id"))
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


@issues_bp.route("/report-fiber-break", methods=["POST"])
@role_required(*_STAFF_ROLES)
def report_fiber_break():
    """Creates a NAP-wide Fiber Break trouble ticket from the GeoMap's
    "+ Tickets" quick-create modal.

    Unlike `report_issue()` above (one subscriber -> one ticket), a
    fiber break is reported against the NAP itself: the admin picks
    the affected NAP (not a single customer), and this route fans
    that out into one `TechnicalIssue` per subscriber still connected
    to it (`nap.subscribers`, excluding `disconnected` ones -- same
    "still occupies a slot" rule `/api/naps`'s `_slot_usage()` uses).
    Each of those per-subscriber issues reuses the exact same
    merge-into-existing-open-issue behaviour `report_issue()` already
    has, just looped, so a subscriber who already has an open ticket
    gets it updated in place instead of duplicated.

    This is deliberately NOT a single NAP-level row: `TechnicalIssue.
    subscriber_id` is a required column (every issue belongs to a
    subscriber so it can be pinned, dispatched, and shown on that
    subscriber's own map marker), and reusing that per-subscriber
    shape is what makes this "just work" with everything already
    built on it -- no GeoMap JS changes needed:

      - Each new issue is `priority="critical"` (forced here,
        regardless of what the modal's Priority dropdown showed),
        `nap_id` set to the chosen NAP, `latitude`/`longitude` copied
        from the subscriber's own registered location (same pin rule
        `report_issue()` enforces). napmap.js's `buildSubscriberIcon()`
        already colors/pulses a subscriber's marker by the worst-
        priority open issue they have -- so every connected
        subscriber's icon turns critical/red automatically the next
        time the GeoMap refreshes (it already polls
        `refreshLiveData()` on an interval and on tab focus; nothing
        new needed here).

    Dispatch is deliberately NOT one Assignment per subscriber,
    though: what needs fixing is the NAP's fiber, not each individual
    subscriber's line, so a field assistant only needs to be sent out
    once. Only the *first* affected subscriber's issue gets dispatched
    (see `_dispatch_field_assistant` call below) -- and that one
    issue's address/latitude/longitude are pointed at the NAP itself
    rather than that subscriber's home, since the NAP is where the
    field assistant actually needs to go. Every other affected
    subscriber still gets/keeps their own critical issue (so their map
    marker still turns red and the outage still shows on their
    account), it's just never separately dispatched -- one ticket on
    the field assistant's mobile dashboard per fiber break, not one
    per connected line.

    A subscriber with no registered latitude/longitude on file is
    silently skipped (same "can't be pinned" case `report_issue()`
    hard-blocks on for a single subscriber) rather than failing the
    whole NAP-wide ticket for one bad record.

    Returns 400 with `errors.nap_id` if no NAP id was submitted, the
    NAP doesn't exist, or the NAP currently has zero connected (non-
    disconnected) subscribers to notify.
    """
    nap_id_raw = request.form.get("nap_id")
    if not nap_id_raw:
        return jsonify({"status": "error", "errors": {"nap_id": ["Please select the affected NAP."]}}), 400

    try:
        nap_id = int(nap_id_raw)
    except (TypeError, ValueError):
        return jsonify({"status": "error", "errors": {"nap_id": ["Invalid NAP selected."]}}), 400

    nap = Nap.query.get(nap_id)
    if nap is None:
        return jsonify({"status": "error", "errors": {"nap_id": ["Selected NAP was not found."]}}), 400

    affected_subscribers = [s for s in nap.subscribers if s.status != "disconnected"]
    if not affected_subscribers:
        return (
            jsonify(
                {
                    "status": "error",
                    "errors": {"nap_id": [f"{nap.nap_code} has no connected subscribers to notify."]},
                }
            ),
            400,
        )

    description = (request.form.get("description") or "").strip() or (
        f"Fiber break reported at {nap.nap_code} — {nap.name}. All connected lines affected."
    )
    assigned_team_id = request.form.get("assigned_team_id")

    created_count = 0
    updated_count = 0
    skipped_no_location = 0
    dispatched = False  # only the first affected subscriber's issue gets an Assignment

    for subscriber in affected_subscribers:
        if subscriber.latitude is None or subscriber.longitude is None:
            skipped_no_location += 1
            continue

        existing_issue = (
            TechnicalIssue.query.filter(
                TechnicalIssue.subscriber_id == subscriber.id,
                TechnicalIssue.status.in_(_OPEN_ISSUE_STATUSES),
            )
            .order_by(TechnicalIssue.created_at.desc())
            .first()
        )

        if existing_issue is not None:
            existing_issue.issue_type = "Fiber Break"
            existing_issue.description = description
            existing_issue.priority = "critical"
            existing_issue.address = subscriber.address
            existing_issue.latitude = subscriber.latitude
            existing_issue.longitude = subscriber.longitude
            existing_issue.nap_id = nap.id
            notify_issue_updated(existing_issue)
            db.session.commit()
            if not dispatched and assigned_team_id:
                # The dispatched ticket points at the NAP itself, not
                # this subscriber's home -- that's where the fiber
                # actually needs fixing, and where the field assistant
                # needs to go.
                existing_issue.address = nap.address
                existing_issue.latitude = nap.latitude
                existing_issue.longitude = nap.longitude
                _dispatch_field_assistant(existing_issue, assigned_team_id)
                dispatched = True
            updated_count += 1
        else:
            issue = TechnicalIssue(
                issue_type="Fiber Break",
                description=description,
                priority="critical",
                status="pending",
                address=subscriber.address,
                latitude=subscriber.latitude,
                longitude=subscriber.longitude,
                subscriber_id=subscriber.id,
                nap_id=nap.id,
            )
            db.session.add(issue)
            db.session.commit()  # issue.id is now populated by MySQL

            issue.issue_code = f"ISS-{issue.id:04d}"
            notify_new_issue_reported(issue)
            if not dispatched and assigned_team_id:
                issue.address = nap.address
                issue.latitude = nap.latitude
                issue.longitude = nap.longitude
                _dispatch_field_assistant(issue, assigned_team_id)
                dispatched = True
            created_count += 1

        db.session.commit()

    total_flagged = created_count + updated_count
    return (
        jsonify(
            {
                "status": "success",
                "nap": {"id": nap.id, "nap_code": nap.nap_code, "name": nap.name},
                "created": created_count,
                "updated": updated_count,
                "skipped_no_location": skipped_no_location,
                "message": (
                    f"Fiber Break ticket created for {nap.nap_code} — {total_flagged} "
                    f"connected subscriber(s) flagged critical."
                ),
            }
        ),
        201,
    )


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
    subscriber_plan_types = []

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

        # Backs the "Create Ticket" button's "+ Tickets" modal (see
        # partials/ticket_form_modal.html) — same union of existing
        # Subscriber.plan_type values + the curated Plan list used by
        # naps.py's geomap() for the same dropdown, kept in sync by
        # hand since the two pages don't share a view function.
        existing_plan_types = {
            row[0]
            for row in db.session.query(Subscriber.plan_type)
            .filter(Subscriber.plan_type.isnot(None), Subscriber.plan_type != "")
            .distinct()
            .all()
        }
        curated_plan_names = {p.name for p in Plan.query.all()}
        subscriber_plan_types = sorted(existing_plan_types | curated_plan_names)

    return render_template(
        "issues/view.html",
        issue=issue,
        assignment=assignment,
        technicians=technicians,
        assignment_history=assignment_history,
        subscriber_plan_types=subscriber_plan_types,
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


# Phase 36: kept in sync by hand with dispatch.py's own
# DISPATCHABLE_REQUEST_STATUSES — same duplication tradeoff already
# used throughout this module (see _OPEN_ASSIGNMENT_STATUSES /
# _OPEN_ISSUE_STATUSES above). Only used here to decide whether to
# show the "Assign a Technician" control on view_service_order below.
_DISPATCHABLE_REQUEST_STATUSES = ("scheduled",)


@issues_bp.route("/service-order/<int:request_id>")
@role_required("administrator")
def view_service_order(request_id):
    """Displays full details for a single Service Order ticket
    (service_requests row) — the Tickets tab's own detail page for
    that ticket type, so opening a Service Order from the Tickets
    table (issues/list.html) never has to leave for the separate
    Service Requests screen. Mirrors view_issue() above: same
    "current open assignment + full technician + full assignment
    history" data shape, just sourced from ServiceRequest/its
    Assignment rows (service_request_id) instead of TechnicalIssue's
    (technical_issue_id).

    Administrator-only, matching every other route in this module that
    manages dispatch (view_issue's own admin-only sections, close_issue
    above) — a field assistant already sees their own dispatched
    service orders on the mobile app's Assignments list and has no
    separate reason to browse this admin page.
    """
    service_request = ServiceRequest.query.get_or_404(request_id)

    current_assignment = (
        Assignment.query.filter(
            Assignment.service_request_id == service_request.id,
            Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES),
        )
        .order_by(Assignment.assigned_at.desc())
        .first()
    )
    technicians = Technician.query.order_by(Technician.full_name).all()

    # Every assignment ever routed to this request, newest first --
    # same "full reassignment/resolution trail" reasoning as
    # view_issue()'s own assignment_history above.
    assignment_history = (
        Assignment.query.filter(Assignment.service_request_id == service_request.id)
        .order_by(Assignment.assigned_at.desc())
        .all()
    )

    request_type = service_request.request_type or ""
    type_label = "NAP Installation" if request_type == "add_nap" else request_type.replace("_", " ").title()

    return render_template(
        "issues/view_service_order.html",
        service_request=service_request,
        type_label=type_label,
        assignment=current_assignment,
        technicians=technicians,
        assignment_history=assignment_history,
        dispatchable=service_request.status in _DISPATCHABLE_REQUEST_STATUSES,
    )
