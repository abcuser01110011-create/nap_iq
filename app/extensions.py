"""
Flask Extensions
------------------
Extension objects are instantiated here, separate from app/__init__.py,
so they can be imported anywhere in the project (models, routes, etc.)
without causing circular imports. They are bound to the actual Flask
app later via `db.init_app(app)` inside the application factory.
"""

from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_jwt_extended import JWTManager

db = SQLAlchemy()

# Mobile API auth (app/routes/api_v1/) — separate from the session-
# cookie login the HTML app uses (app/auth.py). Only the api_v1
# blueprints are ever protected with @jwt_required(); every existing
# HTML route is untouched and keeps using the session cookie exactly
# as before. See app/models.py's RevokedToken for how logout works
# despite JWTs having no server-side session to clear.
jwt = JWTManager()

# Phase 18: brute-force protection for /login (SECURITY_CHECKLIST.md's
# previously-open "Rate limiting on /login" gap). Keyed by remote
# address by default; app/routes/auth.py additionally keys a second,
# per-submitted-username limit so one IP can't grind a single account
# just by spreading requests, and one botnet can't grind many accounts
# from many IPs without also tripping the per-IP limit.
#
# `default_limits=[]`: no blanket app-wide limit is applied here — only
# the routes that explicitly opt in (currently just /login) are
# limited, so this can't silently throttle normal app usage on routes
# nobody has reviewed for it.
#
# Storage: defaults to Flask-Limiter's in-memory storage, which is
# fine for a single-process deployment but does NOT share state across
# multiple worker processes/machines. For a real multi-worker
# deployment, set RATELIMIT_STORAGE_URI (see app/config.py) to a
# shared backend such as Redis, e.g. "redis://localhost:6379/0" — the
# Limiter object itself does not need to change, only the config value.
limiter = Limiter(key_func=get_remote_address, default_limits=[])
