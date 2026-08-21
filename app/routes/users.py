"""
Manage Users Blueprint (Administrator only)
----------------------------------------------
Phase 8. Gives Administrators a UI for the account management that,
per PHASE7_NOTES.md, previously only existed via direct SQL / seed
data: listing accounts, creating them, editing their details/role,
deactivating/reactivating them, and resetting a forgotten password.

This module manages `users` rows (login accounts) only. It does not
touch `subscribers` (customer service/billing records) or create
`technicians` profile rows for new technician accounts — both remain
their own follow-up items (see PHASE7_NOTES.md and app/routes/technician.py,
which already handles a technician account with no linked profile yet
by showing an empty state).

Routes:
    GET  /users/                      -> list_users     (search + role/status filter)
    GET  /users/add                   -> add_user        (show add form)
    POST /users/add                   -> add_user        (process add form)
    GET  /users/<id>/edit             -> edit_user        (show edit form)
    POST /users/<id>/edit             -> edit_user        (process edit form)
    POST /users/<id>/deactivate       -> deactivate_user  (soft-deactivate)
    POST /users/<id>/activate         -> activate_user    (reactivate)
    GET  /users/<id>/reset-password   -> reset_password   (show reset form)
    POST /users/<id>/reset-password   -> reset_password   (process reset form)
"""

from flask import Blueprint, render_template, redirect, url_for, request, flash, g

from app.extensions import db
from app.auth import role_required
from app.models import User, Subscriber
from app.forms import UserForm, AddUserForm, ResetPasswordForm, ROLE_CHOICES

users_bp = Blueprint("users", __name__, url_prefix="/users")

ROLE_LABELS = dict(ROLE_CHOICES)


def _populate_subscriber_link_choices(form, *, current_subscriber_id=None):
    """Fills in the 'Linked Subscriber' dropdown (Phase 10) with every
    subscriber that isn't already linked to a *different* account,
    plus whichever one this account is currently linked to (so editing
    an already-linked account doesn't wipe the choice out from under
    it). Not scoped to role=='user' here — the field is harmless to
    populate regardless of role; the route only *acts* on it when the
    submitted role is 'user'.
    """
    query = Subscriber.query.filter(
        db.or_(Subscriber.user_id.is_(None), Subscriber.user_id == current_subscriber_id)
    )
    subscribers = query.order_by(Subscriber.full_name).all()
    form.subscriber_id.choices = [(0, "-- Not linked --")] + [
        (s.id, f"{s.subscriber_code} — {s.full_name}") for s in subscribers
    ]


@users_bp.route("/")
@role_required("administrator")
def list_users():
    """Displays all user accounts, with optional search (by username,
    full name, or email) and role/status filtering via query string
    parameters (?q=...&role=...&status=...).

    Accounts are never physically deleted from here, so this list also
    shows deactivated accounts unless the admin filters them out — this
    keeps a full record of who has ever had access.
    """
    search_term = request.args.get("q", "").strip()
    role_filter = request.args.get("role", "").strip()
    status_filter = request.args.get("status", "").strip()

    query = User.query

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.filter(
            db.or_(
                User.username.ilike(like_pattern),
                User.full_name.ilike(like_pattern),
                User.email.ilike(like_pattern),
            )
        )

    if role_filter:
        query = query.filter(User.role == role_filter)

    if status_filter in ("active", "inactive", "suspended"):
        query = query.filter(User.status == status_filter)

    users = query.order_by(User.full_name.asc()).all()

    return render_template(
        "users/list.html",
        users=users,
        search_term=search_term,
        role_filter=role_filter,
        status_filter=status_filter,
        role_choices=ROLE_CHOICES,
        role_labels=ROLE_LABELS,
    )


@users_bp.route("/add", methods=["GET", "POST"])
@role_required("administrator")
def add_user():
    """Shows and processes the Add User form."""
    form = AddUserForm()
    form.user_id = None  # no existing record to exclude during uniqueness checks
    _populate_subscriber_link_choices(form)

    if form.validate_on_submit():
        user = User(
            username=form.username.data.strip(),
            full_name=form.full_name.data.strip(),
            email=(form.email.data or "").strip() or None,
            phone_number=(form.phone_number.data or "").strip() or None,
            role=form.role.data,
        )
        user.set_password(form.password.data)
        db.session.add(user)
        db.session.commit()  # need user.id before it can be a subscriber FK target

        # Phase 10: optional Subscriber link, Customer accounts only —
        # see the field's docstring in app/forms.py for why non-'user'
        # roles never act on this value even if one somehow arrived.
        if form.role.data == "user" and form.subscriber_id.data:
            subscriber = Subscriber.query.get(form.subscriber_id.data)
            if subscriber is not None:
                subscriber.user_id = user.id
                db.session.commit()

        flash(f"Account '{user.username}' was created successfully.", "success")
        return redirect(url_for("users.list_users"))

    return render_template("users/form.html", form=form, mode="add", user=None)


@users_bp.route("/<int:user_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_user(user_id):
    """Shows and processes the Edit User form. Password is not editable
    here — see reset_password() below."""
    user = User.query.get_or_404(user_id)
    linked_subscriber = Subscriber.query.filter_by(user_id=user.id).first()

    # On GET, `obj=user` pre-fills the form with the account's current
    # values. On POST, submitted form data automatically takes precedence.
    form = UserForm(obj=user)
    form.user_id = user.id  # excludes this record from the uniqueness checks
    _populate_subscriber_link_choices(
        form, current_subscriber_id=linked_subscriber.id if linked_subscriber else None
    )
    if request.method == "GET" and linked_subscriber is not None:
        form.subscriber_id.data = linked_subscriber.id

    if form.validate_on_submit():
        # Guard: an administrator can't demote their own account away
        # from Administrator. Without this, a lone admin could lock
        # themself out of Manage Users (and every other admin-only
        # page) with no other admin necessarily around to undo it.
        if user.id == g.user.id and form.role.data != "administrator":
            flash("You can't change your own role away from Administrator.", "danger")
            return render_template("users/form.html", form=form, mode="edit", user=user)

        user.username = form.username.data.strip()
        user.full_name = form.full_name.data.strip()
        user.email = (form.email.data or "").strip() or None
        user.phone_number = (form.phone_number.data or "").strip() or None
        user.role = form.role.data

        # Phase 10: reconcile the Subscriber link against whatever was
        # submitted. Only a 'user'-role account can hold a link at
        # all — changing away from 'user' always drops any existing
        # link rather than leaving a stale, inaccessible one behind.
        desired_subscriber_id = form.subscriber_id.data if form.role.data == "user" else 0
        current_subscriber_id = linked_subscriber.id if linked_subscriber else 0

        if desired_subscriber_id != current_subscriber_id:
            if linked_subscriber is not None:
                linked_subscriber.user_id = None
            if desired_subscriber_id:
                new_subscriber = Subscriber.query.get(desired_subscriber_id)
                if new_subscriber is not None:
                    new_subscriber.user_id = user.id

        db.session.commit()
        flash(f"Account '{user.username}' was updated successfully.", "success")
        return redirect(url_for("users.list_users"))

    return render_template("users/form.html", form=form, mode="edit", user=user)


@users_bp.route("/<int:user_id>/deactivate", methods=["POST"])
@role_required("administrator")
def deactivate_user(user_id):
    """Soft-deactivates an account by setting `status` to 'inactive'. The
    account row itself is never physically deleted. A deactivated
    account is treated as logged out on its very next request even if
    its browser still has a valid session cookie (see
    `load_logged_in_user` in app/auth.py)."""
    user = User.query.get_or_404(user_id)

    if user.id == g.user.id:
        flash("You can't deactivate your own account while signed in as it.", "danger")
        return redirect(request.referrer or url_for("users.list_users"))

    if user.role == "administrator":
        other_active_admins = User.query.filter(
            User.role == "administrator",
            User.status == "active",
            User.id != user.id,
        ).count()
        if other_active_admins == 0:
            flash(
                "Can't deactivate the last active Administrator account — "
                "promote another account to Administrator first.",
                "danger",
            )
            return redirect(request.referrer or url_for("users.list_users"))

    user.status = "inactive"
    db.session.commit()
    flash(f"Account '{user.username}' has been deactivated.", "success")
    return redirect(request.referrer or url_for("users.list_users"))


@users_bp.route("/<int:user_id>/activate", methods=["POST"])
@role_required("administrator")
def activate_user(user_id):
    """Reactivates a previously deactivated account."""
    user = User.query.get_or_404(user_id)
    user.status = "active"
    db.session.commit()
    flash(f"Account '{user.username}' has been reactivated.", "success")
    return redirect(request.referrer or url_for("users.list_users"))


@users_bp.route("/<int:user_id>/reset-password", methods=["GET", "POST"])
@role_required("administrator")
def reset_password(user_id):
    """Lets an administrator set a new password for an account — an
    override for e.g. a user who forgot theirs, with no self-service
    email flow. Deliberately its own page/route rather than a field on
    the edit form, so a routine name/role edit can never accidentally
    resubmit or clear a password."""
    user = User.query.get_or_404(user_id)
    form = ResetPasswordForm()

    if form.validate_on_submit():
        user.set_password(form.password.data)
        db.session.commit()
        flash(f"Password for '{user.username}' has been reset.", "success")
        return redirect(url_for("users.list_users"))

    return render_template("users/reset_password.html", form=form, user=user)
