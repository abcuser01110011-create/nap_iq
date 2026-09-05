"""Covers the new public self-service sign-up flow (GET/POST /register)
-- the web counterpart to the mobile app's Register screen. Mirrors
test_login.py's style/fixtures."""

from app.models import User


def test_get_register_shows_form(client):
    resp = client.get("/register")
    assert resp.status_code == 200
    assert b"Create your account" in resp.data


def test_successful_registration_creates_active_user_and_signs_in(client):
    resp = client.post(
        "/register",
        data={"username": "brandnewcustomer", "password": "Passw0rd1"},
        follow_redirects=False,
    )
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"

    user = User.query.filter_by(username="brandnewcustomer").first()
    assert user is not None
    assert user.role == "user"
    assert user.status == "active"
    assert user.check_password("Passw0rd1")

    # The session cookie set by register() is already good enough to
    # reach the customer dashboard, same as a normal login would be.
    home_resp = client.get("/home", follow_redirects=True)
    assert home_resp.status_code == 200


def test_duplicate_username_is_rejected(client):
    client.post("/register", data={"username": "dupeuser", "password": "Passw0rd1"})
    # A successful /register signs the new account straight in, and
    # register() bounces an already-signed-in visitor straight to
    # /home without even looking at the form -- same as login() does.
    # Log back out first so this second POST actually reaches the
    # uniqueness check, matching the real scenario this guards against
    # (two different, both-anonymous visitors racing for one username).
    client.post("/logout")
    resp = client.post(
        "/register",
        data={"username": "dupeuser", "password": "Passw0rd2"},
        follow_redirects=True,
    )
    assert b"already taken" in resp.data
    assert User.query.filter_by(username="dupeuser").count() == 1


def test_existing_demo_username_is_rejected(client):
    """Uniqueness check also covers colliding with a pre-existing
    (non-self-registered) account, not just another self-registration."""
    resp = client.post(
        "/register",
        data={"username": "customer1", "password": "Passw0rd1"},
        follow_redirects=True,
    )
    assert b"already taken" in resp.data


def test_short_password_is_rejected(client):
    resp = client.post(
        "/register",
        data={"username": "someoneelse", "password": "short1"},
        follow_redirects=True,
    )
    assert b"at least 8 characters" in resp.data
    assert User.query.filter_by(username="someoneelse").first() is None


def test_already_logged_in_visiting_register_redirects_to_home(client):
    client.post("/login", data={"username": "customer1", "password": "User@12345"})
    resp = client.get("/register", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"
