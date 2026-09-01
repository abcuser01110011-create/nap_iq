"""
Technician Blueprint
----------------------
The Technician-role interface introduced in Phase 7, extended to let a
technician act on their own assignments end to end: accept a new
assignment, start work on it, save resolution notes as they go, and
mark it complete — each step also keeping the linked
technical_issues.status and the technician's own `technicians.status`
in sync, the same way an administrator dispatching work by hand would
update them.

Dispatch itself (an administrator assigning a technician to an issue
in the first place, or cancelling/reassigning one) lives in
app/routes/dispatch.py — Assignment rows are created there, not here.
This module only covers what a technician can do with an assignment
already routed to them.

Phase 20 (phase_8.pdf, Technician module) adds:
- Resolution notes (`assignments.resolution_notes`), saved either via
  a standalone 'Save Notes' action while work is underway, or as a
  required field on 'Mark Complete' itself.
- An assignment history page (GET /technician/history) — the
  technician-facing counterpart of what dispatch.py already preserves
  (completed/cancelled assignments are never deleted).

Routes:
    GET  /technician/                              -> index
                                                        (the technician's own current workload)
    GET  /technician/history                        -> history
                                                        (past assignments: completed/cancelled)
    POST /technician/assignments/<id>/accept        -> accept_assignment
                                                        (assigned -> accepted)
    POST /technician/assignments/<id>/start          -> start_assignment
                                                        (accepted -> in_progress;
                                                        issue -> in_progress)
    POST /technician/assignments/<id>/notes          -> save_notes
                                                        (resolution_notes only, no status change)
    POST /technician/assignments/<id>/complete       -> complete_assignment
                                                        (in_progress -> completed;
                                                        issue -> resolved;
                                                        resolution_notes required)
"""

from datetime import datetime

from flask import Blueprint, render_template, redirect, url_for, flash, abort, g

from app.extensions import db
from app.auth import role_required
from app.models import Technician, Assignment, TechnicalIssue
from app.forms import ResolutionNotesForm
from app.notifications_utils import notify_issue_status_change

technician_bp = Blueprint("technician", __name__, url_prefix="/technician")

# Any assignment status not in this tuple is "history" — it's done and
# won't change again. Kept in sync by hand with dispatch.py's own
# OPEN_ASSIGNMENT_STATUSES, same reasoning as that module's comment.
CLOSED_ASSIGNMENT_STATUSES = ("completed", "cancelled")

OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")


def _get_own_profile_or_403():
    """Looks up the signed-in technician's own profile row, aborting
    with a 403 if none is linked. The index page already shows a
    friendly empty state for this case (see below) — this helper only
    guards the POST actions, which shouldn't be reachable without a
    profile since the buttons that trigger them live on that same
    page, but a direct POST is defended against anyway."""
    profile = Technician.query.filter_by(user_id=g.user.id).first()
    if profile is None:
        abort(403)
    return profile


def _get_own_assignment_or_403(profile, assignment_id):
    """Looks up an assignment by id and confirms it actually belongs to
    the signed-in technician's own profile — without this check, a
    technician could act on another technician's assignment just by
    changing the id in the URL."""
    assignment = Assignment.query.get_or_404(assignment_id)
    if assignment.technician_id != profile.id:
        abort(403)
    return assignment


@technician_bp.route("/")
@role_required("field_assistant")
def index():
    """Shows the signed-in technician's profile + current assignments.

    Looked up via `technicians.user_id`, which links a technician's
    profile row back to the `users` account they log in with. If no
    profile has been linked yet (e.g. a technician user account was
    created but not yet paired with a technicians row), the page shows
    an explicit empty state instead of erroring.
    """
    profile = Technician.query.filter_by(user_id=g.user.id).first()

    assignments = []
    if profile is not None:
        assignments = (
            Assignment.query.filter(
                Assignment.technician_id == profile.id,
                Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
            )
            .order_by(Assignment.assigned_at.desc())
            .all()
        )

    return render_template(
        "technician/index.html",
        profile=profile,
        assignments=assignments,
        notes_form=ResolutionNotesForm(),
    )


@technician_bp.route("/history")
@role_required("field_assistant")
def history():
    """View assignment history (phase_8.pdf technician item #10): every
    past assignment for the signed-in technician that's no longer
    open — completed or cancelled — newest first. These rows are never
    deleted (see Assignment's docstring / dispatch.py), so this is
    simply the other side of the same query index() already runs,
    filtered to the closed statuses instead of the open ones.
    """
    profile = Technician.query.filter_by(user_id=g.user.id).first()

    assignments = []
    if profile is not None:
        assignments = (
            Assignment.query.filter(
                Assignment.technician_id == profile.id,
                Assignment.status.in_(CLOSED_ASSIGNMENT_STATUSES),
            )
            .order_by(Assignment.assigned_at.desc())
            .all()
        )

    return render_template(
        "technician/history.html",
        profile=profile,
        assignments=assignments,
    )


@technician_bp.route("/assignments/<int:assignment_id>/accept", methods=["POST"])
@role_required("field_assistant")
def accept_assignment(assignment_id):
    """Acknowledges a newly dispatched assignment. Only valid from
    'assigned' — this is the technician's first action on it, before
    any work has actually started."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "assigned":
        flash("That assignment isn't waiting to be accepted anymore.", "warning")
        return redirect(url_for("technician.index"))

    assignment.status = "accepted"
    db.session.commit()

    issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
    flash(f"Assignment for {issue_label} accepted.", "success")
    return redirect(url_for("technician.index"))


@technician_bp.route("/assignments/<int:assignment_id>/start", methods=["POST"])
@role_required("field_assistant")
def start_assignment(assignment_id):
    """Marks work as actually underway. Only valid from 'accepted'.
    Mirrors the status onto the linked technical_issue (so it shows as
    'in_progress' everywhere else in the app — the dashboard, the
    issue detail page, etc.) and marks the technician 'busy'."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "accepted":
        flash("That assignment needs to be accepted before you can start work on it.", "warning")
        return redirect(url_for("technician.index"))

    assignment.status = "in_progress"
    assignment.technical_issue.status = "in_progress"
    profile.status = "busy"
    notify_issue_status_change(assignment.technical_issue)
    db.session.commit()

    issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
    flash(f"{issue_label} marked as in progress.", "success")
    return redirect(url_for("technician.index"))


@technician_bp.route("/assignments/<int:assignment_id>/notes", methods=["POST"])
@role_required("field_assistant")
def save_notes(assignment_id):
    """Saves (or updates) resolution notes on an assignment without
    changing its status — phase_8.pdf technician item #8, kept as its
    own action so a technician can jot down findings while still
    'in_progress' rather than only at the very end. Valid from
    'accepted' or 'in_progress'; notes on a finished/cancelled
    assignment are locked (see complete_assignment, which is the other
    place notes get written/finalized)."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status not in ("accepted", "in_progress"):
        flash("Notes can only be saved on an assignment you've accepted or started.", "warning")
        return redirect(url_for("technician.index"))

    form = ResolutionNotesForm()
    if form.validate_on_submit():
        assignment.resolution_notes = form.resolution_notes.data.strip()
        db.session.commit()
        flash("Resolution notes saved.", "success")
    else:
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")

    return redirect(url_for("technician.index"))


@technician_bp.route("/assignments/<int:assignment_id>/complete", methods=["POST"])
@role_required("field_assistant")
def complete_assignment(assignment_id):
    """Marks an assignment (and its linked issue) resolved. Only valid
    from 'in_progress'. Requires resolution notes (phase_8.pdf's
    workflow lists 'Save resolution notes' as part of a technician's
    update to an issue) — if notes were already saved via save_notes()
    above, the field is pre-filled here and this just confirms them.
    Also increments the technician's resolved_issues_count, and — if
    this was their last open assignment — sets them back to
    'available'."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "in_progress":
        flash("That assignment isn't in progress yet, so it can't be marked complete.", "warning")
        return redirect(url_for("technician.index"))

    form = ResolutionNotesForm()
    if not form.validate_on_submit():
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")
        return redirect(url_for("technician.index"))

    assignment.resolution_notes = form.resolution_notes.data.strip()
    assignment.status = "completed"
    assignment.completed_at = datetime.utcnow()
    assignment.technical_issue.status = "resolved"
    profile.resolved_issues_count = (profile.resolved_issues_count or 0) + 1

    # Bug fix: report_fiber_break() (app/routes/issues.py) fans a single
    # NAP-wide outage out into one TechnicalIssue per still-connected
    # subscriber, but only the *first* affected subscriber's issue is
    # the one actually dispatched (see that function's docstring) --
    # assignment.technical_issue above is only ever that one row.
    # Without this, completing the job here only resolved that single
    # dispatched issue while every other connected subscriber's own
    # "shadow" issue stayed pending/critical forever, which is what
    # kept their GeoMap alert marker pulsing (and their subscriber pin
    # red) even though the fiber break was actually fixed. Mirrors the
    # same fix already applied to the mobile completion path
    # (complete_assignment() in app/routes/api_v1/technician.py).
    if (
        assignment.technical_issue.issue_type == "Fiber Break"
        and assignment.technical_issue.nap_id is not None
    ):
        siblings = TechnicalIssue.query.filter(
            TechnicalIssue.nap_id == assignment.technical_issue.nap_id,
            TechnicalIssue.issue_type == "Fiber Break",
            TechnicalIssue.id != assignment.technical_issue.id,
            TechnicalIssue.status != "resolved",
            TechnicalIssue.status != "closed",
        ).all()
        for sibling in siblings:
            sibling.status = "resolved"
            notify_issue_status_change(sibling)

    still_has_open_work = (
        Assignment.query.filter(
            Assignment.technician_id == profile.id,
            Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
            Assignment.id != assignment.id,
        ).count()
        > 0
    )
    if not still_has_open_work:
        profile.status = "available"

    notify_issue_status_change(assignment.technical_issue)
    db.session.commit()

    issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
    flash(f"{issue_label} marked complete. Nice work!", "success")
    return redirect(url_for("technician.index"))

