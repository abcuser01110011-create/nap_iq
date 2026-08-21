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

from flask import Blueprint, render_template, redirect, url_for, flash, request

from app.extensions import db
from app.auth import role_required
from app.models import TechnicalIssue, Technician, Assignment
from app.forms import AssignTechnicianForm
from app.notifications_utils import notify_issue_status_change
from app.recommendation import get_recommendations

dispatch_bp = Blueprint("dispatch", __name__, url_prefix="/dispatch")

# Same definitions as app/routes/technician.py and app/routes/dashboard.py —
# kept in sync by hand since each module has its own narrow reason to
# import from models directly rather than sharing a constants module.
OPEN_ISSUE_STATUSES = ("pending", "assigned", "in_progress")
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")


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
    """Dispatch board: every technical_issue that's still open, with
    its current assignment (if any) so an administrator can see at a
    glance what needs a technician, what's already out, and to whom.
    """
    issues = (
        TechnicalIssue.query.filter(TechnicalIssue.status.in_(OPEN_ISSUE_STATUSES))
        .order_by(TechnicalIssue.created_at.desc())
        .all()
    )

    # One query for all open assignments rather than N+1 per issue row.
    open_assignments = Assignment.query.filter(
        Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES)
    ).all()
    assignment_by_issue = {a.technical_issue_id: a for a in open_assignments}

    technicians = Technician.query.order_by(Technician.full_name).all()
    available_technician_count = sum(1 for t in technicians if t.status == "available")

    return render_template(
        "dispatch/index.html",
        issues=issues,
        assignment_by_issue=assignment_by_issue,
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


@dispatch_bp.route("/assignments/<int:assignment_id>/cancel", methods=["POST"])
@role_required("administrator")
def cancel(assignment_id):
    """Cancels an open assignment with no replacement technician
    dispatched. The linked issue drops back to 'pending' so it
    reappears at the top of the dispatch board as needing attention."""
    assignment = Assignment.query.get_or_404(assignment_id)

    if assignment.status not in OPEN_ASSIGNMENT_STATUSES:
        flash("That assignment isn't open, so it can't be cancelled.", "warning")
        return redirect(request.referrer or url_for("dispatch.index"))

    issue = assignment.technical_issue
    technician = assignment.technician

    assignment.status = "cancelled"
    issue.status = "pending"
    _release_technician_if_idle(technician)
    notify_issue_status_change(issue)

    db.session.commit()

    issue_label = issue.issue_code or f"#{issue.id}"
    flash(f"Dispatch for {issue_label} was cancelled.", "success")
    return redirect(request.referrer or url_for("dispatch.index"))
