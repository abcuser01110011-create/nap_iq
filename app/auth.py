"""
Authentication & Role-Based Access Control Helpers
-----------------------------------------------------
This module holds the pieces every protected route needs, kept
separate from routes/auth.py (which only owns the /login and /logout
views) so decorators can be imported from here without dragging the
login blueprint's route definitions along with them.

How a request becomes "logged in":
    1. A successful POST to /login stores only `user_id` in the signed,
       server-secret-keyed Flask session cookie — never the password
       or password hash.
    2. `load_logged_in_user` runs on every request (registered as a
       `before_request` hook in app/__init__.py) and looks that id up
       in MySQL, attaching the row to `flask.g.user` for the rest of
       the request. Inactive accounts are treated as logged out even
       if a stale session cookie still references them.
    3. Routes are protected with `@login_required` (any authenticated,
       active user) or `@role_required("administrator", ...)` (only
       the listed roles). Both redirect unauthenticated visitors to
       the login page, and both are safe to stack on any view.
"""

from functools import wraps

from flask import g, session, redirect, url_for, flash, request, abort

from app.models import User

# Where each role lands after login / when it hits its own "home".
# Centralized here so routes/auth.py and the RBAC decorators below
# always agree on the same mapping.
ROLE_HOME_ENDPOINT = {
    "administrator": "dashboard.index",
    "field_assistant": "technician.index",
    "user": "customer.index",
    # Phase 10: payment_collector now has its own real landing page
    # (see app/routes/collector.py) instead of the "no dashboard yet"
    # message noted as a follow-up in PHASE7_NOTES.md.
    "payment_collector": "collector.index",
}


def load_logged_in_user() -> None:
    """Populates `flask.g.user` from the session cookie, if any.

    Registered via `app.before_request` in the application factory so
    it runs before every view function, including ones with no
    decorators at all (templates can then safely check `g.user`).
    """
    user_id = session.get("user_id")

    if user_id is None:
        g.user = None
        return

    user = db_get_user(user_id)

    # A deleted account or one an administrator has since deactivated
    # should not remain usable just because the browser still has a
    # valid session cookie for it.
    if user is None or user.status != "active":
        session.clear()
        g.user = None
        return

    g.user = user


def db_get_user(user_id):
    """Small indirection so this module doesn't need a top-level
    `from app.extensions import db` import purely for a get-by-id."""
    return User.query.get(user_id)


def login_required(view):
    """Requires any authenticated, active account — no role check."""

    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if g.get("user") is None:
            flash("Please log in to continue.", "warning")
            return redirect(url_for("auth.login", next=request.path))
        return view(*args, **kwargs)

    return wrapped_view


def role_required(*roles):
    """Requires an authenticated, active account whose role is one of
    `roles`. Use like `@role_required("administrator")` or
    `@role_required("administrator", "field_assistant")`.

    Unauthenticated visitors are sent to /login (with `next` set so
    they land back here after logging in). Authenticated users whose
    role isn't allowed get a 403 rather than a redirect loop back to a
    page they still can't see — this is what stops, e.g., a Technician
    or Customer from reaching an admin-only URL just by typing it in.
    """

    def decorator(view):
        @wraps(view)
        def wrapped_view(*args, **kwargs):
            if g.get("user") is None:
                flash("Please log in to continue.", "warning")
                return redirect(url_for("auth.login", next=request.path))
            if g.user.role not in roles:
                abort(403)
            return view(*args, **kwargs)

        return wrapped_view

    return decorator
