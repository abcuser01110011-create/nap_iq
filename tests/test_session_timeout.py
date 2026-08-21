"""Automates the mechanism behind TESTING.md Section 5 — Session
timeout (Phase 15 Settings).

What this DOES verify automatically: that changing
AppSettings.session_timeout_minutes actually changes
current_app.permanent_session_lifetime on the very next request (the
live-apply behavior app/settings_utils.py's apply_dynamic_settings()
implements), and that it changes for an ALREADY-LOGGED-IN session too,
not just a fresh login.

What this does NOT verify automatically, and why: NAP-IQ's session
timeout is enforced the standard Flask way — a signed cookie whose
Max-Age/Expires the browser (or an HTTP client) is expected to honor —
not by NAP-IQ re-checking a stored "last active" timestamp on the
server for every request. Flask's own test client does not simulate
real wall-clock time passing, so actually proving "an idle session is
rejected after N minutes" requires either a real browser waiting N
minutes (TESTING.md Section 5's manual steps), or freezegun/monkey-
patching Python's clock deep inside Flask/itsdangerous internals,
which would test the test's mock more than NAP-IQ's own code. That
one specific case is left as the manual step TESTING.md already
describes — everything else about the timeout *mechanism* is covered
here.
"""

from datetime import timedelta

from app.extensions import db
from app.models import AppSettings

from tests.conftest import login


def _set_timeout_minutes(app, minutes):
    with app.app_context():
        settings = AppSettings.get_current()
        settings.session_timeout_minutes = minutes
        db.session.commit()


def test_dynamic_timeout_applies_before_next_request(app, client):
    _set_timeout_minutes(app, 5)

    login(client, "admin1", "Admin@12345")
    with app.app_context():
        assert app.permanent_session_lifetime == timedelta(minutes=5)

    _set_timeout_minutes(app, 45)

    # A request from the ALREADY-logged-in session picks up the new
    # value immediately — apply_dynamic_settings() runs before
    # load_logged_in_user() on every request, not just at login.
    client.get("/dashboard/")
    with app.app_context():
        assert app.permanent_session_lifetime == timedelta(minutes=45)


def test_login_sets_permanent_session(client):
    """session.permanent = True in routes/auth.py's login() — without
    this, PERMANENT_SESSION_LIFETIME/session_timeout_minutes would
    never apply and the session cookie would just be a browser-session
    cookie with no expiry at all."""
    with client.session_transaction() as sess:
        assert not sess.get("user_id")

    login(client, "admin1", "Admin@12345")

    with client.session_transaction() as sess:
        assert sess.permanent is True
        assert sess["user_id"]
