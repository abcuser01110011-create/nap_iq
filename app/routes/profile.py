"""
Profile Blueprint (Phase 12)
-------------------------------
Gives every signed-in account (Administrator, Technician, Customer —
and payment_collector, since nothing here restricts by role) a
self-service page to view its own account info, edit its own contact
details, and change its own password. This is the item PHASE11_NOTES.md
flagged as follow-up #1 ("no /profile route/page for any role yet").

Deliberately separate from app/routes/users.py: Manage Users lets an
Administrator edit *someone else's* account (including role), while
this module only ever touches `g.user`'s own row and never exposes a
role or username field to change. The two modules share the same
underlying `users` table but nothing else.

Routes:
    GET  /profile/                    -> index            (view own info)
    GET  /profile/edit                -> edit_profile      (show edit form)
    POST /profile/edit                -> edit_profile      (process edit form)
    GET  /profile/change-password     -> change_password   (show change-password form)
    POST /profile/change-password     -> change_password   (process change-password form)
"""

from flask import Blueprint, render_template, redirect, url_for, flash, g

from app.extensions import db
from app.auth import login_required
from app.forms import ProfileForm, ChangePasswordForm

profile_bp = Blueprint("profile", __name__, url_prefix="/profile")


@profile_bp.route("/")
@login_required
def index():
    """Read-only summary of the signed-in account's own info. Any
    authenticated, active account can reach this — no role_required
    restriction, since every role is entitled to see its own profile."""
    return render_template("profile/index.html")


@profile_bp.route("/edit", methods=["GET", "POST"])
@login_required
def edit_profile():
    """Lets the signed-in account edit its own full name, email, and
    phone number. Username and role are not editable here — see
    ProfileForm's docstring for why."""
    user = g.user
    form = ProfileForm(obj=user)
    form.user_id = user.id  # excludes this record from the email uniqueness check

    if form.validate_on_submit():
        user.full_name = form.full_name.data.strip()
        user.email = (form.email.data or "").strip() or None
        user.phone_number = (form.phone_number.data or "").strip() or None
        db.session.commit()
        flash("Your profile was updated successfully.", "success")
        return redirect(url_for("profile.index"))

    return render_template("profile/edit.html", form=form)


@profile_bp.route("/change-password", methods=["GET", "POST"])
@login_required
def change_password():
    """Lets the signed-in account change its own password. Requires
    the current password (unlike an administrator's Reset Password
    override in app/routes/users.py) so that a hijacked or left-open
    session can't be used to lock the real account owner out."""
    user = g.user
    form = ChangePasswordForm()

    if form.validate_on_submit():
        if not user.check_password(form.current_password.data):
            flash("Your current password is incorrect.", "danger")
            return render_template("profile/change_password.html", form=form)

        user.set_password(form.password.data)
        db.session.commit()
        flash("Your password has been changed.", "success")
        return redirect(url_for("profile.index"))

    return render_template("profile/change_password.html", form=form)
