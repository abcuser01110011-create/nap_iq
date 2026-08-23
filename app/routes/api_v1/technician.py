"""
Mobile API — Technician Assignments (Phase 25)
--------------------------------------------------
The JSON counterpart to app/routes/technician.py, for the Technician
mobile app. Every status-transition rule, ownership check, and side
effect here (issue status mirroring, technician busy/available state,
notifications) is identical to that module — this file only changes
*how* the result is returned (JSON, not a rendered template + flash +
redirect) and *how* input arrives (a JSON body, not a WTForms
CSRF-protected `<form>` post — see app/__init__.py's csrf.exempt() for
why that's safe here).

Routes:
    GET  /api/v1/technician/assignments              -> list_assignments
                                                          (open workload)
    GET  /api/v1/technician/assignments/history       -> assignment_history
                                                          (completed/cancelled)
    POST /api/v1/technician/assignments/<id>/accept   -> accept_assignment
    POST /api/v1/technician/assignments/<id>/start    -> start_assignment
    POST /api/v1/technician/assignments/<id>/notes    -> save_notes
    POST /api/v1/technician/assignments/<id>/photo    -> upload_assignment_photo
    POST /api/v1/technician/assignments/<id>/complete -> complete_assignment
"""

import uuid
from datetime import datetime

import cloudinary
import cloudinary.uploader
from flask import Blueprint, jsonify, request
from flask_jwt_extended import current_user

from app.extensions import db
from app.jwt_auth import jwt_role_required
from app.models import Assignment, Technician
from app.notifications_utils import notify_issue_status_change

api_v1_technician_bp = Blueprint(
    "api_v1_technician", __name__, url_prefix="/api/v1/technician"
)

# Extensions accepted by upload_assignment_photo() below. Matches the
# formats expo-image-picker's camera/library pickers can hand back on
# both iOS (HEIC by default on newer devices) and Android.
ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png", "heic", "webp"}

# Kept identical to (and in sync with) app/routes/technician.py's own
# copies of these two tuples — see that module's comment for why.
CLOSED_ASSIGNMENT_STATUSES = ("completed", "cancelled")
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")


def _get_own_profile_or_404():
    """The JSON equivalent of technician.py's _get_own_profile_or_403:
    looks up the signed-in technician's own profile row. Returns 404
    (not 403) here — under the HTML flow a technician with no linked
    profile still sees the index page's empty state, but there's no
    page for the mobile app to fall back to, so a clear "no profile"
    error is more useful than a bare 403 would be."""
    profile = Technician.query.filter_by(user_id=current_user.id).first()
    if profile is None:
        return None
    return profile


def _get_own_assignment_or_404(profile, assignment_id):
    """The JSON equivalent of technician.py's _get_own_assignment_or_403.
    Returns None (caller turns this into a 404) rather than aborting
    directly, since the wrong assignment id and "not yours" should
    look identical to the caller either way — same reasoning
    technician.py's version already applies via abort(403) instead of
    abort(404) for a URL a technician could still type in, just
    adapted to this module's return-based error handling."""
    assignment = Assignment.query.get(assignment_id)
    if assignment is None or assignment.technician_id != profile.id:
        return None
    return assignment


def _serialize_assignment(assignment: Assignment) -> dict:
    """The fields the mobile app needs per assignment — including
    enough of the linked issue/subscriber/NAP to show a job card and
    drop a map pin without a second round-trip per assignment."""
    issue = assignment.technical_issue
    subscriber = issue.subscriber if issue else None
    nap = issue.nap if issue else None

    return {
        "id": assignment.id,
        "status": assignment.status,
        "assigned_at": assignment.assigned_at.isoformat() if assignment.assigned_at else None,
        "completed_at": assignment.completed_at.isoformat() if assignment.completed_at else None,
        "resolution_notes": assignment.resolution_notes,
        # assignment.photo_filename now stores the full Cloudinary
        # URL directly (set in upload_assignment_photo() above), so
        # this is just a passthrough — kept as its own field here
        # rather than renaming the column, to avoid an extra migration.
        "photo_url": assignment.photo_filename,
        "issue": {
            "id": issue.id,
            "issue_code": issue.issue_code,
            "issue_type": issue.issue_type,
            "description": issue.description,
            "priority": issue.priority,
            "status": issue.status,
            "address": issue.address,
            "latitude": float(issue.latitude) if issue.latitude is not None else None,
            "longitude": float(issue.longitude) if issue.longitude is not None else None,
        }
        if issue
        else None,
        "subscriber": {
            "id": subscriber.id,
            "subscriber_code": subscriber.subscriber_code,
            "full_name": subscriber.full_name,
            "address": subscriber.address,
            "contact_number": subscriber.contact_number,
            "latitude": float(subscriber.latitude) if subscriber.latitude is not None else None,
            "longitude": float(subscriber.longitude) if subscriber.longitude is not None else None,
        }
        if subscriber
        else None,
        "nap": {
            "id": nap.id,
            "nap_code": nap.nap_code,
            "name": nap.name,
            "latitude": float(nap.latitude) if nap.latitude is not None else None,
            "longitude": float(nap.longitude) if nap.longitude is not None else None,
        }
        if nap
        else None,
    }


@api_v1_technician_bp.route("/assignments", methods=["GET"])
@jwt_role_required("technician")
def list_assignments():
    """The signed-in technician's current (open) workload."""
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignments = (
        Assignment.query.filter(
            Assignment.technician_id == profile.id,
            Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES),
        )
        .order_by(Assignment.assigned_at.desc())
        .all()
    )
    return jsonify(assignments=[_serialize_assignment(a) for a in assignments]), 200


@api_v1_technician_bp.route("/assignments/history", methods=["GET"])
@jwt_role_required("technician")
def assignment_history():
    """The signed-in technician's past (completed/cancelled) assignments."""
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignments = (
        Assignment.query.filter(
            Assignment.technician_id == profile.id,
            Assignment.status.in_(CLOSED_ASSIGNMENT_STATUSES),
        )
        .order_by(Assignment.assigned_at.desc())
        .all()
    )
    return jsonify(assignments=[_serialize_assignment(a) for a in assignments]), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/accept", methods=["POST"])
@jwt_role_required("technician")
def accept_assignment(assignment_id):
    """assigned -> accepted. See technician.py's version for the same
    status-machine rule this mirrors."""
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.status != "assigned":
        return jsonify(error="That assignment isn't waiting to be accepted anymore."), 409

    assignment.status = "accepted"
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/start", methods=["POST"])
@jwt_role_required("technician")
def start_assignment(assignment_id):
    """accepted -> in_progress. Mirrors the status onto the linked
    issue and marks the technician 'busy', exactly as technician.py's
    start_assignment() does."""
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.status != "accepted":
        return jsonify(error="That assignment needs to be accepted before you can start work on it."), 409

    assignment.status = "in_progress"
    assignment.technical_issue.status = "in_progress"
    profile.status = "busy"
    notify_issue_status_change(assignment.technical_issue)
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/notes", methods=["POST"])
@jwt_role_required("technician")
def save_notes(assignment_id):
    """Saves/updates resolution notes without changing status. Valid
    from 'accepted' or 'in_progress' — same rule as technician.py's
    save_notes()."""
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.status not in ("accepted", "in_progress"):
        return jsonify(error="Notes can only be saved on an assignment you've accepted or started."), 409

    data = request.get_json(silent=True) or {}
    notes = str(data.get("resolution_notes") or "").strip()
    if not notes:
        return jsonify(error="resolution_notes is required."), 400

    assignment.resolution_notes = notes
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/photo", methods=["POST"])
@jwt_role_required("technician")
def upload_assignment_photo(assignment_id):
    """Uploads (or replaces) the required completion photo for an
    assignment. Valid from the same statuses as save_notes() —
    'accepted' or 'in_progress' — so a technician can attach it any
    time while actively working the job, not only in the instant
    before completing it. complete_assignment() below refuses to
    transition to 'completed' until this has been set at least once.

    Stored on Cloudinary rather than local disk — Vercel's serverless
    functions have a read-only filesystem, so there's nowhere on the
    server itself a file could persist between requests. Cloudinary's
    config (cloud name / API key / API secret) is picked up
    automatically from the CLOUDINARY_* environment variables, no
    explicit cloudinary.config() call needed.

    Expects multipart/form-data with a single "photo" file field —
    unlike every other route in this module, not a JSON body, since
    this blueprint is already csrf-exempt as a whole (see this
    module's docstring) so that isn't a concern here either.
    """
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.status not in ("accepted", "in_progress"):
        return jsonify(error="A photo can only be added to an assignment you've accepted or started."), 409

    photo = request.files.get("photo")
    if photo is None or photo.filename == "":
        return jsonify(error="No photo file was included in the request."), 400

    ext = photo.filename.rsplit(".", 1)[-1].lower() if "." in photo.filename else ""
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        return jsonify(error="Unsupported photo format. Use JPG, PNG, HEIC, or WEBP."), 400

    # public_id (not the original filename) is what Cloudinary keys
    # the asset on — a random one avoids collisions the same way the
    # old local-disk filename did.
    public_id = f"assignment-photos/assignment-{assignment.id}-{uuid.uuid4().hex}"

    try:
        upload_result = cloudinary.uploader.upload(photo, public_id=public_id, overwrite=True)
    except Exception:
        return jsonify(error="Photo upload failed. Please try again."), 502

    # The old image (if this is a replacement, e.g. the tech retakes
    # the photo) is only removed after the new one uploads
    # successfully and the DB commit succeeds — so a failed upload
    # never leaves the assignment pointing at an image that's gone.
    old_photo_url = assignment.photo_filename
    assignment.photo_filename = upload_result["secure_url"]
    db.session.commit()

    if old_photo_url:
        try:
            # Recover the public_id we originally uploaded under from
            # the stored URL, so the old image can be cleaned up too —
            # best-effort only, a failure here doesn't affect the
            # response since the new photo is already saved.
            old_public_id = old_photo_url.split("/upload/")[1].rsplit(".", 1)[0]
            old_public_id = "/".join(old_public_id.split("/")[1:])  # drop the version segment
            cloudinary.uploader.destroy(old_public_id)
        except Exception:
            pass

    return jsonify(assignment=_serialize_assignment(assignment)), 200
@api_v1_technician_bp.route("/assignments/<int:assignment_id>/complete", methods=["POST"])
@jwt_role_required("technician")
def complete_assignment(assignment_id):
    """in_progress -> completed (issue -> resolved). Requires
    resolution notes, exactly as technician.py's complete_assignment()
    does — accepts a fresh `resolution_notes` value in the body, or
    falls back to whatever was already saved via save_notes() above if
    the body omits it."""
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.status != "in_progress":
        return jsonify(error="That assignment isn't in progress yet, so it can't be marked complete."), 409

    if not assignment.photo_filename:
        return jsonify(error="A completion photo is required before this assignment can be marked complete."), 400

    data = request.get_json(silent=True) or {}
    notes = str(data.get("resolution_notes") or assignment.resolution_notes or "").strip()
    if not notes:
        return jsonify(error="resolution_notes is required to complete an assignment."), 400

    assignment.resolution_notes = notes
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

    return jsonify(assignment=_serialize_assignment(assignment)), 200
