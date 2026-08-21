"""Automates TESTING.md Section 1 — Login, valid and invalid credentials."""

import pytest

from tests.conftest import DEMO_ACCOUNTS, login


@pytest.mark.parametrize("username,password,role,status", DEMO_ACCOUNTS)
def test_valid_login_redirects_to_role_home(client, username, password, role, status):
    resp = login(client, username, password)
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"
    if role == "payment_collector":
        # ROLE_HOME_ENDPOINT in app/auth.py — Phase 10 gave
        # payment_collector its own real landing page
        # (collector.index), so /home now resolves there like every
        # other role instead of the "no dashboard yet" message noted
        # as a Phase 7 follow-up.
        home_resp = client.get("/home", follow_redirects=True)
        assert home_resp.status_code == 200
        assert b"My Collections" in home_resp.data


def test_wrong_password_shows_generic_invalid_message(client):
    resp = login(client, "customer1", "not-the-real-password", follow_redirects=True)
    assert resp.status_code == 200
    assert b"Invalid username or password." in resp.data


def test_nonexistent_username_shows_same_generic_message(client):
    """Same message as a wrong password — TESTING.md Section 1, step 3:
    this is what stops /login being usable to enumerate real usernames."""
    resp = login(client, "definitely-not-a-real-user", "whatever", follow_redirects=True)
    assert resp.status_code == 200
    assert b"Invalid username or password." in resp.data


def test_already_logged_in_visiting_login_redirects_to_home(client):
    login(client, "customer1", "User@12345")
    resp = client.get("/login", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"


def test_logout_clears_session(client):
    login(client, "customer1", "User@12345")
    # A protected page loads while logged in.
    assert client.get("/portal/").status_code == 200

    client.post("/logout")

    # After logout, the same page redirects to /login instead.
    resp = client.get("/portal/", follow_redirects=False)
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]
