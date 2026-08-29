"""
Manage Technicians Blueprint (Administrator only) — Phase 12
-----------------------------------------------------------------
Fills in the "Technicians" sidebar placeholder: an Administrator-only
UI for creating and editing `technicians` roster profiles (the
dispatch-facing record used by app/routes/dispatch.py and
app/routes/technician.py), which previously only existed via direct
SQL / seed data — same gap PHASE10_NOTES.md flagged for Subscribers.

This module manages `technicians` rows and their optional link to a
technician-role `users` login account (`technicians.user_id`), since
unlike the Subscriber<->User link this one has no other owner yet
(Manage Users creating a technician-role account does not also create
a profile here — see PHASE8_NOTES.md's "not touched" list). The
dropdown here only offers technician-role accounts not already linked
to a *different* profile, mirroring the Subscriber-link dropdown's
own exclusion pattern in app/routes/users.py.

Records are never physically deleted — a technician who's no longer
active is set `offline` via the existing `status` column rather than
row-deleted, so historical assignments/resolved-issue counts stay
intact (same reasoning as Subscriber status / NAP status).

Routes:
    GET  /technicians/               -> list_technicians  (search + status filter)
    GET  /technicians/add            -> add_technician     (show add form)
    POST /technicians/add            -> add_technician     (process add form)
    GET  /technicians/<id>           -> view_technician    (view details)
    GET  /technicians/<id>/edit      -> edit_technician    (show edit form)
    POST /technicians/<id>/edit      -> edit_technician    (process edit form)
"""

from flask import Blueprint, render_template, redirect, url_for, request, flash

from app.extensions import db
from app.auth import role_required
from app.models import Technician, User

technicians_bp = Blueprint("technicians", __name__, url_prefix="/technicians")

# Imported lazily inside route functions to avoid a circular import at
# module load time (app/forms.py already imports app.models, and this
# module imports app/forms.py — same ordering every other routes/*.py
# file already uses).
from app.forms import TechnicianForm  # noqa: E402


def _populate_user_link_choices(form, *, current_user_id=None):
    """Fills in the 'Linked Login Account' dropdown with every
    technician-role account that isn't already linked to a *different*
    technician profile, plus whichever one this profile is currently
    linked to (so editing an already-linked profile doesn't wipe the
    choice out from under it). Mirrors
    users.py:_populate_subscriber_link_choices exactly, just in the
    opposite direction (technician profile -> login account instead of
    login account -> subscriber)."""
    linked_user_ids = [
        t.user_id for t in Technician.query.filter(Technician.user_id.isnot(None)).all()
        if t.user_id != current_user_id
    ]
    query = User.query.filter(User.role == "technician")
    if linked_user_ids:
        query = query.filter(~User.id.in_(linked_user_ids))
    accounts = query.order_by(User.full_name).all()
    form.user_id.choices = [(0, "-- Not linked --")] + [
        (u.id, f"{u.username} — {u.full_name}") for u in accounts
    ]


@technicians_bp.route("/")
@role_required("administrator")
def list_technicians():
    """Displays all personnel profiles (technicians and field
    assistants), with optional search (by name or contact number) and
    status filtering via query string parameters (?q=...&status=...)."""
    search_term = request.args.get("q", "").strip()
    status_filter = request.args.get("status", "").strip()

    query = Technician.query

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.filter(
            db.or_(
                Technician.full_name.ilike(like_pattern),
                Technician.contact_number.ilike(like_pattern),
            )
        )

    if status_filter:
        query = query.filter(Technician.status == status_filter)

    technicians = query.order_by(Technician.full_name.asc()).all()

    return render_template(
        "technicians/list.html",
        technicians=technicians,
        search_term=search_term,
        status_filter=status_filter,
    )


@technicians_bp.route("/add", methods=["GET", "POST"])
@role_required("administrator")
def add_technician():
    """Shows and processes the Add Technician / Add Field Assistant
    form. The "Add Personnel" split button on the list page links here
    with ?type=technician or ?type=field_assistant to preselect which
    kind of profile is being created; the type itself stays editable
    on the form either way."""
    form = TechnicianForm()
    form.technician_id_value = None
    _populate_user_link_choices(form)

    requested_type = request.args.get("type", "").strip()
    if request.method == "GET" and requested_type in ("technician", "field_assistant"):
        form.personnel_type.data = requested_type

    if form.validate_on_submit():
        # Field assistants don't get mobile-app access, so a linked
        # login only ever applies to technicians — enforced here too,
        # not just hidden client-side, in case of a stale/tampered POST.
        linked_user_id = form.user_id.data if form.personnel_type.data == "technician" else 0

        technician = Technician(
            full_name=form.full_name.data.strip(),
            contact_number=(form.contact_number.data or "").strip() or None,
            personnel_type=form.personnel_type.data,
            status=form.status.data,
            user_id=linked_user_id or None,  # 0 sentinel -> NULL
        )
        db.session.add(technician)
        db.session.commit()

        label = "Field assistant" if technician.personnel_type == "field_assistant" else "Technician"
        flash(f"{label} '{technician.full_name}' was added successfully.", "success")
        return redirect(url_for("technicians.list_technicians"))

    return render_template("technicians/form.html", form=form, mode="add", technician=None)


@technicians_bp.route("/<int:technician_id>")
@role_required("administrator")
def view_technician(technician_id):
    """Read-only detail view: technician info, linked login account (if
    any), and current open assignments."""
    technician = Technician.query.get_or_404(technician_id)
    open_assignments = [
        a for a in technician.assignments
        if a.status in ("assigned", "accepted", "in_progress")
    ]
    return render_template(
        "technicians/view.html", technician=technician, open_assignments=open_assignments
    )


@technicians_bp.route("/<int:technician_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_technician(technician_id):
    """Shows and processes the Edit Technician form."""
    technician = Technician.query.get_or_404(technician_id)

    form = TechnicianForm(obj=technician)
    form.technician_id_value = technician.id
    _populate_user_link_choices(form, current_user_id=technician.user_id)
    if request.method == "GET":
        form.user_id.data = technician.user_id or 0

    if form.validate_on_submit():
        technician.full_name = form.full_name.data.strip()
        technician.contact_number = (form.contact_number.data or "").strip() or None
        technician.personnel_type = form.personnel_type.data
        technician.status = form.status.data
        # Same rule as add_technician: field assistants never keep a
        # linked login, even if one was set before the type was changed.
        linked_user_id = form.user_id.data if form.personnel_type.data == "technician" else 0
        technician.user_id = linked_user_id or None

        db.session.commit()
        label = "Field assistant" if technician.personnel_type == "field_assistant" else "Technician"
        flash(f"{label} '{technician.full_name}' was updated successfully.", "success")
        return redirect(url_for("technicians.list_technicians"))

    return render_template("technicians/form.html", form=form, mode="edit", technician=technician)
