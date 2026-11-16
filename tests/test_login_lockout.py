"""Failed-login lockout (app/login_attempts.py): 5 attempts, warnings, lock, reset."""

import pytest

from tests.conftest import login


@pytest.fixture()
def lenient(app):
    # Raise Flask-Limiter's own fast test limits so only the lockout is under test.
    app.config["LOGIN_RATE_LIMIT_PER_IP"] = "1000 per minute"
    app.config["LOGIN_RATE_LIMIT_PER_USERNAME"] = "1000 per minute"
    return app


@pytest.mark.parametrize("path", ["/login", "/account/login"])
def test_warns_then_locks_on_fifth_failure(lenient, client, path):
    user = "admin1" if path == "/login" else "customer1"
    for left in (4, 3, 2, 1):
        r = client.post(path, data={"username": user, "password": "bad"}, follow_redirects=True)
        assert r.status_code == 200
        assert f"{left} attempt".encode() in r.data
    r = client.post(path, data={"username": user, "password": "bad"})
    assert r.status_code == 429 and b"temporarily locked" in r.data
    # Correct password is refused while locked.
    pw = "Admin@12345" if path == "/login" else "User@12345"
    assert client.post(path, data={"username": user, "password": pw}).status_code == 429


def test_success_resets_counter(lenient, client):
    for _ in range(3):
        client.post("/login", data={"username": "admin1", "password": "bad"})
    assert client.post("/login", data={"username": "admin1", "password": "Admin@12345"}).status_code == 302
    client.post("/logout")
    r = client.post("/login", data={"username": "admin1", "password": "bad"}, follow_redirects=True)
    assert b"4 attempts" in r.data


def test_min_attempts_is_five(lenient):
    from app.config import Config
    assert Config.LOGIN_MAX_ATTEMPTS >= 5
