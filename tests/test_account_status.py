"""Automates TESTING.md Section 2 — Deactivated / suspended account login."""

from app.extensions import db
from app.models import User

from tests.conftest import login


def _set_status(app, username, status):
    # Deliberately NOT `with app.app_context():` here: the `app` fixture
    # already keeps one app context pushed for the whole test (see
    # conftest.py), and the Flask test client's requests reuse that same
    # context rather than pushing a fresh one. Nesting a second
    # `app.app_context()` gives Flask-SQLAlchemy a distinct scoped
    # session whose commit reaches the real DB but never invalidates the
    # outer session's identity map -- so requests made via `client` keep
    # seeing the pre-update User instance. Reusing the already-active
    # context keeps this on the same session the requests use, so
    # commit()'s default expire-on-commit makes the change visible on
    # the next query, matching how a real request/app-context lifecycle
    # behaves in production.
    user = User.query.filter_by(username=username).first()
    user.status = status
    db.session.commit()


def test_deactivated_account_cannot_log_in(app, client):
    _set_status(app, "customer1", "inactive")

    resp = login(client, "customer1", "User@12345", follow_redirects=True)
    assert resp.status_code == 200
    assert b"This account has been deactivated" in resp.data


def test_suspended_account_cannot_log_in(app, client):
    _set_status(app, "customer1", "suspended")

    resp = login(client, "customer1", "User@12345", follow_redirects=True)
    assert resp.status_code == 200
    assert b"This account has been deactivated" in resp.data


def test_deactivating_mid_session_logs_out_on_next_request(app, client):
    """TESTING.md Section 2, step 3: a session started before
    deactivation must not remain usable after — app/auth.py's
    load_logged_in_user() re-checks status on every request, not
    just at login."""
    login(client, "customer1", "User@12345")
    assert client.get("/portal/").status_code == 200

    _set_status(app, "customer1", "inactive")

    resp = client.get("/portal/", follow_redirects=False)
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]


def test_reactivated_account_can_log_in_again(app, client):
    _set_status(app, "customer1", "inactive")
    assert login(client, "customer1", "User@12345", follow_redirects=True).status_code == 200

    _set_status(app, "customer1", "active")
    resp = login(client, "customer1", "User@12345")
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"
