"""
Authentication Blueprint
--------------------------
The single login system for NAP-IQ. One login form serves every role
(Administrator / Technician / User); which interface a person lands on
after signing in is decided purely by the `role` column on their
`users` row (see ROLE_HOME_ENDPOINT in app/auth.py) — there is no
separate "admin login" vs "customer login" page to keep in sync.

Routes:
    GET  /login    -> login    (show the sign-in form)
    POST /login    -> login    (validate credentials, start a session)
    GET  /register -> register (show the self-service sign-up form)
    POST /register -> register (create the account, then sign it in)
    POST /logout   -> logout   (end the session)
    GET  /home     -> home     (redirect helper: sends a logged-in user
                                to whichever page matches their role)
"""

import re
import time

from flask import Blueprint, render_template, redirect, url_for, flash, request, session, g, current_app, jsonify

from wtforms.validators import ValidationError
from app.forms import LoginForm, SelfRegisterForm, validate_password_complexity
from app.models import User, USER_THEME_PREFERENCES
from app.auth import login_required, ROLE_HOME_ENDPOINT
from app.extensions import db, limiter
from app.email_utils import send_verification_code, verify_code, consume_verification
from sqlalchemy import func

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


def _next_url_allowed_for_role(next_url: str, role: str, user=None) -> bool:
    """True unless `next_url` resolves to a route that @role_required
    has restricted to roles that don't include `role`.

    `next` exists to send someone back to the exact page they were on
    before getting bounced to the login form -- genuinely convenient
    when the *same* account logs back in after e.g. a session timeout.
    But it travels as a plain query string / hidden login-form field,
    not anything tied to a specific account, so it can just as easily
    be left over from a DIFFERENT account's session in the same browser
    tab: an administrator's session expires while viewing an
    admin-only page (next=/that/page gets baked into the login form's
    action), they then sign in as a Technician on that same
    already-loaded form. Without this check, that Technician would be
    sent straight into the admin page and immediately hit a 403,
    instead of landing on their own dashboard the way ROLE_HOME_ENDPOINT
    guarantees everywhere else -- this closes that one gap.

    Routes with no @role_required (bare @login_required, or public)
    have nothing to violate and are always allowed here.
    """
    try:
        adapter = current_app.url_map.bind(request.host)
        endpoint, _args = adapter.match(next_url, method="GET")
    except Exception:
        # Doesn't resolve to a real GET route (unknown path, a
        # POST-only endpoint, a malformed value, ...) -- safest to not
        # honor it rather than guess.
        return False

    view = current_app.view_functions.get(endpoint)
    allowed_roles = getattr(view, "role_required_roles", None)
    if allowed_roles is not None and role not in allowed_roles:
        return False

    # Same leftover-`next` problem, one level deeper: a technician-allowed page
    # that points at ONE specific ticket (/technician/tickets/1). If that ticket
    # belongs to a different technician (the previous account in this browser),
    # the page would answer 403 "Access Denied" right after login.
    if user is not None and endpoint in ("technician.ticket_detail", "technician.mobile_job_detail"):
        from app.models import Assignment, Technician
        profile = Technician.query.filter_by(user_id=user.id).first()
        assignment = Assignment.query.get(_args.get("assignment_id")) if _args.get("assignment_id") else None
        return bool(profile and assignment and assignment.technician_id == profile.id)
    return True


def _login_limits(view):
    """Phase 18 brute-force protection (see config.py): per-IP and
    per-username limits, POST only. Shared by both sign-in pages."""
    view = limiter.limit(
        lambda: current_app.config["LOGIN_RATE_LIMIT_PER_USERNAME"],
        key_func=_login_username_key,
        methods=["POST"],
    )(view)
    return limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"], methods=["POST"])(view)


def _apply_login_theme(user, theme):
    """If the sign-in page was in a theme the visitor picked (light/dark),
    save it as the account's theme so the dashboard opens in the same mode.
    Ignored when absent or invalid (e.g. a brand-new browser)."""
    if theme in USER_THEME_PREFERENCES and user.theme_preference != theme:
        user.theme_preference = theme
        db.session.commit()


def _handle_login(portal):
    """Shared sign-in handler. `portal` is "staff" (administrator, staff,
    technician, collector... every role except 'user') or "customer"
    (role 'user' only, i.e. subscribers)."""
    # Already signed in? Send them straight to their role's home page.
    if g.get("user") is not None:
        return redirect(url_for("auth.home"))

    form = LoginForm()

    if form.validate_on_submit():
        username = form.username.data.strip()
        # Case-insensitive, like MySQL's default collation was (phone keyboards auto-capitalise).
        user = User.query.filter(func.lower(User.username) == username.lower()).first()

        # Same generic message whether the username doesn't exist or the
        # password is wrong (no username enumeration).
        if user is None or not user.check_password(form.password.data):
            flash("Invalid username or password.", "danger")
        elif user.status != "active":
            flash("This account has been deactivated. Please contact an administrator.", "danger")
        elif (portal == "staff") == (user.role == "user"):
            # Correct credentials, wrong door. Only said after the
            # password checked out, so it can't be used to probe accounts.
            if portal == "staff":
                flash("This sign-in is for staff only. Subscribers, please use the account login.", "danger")
            else:
                flash("This sign-in is for subscribers only. Staff, please use the staff login.", "danger")
        else:
            _apply_login_theme(user, request.form.get("theme"))
            session.clear()
            session["user_id"] = user.id
            session.permanent = True  # subject to PERMANENT_SESSION_LIFETIME

            flash(f"Welcome back, {user.full_name}.", "success")

            # Always land on the role's own dashboard (auth.home ->
            # ROLE_HOME_ENDPOINT: Administrator -> Dashboard, Technician ->
            # technician home, Collector -> collector home, Subscriber ->
            # customer home). A `?next=` deep link (e.g. the last page a
            # session expired on) is deliberately ignored so every sign-in
            # starts from the dashboard.
            return redirect(url_for("auth.home"))

    return render_template("auth/login.html", form=form, portal=portal)


@auth_bp.route("/login", methods=["GET", "POST"])
@_login_limits
def login():
    """Staff / administrator sign-in (every role except subscribers)."""
    return _handle_login("staff")


@auth_bp.route("/account/login", methods=["GET", "POST"])
@_login_limits
def customer_login():
    """Subscriber account sign-in, linked from the public landing page."""
    return _handle_login("customer")


@auth_bp.route("/register", methods=["GET", "POST"])
# Same reasoning as api_v1/auth.py's register(): looser than login's
# brute-force limits (this isn't a credential-guessing target), but
# still capped per-IP so an uncapped sign-up form isn't a spam/fake-
# account vector. Reuses the exact same config value so both
# registration paths (web and mobile) share one rate-limit policy.
@limiter.limit(lambda: current_app.config["REGISTER_RATE_LIMIT_PER_IP"], methods=["POST"])
def register():
    """Public self-service sign-up — the web counterpart to the mobile
    app's Register screen (RegisterScreen.tsx / POST
    /api/v1/auth/register). Reachable from the "Don't have an account?
    Register now" link on the sign-in page, in the same footer slot
    the mobile login screen uses it for (see login.html/LoginScreen.tsx).

    Phase 30 "pure registration" rule applies here identically to the
    mobile endpoint: this only ever creates the login itself —
    username + password, role='user', status='active'. No Subscriber,
    no ServiceRequest, no email/location/plan required up front; a
    brand-new account can apply for service later from the customer
    dashboard whenever it's ready, exactly as the mobile app's
    post-register "Apply for service" prompt describes.

    On success, signs the new account straight in (session cookie,
    mirroring login() above) and sends it to its dashboard home —
    matching RegisterScreen's "a successful register() signs the new
    account straight in" behavior, just via a session instead of a
    mobile token pair.
    """
    # Already signed in? Same behavior as login() above.
    if g.get("user") is not None:
        return redirect(url_for("auth.home"))

    form = SelfRegisterForm()

    if form.validate_on_submit():
        username = form.username.data.strip()

        user = User(
            # No separate full-name field on this form, same gap as
            # RegisterScreen -- defaulted to the username for now and
            # editable later from the account's profile page.
            username=username,
            full_name=username,
            role="user",
            status="active",
        )
        user.set_password(form.password.data)
        db.session.add(user)
        db.session.commit()

        session.clear()
        session["user_id"] = user.id
        session.permanent = True

        flash(f"Welcome, {user.full_name}. Your account has been created.", "success")
        return redirect(url_for("auth.home"))

    return render_template("auth/register.html", form=form)


@auth_bp.route("/logout", methods=["POST"])
def logout():
    """Ends the current session. POST-only (submitted via a small form
    with a CSRF token in the nav bar) so a logout can't be triggered
    by, e.g., an <img> tag or link on another site."""
    was_subscriber = g.get("user") is not None and g.user.role == "user"
    session.clear()
    flash("You have been logged out.", "success")
    # Subscribers go back to the public landing page, staff to /login.
    return redirect(url_for("main.index" if was_subscriber else "auth.login"))


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


# ---------------------------------------------------------------------
# Forgot password (staff login) — emailed 6-digit code
# ---------------------------------------------------------------------
# Flow (all JSON, CSRF token sent in the X-CSRFToken header):
#   1. POST /forgot-password/send    {email}                       -> emails a code
#   2. POST /forgot-password/verify  {email, code}              -> unlocks step 3
#   3. POST /forgot-password/reset   {password, confirm_password}  -> sets password
# Codes live in `email_verifications` (purpose="password_reset"), 10-min
# expiry and 5 attempts, via app/email_utils.py. Step 1 always returns the
# same message so it can't be used to discover which emails exist.
# Staff accounts only (role != 'user'); subscribers are not covered.

_PW_RESET_PURPOSE = "password_reset"
_PW_RESET_SESSION_KEY = "pw_reset"
_PW_RESET_WINDOW_SECONDS = 10 * 60
_GENERIC_SEND_MESSAGE = (
    "If that email belongs to a staff account, we've sent a 6-digit code to it."
)


def _forgot_key() -> str:
    data = request.get_json(silent=True) or {}
    return (str(data.get("email") or "").strip().lower()) or "no-email-submitted"


def _forgot_rate_limit(view):
    view = limiter.limit(
        lambda: current_app.config["EMAIL_VERIFICATION_SEND_RATE_LIMIT"],
        key_func=_forgot_key,
        methods=["POST"],
    )(view)
    return limiter.limit(
        lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"], methods=["POST"]
    )(view)


def _find_reset_user(email: str):
    """Active staff account with an email on file, or None."""
    email = (email or "").strip()
    if not email:
        return None
    user = User.query.filter(func.lower(User.email) == email.lower()).first()
    if user is None or user.status != "active" or user.role == "user":
        return None
    return user


@auth_bp.route("/forgot-password/send", methods=["POST"])
@_forgot_rate_limit
def forgot_password_send():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip()
    if not email:
        return jsonify(error="Enter your email address."), 400

    user = _find_reset_user(email)
    if user is not None:
        send_verification_code(user.email, purpose=_PW_RESET_PURPOSE)
    return jsonify(message=_GENERIC_SEND_MESSAGE), 200


@auth_bp.route("/forgot-password/verify", methods=["POST"])
@_forgot_rate_limit
def forgot_password_verify():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip()
    code = str(data.get("code") or "").strip()
    if not email or not re.fullmatch(r"\d{6}", code):
        return jsonify(error="Enter the 6-digit code."), 400

    user = _find_reset_user(email)
    if user is None:
        return jsonify(error="Incorrect code. Please try again."), 400

    ok, message = verify_code(user.email, code, purpose=_PW_RESET_PURPOSE)
    if not ok:
        return jsonify(error=message), 400

    session[_PW_RESET_SESSION_KEY] = {"uid": user.id, "ts": int(time.time())}
    return jsonify(message="Code verified. Enter your new password.", verified=True), 200


@auth_bp.route("/forgot-password/reset", methods=["POST"])
@limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"], methods=["POST"])
def forgot_password_reset():
    state = session.get(_PW_RESET_SESSION_KEY)
    if not state or time.time() - state.get("ts", 0) > _PW_RESET_WINDOW_SECONDS:
        session.pop(_PW_RESET_SESSION_KEY, None)
        return jsonify(error="Your reset session expired. Please request a new code."), 400

    user = db.session.get(User, state["uid"])
    if user is None or user.status != "active" or user.role == "user" or not user.email:
        session.pop(_PW_RESET_SESSION_KEY, None)
        return jsonify(error="This account can't be reset. Contact an administrator."), 400

    data = request.get_json(silent=True) or {}
    password = str(data.get("password") or "")
    confirm = str(data.get("confirm_password") or "")
    if password != confirm:
        return jsonify(error="Passwords do not match."), 400

    class _Field:  # reuse the project's password rules (forms.py)
        data = password

    try:
        validate_password_complexity(None, _Field)
    except ValidationError as exc:
        return jsonify(error=str(exc)), 400

    user.set_password(password)
    db.session.commit()
    consume_verification(user.email, purpose=_PW_RESET_PURPOSE)
    session.pop(_PW_RESET_SESSION_KEY, None)
    return jsonify(message="Password updated. You can now sign in."), 200
