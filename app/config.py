"""
Application Configuration
--------------------------
Centralizes all configuration values for NAP-IQ. Values are pulled from
environment variables (loaded from a local .env file via python-dotenv)
so that secrets and machine-specific settings never get hard-coded or
committed to version control.
"""

import os
from datetime import timedelta
from dotenv import load_dotenv

# Load variables from a .env file located at the project root, if present.
load_dotenv()


def _get_bool(env_var: str, default: str = "True") -> bool:
    """Helper to safely parse boolean-like environment variables."""
    return os.environ.get(env_var, default).strip().lower() in ("1", "true", "yes", "on")


class Config:
    """Base configuration shared by the whole application."""

    # ---- General Flask settings ----
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
    DEBUG = _get_bool("FLASK_DEBUG", "True")

    # ---- Session / authentication settings (Phase 7) ----
    # Flask's session cookie is signed (tamper-evident) using SECRET_KEY
    # but is NOT encrypted, so only non-sensitive data (just `user_id`)
    # is ever stored in it — see app/routes/auth.py.
    SESSION_COOKIE_HTTPONLY = True  # JavaScript can never read the session cookie
    SESSION_COOKIE_SAMESITE = "Lax"  # blocks the cookie being sent on most cross-site requests
    # Only set the Secure flag once the app is actually served over
    # HTTPS (a local http:// dev server can't set a Secure cookie at
    # all, so this defaults to False and MUST be set True in .env for
    # any real deployment).
    SESSION_COOKIE_SECURE = _get_bool("SESSION_COOKIE_SECURE", "False")
    PERMANENT_SESSION_LIFETIME = timedelta(
        minutes=int(os.environ.get("SESSION_LIFETIME_MINUTES", "60"))
    )

    # ---- Mobile API token auth (Phase 25) ----
    # Backs app/extensions.py's `jwt` (Flask-JWT-Extended), used only
    # by the api_v1 blueprints for the Technician and Customer mobile
    # apps — the HTML app keeps using the session cookie above
    # unchanged. Defaults to SECRET_KEY so no extra .env value is
    # required to get started, but a dedicated JWT_SECRET_KEY is
    # recommended for any real deployment so the two can be rotated
    # independently.
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", SECRET_KEY)
    # Short-lived access token: limits how long a stolen/leaked token
    # stays usable. The mobile apps are expected to silently call
    # POST /api/v1/auth/refresh (using the longer-lived refresh token
    # below) when a request comes back 401, rather than a person ever
    # needing to log in again every 15 minutes.
    JWT_ACCESS_TOKEN_EXPIRES = timedelta(
        minutes=int(os.environ.get("JWT_ACCESS_TOKEN_EXPIRES_MINUTES", "15"))
    )
    # Long-lived refresh token: how long a mobile app can stay "logged
    # in" (silently refreshing) without the person re-entering their
    # password. 30 days by default — a technician or customer signing
    # in once and staying signed in is the expected mobile pattern,
    # unlike the 60-minute web session above.
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(
        days=int(os.environ.get("JWT_REFRESH_TOKEN_EXPIRES_DAYS", "30"))
    )
    # Tokens are only ever sent as "Authorization: Bearer <token>" by
    # the mobile apps, never as a cookie — turning cookie support off
    # here means a JWT can't accidentally also function as a session
    # cookie, keeping the two auth mechanisms fully separate.
    JWT_TOKEN_LOCATION = ["headers"]

    # ---- Rate limiting (Phase 18) ----
    # Backs app/extensions.py's `limiter`. In-memory storage (Flask-
    # Limiter's default when this is unset) only tracks attempts within
    # a single process — fine for local dev / a single-worker
    # deployment, but each worker would keep its own separate counters
    # under a multi-process/multi-machine deployment (e.g. gunicorn
    # with >1 worker), which weakens the limit. Point this at a shared
    # store such as Redis in that case, e.g.
    # RATELIMIT_STORAGE_URI=redis://localhost:6379/0 in .env.
    RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")
    # Applied to POST /login by app/routes/auth.py. Two comma-separated
    # limits are used there: a per-IP limit (this value) and a tighter
    # per-submitted-username limit, so distributing attempts across
    # many IPs against one account is still caught. Overridable per
    # deployment without a code change.
    LOGIN_RATE_LIMIT_PER_IP = os.environ.get("LOGIN_RATE_LIMIT_PER_IP", "10 per minute")
    LOGIN_RATE_LIMIT_PER_USERNAME = os.environ.get("LOGIN_RATE_LIMIT_PER_USERNAME", "5 per minute")

    # ---- HTTPS enforcement (Phase 18) ----
    # SESSION_COOKIE_SECURE (above) only controls whether the session
    # cookie is marked Secure — it does not redirect or reject a plain
    # HTTP request. This is the separate control for that, applied by
    # `_enforce_https()` in app/__init__.py.
    #
    # Defaults to False because a local http:// dev server has no TLS
    # to redirect to, and because many production deployments already
    # terminate TLS (and redirect HTTP->HTTPS) at a reverse proxy or
    # load balancer in front of the app, which makes an in-app redirect
    # redundant. Set FORCE_HTTPS=True in .env for a deployment where
    # Flask itself is the first hop that sees plain HTTP traffic.
    FORCE_HTTPS = _get_bool("FORCE_HTTPS", "False")
    # When running behind a reverse proxy that terminates TLS, the
    # proxy talks to Flask over plain HTTP internally and forwards the
    # original scheme via the X-Forwarded-Proto header. Only trust that
    # header if the deployment's proxy is actually known to set it
    # correctly — trusting it blindly with no proxy in front would let
    # a client fake "already HTTPS" by setting the header itself.
    TRUST_X_FORWARDED_PROTO = _get_bool("TRUST_X_FORWARDED_PROTO", "False")
    # ---- Technician assignment completion photos (mobile app) ----
    # Where POST /api/v1/technician/assignments/<id>/photo saves the
    # required completion photo. Lives under app/static so it's
    # servable directly by Flask's static handler without a separate
    # route — see _serialize_assignment()'s photo_url in
    # api_v1/technician.py for how the mobile app is given a URL to it.
    UPLOAD_FOLDER = os.environ.get(
        "ASSIGNMENT_PHOTO_UPLOAD_FOLDER",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "uploads", "assignment_photos"),
    )
    # Flask rejects any request body larger than this with a 413
    # before it even reaches the route — a blanket safety net against
    # an oversized upload, on top of the mobile app already
    # compressing photos before sending them. 8 MB comfortably covers
    # a compressed phone photo with headroom.
    MAX_CONTENT_LENGTH = int(os.environ.get("MAX_UPLOAD_SIZE_BYTES", str(8 * 1024 * 1024)))

    # ---- MySQL connection settings ----

    # ---- MySQL connection settings ----
    MYSQL_HOST = os.environ.get("MYSQL_HOST", "localhost")
    MYSQL_PORT = os.environ.get("MYSQL_PORT", "3306")
    MYSQL_USER = os.environ.get("MYSQL_USER", "root")
    MYSQL_PASSWORD = os.environ.get("MYSQL_PASSWORD", "")
    MYSQL_DB = os.environ.get("MYSQL_DB", "nap_iq")

    # SQLAlchemy connects to MySQL through the PyMySQL driver.
    SQLALCHEMY_DATABASE_URI = (
        f"mysql+pymysql://{MYSQL_USER}:{MYSQL_PASSWORD}"
        f"@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DB}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Verifies connections are alive before using them from the pool.
    # Prevents "MySQL server has gone away" errors after idle periods.
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
    }
