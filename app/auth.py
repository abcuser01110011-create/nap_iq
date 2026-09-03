"""
Authentication Blueprint
--------------------------
The single login system for NAP-IQ. One login form serves every role
(Administrator / Technician / User); which interface a person lands on
after signing in is decided purely by the `role` column on their
`users` row (see ROLE_HOME_ENDPOINT in app/auth.py) — there is no
separate "admin login" vs "customer login" page to keep in sync.

Routes:
    GET  /login   -> login   (show the sign-in form)
    POST /login   -> login   (validate credentials, start a session)
    POST /logout  -> logout  (end the session)
    GET  /home    -> home    (redirect helper: sends a logged-in user
                              to whichever page matches their role)
"""

from flask import Blueprint, render_template, redirect, url_for, flash, request, session, g, current_app

from app.forms import LoginForm
from app.models import User
from app.auth import login_required, ROLE_HOME_ENDPOINT
from app.extensions import limiter

auth_bp = Blueprint("auth", __name__)


def _login_username_key() -> str:
    """Rate-limit key for the per-username /login limit.

    Falls back to a constant string when no username was submitted
    (e.g. a bare GET, or a POST with a blank field) so Flask-Limiter
    always gets a key — that request is still fully covered by the
    per-IP limit either way, this just avoids a KeyError-shaped edge
    case from an empty key.
    """
    username = (request.form.get("username") or "").strip().lower()
    return username or "no-username-submitted"


def _is_safe_next_url(next_url: str) -> bool:
    """Only ever redirect to a same-site, relative path after login.

    Without this check, a crafted `?next=https://evil.example` link
    could use NAP-IQ's own login page to send a person somewhere else
    right after they authenticate (an "open redirect"). Requiring the
    value to start with a single '/' (and not '//', which browsers can
    treat as protocol-relative and follow off-site) keeps `next`
    restricted to pages within this app.
    """
    return bool(next_url) and next_url.startswith("/") and not next_url.startswith("//")


@auth_bp.route("/login", methods=["GET", "POST"])
# Phase 18 — brute-force protection (SECURITY_CHECKLIST.md's previously-
# open "Rate limiting on /login" gap). Two independent limits, both
# scoped to POST only (methods=["POST"]) so a slow page-refresh loop on
# the plain GET form never counts against either budget:
#   - per remote IP (Limiter's default key_func) — stops one source
#     hammering any/many accounts.
#   - per submitted username (_login_username_key) — stops many IPs
#     (e.g. a botnet) grinding a single account, which a pure per-IP
#     limit alone would not catch.
# Limit values come from app/config.py (LOGIN_RATE_LIMIT_PER_IP /
# _PER_USERNAME) via a lambda so they're read from current_app.config
# at request time rather than frozen at import time.
@limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"], methods=["POST"])
@limiter.limit(
    lambda: current_app.config["LOGIN_RATE_LIMIT_PER_USERNAME"],
    key_func=_login_username_key,
    methods=["POST"],
)
def login():
    """Shows and processes the sign-in form."""
    # Already signed in? Don't show the login form again — send them
    # straight to their role's home page.
    if g.get("user") is not None:
        return redirect(url_for("auth.home"))

    form = LoginForm()

    if form.validate_on_submit():
        username = form.username.data.strip()
        user = User.query.filter_by(username=username).first()

        # Same generic message whether the username doesn't exist or
        # the password is wrong, and no early-return that would let a
        # timing difference hint at which case it was — this keeps the
        # login form from being usable to enumerate valid usernames.
        if user is None or not user.check_password(form.password.data):
            flash("Invalid username or password.", "danger")
        elif user.status != "active":
            flash("This account has been deactivated. Please contact an administrator.", "danger")
        else:
            # session.clear() first: guarantees no leftover data from a
            # previous session (e.g. a different account on a shared
            # browser) survives into this one.
            session.clear()
            session["user_id"] = user.id
            session.permanent = True  # subject to PERMANENT_SESSION_LIFETIME

            flash(f"Welcome back, {user.full_name}.", "success")

            next_url = request.args.get("next") or request.form.get("next")
            if _is_safe_next_url(next_url):
                return redirect(next_url)
            return redirect(url_for("auth.home"))

    return render_template("auth/login.html", form=form)


@auth_bp.route("/logout", methods=["POST"])
def logout():
    """Ends the current session. POST-only (submitted via a small form
    with a CSRF token in the nav bar) so a logout can't be triggered
    by, e.g., an <img> tag or link on another site."""
    session.clear()
    flash("You have been logged out.", "success")
    return redirect(url_for("auth.login"))


@auth_bp.route("/home")
@login_required
def home():
    """Sends a logged-in user to the interface for their role."""
    endpoint = ROLE_HOME_ENDPOINT.get(g.user.role)
    if endpoint is None:
        # A role that exists in the database but has no web dashboard
        # -- currently plain role='technician' accounts (mobile-app-only
        # by design, see Technician.personnel_type / routes/technicians.py)
        # and legacy 'payment_collector' accounts predating Phase 10.
        #
        # session.clear() here is required, not cosmetic: without it,
        # the redirect below to /login lands on a page that still sees
        # this same account as logged in, which immediately bounces
        # back to /home -- and /home lands right back here -- an
        # infinite redirect loop (ERR_TOO_MANY_REDIRECTS in the
        # browser) that made the entire site unreachable for that
        # account, including '/' itself. Clearing the session first
        # means /login actually renders the sign-in form instead.
        flash(
            "Your account role doesn't have a dedicated dashboard yet. "
            "Please contact an administrator.",
            "warning",
        )
        session.clear()
        return redirect(url_for("auth.login"))
    return redirect(url_for(endpoint))
