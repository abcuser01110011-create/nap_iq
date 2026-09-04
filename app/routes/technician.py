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
    GET  /technician/tickets/<id>                    -> ticket_detail
                                                        (full details + actions for one assignment,
                                                        linked to from each card on index)
    GET  /technician/history                        -> history
                                                        (past assignments: completed/cancelled)
    POST /technician/assignments/<id>/accept        -> accept_assignment
                                                        (assigned -> accepted)
    POST /technician/assignments/<id>/start          -> start_assignment
                                                        (accepted -> in_progress;
                                                        issue -> in_progress)
    POST /technician/assignments/<id>/notes          -> save_notes
                                                        (resolution_notes only, no status change)
    POST /technician/assignments/<id>/photo          -> upload_photo
                                                        (required completion photo, uploaded to
                                                        Cloudinary; valid from 'accepted' or
                                                        'in_progress')
    POST /technician/assignments/<id>/complete       -> complete_assignment
                                                        (in_progress -> completed;
                                                        issue -> resolved;
                                                        resolution_notes and a completion photo
                                                        are both required)

Web version of the mobile app (UI only)
----------------------------------------
mobile_jobs() / mobile_history() / mobile_profile() / mobile_job_detail()
below are a from-scratch web equivalent of the field-assistant React
Native app's own screens (mobile/apps/app/src/screens/technician/*.tsx)
-- same dark navy theme, same card layouts, same bottom tab bar (Jobs /
History / Profile) -- so a technician sees a near-identical experience
opening this in a browser instead of the phone app. Read-only for now:
they reuse the exact same queries as index()/history() above (no new
business logic), and the action buttons (Accept/Start/Complete, notes
editing, photo upload, GPS pin, NAP linking) are rendered but disabled
placeholders -- wiring those up to actually mutate an assignment is a
deliberate follow-up, not done here.

Routes:
    GET  /technician/mobile                         -> mobile_jobs
    GET  /technician/mobile/history                 -> mobile_history
    GET  /technician/mobile/profile                 -> mobile_profile
    GET  /technician/mobile/jobs/<assignment_id>     -> mobile_job_detail
"""

import uuid
from datetime import datetime

import cloudinary
import cloudinary.uploader
from flask import Blueprint, render_template, redirect, url_for, flash, abort, g, request

from app.extensions import db
from app.auth import role_required
from app.models import Technician, Assignment
from app.forms import ResolutionNotesForm
from app.notifications_utils import notify_issue_status_change

# Mirrors app/routes/api_v1/technician.py's ALLOWED_PHOTO_EXTENSIONS exactly
# -- same completion-photo requirement, just reachable from the desktop
# web UI instead of the mobile app's JSON API.
ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png", "heic", "webp"}

# Mirrors mobile/apps/app/src/screens/technician/statusLabels.ts exactly
# -- both the web and mobile UI should read the same everywhere.
STATUS_LABELS = {
    "assigned": "Assigned",
    "accepted": "Accepted",
    "in_progress": "In progress",
    "completed": "Completed",
    "cancelled": "Cancelled",
}

REQUEST_TYPE_LABELS = {
    "new_installation": "New installation",
    "disconnection": "Disconnection",
    "relocation": "Relocation",
    "upgrade": "Upgrade",
    "add_nap": "Nap Installation",
}

JOB_TYPE_LABELS = {
    "repair": "Repair",
    "installation": "Installation",
}

PRIORITY_LABELS = {
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "critical": "Urgent",
}

# Same default home-service-area fallback as the mobile app's
# AssignmentsScreen.DEFAULT_ADDRESS.
DEFAULT_ADDRESS = "Sta. Cruz, Laguna"

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
@role_required("technician")
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

    jobs = [_serialize_job(a) for a in assignments]

    return render_template(
        "technician/index.html",
        profile=profile,
        jobs=jobs,
        notes_form=ResolutionNotesForm(),
    )


@technician_bp.route("/history")
@role_required("technician")
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


@technician_bp.route("/tickets/<int:assignment_id>")
@role_required("technician")
def ticket_detail(assignment_id):
    """Full detail page for a single assignment, linked to from each
    card on the 'My Work' list (technician/index.html). Uses the same
    `_serialize_job()` view-model as the mobile-style pages below so
    the ticket code / type / address / priority labels always agree,
    but — unlike mobile_job_detail() — this is the real thing: the
    Accept/Start/Notes/Complete actions here are fully wired up (the
    same actions that used to live inline on each card in the list).
    """
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    return render_template(
        "technician/ticket_detail.html",
        profile=profile,
        job=_serialize_job(assignment),
        notes_form=ResolutionNotesForm(),
    )


@technician_bp.route("/assignments/<int:assignment_id>/accept", methods=["POST"])
@role_required("technician")
def accept_assignment(assignment_id):
    """Acknowledges a newly dispatched assignment. Only valid from
    'assigned' — this is the technician's first action on it, before
    any work has actually started."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "assigned":
        flash("That assignment isn't waiting to be accepted anymore.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    assignment.status = "accepted"
    db.session.commit()

    issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
    flash(f"Assignment for {issue_label} accepted.", "success")
    return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))


@technician_bp.route("/assignments/<int:assignment_id>/start", methods=["POST"])
@role_required("technician")
def start_assignment(assignment_id):
    """Marks work as actually underway. Only valid from 'accepted'.
    Mirrors the status onto the linked technical_issue (so it shows as
    'in_progress' everywhere else in the app — the dashboard, the
    issue detail page, etc.) and marks the technician 'busy'."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "accepted":
        flash("That assignment needs to be accepted before you can start work on it.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    assignment.status = "in_progress"
    assignment.technical_issue.status = "in_progress"
    profile.status = "busy"
    notify_issue_status_change(assignment.technical_issue)
    db.session.commit()

    issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
    flash(f"{issue_label} marked as in progress.", "success")
    return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))


@technician_bp.route("/assignments/<int:assignment_id>/notes", methods=["POST"])
@role_required("technician")
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
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    form = ResolutionNotesForm()
    if form.validate_on_submit():
        assignment.resolution_notes = form.resolution_notes.data.strip()
        db.session.commit()
        flash("Resolution notes saved.", "success")
    else:
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")

    return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))


@technician_bp.route("/assignments/<int:assignment_id>/complete", methods=["POST"])
@role_required("technician")
def complete_assignment(assignment_id):
    """Marks an assignment (and its linked issue) resolved. Only valid
    from 'in_progress'. Requires resolution notes (phase_8.pdf's
    workflow lists 'Save resolution notes' as part of a technician's
    update to an issue) — if notes were already saved via save_notes()
    above, the field is pre-filled here and this just confirms them.
    Also requires a completion photo (uploaded separately via
    upload_photo() below) to already be attached — mirrors the same
    rule app/routes/api_v1/technician.py's complete_assignment()
    enforces for the mobile app, now on the desktop web UI too.
    Also increments the technician's resolved_issues_count, and — if
    this was their last open assignment — sets them back to
    'available'."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "in_progress":
        flash("That assignment isn't in progress yet, so it can't be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    if not assignment.photo_filename:
        flash("A completion photo is required before this assignment can be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    form = ResolutionNotesForm()
    if not form.validate_on_submit():
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    assignment.resolution_notes = form.resolution_notes.data.strip()
    assignment.status = "completed"
    assignment.completed_at = datetime.utcnow()
    assignment.technical_issue.status = "resolved"
    profile.resolved_issues_count = (profile.resolved_issues_count or 0) + 1

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


@technician_bp.route("/assignments/<int:assignment_id>/photo", methods=["POST"])
@role_required("technician")
def upload_photo(assignment_id):
    """Uploads (or replaces) the required completion photo for an
    assignment from the desktop web UI. Mirrors
    app/routes/api_v1/technician.py's upload_assignment_photo() —
    same allowed statuses ('accepted' or 'in_progress'), same
    Cloudinary storage (its config is picked up automatically from the
    CLOUDINARY_* environment variables), same best-effort cleanup of
    the old image on a replacement — just reached via a regular
    CSRF-protected form post instead of the mobile app's JSON API."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status not in ("accepted", "in_progress"):
        flash("A photo can only be added to an assignment you've accepted or started.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    photo = request.files.get("photo")
    if photo is None or photo.filename == "":
        flash("Choose a photo file to upload first.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    ext = photo.filename.rsplit(".", 1)[-1].lower() if "." in photo.filename else ""
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        flash("Unsupported photo format. Use JPG, PNG, HEIC, or WEBP.", "danger")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    public_id = f"assignment-photos/assignment-{assignment.id}-{uuid.uuid4().hex}"

    try:
        upload_result = cloudinary.uploader.upload(photo, public_id=public_id, overwrite=True)
    except Exception:
        flash("Photo upload failed. Please try again.", "danger")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    # The old image (if this is a replacement, e.g. the tech retakes
    # the photo) is only removed after the new one uploads
    # successfully and the DB commit succeeds — so a failed upload
    # never leaves the assignment pointing at an image that's gone.
    old_photo_url = assignment.photo_filename
    assignment.photo_filename = upload_result["secure_url"]
    db.session.commit()

    if old_photo_url:
        try:
            old_public_id = old_photo_url.split("/upload/")[1].rsplit(".", 1)[0]
            old_public_id = "/".join(old_public_id.split("/")[1:])  # drop the version segment
            cloudinary.uploader.destroy(old_public_id)
        except Exception:
            pass

    flash("Completion photo uploaded.", "success")
    return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))


# ------------------------------------------------------------------ #
# Web version of the mobile app (UI only) -- see module docstring     #
# ------------------------------------------------------------------ #

def _job_source(assignment):
    """Returns whichever of (technical_issue, service_request) this
    assignment actually links to (see Assignment's own docstring:
    exactly one of the two is ever set)."""
    return assignment.technical_issue, assignment.service_request


def _ticket_code(assignment):
    """Mirrors statusLabels.ts's ticketCode() exactly: 'TN 00006' for a
    repair, 'SO 00001' for an installation, zero-padded to 5 digits."""
    issue, request = _job_source(assignment)
    if issue:
        return f"TN {issue.id:05d}"
    if request:
        return f"SO {request.id:05d}"
    return f"Job #{assignment.id}"


def _serialize_job(assignment):
    """Builds the flat, template-friendly view of an Assignment that
    every mobile_* screen below renders from -- one place computing
    ticket code / type label / address / priority / etc. so the Jobs
    list, History list, and Job Detail screens all agree with each
    other (and with the mobile app's own statusLabels.ts helpers)."""
    issue, request = _job_source(assignment)
    is_installation = assignment.service_request_id is not None
    is_new_installation = is_installation and request and request.request_type == "new_installation"

    subscriber = issue.subscriber if issue else (request.subscriber if request else None)

    if issue:
        type_label = issue.issue_type
    elif request:
        type_label = REQUEST_TYPE_LABELS.get(request.request_type, request.request_type)
    else:
        type_label = JOB_TYPE_LABELS.get("installation" if is_installation else "repair")

    if subscriber and subscriber.address:
        address = subscriber.address
    elif issue and issue.address:
        address = issue.address
    elif request and request.address:
        address = request.address
    else:
        address = DEFAULT_ADDRESS

    priority = (issue.priority if issue else None) or (request.priority if request else None)

    lat = (subscriber.latitude if subscriber else None) or (issue.latitude if issue else None) or (request.latitude if request else None)
    lng = (subscriber.longitude if subscriber else None) or (issue.longitude if issue else None) or (request.longitude if request else None)

    can_accept = assignment.status == "assigned"
    can_start = assignment.status == "accepted"
    can_edit = assignment.status in ("accepted", "in_progress")
    can_complete = assignment.status == "in_progress"
    is_closed = assignment.status in CLOSED_ASSIGNMENT_STATUSES

    return {
        "assignment": assignment,
        "ticket_code": _ticket_code(assignment),
        "status_label": STATUS_LABELS.get(assignment.status, assignment.status),
        "type_label": type_label,
        "address": address,
        "priority": priority,
        "priority_label": PRIORITY_LABELS.get(priority, priority),
        "subscriber_label": "NAP" if (request and request.request_type == "add_nap") else "Subscriber",
        "subscriber_name": (
            f"{subscriber.subscriber_code} — {subscriber.full_name}" if subscriber
            else (request.full_name if request else None)
        ),
        "plan_label": request.plan_label if request else None,
        "contact_number": subscriber.contact_number if subscriber else (request.contact_number if request else None),
        "port_number": assignment.port_number,
        "description": issue.description if issue else (request.notes if request else None),
        "nap_label": f"{assignment.technical_issue.nap.nap_code} — {assignment.technical_issue.nap.name}" if (issue and issue.nap) else None,
        "lat": lat,
        "lng": lng,
        "is_installation": is_installation,
        "is_new_installation": is_new_installation,
        "can_accept": can_accept,
        "can_start": can_start,
        "can_edit": can_edit,
        "can_complete": can_complete,
        "is_closed": is_closed,
        "show_photo_card": can_edit or is_closed or bool(assignment.photo_filename),
    }


@technician_bp.route("/mobile")
@role_required("technician")
def mobile_jobs():
    """Web equivalent of the mobile app's Jobs (Assignments) tab --
    same open-assignments query as index() above, sorted the same way
    (critical first, ties keeping most-recent-first order)."""
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

    priority_rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
    jobs = sorted(
        (_serialize_job(a) for a in assignments),
        key=lambda job: priority_rank.get(job["priority"], 0),
        reverse=True,
    )

    return render_template(
        "technician_mobile/jobs.html",
        profile=profile,
        jobs=jobs,
        active_tab="jobs",
    )


@technician_bp.route("/mobile/history")
@role_required("technician")
def mobile_history():
    """Web equivalent of the mobile app's History tab -- same closed-
    assignments query as history() above."""
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

    jobs = [_serialize_job(a) for a in assignments]

    return render_template(
        "technician_mobile/history.html",
        profile=profile,
        jobs=jobs,
        active_tab="history",
    )


@technician_bp.route("/mobile/profile")
@role_required("technician")
def mobile_profile():
    """Web equivalent of the mobile app's Profile tab. Unlike the
    mobile app, there's no offline sync queue to report here (that's a
    mobile-only concern -- see OfflineContext.tsx), so this shows
    account + work-status info only."""
    profile = Technician.query.filter_by(user_id=g.user.id).first()
    return render_template(
        "technician_mobile/profile.html",
        profile=profile,
        active_tab="profile",
    )


@technician_bp.route("/mobile/jobs/<int:assignment_id>")
@role_required("technician")
def mobile_job_detail(assignment_id):
    """Web equivalent of the mobile app's Job Detail screen. Read-only
    for now -- see this module's docstring for what's intentionally
    not wired up yet (accept/start/complete, notes, photo, GPS pin,
    NAP linking)."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    return render_template(
        "technician_mobile/job_detail.html",
        job=_serialize_job(assignment),
        hide_tabbar=True,
    )

