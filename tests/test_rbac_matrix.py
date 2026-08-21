"""Automates TESTING.md Section 3 — Role-based direct-URL access.

Each entry is (url, allowed_roles). For every demo account NOT in
allowed_roles, requesting that URL directly must return NAP-IQ's own
403 page (app/templates/errors/403.html) rather than a generic error
or a silent redirect. For an unauthenticated request, it must instead
redirect to /login with ?next= set to come back here after signing in.
"""

import pytest
from urllib.parse import urlparse, parse_qs, quote

from tests.conftest import DEMO_ACCOUNTS, login

# (url, allowed roles) — mirrors each blueprint's @role_required(...).
# GET-only routes, chosen so a single request is a valid, side-effect-
# free probe of the RBAC guard itself.
ROUTE_MATRIX = [
    ("/dashboard/", {"administrator"}),
    ("/users/", {"administrator"}),
    ("/technician/", {"technician"}),
    ("/technician/history", {"technician"}),                # Phase 20
    ("/portal/", {"user"}),
    ("/naps/", {"administrator", "technician"}),          # _VIEW_ROLES
    ("/naps/add", {"administrator"}),                       # _MANAGE_ROLES
    ("/naps/map", {"administrator", "technician"}),        # Phase 15: GeoMap/navigation entry point — _VIEW_ROLES
    ("/dispatch/", {"administrator"}),                       # Phase 15: Dispatch Board
    ("/reports/", {"administrator"}),                        # Phase 20 coverage gap
]

ALL_ROLES = {role for _, _, role, _ in DEMO_ACCOUNTS}


def _account_for_role(role):
    for username, password, acct_role, _status in DEMO_ACCOUNTS:
        if acct_role == role:
            return username, password
    raise LookupError(role)


@pytest.mark.parametrize("url,allowed_roles", ROUTE_MATRIX)
def test_disallowed_roles_get_403(client, url, allowed_roles):
    for role in ALL_ROLES - allowed_roles:
        username, password = _account_for_role(role)
        login(client, username, password)

        resp = client.get(url)
        assert resp.status_code == 403, (
            f"{role} ({username}) should be 403'd from {url}, got {resp.status_code}"
        )
        assert b"Access Denied" in resp.data

        client.post("/logout")


@pytest.mark.parametrize("url,allowed_roles", ROUTE_MATRIX)
def test_allowed_roles_get_200(client, url, allowed_roles):
    for role in allowed_roles:
        # payment_collector is never in an allowed_roles set above, so
        # every entry here has a real Phase 7 account to log in as.
        username, password = _account_for_role(role)
        login(client, username, password)

        resp = client.get(url)
        assert resp.status_code == 200, (
            f"{role} ({username}) should be able to reach {url}, got {resp.status_code}"
        )

        client.post("/logout")


@pytest.mark.parametrize("url,_allowed_roles", ROUTE_MATRIX)
def test_unauthenticated_redirects_to_login_with_next(client, url, _allowed_roles):
    resp = client.get(url, follow_redirects=False)
    assert resp.status_code == 302

    location = urlparse(resp.headers["Location"])
    assert location.path == "/login"
    assert parse_qs(location.query)["next"] == [url]


def test_next_is_honored_after_successful_login(client):
    # Hitting a protected page while logged out sets next=...
    resp = client.get("/dashboard/", follow_redirects=False)
    location = urlparse(resp.headers["Location"])
    next_url = parse_qs(location.query)["next"][0]
    assert next_url == "/dashboard/"

    # Logging in via that exact URL (as the login page's form would
    # submit it) lands back on the originally-requested page.
    resp = client.post(
        f"/login?next={quote(next_url, safe='')}",
        data={"username": "admin1", "password": "Admin@12345"},
    )
    assert resp.status_code == 302
    assert resp.headers["Location"] == next_url


def test_open_redirect_next_is_rejected(client):
    """TESTING.md Section 3's last paragraph / SECURITY_CHECKLIST.md's
    open-redirect guard: an absolute, off-site next= must NOT be
    followed after login."""
    resp = client.post(
        "/login?next=https://evil.example",
        data={"username": "admin1", "password": "Admin@12345"},
    )
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"  # falls back, doesn't follow evil.example


def test_protocol_relative_next_is_rejected(client):
    """A leading '//' can be treated as protocol-relative by browsers
    and followed off-site — must be rejected the same as a full URL."""
    resp = client.post(
        "/login?next=//evil.example",
        data={"username": "admin1", "password": "Admin@12345"},
    )
    assert resp.status_code == 302
    assert resp.headers["Location"] == "/home"
