"""
Pytest fixtures for NAP-IQ's automated auth/RBAC test suite (Phase 19).
--------------------------------------------------------------------------
Runs the REAL Flask app (app.create_app) against an in-memory SQLite
database instead of MySQL, so this suite needs no live database server
and no browser — Flask's test client sends real HTTP requests straight
into the app in-process and inspects the real response (status code,
redirect target, session cookie, rendered HTML), which is exactly what
a person clicking through TESTING.md's steps in a browser would be
checking by eye.

Why SQLite instead of MySQL: every model in app/models.py uses
SQLAlchemy's cross-dialect column types (String, Integer, DateTime,
Enum, etc.) with no raw MySQL-specific SQL in the auth/RBAC code path,
so the ORM layer this suite exercises behaves identically on both. This
is NOT a substitute for running against real MySQL at least once before
a production deploy (see PHASE19_NOTES.md) — it only proves the
Python/Flask logic is correct, not e.g. MySQL-specific collation or
ENUM-storage quirks. Section 10 of TESTING.md still recommends one real
run against MySQL.

Run with:
    pip install -r requirements.txt pytest
    pytest -v
"""

import pytest

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import User


class TestConfig(Config):
    """Overrides only what needs to differ for fast, isolated,
    no-network test runs. Everything else (session cookie flags,
    RBAC decorators, etc.) is inherited unchanged from the real
    Config class, since those are exactly what this suite verifies."""

    TESTING = True
    DEBUG = False
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SECRET_KEY = "test-secret-key-not-for-production"

    # WTF_CSRF_ENABLED=False for most tests: Flask-WTF's CSRF token is
    # tied to a rendered form/session round-trip, which the CSRF-
    # specific tests in test_csrf.py exercise explicitly instead. Every
    # OTHER test in this suite is about auth/RBAC/rate-limiting, not
    # CSRF, so leaving it on everywhere would make every POST in this
    # file also a CSRF test by accident, obscuring failures.
    WTF_CSRF_ENABLED = False

    # Fast, deterministic rate limits for test_rate_limiting.py — the
    # real defaults (10/min, 5/min) would make that test slow and
    # require faking the clock. Overridden back to the real defaults
    # in test_rate_limiting.py's own dedicated app for the one test
    # that checks the shipped default values themselves.
    LOGIN_RATE_LIMIT_PER_IP = "3 per minute"
    LOGIN_RATE_LIMIT_PER_USERNAME = "2 per minute"
    RATELIMIT_STORAGE_URI = "memory://"

    # HTTPS-enforcement tests turn this on per-test via a dedicated
    # fixture (see test_https_enforcement.py) rather than globally.
    FORCE_HTTPS = False


# Demo accounts mirroring database/seed.sql (see TESTING.md's table) —
# recreated here via User.set_password() rather than copying seed.sql's
# pre-hashed strings, so this suite never depends on Werkzeug's exact
# hash format matching what shipped in seed.sql at some earlier version.
DEMO_ACCOUNTS = [
    # username,   password,        role,                 status
    ("admin1",    "Admin@12345",   "administrator",      "active"),
    ("tech1",     "Tech@12345",    "technician",          "active"),
    ("tech2",     "Tech@12345",    "technician",          "active"),
    ("collector1","Collect@12345", "payment_collector",   "active"),
    ("customer1", "User@12345",    "user",                "active"),
]


@pytest.fixture()
def app():
    """One fresh app + in-memory database per test function — nothing
    persists between tests, so test order never matters and a failing
    test can't leave stale state for the next one."""
    flask_app = create_app(TestConfig)

    with flask_app.app_context():
        db.create_all()
        for username, password, role, status in DEMO_ACCOUNTS:
            user = User(
                username=username,
                full_name=username.title(),
                email=f"{username}@example.test",
                role=role,
                status=status,
            )
            user.set_password(password)
            db.session.add(user)
        db.session.commit()

        yield flask_app

        db.session.remove()
        db.drop_all()


@pytest.fixture()
def client(app):
    """Flask's test client — sends real WSGI requests through the real
    app, cookie jar included, with no network socket and no browser."""
    return app.test_client()


def login(client, username, password, **kwargs):
    """Small helper so every test doesn't repeat the same POST call."""
    kwargs.setdefault("follow_redirects", False)
    return client.post(
        "/login",
        data={"username": username, "password": password},
        **kwargs,
    )
