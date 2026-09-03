"""
Manage Personnel Blueprint (Administrator only) — Phase 12
-----------------------------------------------------------------
Fills in the "Personnel" sidebar placeholder: an Administrator-only
UI for creating and editing `technicians` roster profiles (the
dispatch-facing record used by app/routes/dispatch.py and
app/routes/technician.py), which previously only existed via direct
SQL / seed data — same gap PHASE10_NOTES.md flagged for Subscribers.

Two kinds of profile share this one roster table, distinguished by
`technicians.personnel_type`:

  * "technician"      — logs into the mobile Technician app. Its
                          `users` login (role='technician') is created
                          right here, inline, via the username/password
                          fields on the Add Technician form — there's
                          no separate "link an existing account" step
                          the way earlier phases did it.
  * "field_assistant" — admin web dashboard only, no mobile access.
                          Its `users` login (role='field_assistant')
                          is created the same inline way, but
                          MOBILE_API_ROLES (app/jwt_auth.py) only
                          issues mobile tokens to role='technician',
                          so this login can't sign into the mobile
                          app. There's no "Add Field Assistant" entry
                          point on the Personnel list anymore, but
                          existing Field Assistant profiles (and this
                          route's ?type=field_assistant param) still
                          work.

Records are never physically deleted — a profile that's no longer
active is set `offline` via the existing `status` column rather than
row-deleted, so historical assignments/resolved-issue counts stay
intact (same reasoning as Subscriber status / NAP status). The linked
login account (if any) is likewise never deleted from here; that stays
a Manage Users action.

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
    """Shows and processes the Add Technician form.

    The list page's "Add Technician" button links here with
    ?type=technician; personnel_type/status are no longer editable on
    this form (the template renders them as hidden fields carrying
    their default values) — every profile created here is
    personnel_type='technician', status='available'.

    Adding a Technician also creates their mobile-app login
    (role='technician') from the username/password fields on the same
    form, since the mobile Technician app authenticates against
    accounts with that role (see app/jwt_auth.py's MOBILE_API_ROLES).
    """
    form = TechnicianForm()
    form.technician_id_value = None

    requested_type = request.args.get("type", "").strip()
    if request.method == "GET" and requested_type in ("technician", "field_assistant"):
        form.personnel_type.data = requested_type
    elif request.method == "GET":
        form.personnel_type.data = "technician"

    needs_credentials = True
    if form.validate_on_submit() and form.validate_credentials_if_needed(needs_credentials=needs_credentials):
        login_role = "technician" if form.personnel_type.data == "technician" else "field_assistant"
        login = User(
            username=form.username.data.strip(),
            full_name=form.full_name.data.strip(),
            role=login_role,
        )
        login.set_password(form.password.data)
        db.session.add(login)
        db.session.flush()  # assign login.id without a separate round trip

        technician = Technician(
            full_name=form.full_name.data.strip(),
            contact_number=(form.contact_number.data or "").strip() or None,
            personnel_type=form.personnel_type.data,
            status=form.status.data,
            user_id=login.id,
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
    """Read-only detail view: personnel info, linked mobile login (if
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
    """Shows and processes the Edit Technician / Edit Field Assistant
    form. If this profile doesn't have a mobile login yet, the same
    inline username/password fields from the Add form appear here to
    create one (role='technician' or role='field_assistant', matching
    personnel_type). An already-linked login is shown read-only — a
    password change is a Manage Users action, not this form's job.

    BUGFIX: switching an existing profile's Personnel Type here (e.g.
    Field Assistant -> Technician, to grant mobile-app access — see
    MOBILE_API_ROLES in app/jwt_auth.py, which only issues mobile
    tokens to role='technician') previously only updated
    technicians.personnel_type. An already-linked login's users.role
    was left exactly as it was when first created, so the profile
    looked like the right type on this page while the actual login
    still carried the old role and mobile sign-in kept failing with
    "This account type isn't supported in this app." This now keeps
    the two in sync whenever personnel_type changes.
    """
    technician = Technician.query.get_or_404(technician_id)

    form = TechnicianForm(obj=technician)
    form.technician_id_value = technician.id

    needs_credentials = technician.user_id is None
    if form.validate_on_submit() and form.validate_credentials_if_needed(needs_credentials=needs_credentials):
        technician.full_name = form.full_name.data.strip()
        technician.contact_number = (form.contact_number.data or "").strip() or None
        technician.personnel_type = form.personnel_type.data
        technician.status = form.status.data

        login_role = "technician" if form.personnel_type.data == "technician" else "field_assistant"

        if needs_credentials:
            login = User(
                username=form.username.data.strip(),
                full_name=technician.full_name,
                role=login_role,
            )
            login.set_password(form.password.data)
            db.session.add(login)
            db.session.flush()
            technician.user_id = login.id
        elif technician.user.role in ("technician", "field_assistant"):
            # Existing login, type changed on this edit -- keep its
            # role (and therefore its mobile-app access) matching
            # what the page now shows. The `in (...)` guard leaves
            # any account somehow linked with a different role
            # (administrator/payment_collector) untouched rather than
            # silently downgrading it.
            technician.user.role = login_role

        db.session.commit()
        label = "Field assistant" if technician.personnel_type == "field_assistant" else "Technician"
        flash(f"{label} '{technician.full_name}' was updated successfully.", "success")
        return redirect(url_for("technicians.list_technicians"))

    return render_template(
        "technicians/form.html",
        form=form,
        mode="edit",
        technician=technician,
        needs_credentials=needs_credentials,
    )
