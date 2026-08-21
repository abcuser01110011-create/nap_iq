"""
Mobile API Auth Blueprint (Phase 25)
---------------------------------------
The token-based counterpart to app/routes/auth.py's session-cookie
/login — used only by the Technician and Customer mobile apps. See
app/jwt_auth.py's module docstring for how a request becomes "logged
in" under this scheme.

Routes:
    POST /api/v1/auth/login    -> login    (credentials -> token pair)
    POST /api/v1/auth/refresh  -> refresh  (refresh token -> new access token)
    POST /api/v1/auth/logout   -> logout   (revokes the presented token)
"""

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

api_v1_auth_bp = Blueprint("api_v1_auth", __name__, url_prefix="/api/v1/auth")


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
