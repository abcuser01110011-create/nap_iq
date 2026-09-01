"""
Mobile API — Technician Assignments (Phase 25; extended Phase 28)
--------------------------------------------------
The JSON counterpart to app/routes/technician.py, for the Technician
mobile app. Every status-transition rule, ownership check, and side
effect here (issue status mirroring, technician busy/available state,
notifications) is identical to that module — this file only changes
*how* the result is returned (JSON, not a rendered template + flash +
redirect) and *how* input arrives (a JSON body, not a WTForms
CSRF-protected `<form>` post — see app/__init__.py's csrf.exempt() for
why that's safe here).

Phase 28 (installation dispatch): app/routes/dispatch.py's
assign_request()/reassign_request() can now route an Assignment at a
`service_request` (installation) instead of a `technical_issue`
(repair) — see Assignment's docstring in app/models.py. Every route
below has to work for either source, since the mobile app's
accept -> start -> complete flow is the same one screen either way
(the roadmap's "reusing the same accept -> in-progress -> complete
flow already built for repairs" — no separate install-only endpoints).
Two things differ by source rather than being unified:
  - `service_requests.status` has no 'in_progress' value (see that
    enum in database/schema.sql) the way `technical_issues.status`
    does, so start_assignment() only mirrors status onto the linked
    record for a repair; an install's ServiceRequest simply stays
    'scheduled' while its Assignment moves through accepted ->
    in_progress, same as it already was the moment dispatch happened.
  - An install additionally requires a customer signature (not just
    the completion photo every job requires) before it can be marked
    complete — see upload_assignment_signature() and
    complete_assignment() below.
Phase 29 (auto-activation): `complete_assignment()` below now also
flips the linked Subscriber to 'active' (with today's `installed_at`)
and the ServiceRequest to 'completed' the moment an install
Assignment's own status reaches 'completed' — the hook this module's
Phase 28 docstring above flagged as deliberately out of scope at the
time. It lives here rather than in a separate handler because
`Assignment.status == 'completed'` (set two lines above the hook) is
itself the trigger the roadmap names, and this is the one place that
transition happens for an install job.

Routes:
    GET  /api/v1/technician/assignments                 -> list_assignments
                                                             (open workload)
    GET  /api/v1/technician/assignments/history          -> assignment_history
                                                             (completed/cancelled)
    POST /api/v1/technician/assignments/<id>/accept      -> accept_assignment
    POST /api/v1/technician/assignments/<id>/start       -> start_assignment
    POST /api/v1/technician/assignments/<id>/notes       -> save_notes
    POST /api/v1/technician/assignments/<id>/photo       -> upload_assignment_photo
    POST /api/v1/technician/assignments/<id>/signature   -> upload_assignment_signature
                                                             (Phase 28, install-only, kept
                                                             but no longer required -- see
                                                             pin-location below)
    POST /api/v1/technician/assignments/<id>/pin-location -> pin_assignment_location
                                                             (install-only; replaces the
                                                             signature requirement)
    POST /api/v1/technician/assignments/<id>/complete    -> complete_assignment
"""

import uuid
from datetime import date, datetime
from io import BytesIO

import cloudinary
import cloudinary.uploader
from flask import Blueprint, jsonify, request
from flask_jwt_extended import current_user
from PIL import Image, ImageOps

try:
    # Registers a Pillow opener for .heic/.heif — the default camera
    # format on many iPhones — which Pillow can't decode on its own.
    # Import is optional/best-effort: if the dependency isn't
    # installed for some reason, HEIC signature photos just skip the
    # scan-cleanup step below (see _scan_signature_image) rather than
    # breaking signature upload entirely.
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover - exercised only if the dep is missing
    pass

from app.extensions import db
from app.jwt_auth import jwt_role_required
from app.models import Assignment, Nap, Technician
from app.nap_recommendation import recommend_naps
from app.nap_status import slot_usage, sync_nap_status
from app.notifications_utils import notify, notify_issue_status_change

api_v1_technician_bp = Blueprint(
    "api_v1_technician", __name__, url_prefix="/api/v1/technician"
)

# Extensions accepted by upload_assignment_photo() and
# upload_assignment_signature() below. Matches the formats
# expo-image-picker's camera/library pickers can hand back on both
# iOS (HEIC by default on newer devices) and Android — the signature
# is captured through the same camera/library picker as the
# completion photo (see upload_assignment_signature()'s docstring for
# why), so it accepts the same set.
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


def _assignment_nap(assignment: Assignment):
    """The NAP an assignment's issue/service_request is linked to (or
    None), shared by _serialize_assignment() below and
    _validate_port_number()'s range check so both stay in sync."""
    issue = assignment.technical_issue
    service_request = assignment.service_request
    return issue.nap if issue else (service_request.requested_nap if service_request else None)


def _validate_port_number(assignment: Assignment, data: dict):
    """Parses an optional `port_number` field against the range of the
    assignment's linked NAP (1..nap.total_ports) for the mobile Job
    Detail screen's port dropdown. Mirrors resolution_notes' "blank
    clears it" behavior, but a missing key leaves whatever was
    previously saved untouched (so e.g. a save_notes() call that only
    updates notes doesn't accidentally wipe an already-chosen port).

    Returns (value_to_save, error) — error is an (message, http_status)
    tuple to short-circuit the caller with, or None on success.
    """
    if "port_number" not in data:
        return assignment.port_number, None

    raw = data.get("port_number")
    if raw is None or str(raw).strip() == "":
        return None, None

    try:
        port_number = int(raw)
    except (TypeError, ValueError):
        return None, ("port_number must be a whole number.", 400)

    nap = _assignment_nap(assignment)
    if nap is None:
        return None, ("This assignment has no NAP linked, so a port number can't be set.", 400)

    if port_number < 1 or port_number > nap.total_ports:
        return None, (f"port_number must be between 1 and {nap.total_ports}.", 400)

    return port_number, None


def _serialize_assignment(assignment: Assignment) -> dict:
    """The fields the mobile app needs per assignment — including
    enough of the linked issue-or-request/subscriber/NAP to show a
    job card and drop a map pin without a second round-trip per
    assignment.

    Phase 28: exactly one of `assignment.technical_issue` /
    `assignment.service_request` is ever set (see Assignment's
    docstring in app/models.py) — `job_type` tells the mobile app
    which, so it doesn't have to infer it from which of `issue` /
    `service_request` is non-null. `subscriber` is populated from
    whichever source is set (a service_request's own `.subscriber`
    relationship — the same Subscriber row Phase 26 created at
    registration — for an install; the issue's `.subscriber` for a
    repair, unchanged) so the mobile app's existing subscriber-card UI
    needs no branching at all — only the job-detail-specific fields
    (`issue` vs `service_request`) differ by type.
    """
    issue = assignment.technical_issue
    service_request = assignment.service_request
    subscriber = issue.subscriber if issue else (service_request.subscriber if service_request else None)
    nap = _assignment_nap(assignment)

    return {
        "id": assignment.id,
        "status": assignment.status,
        # Phase 28: "repair" for a technical_issue-sourced row,
        # "installation" for a service_request-sourced one — lets the
        # mobile app group/label jobs without inspecting which of
        # `issue`/`service_request` is non-null itself.
        "job_type": "repair" if issue is not None else "installation",
        "assigned_at": assignment.assigned_at.isoformat() if assignment.assigned_at else None,
        "completed_at": assignment.completed_at.isoformat() if assignment.completed_at else None,
        # The port chosen from the mobile Job Detail screen's dropdown
        # (1..nap.total_ports below) — see _validate_port_number().
        "port_number": assignment.port_number,
        "resolution_notes": assignment.resolution_notes,
        # assignment.photo_filename now stores the full Cloudinary
        # URL directly (set in upload_assignment_photo() above), so
        # this is just a passthrough — kept as its own field here
        # rather than renaming the column, to avoid an extra migration.
        "photo_url": assignment.photo_filename,
        # Phase 28: same passthrough pattern as photo_url above — only
        # ever non-null for an installation (see
        # upload_assignment_signature()'s docstring below). No longer
        # required for completion (superseded by pin_latitude /
        # pin_longitude below) but still returned for any
        # already-recorded sign-offs.
        "signature_url": assignment.signature_filename,
        # The technician's on-site GPS fix for an installation,
        # captured via pin_assignment_location() below — the
        # replacement for the customer-signature requirement above.
        # Only ever non-null for an installation.
        "pin_latitude": float(assignment.pin_latitude) if assignment.pin_latitude is not None else None,
        "pin_longitude": float(assignment.pin_longitude) if assignment.pin_longitude is not None else None,
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
        # Phase 28: the installation counterpart to `issue` above.
        # `full_name`/`address`/`contact_number` are the walk-in
        # applicant fields (see ServiceRequest in app/models.py) --
        # only ever populated for a Service Order with no linked
        # Subscriber (the GeoMap "+ Tickets" quick-create modal's
        # Customer field is free text, not matched against
        # `subscribers`). Passed through here so the mobile app can
        # fall back to them when `subscriber` below is null, same
        # "prefer the real linked record, fall back to the request's
        # own copy" pattern as latitude/longitude above.
        "service_request": {
            "id": service_request.id,
            "request_type": service_request.request_type,
            "status": service_request.status,
            "priority": service_request.priority,
            "notes": service_request.notes,
            "latitude": float(service_request.latitude) if service_request.latitude is not None else None,
            "longitude": float(service_request.longitude) if service_request.longitude is not None else None,
            "full_name": service_request.full_name,
            "address": service_request.address,
            "contact_number": service_request.contact_number,
        }
        if service_request
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
            # Drives the mobile Job Detail screen's port dropdown —
            # options 1..total_ports.
            "total_ports": nap.total_ports,
        }
        if nap
        else None,
    }


@api_v1_technician_bp.route("/assignments", methods=["GET"])
@jwt_role_required("field_assistant")
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
@jwt_role_required("field_assistant")
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
@jwt_role_required("field_assistant")
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
@jwt_role_required("field_assistant")
def start_assignment(assignment_id):
    """accepted -> in_progress. Marks the technician 'busy' either
    way; mirrors the status onto the linked issue only for a repair,
    exactly as technician.py's start_assignment() does.

    Phase 28: an installation's linked service_request has no
    'in_progress' value in its own status enum (see that enum in
    database/schema.sql) — it's already 'scheduled' from the moment
    dispatch.py's assign_request() ran, and stays 'scheduled' right
    through the technician accepting and starting work, only moving
    again once Phase 29's completion hook lands. So for an
    installation this only flips the Assignment's own status (already
    done below, unconditionally) and the technician's busy state —
    there's no linked-record status to mirror and nothing new to
    notify the customer about, unlike the repair path.
    """
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.status != "accepted":
        return jsonify(error="That assignment needs to be accepted before you can start work on it."), 409

    assignment.status = "in_progress"
    if assignment.technical_issue is not None:
        assignment.technical_issue.status = "in_progress"
        notify_issue_status_change(assignment.technical_issue)
    profile.status = "busy"
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/notes", methods=["POST"])
@jwt_role_required("field_assistant")
def save_notes(assignment_id):
    """Saves/updates resolution notes (and, optionally, the serviced
    port_number — see _validate_port_number()) without changing
    status. Valid from 'accepted' or 'in_progress' — same rule as
    technician.py's save_notes()."""
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

    port_number, error = _validate_port_number(assignment, data)
    if error:
        message, status = error
        return jsonify(error=message), status

    assignment.resolution_notes = notes or None
    assignment.port_number = port_number
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/photo", methods=["POST"])
@jwt_role_required("field_assistant")
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


def _scan_signature_image(file_storage):
    """Turns a phone photo of a paper signature into a clean cutout:
    solid black ink on a transparent background, cropped tight to the
    ink itself — the same shape a "scan document" feature or a
    signature-stamp tool produces, so the result looks like a proper
    digital signature rather than a photo of a piece of paper.

    Steps: undo whatever EXIF rotation the phone recorded (a raw
    upload can otherwise come out sideways) -> grayscale ->
    autocontrast (spreads out whatever range of grays the photo
    actually used, so lighting/shadow differences between photos
    don't change how dark "ink" has to be to register) -> threshold
    into pure ink/background -> crop to the ink's bounding box (with a
    small margin) -> ink pixels painted solid black, everything else
    made fully transparent.

    Returns a BytesIO of a PNG (transparency needs PNG; JPEG has no
    alpha channel) ready to hand to cloudinary.uploader.upload(), or
    None if the photo couldn't be processed for any reason (unreadable
    format despite passing the extension check, corrupted upload, or
    a photo with no ink dark enough to detect at all — e.g. a blank
    page). None is a deliberate "processing didn't happen" signal, not
    an error: the caller falls back to uploading the original photo
    unprocessed rather than blocking a technician's job over a photo
    this cleanup step merely couldn't improve.
    """
    try:
        image = Image.open(file_storage.stream)
        image = ImageOps.exif_transpose(image)  # undo phone rotation
        gray = image.convert("L")
        gray = ImageOps.autocontrast(gray, cutoff=1)

        # Threshold: this pixel value split was tuned against ordinary
        # ballpoint-pen-on-white-paper photos, not against very light
        # pencil or heavily shadowed photos — see this function's
        # docstring for why a bad result here just falls back to the
        # original photo rather than failing the upload.
        THRESHOLD = 140
        ink_mask = gray.point(lambda p: 255 if p < THRESHOLD else 0)

        bbox = ink_mask.getbbox()
        if bbox is None:
            # No pixel was dark enough to count as ink at all.
            return None

        margin = 12
        left, top, right, bottom = bbox
        left = max(left - margin, 0)
        top = max(top - margin, 0)
        right = min(right + margin, ink_mask.width)
        bottom = min(bottom + margin, ink_mask.height)
        ink_mask = ink_mask.crop((left, top, right, bottom))

        # Solid black ink, everything else fully transparent — the
        # mask itself becomes the alpha channel.
        black_ink = Image.new("RGBA", ink_mask.size, (0, 0, 0, 0))
        black_ink.putalpha(ink_mask)

        output = BytesIO()
        black_ink.save(output, format="PNG")
        output.seek(0)
        return output
    except Exception:
        return None


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/signature", methods=["POST"])
@jwt_role_required("field_assistant")
def upload_assignment_signature(assignment_id):
    """Phase 28: uploads (or replaces) the customer's sign-off for an
    *installation* assignment — the install-only counterpart to
    upload_assignment_photo() above, required by complete_assignment()
    below the same way that route already requires a photo. A repair
    (technical_issue-sourced) assignment has no signature step at all
    (see Assignment.signature_filename's comment in app/models.py), so
    this rejects with 409 rather than silently accepting one.

    Captured through the same camera/library picker as the completion
    photo — reusing expo-image-picker rather than adding a dedicated
    signature-canvas library, matching this codebase's own "same
    pattern, new column" approach to this phase (see the roadmap's
    Phase 28 section). In practice this is a photo of a signed
    printout, not a signature drawn live on the device — deliberately,
    since it's a much lower-friction ask for a non-technical
    subscriber than handing them the technician's phone to draw on. A
    proper signature-pad widget for subscribers who'd prefer that
    remains a reasonable future enhancement, but isn't required by
    anything currently in scope for this phase.

    Before upload, `_scan_signature_image()` above turns that raw
    photo into a clean cutout — solid black ink on a transparent
    background, tightly cropped — so the stored result looks like an
    actual digital signature rather than a photo of a piece of paper.
    If that processing fails for any reason (see that function's
    docstring for when), this falls back to uploading the original,
    unprocessed photo rather than blocking the technician's job over a
    photo the cleanup step merely couldn't improve.

    Same statuses valid as upload_assignment_photo() — 'accepted' or
    'in_progress' — and stored on Cloudinary for the same
    read-only-filesystem reason described on that route.
    """
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.service_request_id is None:
        return jsonify(error="A signature only applies to an installation assignment."), 409

    if assignment.status not in ("accepted", "in_progress"):
        return jsonify(error="A signature can only be added to an assignment you've accepted or started."), 409

    signature = request.files.get("signature")
    if signature is None or signature.filename == "":
        return jsonify(error="No signature file was included in the request."), 400

    ext = signature.filename.rsplit(".", 1)[-1].lower() if "." in signature.filename else ""
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        return jsonify(error="Unsupported image format. Use JPG, PNG, HEIC, or WEBP."), 400

    public_id = f"assignment-signatures/assignment-{assignment.id}-{uuid.uuid4().hex}"

    # Scan-cleanup happens before upload: whatever _scan_signature_image()
    # returns (a processed PNG, or None if it couldn't process this
    # particular photo) decides what actually gets sent to Cloudinary.
    processed = _scan_signature_image(signature)
    upload_target = processed if processed is not None else signature
    upload_kwargs = {"public_id": public_id, "overwrite": True}
    if processed is not None:
        # Tell Cloudinary explicitly rather than relying on filename
        # sniffing — `processed` is a bare BytesIO, not a FileStorage
        # with a real filename/content-type attached.
        upload_kwargs["format"] = "png"

    try:
        upload_result = cloudinary.uploader.upload(upload_target, **upload_kwargs)
    except Exception:
        return jsonify(error="Signature upload failed. Please try again."), 502

    # Same "only clean up the old asset after the new one is safely
    # saved" ordering as upload_assignment_photo() above.
    old_signature_url = assignment.signature_filename
    assignment.signature_filename = upload_result["secure_url"]
    db.session.commit()

    if old_signature_url:
        try:
            old_public_id = old_signature_url.split("/upload/")[1].rsplit(".", 1)[0]
            old_public_id = "/".join(old_public_id.split("/")[1:])
            cloudinary.uploader.destroy(old_public_id)
        except Exception:
            pass

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/pin-location", methods=["POST"])
@jwt_role_required("field_assistant")
def pin_assignment_location(assignment_id):
    """Records the technician's own on-site GPS fix for an
    *installation* assignment — the replacement for the old customer
    e-signature requirement (see upload_assignment_signature() above,
    kept but no longer required). Required by complete_assignment()
    below the same way a signature used to be. A repair
    (technical_issue-sourced) assignment has no pin-location step at
    all, so this rejects with 409 rather than silently accepting one.

    Mirrors the customer mobile app's "Track My Location" step on
    ApplyForServiceScreen: a plain device GPS fix, taken with
    expo-location and posted here as JSON (no image involved, so no
    Cloudinary round-trip like the photo/signature endpoints above).
    Same statuses valid as those routes -- 'accepted' or
    'in_progress'.
    """
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.service_request_id is None:
        return jsonify(error="A pinned location only applies to an installation assignment."), 409

    if assignment.status not in ("accepted", "in_progress"):
        return jsonify(error="A location can only be pinned on an assignment you've accepted or started."), 409

    data = request.get_json(silent=True) or {}
    latitude = data.get("latitude")
    longitude = data.get("longitude")
    if latitude is None or longitude is None:
        return jsonify(error="latitude and longitude are required."), 400

    try:
        latitude = float(latitude)
        longitude = float(longitude)
    except (TypeError, ValueError):
        return jsonify(error="latitude and longitude must be numbers."), 400

    if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        return jsonify(error="latitude/longitude are out of range."), 400

    assignment.pin_latitude = latitude
    assignment.pin_longitude = longitude
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/nearby-naps", methods=["GET"])
@jwt_role_required("field_assistant")
def nearby_naps(assignment_id):
    """Nearest-suitable-NAP candidates for the technician's own pinned
    on-site location, so they can link the right NAP themselves on an
    installation the office dispatched with none set (see
    link_nap() below). Reuses the same recommend_naps() engine the
    admin's "Recommend NAP" page (app/routes/service_requests.py's
    recommend_nap()) already uses — active status, a free port, and
    (if configured) within Settings > App Settings' Max Connection
    Radius — just measured from the technician's GPS pin instead of
    the service request's original customer-location field, since the
    technician is the one actually standing at the install site right
    now.

    Requires a location already pinned (pin_assignment_location()
    above) — there's nothing to measure distance from otherwise, so
    this 409s rather than silently falling back to some other
    coordinate.
    """
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.service_request_id is None:
        return jsonify(error="Linking a NAP only applies to an installation assignment."), 409

    if assignment.pin_latitude is None or assignment.pin_longitude is None:
        return jsonify(error="Pin your location before looking up nearby NAPs."), 409

    recommendations = recommend_naps(float(assignment.pin_latitude), float(assignment.pin_longitude))

    return (
        jsonify(
            naps=[
                {
                    "id": row["nap"].id,
                    "nap_code": row["nap_code"],
                    "name": row["name"],
                    "distance_km": row["distance_km"],
                    "available_ports": row["available_ports"],
                    "total_ports": row["total_ports"],
                    "is_recommended": row["is_recommended"],
                }
                for row in recommendations
            ]
        ),
        200,
    )


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/link-nap", methods=["POST"])
@jwt_role_required("field_assistant")
def link_nap(assignment_id):
    """Lets the technician set `service_request.requested_nap_id`
    themselves, from the nearby_naps() list above — the field
    counterpart to the admin's assign_nap()
    (app/routes/service_requests.py), for an installation that was
    dispatched with no NAP linked yet. Same field, same "the only
    thing this route does" contract as that one; doesn't touch
    service_request.status (assign_nap() advances 'approved' ->
    'scheduled', but this request is already scheduled/dispatched by
    the time a technician has an assignment for it, so there's no
    status step to auto-advance here).

    Only valid once a location has been pinned (same reasoning as
    nearby_naps() above), and only while the assignment is still
    'accepted'/'in_progress' — same window save_notes()/
    pin_assignment_location() already use.
    """
    profile = _get_own_profile_or_404()
    if profile is None:
        return jsonify(error="No technician profile is linked to this account yet."), 404

    assignment = _get_own_assignment_or_404(profile, assignment_id)
    if assignment is None:
        return jsonify(error="Assignment not found."), 404

    if assignment.service_request_id is None:
        return jsonify(error="Linking a NAP only applies to an installation assignment."), 409

    if assignment.status not in ("accepted", "in_progress"):
        return jsonify(error="A NAP can only be linked on an assignment you've accepted or started."), 409

    if assignment.pin_latitude is None or assignment.pin_longitude is None:
        return jsonify(error="Pin your location before linking a NAP."), 409

    data = request.get_json(silent=True) or {}
    nap_id = data.get("nap_id")
    nap = Nap.query.get(nap_id) if nap_id else None
    if nap is None:
        return jsonify(error="nap_id is required and must reference a real NAP."), 400

    # Re-checked here rather than trusted from the nearby_naps() list
    # the app fetched a moment ago — same "never trust a stale
    # client-side snapshot of a NAP's status/ports" reasoning the
    # admin's assign_nap() route already documents.
    _used, live_available = slot_usage(nap)
    if nap.status != "active" or live_available <= 0:
        return (
            jsonify(
                error=(
                    f"NAP '{nap.nap_code}' is no longer active with available "
                    "ports — refresh nearby NAPs and try again."
                )
            ),
            409,
        )

    # If this is actually changing an already-linked NAP (not the
    # first link) — e.g. a mistouch correction from the Job Detail
    # screen's NAP field — any previously chosen port_number is a
    # physical port on the OLD NAP hardware. Leaving it in place after
    # switching NAPs would silently misrepresent which port was
    # serviced, so it's cleared here rather than carried over just
    # because it happens to still be in range for the new NAP's
    # total_ports.
    if assignment.service_request.requested_nap_id != nap.id:
        assignment.port_number = None

    assignment.service_request.requested_nap_id = nap.id
    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200


@api_v1_technician_bp.route("/assignments/<int:assignment_id>/complete", methods=["POST"])
@jwt_role_required("field_assistant")
def complete_assignment(assignment_id):
    """in_progress -> completed (a repair's issue -> resolved).
    Resolution notes are optional -- if given, they're saved before
    completing; if omitted, whatever was already saved via
    save_notes() (or nothing at all) is kept as-is. port_number works
    the same way -- see _validate_port_number().

    Phase 28: an installation additionally requires the technician's
    pinned on-site location (not just the completion photo every job
    requires) before it can be marked complete — see
    pin_assignment_location()'s docstring above. This replaces the
    older customer-signature requirement.

    Phase 29: once those checks pass and the Assignment itself moves
    to 'completed' below, an installation additionally flips
    `service_request.status` to 'completed' and `subscriber.status`
    to 'active' (with `installed_at` set to today) — see the "Phase
    29" comment further down this function.
    """
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

    is_installation = assignment.service_request_id is not None
    if is_installation and (assignment.pin_latitude is None or assignment.pin_longitude is None):
        return jsonify(error="Pinning your location is required before this installation can be marked complete."), 400

    data = request.get_json(silent=True) or {}
    notes = str(data.get("resolution_notes") or assignment.resolution_notes or "").strip()

    port_number, error = _validate_port_number(assignment, data)
    if error:
        message, status = error
        return jsonify(error=message), status

    assignment.resolution_notes = notes or None
    assignment.port_number = port_number
    assignment.status = "completed"
    assignment.completed_at = datetime.utcnow()

    if assignment.technical_issue is not None:
        assignment.technical_issue.status = "resolved"
        # Named specifically for repairs (see this column's comment in
        # app/models.py) — an installation's completion isn't a
        # "resolved issue", so it isn't counted here. Phase 29's
        # auto-activation is the right place for any install-specific
        # completion metric, if one's ever wanted.
        profile.resolved_issues_count = (profile.resolved_issues_count or 0) + 1
        notify_issue_status_change(assignment.technical_issue)

    # Phase 29 (auto-activation): the install counterpart to the
    # repair branch above. Closes the Register -> review -> dispatch
    # -> activation loop the roadmap describes — the moment a
    # technician marks an install Assignment complete, the applicant's
    # account goes live with no separate admin action required.
    if assignment.service_request is not None:
        service_request = assignment.service_request
        subscriber = service_request.subscriber
        service_request.status = "completed"
        if subscriber is not None:
            subscriber.status = "active"
            subscriber.installed_at = date.today()
            # This is the same "a subscriber just occupied a slot"
            # case every other write path in the app already re-syncs
            # for (see app/nap_status.py) -- without it, a NAP whose
            # last open slot gets filled by a completed installation
            # stays stored as "active" instead of flipping to "full",
            # even though the GeoMap's live usage badge (computed
            # straight from used/total ports) correctly shows 100%.
            db.session.flush()
            if subscriber.nap is not None:
                sync_nap_status(subscriber.nap)
            notify(
                "service_request",
                "You're connected!",
                f"Your installation is complete — {subscriber.subscriber_code} is now active. "
                "Welcome to PG Networks!",
                customer_user_id=subscriber.user_id,
                entity_type="service_request",
                entity_id=service_request.id,
            )

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

    db.session.commit()

    return jsonify(assignment=_serialize_assignment(assignment)), 200
