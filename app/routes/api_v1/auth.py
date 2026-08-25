"""
Mobile API Auth Blueprint (Phase 25 / Phase 26)
---------------------------------------
The token-based counterpart to app/routes/auth.py's session-cookie
/login — used only by the Technician and Customer mobile apps. See
app/jwt_auth.py's module docstring for how a request becomes "logged
in" under this scheme.

Routes:
    POST /api/v1/auth/login    -> login    (credentials -> token pair)
    POST /api/v1/auth/register -> register (Phase 26: new customer
                                  self-registration -> auto-login)
    POST /api/v1/auth/refresh  -> refresh  (refresh token -> new access token)
    POST /api/v1/auth/logout   -> logout   (revokes the presented token)
"""
from app.extensions import db, limiter
from app.jwt_auth import MOBILE_API_ROLES
from app.models import RevokedToken, User, Subscriber
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
from app.models import Plan, RevokedToken, ServiceRequest, Subscriber, User
from app.nap_recommendation import recommend_naps
from app.email_utils import (
    consume_verification,
    is_email_verified,
    send_verification_code,
    verify_code,
)

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
    the payload is clean. Mirrors the rules UserForm/AddUserForm
    already enforce on the web side (app/forms.py) so an account
    created here follows the exact same constraints as one an
    administrator creates — just enforced by hand since this endpoint
    takes JSON, not a WTForm post.
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

    full_name = str(data.get("full_name") or "").strip()
    if not full_name or len(full_name) > 100:
        errors["full_name"] = "Full name is required (max 100 characters)."

    email = str(data.get("email") or "").strip() or None
    if email:
        if len(email) > 100 or not _EMAIL_RE.match(email):
            errors["email"] = "Enter a valid email address."
        elif User.query.filter_by(email=email).first() is not None:
            errors["email"] = "This email is already registered."
        elif not is_email_verified(email, purpose=_REGISTRATION_EMAIL_PURPOSE):
            # Applicant must have completed the send-code / verify-code
            # exchange below for this exact email before the account
            # can be created — see app/email_utils.py's is_email_verified().
            errors["email"] = "Please verify this email address before submitting."
    else:
        # Email verification is the whole point of this phase, so an
        # applicant can no longer skip providing one the way the
        # earlier optional-email registration allowed.
        errors["email"] = "Email is required so we can verify it and send you updates."

    phone_number = str(data.get("phone_number") or "").strip() or None
    if phone_number and len(phone_number) > 20:
        errors["phone_number"] = "Phone number is too long."

    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        errors["location"] = "A valid installation location (latitude/longitude) is required."

    plan_name = str(data.get("plan_name") or "").strip() or None
    if plan_name and Plan.query.filter_by(name=plan_name).first() is None:
        errors["plan_name"] = "Selected plan is no longer available."

    address = str(data.get("address") or "").strip() or None
    if address and len(address) > 255:
        errors["address"] = "Address is too long."

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
    """Self-service customer registration (Phase 26). Creates a User
    (role='user'), a linked Subscriber in 'pending_review' status
    (NOT 'active' — see app/models.py's Subscriber.status comment),
    and a ServiceRequest(request_type='new_installation') so the
    application immediately shows up in the admin's existing
    service_requests review queue (app/routes/service_requests.py) —
    no new admin-side workflow needed, it's the same queue staff-
    created requests already land in.

    Re-checks coverage at submit time via app.nap_recommendation
    (not just trusting whatever the app's earlier coverage-check call
    said) for the same reason quick_add_subscriber() re-validates NAP
    capacity — the frontend's earlier check can go stale between
    screens.

    On success, logs the new account straight in (returns a token
    pair, same shape as /login) so the mobile app can drop the person
    directly onto their pending-application status screen without a
    separate login step.
    """
    data = request.get_json(silent=True) or {}
    errors = _validate_registration(data)
    if errors:
        return jsonify(errors=errors), 400

    latitude = float(data["latitude"])
    longitude = float(data["longitude"])

    if not recommend_naps(latitude, longitude, limit=1):
        return (
            jsonify(
                error="Sorry, we don't currently have coverage at this location. "
                "We'll notify you when service becomes available."
            ),
            422,
        )

    username = str(data.get("username")).strip()
    password = str(data.get("password"))
    full_name = str(data.get("full_name")).strip()
    email = str(data.get("email") or "").strip() or None
    phone_number = str(data.get("phone_number") or "").strip() or None
    plan_name = str(data.get("plan_name") or "").strip() or None
    address = str(data.get("address") or "").strip() or None

    user = User(
        username=username,
        full_name=full_name,
        email=email,
        phone_number=phone_number,
        role="user",
        status="active",
    )
    user.set_password(password)
    db.session.add(user)
    db.session.flush()  # assigns user.id, needed below

    subscriber = Subscriber(
        # Temporary unique placeholder — user.id is already unique at
        # this point, so this can never collide with a concurrent
        # registration the way a shared constant like "PENDING" could.
        # Overwritten with the real SUB-#### code right after this
        # row gets its own id.
        subscriber_code=f"PENDING-{user.id}",
        full_name=full_name,
        address=address,
        latitude=latitude,
        longitude=longitude,
        contact_number=phone_number,
        email=email,
        plan_type=plan_name,
        nap_id=None,  # set later by admin via the existing assign-nap flow
        user_id=user.id,
        status="pending_review",
    )
    db.session.add(subscriber)
    db.session.flush()  # assigns subscriber.id
    subscriber.subscriber_code = f"SUB-{subscriber.id:04d}"

    service_request = ServiceRequest(
        request_type="new_installation",
        subscriber_id=subscriber.id,
        latitude=latitude,
        longitude=longitude,
        status="pending",
        notes=f"Self-registered via mobile app. Plan requested: {plan_name or 'not specified'}.",
    )
    db.session.add(service_request)
    db.session.commit()

    # The email's verification record has now done its job — remove it
    # so it can't be replayed against a second registration attempt.
    if email:
        consume_verification(email, purpose=_REGISTRATION_EMAIL_PURPOSE)

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
    check happens later, at register()) and never reveals SMTP
    delivery failures to the client, only logs them.
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
    On success, the email is marked verified so register() above will
    accept it; on failure, returns the specific reason (expired, wrong,
    too many attempts, none requested) so the mobile UI can show it.
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
