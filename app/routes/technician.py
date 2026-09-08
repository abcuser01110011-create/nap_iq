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
    POST /technician/assignments/<id>/pin-location   -> pin_assignment_location
                                                        (installation-only GPS fix, desktop
                                                        counterpart of api_v1/technician.py's
                                                        same-named route; required before
                                                        complete_assignment on an installation)
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
from datetime import date, datetime

import cloudinary
import cloudinary.uploader
from flask import Blueprint, render_template, redirect, url_for, flash, abort, g, request

from app.extensions import db
from app.auth import role_required
from app.models import Technician, Assignment, CablePath, Nap, Subscriber
from app.forms import ResolutionNotesForm
from app.notifications_utils import notify, notify_issue_status_change
from app.issue_utils import resolve_fiber_break_siblings
from app.nap_recommendation import recommend_naps
from app.nap_status import slot_usage, sync_nap_status
from app.routes.service_requests import _sync_subscriber_nap
from app.routes.api_v1.technician import (
    _assignment_nap, _nap_occupied_ports, _validate_port_number, _subscriber_installed_port_number,
)

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
    issue detail page, etc.) and marks the technician 'busy'.

    Bug fix: an installation-type assignment is linked via
    service_request_id instead of technical_issue_id (see Assignment's
    docstring in app/models.py), so assignment.technical_issue is None
    for it — unconditionally writing to `.status` on it here raised
    an AttributeError (500) the moment a technician tried to start
    work on an installation. Guarded exactly like
    api_v1/technician.py's start_assignment() already does: a
    service_request has no 'in_progress' value in its own status enum
    (it's already 'scheduled' from dispatch and stays that way through
    accept/start — see that route's docstring), so for an installation
    this now only flips the Assignment's own status and the
    technician's busy state, same as the mobile app already does."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "accepted":
        flash("That assignment needs to be accepted before you can start work on it.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    assignment.status = "in_progress"
    if assignment.technical_issue is not None:
        assignment.technical_issue.status = "in_progress"
        notify_issue_status_change(assignment.technical_issue)
    profile.status = "busy"
    db.session.commit()

    if assignment.technical_issue is not None:
        issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
        flash(f"{issue_label} marked as in progress.", "success")
    else:
        flash("Installation marked as in progress.", "success")
    return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))


@technician_bp.route("/assignments/<int:assignment_id>/pin-location", methods=["POST"])
@role_required("technician")
def pin_assignment_location(assignment_id):
    """Records the technician's own on-site GPS fix for an
    *installation* assignment — the desktop web counterpart of
    api_v1/technician.py's pin_assignment_location(), same validation
    rules (installation-only, only while 'accepted'/'in_progress'),
    just reached via a plain JSON fetch from ticket_detail.html's
    'Pin My Location' button (browser geolocation) instead of the
    mobile app's expo-location + JWT API call. Required before
    complete_assignment() below will accept an installation as done —
    see that route's own docstring."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.service_request_id is None:
        return {"error": "A pinned location only applies to an installation assignment."}, 409

    if assignment.status not in ("accepted", "in_progress"):
        return {"error": "A location can only be pinned on an assignment you've accepted or started."}, 409

    data = request.get_json(silent=True) or {}
    latitude = data.get("latitude")
    longitude = data.get("longitude")
    if latitude is None or longitude is None:
        return {"error": "latitude and longitude are required."}, 400

    try:
        latitude = float(latitude)
        longitude = float(longitude)
    except (TypeError, ValueError):
        return {"error": "latitude and longitude must be numbers."}, 400

    if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
        return {"error": "latitude/longitude are out of range."}, 400

    assignment.pin_latitude = latitude
    assignment.pin_longitude = longitude
    db.session.commit()

    return {"pin_latitude": latitude, "pin_longitude": longitude}, 200


@technician_bp.route("/assignments/<int:assignment_id>/nearby-naps", methods=["GET"])
@role_required("technician")
def nearby_naps(assignment_id):
    """Nearest-suitable-NAP candidates for the technician's own pinned
    on-site location, so they can link the right NAP themselves on a
    New Installation that was dispatched with none set. Desktop web
    counterpart of api_v1/technician.py's nearby_naps() — same
    recommend_naps() engine (active status, a free port, and, if
    configured, within Settings > App Settings' Max Connection
    Radius), just reached via a plain JSON fetch from
    ticket_detail.html instead of the mobile app's JWT API call.

    Requires a location already pinned (pin_assignment_location()
    above) — there's nothing to measure distance from otherwise, so
    this 409s rather than silently falling back to some other
    coordinate."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.service_request_id is None:
        return {"error": "Linking a NAP only applies to an installation assignment."}, 409

    if assignment.pin_latitude is None or assignment.pin_longitude is None:
        return {"error": "Pin your location before looking up nearby NAPs."}, 409

    recommendations = recommend_naps(float(assignment.pin_latitude), float(assignment.pin_longitude))

    return {
        "naps": [
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
    }, 200


@technician_bp.route("/assignments/<int:assignment_id>/link-nap", methods=["POST"])
@role_required("technician")
def link_nap(assignment_id):
    """Sets `service_request.requested_nap_id` from the nearby_naps()
    list above — desktop web counterpart of api_v1/technician.py's
    link_nap(), same rules and re-checked live availability (never
    trusting the nearby-NAPs snapshot the browser fetched a moment
    earlier), same "switching NAPs clears any already-picked
    port_number" safeguard, since a port number is a physical port on
    one specific NAP's hardware."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.service_request_id is None:
        return {"error": "Linking a NAP only applies to an installation assignment."}, 409

    if assignment.status not in ("accepted", "in_progress"):
        return {"error": "A NAP can only be linked on an assignment you've accepted or started."}, 409

    if assignment.pin_latitude is None or assignment.pin_longitude is None:
        return {"error": "Pin your location before linking a NAP."}, 409

    data = request.get_json(silent=True) or {}
    nap_id = data.get("nap_id")
    nap = Nap.query.get(nap_id) if nap_id else None
    if nap is None:
        return {"error": "nap_id is required and must reference a real NAP."}, 400

    _used, live_available = slot_usage(nap)
    if nap.status != "active" or live_available <= 0:
        return {
            "error": (
                f"NAP '{nap.nap_code}' is no longer active with available "
                "ports — refresh nearby NAPs and try again."
            )
        }, 409

    if assignment.service_request.requested_nap_id != nap.id:
        assignment.port_number = None

    assignment.service_request.requested_nap_id = nap.id
    db.session.commit()

    return {
        "nap": {
            "id": nap.id,
            "nap_code": nap.nap_code,
            "name": nap.name,
            "total_ports": nap.total_ports,
            "occupied_ports": _nap_occupied_ports(nap, exclude_assignment_id=assignment.id),
        },
        "port_number": assignment.port_number,
    }, 200


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
    """Marks an assignment (and its linked issue, for a repair) resolved.
    Only valid from 'in_progress'. Requires resolution notes
    (phase_8.pdf's workflow lists 'Save resolution notes' as part of a
    technician's update to an issue) — if notes were already saved via
    save_notes() above, the field is pre-filled here and this just
    confirms them. Also requires a completion photo (uploaded
    separately via upload_photo() below) to already be attached —
    mirrors the same rule app/routes/api_v1/technician.py's
    complete_assignment() enforces for the mobile app, now on the
    desktop web UI too. Also increments the technician's
    resolved_issues_count, and — if this was their last open
    assignment — sets them back to 'available'.

    Bug fix: an installation-type assignment has no technical_issue
    (see Assignment's docstring in app/models.py) — the old code
    unconditionally wrote to assignment.technical_issue.status,
    raising an AttributeError (500) the moment a technician tried to
    complete an installation. Guarded the same way start_assignment()
    above already was fixed. Also now requires the technician's own
    on-site GPS pin (pin_assignment_location() above) before an
    installation can be completed, matching the mobile app's rule —
    see that route's docstring.

    Bug fix: this now matches the mobile app's Phase 29/36/37/38
    auto-activation behavior exactly (see api_v1/technician.py's
    complete_assignment() docstring) instead of stopping at
    assignment.status = "completed". Previously, completing a job from
    the desktop web UI left service_request.status stuck at whatever
    it was (so the ticket still showed as pending), never created the
    real Nap row for an "Add NAP" ticket (so it never appeared on the
    GeoMap), never provisioned/activated the Subscriber for a walk-in
    New Installation, and never called _sync_subscriber_nap()/
    sync_nap_status() (so an existing subscriber's connector line and
    the NAP's occupancy/status badge never updated either) -- the same
    installation, completed from a phone, did all of this correctly.
    The web technician UI is the one being changed here to match the
    mobile app's already-correct behavior; the mobile flow itself is
    untouched."""
    profile = _get_own_profile_or_403()
    assignment = _get_own_assignment_or_403(profile, assignment_id)

    if assignment.status != "in_progress":
        flash("That assignment isn't in progress yet, so it can't be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    if not assignment.photo_filename:
        flash("A completion photo is required before this assignment can be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    is_installation = assignment.service_request_id is not None
    if is_installation and (assignment.pin_latitude is None or assignment.pin_longitude is None):
        flash("Pin your on-site location before this installation can be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    # A New Installation ticket (connecting a subscriber into a free
    # port on an existing NAP) needs a NAP linked and a port picked
    # before it's really "done" — an Add NAP ticket (installing the
    # NAP box itself) has no subscriber port to record, so it's
    # narrower than the broader is_installation check above, same
    # distinction api_v1/technician.py's isNewInstallationTicket
    # makes on the mobile side.
    is_new_installation = (
        is_installation
        and assignment.service_request is not None
        and assignment.service_request.request_type == "new_installation"
    )
    if is_new_installation and _assignment_nap(assignment) is None:
        flash("Link a NAP before this installation can be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    port_number, port_error = _validate_port_number(assignment, request.form)
    if port_error is not None:
        message, _status = port_error
        flash(message, "danger")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))
    if is_new_installation and port_number is None:
        flash("Select a port before this installation can be marked complete.", "warning")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    form = ResolutionNotesForm()
    if not form.validate_on_submit():
        for field_errors in form.errors.values():
            for message in field_errors:
                flash(message, "danger")
        return redirect(url_for("technician.ticket_detail", assignment_id=assignment.id))

    assignment.resolution_notes = form.resolution_notes.data.strip()
    assignment.port_number = port_number
    assignment.status = "completed"
    assignment.completed_at = datetime.utcnow()

    if assignment.technical_issue is not None:
        assignment.technical_issue.status = "resolved"
        # A Fiber Break's other connected subscribers never get their own
        # Assignment (see resolve_fiber_break_siblings()'s docstring) --
        # resolve them together with the one that was actually dispatched
        # so their markers/tickets don't keep showing the outage as open.
        resolve_fiber_break_siblings(assignment.technical_issue)
        profile.resolved_issues_count = (profile.resolved_issues_count or 0) + 1
        notify_issue_status_change(assignment.technical_issue)

    # Phase 29/36/37/38 (auto-activation) -- ported from
    # api_v1/technician.py's complete_assignment() so completing an
    # installation from the desktop web UI behaves exactly like
    # completing it from the mobile app: the ServiceRequest is closed
    # out, an "Add NAP" ticket's real Nap row gets created (so it can
    # show up on the GeoMap), a walk-in New Installation's Subscriber
    # gets provisioned/activated, and the NAP <-> Subscriber sync +
    # status recompute both run. See that function's docstring for the
    # full reasoning behind each step; this block is kept identical on
    # purpose so the two entry points never drift apart again.
    if assignment.service_request is not None:
        service_request = assignment.service_request
        subscriber = service_request.subscriber
        service_request.status = "completed"

        if service_request.request_type == "add_nap":
            nap_code = service_request.planned_nap_code
            if not nap_code or Nap.query.filter_by(nap_code=nap_code).first() is not None:
                candidate_number = Nap.query.count() + 1
                nap_code = f"N-{candidate_number:03d}"
                while Nap.query.filter_by(nap_code=nap_code).first() is not None:
                    candidate_number += 1
                    nap_code = f"N-{candidate_number:03d}"

            total_ports = service_request.port_capacity or 8
            nap = Nap(
                nap_code=nap_code,
                name=service_request.full_name or f"NAP {nap_code}",
                address=service_request.address,
                latitude=assignment.pin_latitude or service_request.latitude,
                longitude=assignment.pin_longitude or service_request.longitude,
                total_ports=total_ports,
                used_ports=0,
                available_ports=total_ports,
                status="active",
            )
            db.session.add(nap)

        if subscriber is None and is_new_installation:
            subscriber = Subscriber(
                subscriber_code=f"PENDING-{assignment.id}",
                full_name=service_request.full_name or "Walk-in customer",
                address=service_request.address,
                latitude=assignment.pin_latitude or service_request.latitude,
                longitude=assignment.pin_longitude or service_request.longitude,
                contact_number=service_request.contact_number,
                plan_type=service_request.plan_label,
                status="active",
            )
            db.session.add(subscriber)
            db.session.flush()  # assigns subscriber.id
            subscriber.subscriber_code = f"SUB-{subscriber.id:04d}"
            service_request.subscriber_id = subscriber.id

        if subscriber is not None:
            subscriber.status = "active"
            subscriber.installed_at = date.today()
            _sync_subscriber_nap(service_request)
            db.session.flush()
            if subscriber.nap is not None:
                sync_nap_status(subscriber.nap)
                # Kept byte-for-byte identical to the mobile
                # complete_assignment() in api_v1/technician.py (see
                # that copy's comment for the full reasoning) so the
                # two entry points never drift apart: promotes a
                # technician-recorded cable-path GPS trail (only ever
                # set via the mobile Job Detail screen — the desktop
                # web UI has no way to walk a route) into a real
                # CablePath row for the GeoMap to draw.
                if assignment.cable_path_points:
                    existing_path = CablePath.query.filter_by(subscriber_id=subscriber.id).first()
                    if existing_path is None:
                        existing_path = CablePath(subscriber_id=subscriber.id)
                        db.session.add(existing_path)
                    existing_path.nap_id = subscriber.nap.id
                    existing_path.source_assignment_id = assignment.id
                    existing_path.points = assignment.cable_path_points
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

    if assignment.technical_issue is not None:
        issue_label = assignment.technical_issue.issue_code or f"#{assignment.technical_issue_id}"
        flash(f"{issue_label} marked complete. Nice work!", "success")
    else:
        flash("Installation marked complete. Nice work!", "success")
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

    # Fiber Break's forced-critical priority is the whole NAP being
    # down, not an individual complaint -- same "Critical" (not the
    # usual "Urgent" label every other critical-priority ticket gets)
    # exception napmap.js's formatPriorityLabel() already applies on
    # the GeoMap, kept in sync here so the technician web dashboard
    # and mobile app agree with it.
    if issue and issue.issue_type == "Fiber Break" and priority == "critical":
        priority_label = "Critical"
    else:
        priority_label = PRIORITY_LABELS.get(priority, priority)

    lat = (subscriber.latitude if subscriber else None) or (issue.latitude if issue else None) or (request.latitude if request else None)
    lng = (subscriber.longitude if subscriber else None) or (issue.longitude if issue else None) or (request.longitude if request else None)

    can_accept = assignment.status == "assigned"
    can_start = assignment.status == "accepted"
    can_edit = assignment.status in ("accepted", "in_progress")
    can_complete = assignment.status == "in_progress"
    is_closed = assignment.status in CLOSED_ASSIGNMENT_STATUSES

    # The linked NAP, if any — issue.nap for a repair/Fiber Break,
    # request.requested_nap for an installation (see _assignment_nap()
    # in api_v1/technician.py, imported above; shared with
    # nearby_naps()/link_nap()/complete_assignment() so this view-model
    # and those routes never disagree about which NAP an assignment is
    # linked to). Exposed as its own dict (not just nap_label below) so
    # ticket_detail.html's port picker has total_ports/occupied_ports
    # to build its 1..total_ports dropdown from, same fields the mobile
    # app's assignment.nap already carries.
    nap = _assignment_nap(assignment)

    # A Repair ticket's `issue.nap` is only ever set if the person who
    # reported it happened to pick one on the report form -- it's an
    # optional field (app/routes/issues.py's IssueReportForm, "None" is
    # a valid choice), so it's often blank even though the subscriber
    # is obviously connected to a real NAP. Fall back to that actual
    # connection (`subscriber.nap`) so "NAP connected" reliably shows
    # on a Repair ticket's Job Detail page instead of only when the
    # original report happened to name one. Left untouched for an
    # installation, where `request.requested_nap` is already the
    # correct, deliberate answer.
    if nap is None and not is_installation and subscriber is not None:
        nap = subscriber.nap

    nap_info = (
        {
            "id": nap.id,
            "nap_code": nap.nap_code,
            "name": nap.name,
            "total_ports": nap.total_ports,
            "occupied_ports": _nap_occupied_ports(nap, exclude_assignment_id=assignment.id),
        }
        if nap
        else None
    )

    # Same reasoning for the port number: `assignment.port_number` is
    # only ever set once a technician explicitly (re-)records one for
    # THIS ticket, so a freshly-opened Repair ticket normally has none
    # yet even though the subscriber has been connected to a specific
    # port since their installation. Fall back to that on-file port --
    # the exact same _subscriber_installed_port_number() lookup the
    # native mobile app's API already exposes as
    # subscriber.installed_port_number -- so the desktop and
    # mobile-web Job Detail pages show the same "port they're
    # servicing" a technician sees there. Left untouched for an
    # installation, where a still-blank port genuinely means "not
    # chosen yet".
    displayed_port_number = assignment.port_number
    if displayed_port_number is None and not is_installation and subscriber is not None:
        displayed_port_number = _subscriber_installed_port_number(subscriber)

    return {
        "assignment": assignment,
        "ticket_code": _ticket_code(assignment),
        "status_label": STATUS_LABELS.get(assignment.status, assignment.status),
        "type_label": type_label,
        "address": address,
        "priority": priority,
        "priority_label": priority_label,
        "subscriber_label": "NAP" if (request and request.request_type == "add_nap") else "Subscriber",
        "subscriber_name": (
            f"{subscriber.subscriber_code} — {subscriber.full_name}" if subscriber
            else (request.full_name if request else None)
        ),
        "plan_label": request.plan_label if request else None,
        "contact_number": subscriber.contact_number if subscriber else (request.contact_number if request else None),
        "port_number": displayed_port_number,
        "description": issue.description if issue else (request.notes if request else None),
        "nap": nap_info,
        "nap_label": f"{nap.nap_code} — {nap.name}" if nap else None,
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

