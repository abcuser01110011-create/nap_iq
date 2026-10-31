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

from datetime import datetime

from flask import Blueprint, render_template, redirect, url_for, request, flash, jsonify

from app.extensions import db
from app.auth import role_required
from app.models import Technician, TechnicianTeam, User

technicians_bp = Blueprint("technicians", __name__, url_prefix="/technicians")

# Imported lazily inside route functions to avoid a circular import at
# module load time (app/forms.py already imports app.models, and this
# module imports app/forms.py — same ordering every other routes/*.py
# file already uses).
from app.forms import TechnicianForm  # noqa: E402


def team_status(team):
    """One status for the whole team (members don't show their own status
    once they're on a team): 'offline' when every member is offline,
    'busy' when any member is busy, otherwise 'available'."""
    statuses = [m.effective_status for m in team.members]
    if not statuses or all(s == "offline" for s in statuses):
        return "offline"
    return "busy" if "busy" in statuses else "available"


def _team_lookup():
    """{technician_id: team} for every technician already on a team.
    Returns {} if the teams tables don't exist yet."""
    try:
        teams = TechnicianTeam.query.all()
    except Exception:
        db.session.rollback()
        return {}
    return {m.id: t for t in teams for m in t.members}


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

    technicians = query.order_by(Technician.full_name.asc()).all()

    # Technicians on a team show the TEAM's status (not their own), so the
    # status filter uses the same value as the badge in the table.
    team_of = _team_lookup()
    team_statuses = {t.id: team_status(t) for t in set(team_of.values())}

    def display_status(tech):
        team = team_of.get(tech.id)
        return team_statuses[team.id] if team else tech.effective_status

    # Filter on the derived status (busy = has open tickets), not the stored
    # column, so the filter matches the badge shown in the table.
    if status_filter:
        technicians = [t for t in technicians if display_status(t) == status_filter]

    # Accounts whose mobile login was deactivated are hidden from the main
    # list and shown only via "View deactivated accounts" (?account=deactivated).
    # Profiles with no login at all count as active.
    show_deactivated = request.args.get("account", "").strip() == "deactivated"
    technicians = [
        t for t in technicians
        if (t.user is not None and t.user.status != "active") == show_deactivated
    ]

    # Team cards above the table. Wrapped so the page still loads if the
    # teams tables haven't been created yet (database/add_teams.sql).
    teams = []
    if not show_deactivated:
        try:
            teams = TechnicianTeam.query.order_by(TechnicianTeam.name.asc()).all()
        except Exception:
            db.session.rollback()
            teams = []
    for t in teams:
        team_statuses.setdefault(t.id, team_status(t))

    return render_template(
        "technicians/list.html",
        technicians=technicians,
        search_term=search_term,
        status_filter=status_filter,
        show_deactivated=show_deactivated,
        teams=teams,
        team_of=team_of,
        team_statuses=team_statuses,
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
    # The Technician list opens this same detail view in a popup (fetched
    # in the background) -- it asks for just the contents via ?partial=1.
    if request.args.get("partial"):
        return render_template(
            "technicians/_detail_body.html", technician=technician, open_assignments=open_assignments
        )
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
        if request.args.get("partial"):
            # Edit popup on the Technician list: it reloads the list itself.
            return jsonify(ok=True)
        return redirect(url_for("technicians.list_technicians"))

    # Edit popup: only the form (with any validation errors) is returned.
    if request.args.get("partial"):
        return render_template(
            "technicians/_form_body.html",
            form=form,
            mode="edit",
            technician=technician,
            needs_credentials=needs_credentials,
        )

    return render_template(
        "technicians/form.html",
        form=form,
        mode="edit",
        technician=technician,
        needs_credentials=needs_credentials,
    )


def _set_login_status(technician_id, new_status):
    """Shared by deactivate/activate: flips the linked mobile login's
    users.status (an 'inactive' account can't sign in -- see app/auth.py
    and app/jwt_auth.py). The Technician profile row itself is kept."""
    technician = Technician.query.get_or_404(technician_id)
    if technician.user is None:
        flash("This profile has no mobile login to change.", "warning")
    else:
        technician.user.status = new_status
        db.session.commit()
        verb = "deactivated" if new_status == "inactive" else "reactivated"
        flash(f"Account '{technician.user.username}' has been {verb}.", "success")
    if request.args.get("partial"):
        return jsonify(ok=True)  # the list popup reloads the page itself
    return redirect(url_for("technicians.list_technicians"))


@technicians_bp.route("/<int:technician_id>/deactivate", methods=["POST"])
@role_required("administrator")
def deactivate_technician_account(technician_id):
    return _set_login_status(technician_id, "inactive")


@technicians_bp.route("/<int:technician_id>/activate", methods=["POST"])
@role_required("administrator")
def activate_technician_account(technician_id):
    return _set_login_status(technician_id, "active")


# ---------------------------------------------------------------------
# Create Team (popup form on the Technician list)
# ---------------------------------------------------------------------

def _team_candidates(team=None):
    """Technicians / field assistants that can be put on a team: everyone
    except profiles whose mobile login has been deactivated and anyone who
    is already a member of a team (a person can only be in one team). When
    editing, `team`'s own members stay selectable."""
    people = Technician.query.order_by(Technician.full_name.asc()).all()
    taken = {
        m.id
        for t in TechnicianTeam.query.all()
        if team is None or t.id != team.id
        for m in t.members
    }
    return [
        t for t in people
        if t.id not in taken and (t.user is None or t.user.status == "active")
    ]


def _handle_team_form(team=None):
    """Shared by create_team() and edit_team(): `team` is None when
    creating. GET returns the form; POST validates and saves (JSON
    {"ok": true} on success, the form again with errors otherwise)."""
    candidates = _team_candidates(team)
    if team is not None:
        # Keep current members selectable even if their login was deactivated
        # since, so editing a team never silently drops them.
        known = {t.id for t in candidates}
        candidates = sorted(
            candidates + [m for m in team.members if m.id not in known],
            key=lambda t: t.full_name.lower(),
        )
    by_id = {t.id: t for t in candidates}

    if team is None:
        values = {"name": "", "description": "", "member_ids": [], "leader_id": None}
        action = url_for("technicians.create_team")
    else:
        values = {
            "name": team.name,
            "description": team.description or "",
            "member_ids": [m.id for m in team.members],
            "leader_id": team.leader_id,
        }
        action = url_for("technicians.edit_team", team_id=team.id)
    errors = {}

    if request.method == "POST":
        name = (request.form.get("name") or "").strip()
        description = (request.form.get("description") or "").strip()
        member_ids = []
        for raw in request.form.getlist("member_ids"):
            if raw.isdigit() and int(raw) in by_id and int(raw) not in member_ids:
                member_ids.append(int(raw))
        leader_raw = (request.form.get("leader_id") or "").strip()
        leader_id = int(leader_raw) if leader_raw.isdigit() else None
        values = {"name": name, "description": description, "member_ids": member_ids, "leader_id": leader_id}

        if not name:
            errors["name"] = "Team name is required."
        elif len(name) > 100:
            errors["name"] = "Team name must be 100 characters or fewer."
        else:
            clash = TechnicianTeam.query.filter(db.func.lower(TechnicianTeam.name) == name.lower())
            if team is not None:
                clash = clash.filter(TechnicianTeam.id != team.id)
            if clash.first():
                errors["name"] = "A team with this name already exists."
        if len(description) > 255:
            errors["description"] = "Description must be 255 characters or fewer."
        if not member_ids:
            errors["members"] = "Add at least one member."
        elif any(
            raw.isdigit() and int(raw) not in by_id
            for raw in request.form.getlist("member_ids")
        ):
            errors["members"] = "One or more selected technicians are already on another team."
        if leader_id is None:
            errors["leader"] = "Team leader is required."
        elif leader_id not in member_ids:
            errors["leader"] = "The team leader must be one of the members."

        if not errors:
            creating = team is None
            if creating:
                team = TechnicianTeam()
                db.session.add(team)
            team.name = name
            team.description = description or None
            team.leader_id = leader_id
            team.members = [by_id[i] for i in member_ids]
            db.session.commit()
            count = len(member_ids)
            flash(
                f"Team '{team.name}' was {'created' if creating else 'updated'} with {count} member{'' if count == 1 else 's'}.",
                "success",
            )
            return jsonify(ok=True)

    return render_template(
        "technicians/_team_form.html",
        candidates=candidates,
        values=values,
        errors=errors,
        team=team,
        form_action=action,
    ), (400 if errors else 200)


@technicians_bp.route("/teams/options", methods=["GET"])
@role_required("administrator")
def team_options():
    """JSON list of teams for the ticket forms' "Team" picker (replaces the
    old per-technician picker). Same shape /api/personnel returned, so
    tickets.js can render it unchanged: `full_name` is the team name and
    `status` is the shared team status. The lightest-loaded team that isn't
    offline is flagged `recommended` so it is pre-selected."""
    open_states = ("accepted", "assigned", "in_progress")
    rows = []
    for team in TechnicianTeam.query.order_by(TechnicianTeam.name.asc()).all():
        if not team.members:
            continue
        open_count = sum(
            1 for m in team.members for a in m.assignments if a.status in open_states
        )
        completed_count = sum(
            1 for m in team.members for a in m.assignments if a.status == "completed"
        )
        rows.append({
            "id": team.id,
            "full_name": team.name,
            "status": team_status(team),
            "member_count": len(team.members),
            "open_count": open_count,
            "completed_count": completed_count,
            "recommended": False,
        })
    candidates = [r for r in rows if r["status"] != "offline"] or rows
    if candidates:
        best = min(candidates, key=lambda r: (r["open_count"], r["full_name"].lower(), r["id"]))
        best["recommended"] = True
    return jsonify(rows)


@technicians_bp.route("/teams/new", methods=["GET", "POST"])
@role_required("administrator")
def create_team():
    """Create Team popup (see _handle_team_form)."""
    return _handle_team_form(None)


@technicians_bp.route("/teams/<int:team_id>", methods=["GET"])
@role_required("administrator")
def view_team(team_id):
    """Team details popup body: members, leader, status summary."""
    team = TechnicianTeam.query.get_or_404(team_id)
    jobs = _team_jobs(team)
    in_progress = [j for j in jobs if j["status"] == "in_progress"]
    return render_template(
        "technicians/_team_detail.html",
        team=team,
        team_status=team_status(team),
        jobs=jobs,
        in_progress=in_progress,
    )


_JOB_REQUEST_LABELS = {
    "new_installation": "New Installation",
    "disconnection": "Disconnection",
    "relocation": "Relocation",
    "upgrade": "Plan Upgrade",
    "add_nap": "Add NAP",
}


def _team_jobs(team):
    """Every ticket (repair or service order) assigned to any member of
    `team`, newest first, one row per ticket. A ticket dispatched to a
    team is stored as one Assignment per member, so rows are de-duplicated
    by the ticket they point at; when members disagree on status, the
    furthest-along one wins (in progress > accepted > assigned > ...)."""
    rank = {"in_progress": 4, "accepted": 3, "assigned": 2, "completed": 1, "cancelled": 0}
    by_ticket = {}
    for member in team.members:
        for a in member.assignments:
            if a.technical_issue_id is not None:
                key = ("TN", a.technical_issue_id)
            elif a.service_request_id is not None:
                key = ("SO", a.service_request_id)
            else:
                key = ("JOB", a.id)
            row = by_ticket.get(key)
            if row is not None and rank.get(row["status"], 0) >= rank.get(a.status, 0):
                continue

            issue, request_ = a.technical_issue, a.service_request
            if issue is not None:
                type_label = issue.issue_type
                subscriber = issue.subscriber
                address = (subscriber.address if subscriber and subscriber.address else issue.address)
                who = subscriber.full_name if subscriber else None
                code = issue.issue_code or f"ISS-{issue.id:04d}"
            elif request_ is not None:
                type_label = _JOB_REQUEST_LABELS.get(request_.request_type, request_.request_type)
                subscriber = request_.subscriber
                address = request_.address or (subscriber.address if subscriber else None)
                who = request_.full_name or (subscriber.full_name if subscriber else None)
                code = f"SO-{request_.id:04d}"
            else:
                type_label, address, who, code = "Job", None, None, f"Job #{a.id}"

            priority = (issue.priority if issue is not None else (request_.priority if request_ is not None else None))
            by_ticket[key] = {
                "code": code,
                "type": type_label,
                "who": who,
                "address": address,
                "status": a.status,
                "priority": priority,
                "assigned_at": a.assigned_at,
                "assigned_label": a.assigned_at.strftime("%b %d, %Y %I:%M %p") if a.assigned_at else "",
                "techs": [],
            }
        # every member holding this same ticket (for the "Assigned to" line)
        for a in member.assignments:
            if a.technical_issue_id is not None:
                k = ("TN", a.technical_issue_id)
            elif a.service_request_id is not None:
                k = ("SO", a.service_request_id)
            else:
                k = ("JOB", a.id)
            if k in by_ticket and member.full_name not in by_ticket[k]["techs"]:
                by_ticket[k]["techs"].append(member.full_name)
    return sorted(by_ticket.values(), key=lambda r: r["assigned_at"] or datetime.min, reverse=True)


@technicians_bp.route("/teams/<int:team_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_team(team_id):
    """Edit Team popup (see _handle_team_form)."""
    team = TechnicianTeam.query.get_or_404(team_id)
    return _handle_team_form(team)
