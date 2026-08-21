"""Automates TESTING.md Section 2b — HTTPS enforcement (Phase 18, opt-in).

Uses its own app instance with FORCE_HTTPS=True rather than the shared
`client` fixture, since this behavior is off by default and shouldn't
affect every other test in the suite.
"""

import pytest

from app import create_app
from app.extensions import db

from tests.conftest import TestConfig


class ForceHttpsConfig(TestConfig):
    FORCE_HTTPS = True


@pytest.fixture()
def https_client():
    flask_app = create_app(ForceHttpsConfig)
    with flask_app.app_context():
        db.create_all()
        yield flask_app.test_client()
        db.session.remove()
        db.drop_all()


def test_plain_http_request_redirects_to_https(https_client):
    resp = https_client.get("/login", base_url="http://example.test")
    assert resp.status_code == 301
    assert resp.headers["Location"].startswith("https://")


def test_https_request_is_not_redirected(https_client):
    resp = https_client.get("/login", base_url="https://example.test")
    assert resp.status_code == 200


def test_force_https_off_by_default(client):
    """The shared `client` fixture uses TestConfig, which leaves
    FORCE_HTTPS at its real-world default (False) — a plain-HTTP
    request must be served normally, not redirected, matching local
    dev with no TLS available."""
    resp = client.get("/login", base_url="http://example.test")
    assert resp.status_code == 200
