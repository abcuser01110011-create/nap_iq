"""
Mobile API Authentication & RBAC Helpers (Phase 25)
-----------------------------------------------------
The JWT counterpart to app/auth.py, kept as its own module for the
same reason app/auth.py is split from routes/auth.py: so the decorator
used by every protected api_v1 view can be imported without dragging
in the /api/v1/auth/* route definitions themselves.

How a mobile request becomes "logged in":
    1. A successful POST to /api/v1/auth/login (app/routes/api_v1/auth.py)
       returns a short-lived access token and a longer-lived refresh
       token — no server-side session, no cookie. See app/config.py's
       JWT_ACCESS_TOKEN_EXPIRES / JWT_REFRESH_TOKEN_EXPIRES.
    2. The mobile app sends the access token as
       `Authorization: Bearer <token>` on every request. Flask-JWT-
       Extended verifies its signature/expiry; the `user_lookup_loader`
       registered in app/__init__.py turns that into `current_user`
       (a real User row), the same way `flask.g.user` works for the
       session-cookie side.
    3. Routes are protected with `@jwt_role_required("technician")` /
       `@jwt_role_required("user")` — the JWT analogue of
       `role_required()`. An expired/invalid/missing token, a
       deactivated account, or a disallowed role all get a JSON 401/403
       (never a redirect — there's no login *page* to redirect a
       mobile app to).

Logout: unlike a session cookie, a JWT is self-contained and would
normally stay valid until it expires even after "logout". See
app/models.py's RevokedToken and the `token_in_blocklist_loader` in
app/__init__.py for how POST /api/v1/auth/logout still invalidates a
token immediately.
"""

from functools import wraps

from flask import jsonify
from flask_jwt_extended import jwt_required, current_user

# Only these two roles get mobile apps (see NAP-IQ mobile apps plan) —
# an Administrator or Payment Collector JWT is never issued in the
# first place (app/routes/api_v1/auth.py's login() enforces this too),
# but this tuple is also what every jwt_role_required() call below
# checks against, so it's the single place that scope is defined.
MOBILE_API_ROLES = ("technician", "user")


def jwt_role_required(*roles):
    """Requires a valid access-token JWT whose account is active and
    whose role is one of `roles`. Use like
    `@jwt_role_required("technician")`.

    Mirrors app/auth.py's role_required(), but for JSON API responses
    instead of redirects:
      - No/invalid/expired token -> Flask-JWT-Extended's own 401
        handler (registered via JWTManager defaults) returns JSON
        automatically; this decorator doesn't need to handle that case
        itself since @jwt_required() below raises before this
        function's body runs.
      - Valid token, but the account was deactivated *after* the token
        was issued, or its role isn't in `roles` -> explicit 401/403
        JSON here, since Flask-JWT-Extended has no way to know either
        of those on its own.
    """

    def decorator(view):
        @jwt_required()
        @wraps(view)
        def wrapped_view(*args, **kwargs):
            user = current_user
            if user is None or user.status != "active":
                return jsonify(error="Account is not active. Please log in again."), 401
            if user.role not in roles:
                return jsonify(error="Not permitted for this account role."), 403
            return view(*args, **kwargs)

        return wrapped_view

    return decorator
