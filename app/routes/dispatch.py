"""
Admin Dispatch Blueprint (Phase 10)
--------------------------------------
This is the missing link flagged in PHASE9_NOTES.md: an administrator
assigning a technician to an open `technical_issue` in the first
place. Everything downstream of this (a technician accepting,
starting, and completing that assignment) was already built in Phase
9 — this phase only creates/cancels/reassigns the `assignments` row
that Phase 9's workflow depends on existing.

Scope, deliberately kept tight:
- Assign: create a brand-new `assignments` row for an issue with no
  currently-open assignment. Issue -> 'assigned'.
- Reassign: cancel the issue's current open assignment and create a
  new one for a different technician. History is preserved (the old
  assignment row is marked 'cancelled', not deleted or overwritten) —
  see the docstring on `Assignment` in app/models.py, which flagged
  this exact use case back in an earlier phase. Issue -> 'assigned'
  regardless of how far along the cancelled assignment had gotten.
- Cancel: cancel the issue's current open assignment with nobody new
  dispatched. Issue -> 'pending'.

A technician's `technicians.status` is only ever flipped to 'busy' by
the technician themself starting work (Phase 9's start_assignment) —
being dispatched does not, by itself, make a technician busy. This
phase mirrors that: cancelling/reassigning frees a technician back to
'available' only if they have no other open assignment left, and only
if they were 'busy' in the first place (an 'offline' technician stays
offline; that's a status the technician/administrator sets deliberately
elsewhere, not something a dispatch action should silently overwrite).

Routes:
    GET  /dispatch/                                   -> index
                                                          (board of open issues)
    GET  /dispatch/issues/<issue_id>/recommend         -> recommend
                                                          (Phase 21, see below)
    POST /dispatch/issues/<issue_id>/assign            -> assign
    POST /dispatch/issues/<issue_id>/reassign          -> reassign
    POST /dispatch/assignments/<assignment_id>/cancel  -> cancel

---------------------------------------------------------------------
Phase 21 (phase_10.pdf) — Technician recommendation
---------------------------------------------------------------------
`recommend()` below is the only new route this phase adds. It is a
read-only GET that renders a ranked list of technicians (via
app/recommendation.py's `get_recommendations()` — see that module's
docstring for the full scoring formula, the exact database queries,
and the distance calculation) for one open issue, each with an
"Assign Technician" button.

Deliberately, `recommend()` does NOT create an assignment itself and
does NOT introduce a new "confirm" route. Every one of those buttons
is a plain HTML form posting to the *existing* `assign()` / `reassign()`
routes below — the same two routes the manual dispatch board
(dispatch/index.html) and the issue detail page (issues/view.html)
already post to, already CSRF-protected, already
`@role_required("administrator")`, already tested. This is the
"Administrator confirms -> Create assignment" step phase_10.pdf's
workflow diagram calls for: the recommendation page is purely
advisory right up until the Administrator clicks a real submit
button, at which point the request looks, to assign()/reassign(),
identical to one that came from the manual dropdown — except it also
carries the recommended candidate's `total_score` in a hidden
`recommendation_score` form field (see `AssignTechnicianForm` in
app/forms.py), which the two routes below now store on the new
`assignments` row as `dispatch_score` (a column that already existed
in database/schema.sql since Phase 9/10 but had never been populated
by anything until now). Manually dispatching from the board or the
issue page still leaves `dispatch_score` NULL exactly as before —
this phase only adds information for the recommendation path, it
does not change the manual path's behavior at all.

"Choose Another Technician" (phase_10.pdf's UI spec) isn't a separate
button/route either — the recommendation page simply lists every
candidate, ranked, each with their own "Assign Technician" button, so
choosing a different one is just clicking a different row's button.
"""

from types import SimpleNamespace

from flask import Blueprint, render_template, redirect, url_for, flash, request

from app.extensions import db
from app.auth import role_required
from app.models import TechnicalIssue, ServiceRequest, Technician, Assignment
from app.forms import AssignTechnicianForm
from app.notifications_utils import notify_issue_status_change
from app.recommendation import get_recommendations

dispatch_bp = Blueprint("dispatch", __name__, url_prefix="/dispatch")

# Same definitions as app/routes/technician.py and app/routes/dashboard.py —
# kept in sync by hand since each module has its own narrow reason to
# import from models directly rather than sharing a constants module.
OPEN_ISSUE_STATUSES = ("pending", "assigned", "in_progress")
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")

# Phase 28: the only service_request status a technician can be
# dispatched against. A service_request has no dedicated "dispatched"
# status distinct from "ready to be installed" the way a
# technical_issue does (compare 'assigned' there) — it just stays
# 'scheduled' for the whole install, from first dispatch through to
# completion, at which point Phase 29's install-completion hook moves
# it straight to 'completed'.
DISPATCHABLE_REQUEST_STATUSES = ("scheduled",)


def _populate_technician_choices(form, *, exclude_technician_id=None):
    """Fills in the Technician dropdown from the current roster,
    labelled with their status so an administrator can see at a
    glance who's actually free before dispatching them."""
    technicians = Technician.query.order_by(Technician.full_name).all()
    form.technician_id.choices = [(0, "-- Select Technician --")] + [
        (t.id, f"{t.full_name} ({t.status})")
        for t in technicians
        if t.id != exclude_technician_id
    ]


def _current_open_assignment(issue_id):
    """The issue's single currently-open assignment, if any. An issue
    should only ever have at most one open assignment at a time — this
    phase's own assign()/reassign() guard that invariant — so `.first()`
    is safe rather than needing to reason about multiple rows."""
    return (
        Assignment.query.filter(
            Assignment.technical_issue_id == issue_id,
            Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
        )
        .order_by(Assignment.assigned_at.desc())
        .first()
    )


def _current_open_assignment_for_request(request_id):
    """The service_request counterpart of `_current_open_assignment()`
    above — same "at most one open assignment at a time" invariant."""
    return (
        Assignment.query.filter(
            Assignment.service_request_id == request_id,
            Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
        )
        .order_by(Assignment.assigned_at.desc())
        .first()
    )


def _service_request_recommendation_source(service_request):
    """Adapts a ServiceRequest for app/recommendation.py's
    `get_recommendations()`, which was written against a
    `technical_issue` and only ever reads `.latitude`, `.longitude`,
    and `.nap` off whatever it's given. A ServiceRequest already has
    `.latitude`/`.longitude` of its own (Phase 22), just under a
    differently-named NAP relationship (`.requested_nap`) — this is a
    tiny read-only stand-in exposing `.nap` too, so
    `get_recommendations()` itself never needs to know or care which
    kind of source it was called for."""
    return SimpleNamespace(
        latitude=service_request.latitude,
        longitude=service_request.longitude,
        nap=service_request.requested_nap,
    )


def _release_technician_if_idle(technician):
    """Sets a 'busy' technician back to 'available' if this was their
    last open assignment. Mirrors the same check Phase 9's
    complete_assignment() already does — duplicated here (rather than
    imported from technician.py) to keep the two blueprints
    independent, same as the duplicated OPEN_* constants above."""
    if technician is None or technician.status != "busy":
        return
    still_open = Assignment.query.filter(
        Assignment.technician_id == technician.id,
        Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
    ).count()
    if still_open == 0:
        technician.status = "available"


@dispatch_bp.route("/")
@role_required("administrator")
def index():
    """Dispatch board: every technical_issue that's still open, plus
    (Phase 28) every service_request that's reached 'scheduled', each
    with its current assignment (if any) so an administrator can see
    at a glance what needs a technician, what's already out, and to
    whom — for repairs and installs alike.
    """
    issues = (
        TechnicalIssue.query.filter(TechnicalIssue.status.in_(OPEN_ISSUE_STATUSES))
        .order_by(TechnicalIssue.created_at.desc())
        .all()
    )
    # Phase 28: see DISPATCHABLE_REQUEST_STATUSES above for why a
    # single-status filter is enough here (unlike OPEN_ISSUE_STATUSES,
    # which needs a range).
    requests = (
        ServiceRequest.query.filter(ServiceRequest.status.in_(DISPATCHABLE_REQUEST_STATUSES))
        .order_by(ServiceRequest.updated_at.desc())
        .all()
    )

    # One query for all open assignments rather than N+1 per row.
    open_assignments = Assignment.query.filter(
        Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES)
    ).all()
    assignment_by_issue = {
        a.technical_issue_id: a for a in open_assignments if a.technical_issue_id is not None
    }
    assignment_by_request = {
        a.service_request_id: a for a in open_assignments if a.service_request_id is not None
    }

    technicians = Technician.query.order_by(Technician.full_name).all()
    available_technician_count = sum(1 for t in technicians if t.status == "available")

    return render_template(
        "dispatch/index.html",
        issues=issues,
        assignment_by_issue=assignment_by_issue,
        requests=requests,
        assignment_by_request=assignment_by_request,
        technicians=technicians,
        technician_count=len(technicians),
        available_technician_count=available_technician_count,
    )


@dispatch_bp.route("/issues/<int:issue_id>/recommend")
@role_required("administrator")
def recommend(issue_id):
    """Phase 21: shows ranked technician recommendations for one
    issue, each with an "Assign Technician" button. Read-only — see
    this module's own docstring above and app/recommendation.py's
    docstring for the full formula/query/confirmation-flow
    explanation.

    Works for an issue with no open assignment (buttons post to
    `assign`) just as well as one that's already dispatched but the
    Administrator wants to see whether a better-fitting technician is
    available (buttons post to `reassign` instead, same as the manual
    dropdown already offers on both the dispatch board and the issue
    detail page) — mirrors those two pages' own
    `'reassign' if assignment else 'assign'` branching rather than
    introducing a third case.
    """
    issue = TechnicalIssue.query.get_or_404(issue_id)
    current_assignment = _current_open_assignment(issue.id)

    recommendations = get_recommendations(issue)
    if current_assignment is not None:
        # Don't recommend "reassigning" an issue to the technician it's
        # already assigned to — that's a confusing no-op, not a real
        # choice. Mirrors dispatch/index.html and issues/view.html's
        # own manual Reassign dropdowns, which already exclude the
        # current technician from their choices for the same reason.
        recommendations = [
            row for row in recommendations
            if row["technician"].id != current_assignment.technician_id
        ]

    return render_template(
        "dispatch/recommend.html",
        issue=issue,
        current_assignment=current_assignment,
        recommendations=recommendations,
    )


@dispatch_bp.route("/issues/<int:issue_id>/assign", methods=["POST"])
@role_required("administrator")
def assign(issue_id):
    """Creates a brand-new assignment for an issue that has no
    currently-open one. Rejects (with a flash, not a 500) an attempt
    to assign an issue that already has one — use Reassign for that,
    so the old assignment's history is preserved instead of silently
    orphaned."""
    issue = TechnicalIssue.query.get_or_404(issue_id)

    if _current_open_assignment(issue.id) is not None:
        flash(
            f"{issue.issue_code or ('#' + str(issue.id))} already has an open "
            "assignment — use Reassign instead.",
            "warning",
        )
        return redirect(request.referrer or url_for("dispatch.index"))

    form = AssignTechnicianForm()
    _populate_technician_choices(form)

    if form.validate_on_submit():
        technician = Technician.query.get_or_404(form.technician_id.data)
        assignment = Assignment(
            technical_issue_id=issue.id,
            technician_id=technician.id,
            status="assigned",
            # Phase 21: only non-None when this POST came from the
            # recommendation page (see this module's docstring) —
            # the manual dropdown never sets this field, so this
            # stays NULL for a manually-picked technician exactly as
            # it always has.
            dispatch_score=form.recommendation_score.data,
        )
        issue.status = "assigned"
        db.session.add(assignment)
        notify_issue_status_change(issue)
        db.session.commit()

        issue_label = issue.issue_code or f"#{issue.id}"
        flash(f"{issue_label} dispatched to {technician.full_name}.", "success")
    else:
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")

    return redirect(request.referrer or url_for("dispatch.index"))


@dispatch_bp.route("/issues/<int:issue_id>/reassign", methods=["POST"])
@role_required("administrator")
def reassign(issue_id):
    """Cancels the issue's current open assignment and dispatches a
    different technician. The cancelled assignment row is kept (status
    'cancelled'), not deleted, so reassignment history stays visible on
    the issue. The freshly-freed technician is released back to
    'available' the same way cancel() below does."""
    issue = TechnicalIssue.query.get_or_404(issue_id)
    current = _current_open_assignment(issue.id)

    if current is None:
        flash(
            f"{issue.issue_code or ('#' + str(issue.id))} has no open assignment "
            "to reassign — use Assign instead.",
            "warning",
        )
        return redirect(request.referrer or url_for("dispatch.index"))

    form = AssignTechnicianForm()
    _populate_technician_choices(form, exclude_technician_id=current.technician_id)

    if form.validate_on_submit():
        new_technician = Technician.query.get_or_404(form.technician_id.data)
        old_technician = current.technician

        current.status = "cancelled"
        _release_technician_if_idle(old_technician)

        new_assignment = Assignment(
            technical_issue_id=issue.id,
            technician_id=new_technician.id,
            status="assigned",
            # Phase 21: see the matching comment in assign() above.
            dispatch_score=form.recommendation_score.data,
        )
        issue.status = "assigned"
        db.session.add(new_assignment)
        notify_issue_status_change(issue)
        db.session.commit()

        issue_label = issue.issue_code or f"#{issue.id}"
        flash(
            f"{issue_label} reassigned from {old_technician.full_name if old_technician else 'previous technician'} "
            f"to {new_technician.full_name}.",
            "success",
        )
    else:
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")

    return redirect(request.referrer or url_for("dispatch.index"))


@dispatch_bp.route("/requests/<int:request_id>/recommend")
@role_required("administrator")
def recommend_request(request_id):
    """Phase 28: the service_request counterpart of recommend() above
    — see this module's docstring for how a ServiceRequest is adapted
    for app/recommendation.py's scoring formula."""
    service_request = ServiceRequest.query.get_or_404(request_id)
    current_assignment = _current_open_assignment_for_request(service_request.id)

    recommendations = get_recommendations(
        _service_request_recommendation_source(service_request)
    )
    if current_assignment is not None:
        recommendations = [
            row for row in recommendations
            if row["technician"].id != current_assignment.technician_id
        ]

    return render_template(
        "dispatch/recommend_request.html",
        service_request=service_request,
        current_assignment=current_assignment,
        recommendations=recommendations,
    )


@dispatch_bp.route("/requests/<int:request_id>/assign", methods=["POST"])
@role_required("administrator")
def assign_request(request_id):
    """Phase 28: the service_request counterpart of assign() above.
    Only valid once the request has reached 'scheduled' — an
    administrator can't dispatch a technician for an install that
    hasn't been approved and given a NAP yet."""
    service_request = ServiceRequest.query.get_or_404(request_id)
    request_label = f"Request #{service_request.id}"

    if service_request.status not in DISPATCHABLE_REQUEST_STATUSES:
        flash(
            f"{request_label} isn't scheduled yet — approve it and assign a NAP "
            "before dispatching a technician.",
            "warning",
        )
        return redirect(request.referrer or url_for("dispatch.index"))

    if _current_open_assignment_for_request(service_request.id) is not None:
        flash(f"{request_label} already has an open assignment — use Reassign instead.", "warning")
        return redirect(request.referrer or url_for("dispatch.index"))

    form = AssignTechnicianForm()
    _populate_technician_choices(form)

    if form.validate_on_submit():
        technician = Technician.query.get_or_404(form.technician_id.data)
        assignment = Assignment(
            service_request_id=service_request.id,
            technician_id=technician.id,
            status="assigned",
            dispatch_score=form.recommendation_score.data,
        )
        # Deliberately no service_request.status change here — see
        # this module's docstring for why 'scheduled' already covers
        # "dispatched but not yet installed" for a service_request.
        db.session.add(assignment)
        db.session.commit()

        flash(f"{request_label} dispatched to {technician.full_name}.", "success")
    else:
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")

    return redirect(request.referrer or url_for("dispatch.index"))


@dispatch_bp.route("/requests/<int:request_id>/reassign", methods=["POST"])
@role_required("administrator")
def reassign_request(request_id):
    """Phase 28: the service_request counterpart of reassign() above."""
    service_request = ServiceRequest.query.get_or_404(request_id)
    request_label = f"Request #{service_request.id}"
    current = _current_open_assignment_for_request(service_request.id)

    if current is None:
        flash(f"{request_label} has no open assignment to reassign — use Assign instead.", "warning")
        return redirect(request.referrer or url_for("dispatch.index"))

    form = AssignTechnicianForm()
    _populate_technician_choices(form, exclude_technician_id=current.technician_id)

    if form.validate_on_submit():
        new_technician = Technician.query.get_or_404(form.technician_id.data)
        old_technician = current.technician

        current.status = "cancelled"
        _release_technician_if_idle(old_technician)

        new_assignment = Assignment(
            service_request_id=service_request.id,
            technician_id=new_technician.id,
            status="assigned",
            dispatch_score=form.recommendation_score.data,
        )
        db.session.add(new_assignment)
        db.session.commit()

        flash(
            f"{request_label} reassigned from "
            f"{old_technician.full_name if old_technician else 'previous technician'} "
            f"to {new_technician.full_name}.",
            "success",
        )
    else:
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")

    return redirect(request.referrer or url_for("dispatch.index"))


@dispatch_bp.route("/assignments/<int:assignment_id>/cancel", methods=["POST"])
@role_required("administrator")
def cancel(assignment_id):
    """Cancels an open assignment with no replacement technician
    dispatched. For a repair (technical_issue-linked) assignment, the
    linked issue drops back to 'pending' so it reappears at the top of
    the dispatch board. For an install (service_request-linked, Phase
    28) assignment, the linked request simply stays 'scheduled' — see
    this module's docstring for why that status already means "needs
    a technician" regardless of whether one's currently dispatched."""
    assignment = Assignment.query.get_or_404(assignment_id)

    if assignment.status not in OPEN_ASSIGNMENT_STATUSES:
        flash("That assignment isn't open, so it can't be cancelled.", "warning")
        return redirect(request.referrer or url_for("dispatch.index"))

    technician = assignment.technician
    assignment.status = "cancelled"
    _release_technician_if_idle(technician)

    if assignment.technical_issue_id is not None:
        issue = assignment.technical_issue
        issue.status = "pending"
        notify_issue_status_change(issue)
        db.session.commit()
        label = issue.issue_code or f"#{issue.id}"
    else:
        db.session.commit()
        label = f"Request #{assignment.service_request_id}"

    flash(f"Dispatch for {label} was cancelled.", "success")
    return redirect(request.referrer or url_for("dispatch.index"))
