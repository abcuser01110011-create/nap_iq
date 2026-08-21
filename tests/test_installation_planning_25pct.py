"""Installation Planning integration, Phase 2 (25%) coverage.

Covers the one new route this phase adds:
`GET /api/naps/nearest-available?lat=<>&lng=<>`
(`app.routes.api.nearest_available_nap_json`) -- the read-only,
administrator-only data contract translated from the napV4-route-line
prototype's `nearestAvailableNap(pos)` / `napUsage(napId)`.

Same style as tests/test_nap_recommendation.py's integration group:
plain Flask test-client calls against the real app + in-memory SQLite
(see tests/conftest.py). The underlying filter/sort/distance logic
(`app.nap_recommendation.recommend_naps()`) already has its own
dedicated unit tests in test_nap_recommendation.py and is not
re-tested here -- this file only covers the new route's contract:
auth, parameter validation, and response shape.
"""

from app.extensions import db
from app.models import Nap

from tests.conftest import login


def _seed_nap(**overrides):
    defaults = dict(
        nap_code="NAP-500",
        name="Test NAP",
        address="Test Address",
        latitude=14.6000,
        longitude=121.0000,
        total_ports=8,
        used_ports=2,
        available_ports=6,
        status="active",
    )
    defaults.update(overrides)
    nap = Nap(**defaults)
    db.session.add(nap)
    db.session.commit()
    return nap


def test_requires_login(app, client):
    resp = client.get("/api/naps/nearest-available?lat=14.6&lng=121.0")
    assert resp.status_code == 302  # redirected to /login


def test_technician_forbidden(app, client):
    """Administrator-only, deliberately narrower than /api/naps and
    /api/technicians/<id>/location (both _STAFF_ROLES) -- see the
    route's own docstring for why."""
    login(client, "tech1", "Tech@12345")
    resp = client.get("/api/naps/nearest-available?lat=14.6&lng=121.0")
    assert resp.status_code == 403


def test_missing_params_returns_400(app, client):
    login(client, "admin1", "Admin@12345")
    resp = client.get("/api/naps/nearest-available")
    assert resp.status_code == 400
    assert resp.get_json()["status"] == "error"


def test_non_numeric_params_returns_400(app, client):
    login(client, "admin1", "Admin@12345")
    resp = client.get("/api/naps/nearest-available?lat=abc&lng=121.0")
    assert resp.status_code == 400


def test_out_of_range_params_returns_400(app, client):
    login(client, "admin1", "Admin@12345")
    resp = client.get("/api/naps/nearest-available?lat=999&lng=121.0")
    assert resp.status_code == 400


def test_no_nap_available_is_a_clean_200_not_an_error(app, client):
    """Empty candidate pool is a normal, honest result -- mirrors the
    prototype's `!suggestion` branch, not a failure."""
    with app.app_context():
        login(client, "admin1", "Admin@12345")
        resp = client.get("/api/naps/nearest-available?lat=14.6&lng=121.0")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "no_nap_available"
        assert body["nap"] is None
        assert body["distance_km"] is None
        assert body["available_ports"] is None
        assert body["point"] == {"lat": 14.6, "lng": 121.0}


def test_returns_nearest_nap_with_capacity(app, client):
    with app.app_context():
        _seed_nap(nap_code="NAP-501", name="Far NAP", latitude=14.7000, longitude=121.2000, available_ports=5)
        near = _seed_nap(nap_code="NAP-502", name="Near NAP", latitude=14.6000, longitude=121.0000, available_ports=3)

        login(client, "admin1", "Admin@12345")
        resp = client.get("/api/naps/nearest-available?lat=14.6001&lng=121.0001")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "success"
        assert body["nap"]["id"] == near.id
        assert body["nap"]["nap_code"] == "NAP-502"
        assert body["nap"]["address"] == "Test Address"
        assert body["available_ports"] == 3
        assert body["distance_km"] < 1


def test_full_nap_excluded_even_if_nearest(app, client):
    with app.app_context():
        _seed_nap(nap_code="NAP-503", name="Full NAP", latitude=14.6000, longitude=121.0000, available_ports=0)
        farther_but_open = _seed_nap(
            nap_code="NAP-504", name="Open NAP", latitude=14.6500, longitude=121.0500, available_ports=1
        )

        login(client, "admin1", "Admin@12345")
        resp = client.get("/api/naps/nearest-available?lat=14.6001&lng=121.0001")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "success"
        assert body["nap"]["id"] == farther_but_open.id


def test_maintenance_status_nap_excluded(app, client):
    with app.app_context():
        _seed_nap(nap_code="NAP-505", name="Maint NAP", latitude=14.6000, longitude=121.0000, status="maintenance", available_ports=8)

        login(client, "admin1", "Admin@12345")
        resp = client.get("/api/naps/nearest-available?lat=14.6001&lng=121.0001")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "no_nap_available"
