"""Automates TESTING.md Section 2a — Login rate limiting (Phase 18).

Uses TestConfig's fast limits (3/min per IP, 2/min per username —
see tests/conftest.py) instead of the real 10/min & 5/min defaults, so
this test doesn't need to either wait a full minute or fake the clock.
The mechanism under test (Flask-Limiter, keyed by IP and by
_login_username_key()) is identical in both cases — only the numbers
differ.
"""

from tests.conftest import login


def test_per_username_limit_returns_429_after_limit_exhausted(client):
    # TestConfig: LOGIN_RATE_LIMIT_PER_USERNAME = "2 per minute"
    for _ in range(2):
        resp = login(client, "customer1", "wrong-password", follow_redirects=True)
        assert resp.status_code == 200  # normal "Invalid username or password" page

    resp = login(client, "customer1", "wrong-password")
    assert resp.status_code == 429


def test_per_ip_limit_returns_429_across_different_usernames(client):
    # TestConfig: LOGIN_RATE_LIMIT_PER_IP = "3 per minute". Using a
    # different (nonexistent) username each time isolates this from
    # the per-username limit, which is keyed separately per username.
    for i in range(3):
        resp = login(client, f"no-such-user-{i}", "whatever", follow_redirects=True)
        assert resp.status_code == 200

    resp = login(client, "no-such-user-999", "whatever")
    assert resp.status_code == 429


def test_get_login_is_never_rate_limited(client):
    """Both limits are scoped to POST only (methods=["POST"] in
    app/routes/auth.py) — a page refresh loop on the plain form must
    never count against either budget."""
    for _ in range(10):
        resp = client.get("/login")
        assert resp.status_code == 200


def test_rate_limit_response_uses_styled_429_page(client):
    for _ in range(2):
        login(client, "customer1", "wrong-password")

    resp = login(client, "customer1", "wrong-password")
    assert resp.status_code == 429
    assert b"Too Many Attempts" in resp.data
