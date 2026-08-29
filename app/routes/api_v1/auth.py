"""
Mobile API Auth Blueprint (Phase 25 / Phase 26)
---------------------------------------
The token-based counterpart to app/routes/auth.py's session-cookie
/login — used only by the Technician and Customer mobile apps. See
app/jwt_auth.py's module docstring for how a request becomes "logged
in" under this scheme.

Routes:
    POST /api/v1/auth/login    -> login    (credentials -> token pair)
    POST /api/v1/auth/register -> register (Phase 30: pure username +
                                  password account creation -> auto-login;
                                  see app/routes/api_v1/customer.py's
                                  apply() for the "apply for service"
                                  step this used to include)
    POST /api/v1/auth/refresh  -> refresh  (refresh token -> new access token)
    POST /api/v1/auth/logout   -> logout   (revokes the presented token)
"""
import re

from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import (
    create_access_token,
    create_refresh_token,
    get_jwt,
    jwt_required,
)

from app.extensions import db, limiter
from app.jwt_auth import MOBILE_API_ROLES
from app.models import RevokedToken, User
from app.email_utils import send_verification_code, verify_code

api_v1_auth_bp = Blueprint("api_v1_auth", __name__, url_prefix="/api/v1/auth")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_REGISTRATION_EMAIL_PURPOSE = "registration"


def _send_code_email_key() -> str:
    """Rate-limit key for POST /api/v1/auth/send-verification-code —
    keyed by the submitted email (lowercased) rather than IP, so the
    limit is "how many codes can this address be sent" regardless of
    which device/IP is asking. Falls back to a constant string on a
    malformed body, same reasoning as _login_username_key above."""
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip().lower()
    return email or "no-email-submitted"


def _login_username_key() -> str:
    """Rate-limit key for the per-username /api/v1/auth/login limit.

    Same purpose as routes/auth.py's _login_username_key, adapted for
    a JSON body instead of a form post. Falls back to a constant
    string on a malformed/missing body so the per-username limiter
    always has a key — that request is still fully covered by the
    per-IP limit either way.
    """
    data = request.get_json(silent=True) or {}
    username = str(data.get("username") or "").strip().lower()
    return username or "no-username-submitted"


def _user_payload(user: User) -> dict:
    """The subset of a User row the mobile apps need after login/refresh
    — never the password hash, obviously."""
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "email": user.email,
    }


def _validate_registration(data: dict) -> dict:
    """Returns a field -> message dict of validation errors, empty if
    the payload is clean.

    Phase 30 (pure registration): register() now only ever creates the
    login itself — username + password. Everything else that used to
    live here (full name, email + verification, phone, install
    location, plan) moved to POST /api/v1/customer/apply
    (app/routes/api_v1/customer.py's _validate_application()), which
    runs *after* the account already exists and the applicant is
    signed in. This keeps username/password validation identical to
    before (still mirrors UserForm/AddUserForm in app/forms.py), it
    just no longer requires the rest of an application to exist first.
    """
    errors = {}

    username = str(data.get("username") or "").strip()
    if not (3 <= len(username) <= 50):
        errors["username"] = "Username must be between 3 and 50 characters."
    elif User.query.filter_by(username=username).first() is not None:
        errors["username"] = "This username is already taken. Choose a different one."

    password = str(data.get("password") or "")
    if len(password) < 8:
        errors["password"] = "Password must be at least 8 characters."

    return errors


@api_v1_auth_bp.route("/login", methods=["POST"])
# Same two independent limits as the web /login (routes/auth.py), and
# the same reasoning: per-IP stops one source hammering any/many
# accounts, per-username stops many IPs grinding a single account.
# Reuses the exact config values so both login paths are governed by
# the same brute-force policy from one place (app/config.py).
@limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"])
@limiter.limit(
    lambda: current_app.config["LOGIN_RATE_LIMIT_PER_USERNAME"],
    key_func=_login_username_key,
)
def login():
    """Exchanges a username/password for an access + refresh token
    pair. Only Technician and Customer ("user") accounts are issued
    tokens here — an Administrator or Payment Collector logging in
    still only ever uses the web dashboard's session-cookie login."""
    data = request.get_json(silent=True) or {}
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")

    if not username or not password:
        return jsonify(error="Username and password are required."), 400

    user = User.query.filter_by(username=username).first()

    # Same generic message whether the username doesn't exist or the
    # password is wrong, no early-return timing tell — mirrors
    # routes/auth.py's login() so this endpoint can't be used to
    # enumerate valid usernames either.
    if user is None or not user.check_password(password):
        return jsonify(error="Invalid username or password."), 401

    if user.status != "active":
        return jsonify(error="This account has been deactivated. Please contact an administrator."), 403

    if user.role not in MOBILE_API_ROLES:
        return jsonify(error="This account's role doesn't have a mobile app."), 403

    identity = str(user.id)
    access_token = create_access_token(identity=identity)
    refresh_token = create_refresh_token(identity=identity)

    return jsonify(
        access_token=access_token,
        refresh_token=refresh_token,
        user=_user_payload(user),
    ), 200


@api_v1_auth_bp.route("/register", methods=["POST"])
# Phase 26: looser than login's brute-force limits (this isn't a
# credential-guessing target the same way), but still capped per-IP
# — an uncapped register endpoint is a spam/fake-account vector.
@limiter.limit(lambda: current_app.config["REGISTER_RATE_LIMIT_PER_IP"])
def register():
    """Pure self-service account creation (Phase 30). Creates only a
    User (role='user', status='active') from a username + password —
    no Subscriber, no ServiceRequest, no email/location/plan required.

    This intentionally does NOT apply for service. A brand-new account
    has nothing pending review yet; it can log back in at any time
    with nothing else on file, and apply for service later (any
    number of sessions later) via POST /api/v1/customer/apply once
    signed in. See that endpoint (app/routes/api_v1/customer.py) for
    the flow this used to do in one step.

    On success, logs the new account straight in (returns a token
    pair, same shape as /login) so the mobile app can drop the person
    directly onto their dashboard without a separate login step.
    """
    data = request.get_json(silent=True) or {}
    errors = _validate_registration(data)
    if errors:
        return jsonify(errors=errors), 400

    username = str(data.get("username")).strip()
    password = str(data.get("password"))

    user = User(
        # full_name has no separate field on this screen (see
        # RegisterScreen) — defaulted to the username for now and
        # editable later from the profile screen or when applying for
        # service, rather than adding a nullable-full-name migration
        # just for this gap.
        username=username,
        full_name=username,
        role="user",
        status="active",
    )
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    identity = str(user.id)
    access_token = create_access_token(identity=identity)
    refresh_token = create_refresh_token(identity=identity)

    return jsonify(
        access_token=access_token,
        refresh_token=refresh_token,
        user=_user_payload(user),
    ), 201


@api_v1_auth_bp.route("/send-verification-code", methods=["POST"])
@limiter.limit(lambda: current_app.config["EMAIL_VERIFICATION_SEND_RATE_LIMIT"], key_func=_send_code_email_key)
def send_verification_code_route():
    """Sends a 6-digit one-time code to the submitted email via Gmail
    SMTP (app/email_utils.py), for the mobile Register screen's "verify
    your email" step. Always returns 200 with the same generic message
    regardless of whether the address is already registered or the
    send actually succeeded server-side — this endpoint intentionally
    never confirms/denies "is this email already in our system" (that
    check happens later, at POST /api/v1/customer/apply) and never
    reveals SMTP delivery failures to the client, only logs them.
    """
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip()

    if not email or len(email) > 100 or not _EMAIL_RE.match(email):
        return jsonify(error="Enter a valid email address."), 400

    send_verification_code(email, purpose=_REGISTRATION_EMAIL_PURPOSE)
    return jsonify(message="If that email is valid, a verification code has been sent."), 200


@api_v1_auth_bp.route("/verify-email-code", methods=["POST"])
@limiter.limit(lambda: current_app.config["EMAIL_VERIFICATION_SEND_RATE_LIMIT"], key_func=_send_code_email_key)
def verify_email_code_route():
    """Checks the code the applicant typed in against the one most
    recently sent to that email (app/email_utils.py's verify_code()).
    On success, the email is marked verified so POST /api/v1/customer/apply
    will accept it; on failure, returns the specific reason (expired,
    wrong, too many attempts, none requested) so the mobile UI can show it.
    """
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip()
    code = str(data.get("code") or "").strip()

    if not email or not code:
        return jsonify(error="Email and code are required."), 400

    ok, message = verify_code(email, code, purpose=_REGISTRATION_EMAIL_PURPOSE)
    if not ok:
        return jsonify(error=message), 400

    return jsonify(message="Email verified.", verified=True), 200


@api_v1_auth_bp.route("/refresh", methods=["POST"])
@jwt_required(refresh=True)
def refresh():
    """Exchanges a still-valid refresh token for a new access token.
    Re-checks the account's status/role at refresh time (not just at
    original login) so a deactivation or role change takes effect the
    next time the mobile app silently refreshes, not just at the next
    full login."""
    from flask_jwt_extended import get_jwt_identity

    user = User.query.get(int(get_jwt_identity()))

    if user is None or user.status != "active" or user.role not in MOBILE_API_ROLES:
        return jsonify(error="Account is no longer eligible. Please log in again."), 401

    new_access_token = create_access_token(identity=str(user.id))
    return jsonify(access_token=new_access_token), 200


@api_v1_auth_bp.route("/logout", methods=["POST"])
@jwt_required(verify_type=False)  # accepts either an access or a refresh token
def logout():
    """Revokes whichever token (access or refresh) was presented, by
    recording its jti in RevokedToken — see that model's docstring and
    the token_in_blocklist_loader in app/__init__.py for why this is
    necessary at all for a normally-stateless JWT. A mobile app should
    call this once per token it's holding (i.e. once for the access
    token, once for the refresh token) to fully sign out."""
    jti = get_jwt()["jti"]
    db.session.add(RevokedToken(jti=jti))
    db.session.commit()
    return jsonify(message="Logged out."), 200
