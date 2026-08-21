"""Phase 22 coverage (phase_11.pdf) — the nearest-available-NAP
recommendation engine (app/nap_recommendation.py) and its two
service-request routes (GET recommend-nap, POST assign-nap), plus the
GeoMap JSON feed that displays the result (GET /api/service-requests/
<id>/recommend-nap).

Same two-group split test_recommendation.py already uses:

  1. Pure unit tests directly against app/nap_recommendation.py's
     recommend_naps() — no Flask app, no route, so these pin down the
     exact filter/sort behavior independent of anything route-related.
  2. Integration tests via the Flask test client (in-memory SQLite,
     same approach as the rest of this suite — see conftest.py),
     covering the recommend_nap/assign_nap routes and the new JSON
     feed.

phase_11.pdf's four named test cases are group 1's first four tests,
in order: nearby available NAP, nearby full NAP (excluded), multiple
available NAPs (sorted, nearest flagged), no available NAP (empty
result).
"""

import pytest

from app.extensions import db
from app.models import Nap, Subscriber, ServiceRequest
from app.nap_recommendation import recommend_naps

from tests.conftest import login


# ---------------------------------------------------------------------
# 1. Pure unit tests — no Flask app route, but needs an app context
#    for the ORM query, so these still take the `app` fixture.
# ---------------------------------------------------------------------

def test_nearby_available_nap_is_recommended(app):
    """phase_11.pdf case 1: a single nearby, active NAP with a free
    port is recommended."""
    with app.app_context():
        nap = Nap(
            nap_code="NAP-300", name="Nearby NAP",
            latitude=14.6000, longitude=121.0000,
            total_ports=8, used_ports=2, available_ports=6, status="active",
        )
        db.session.add(nap)
        db.session.commit()

        rows = recommend_naps(14.6001, 121.0001)
        assert len(rows) == 1
        assert rows[0]["nap"].id == nap.id
        assert rows[0]["is_recommended"] is True
        assert rows[0]["distance_km"] < 1


def test_nearby_full_nap_is_excluded(app):
    """phase_11.pdf case 2: a nearby NAP with zero available ports is
    never recommended, no matter how close it is."""
    with app.app_context():
        full_nap = Nap(
            nap_code="NAP-301", name="Full NAP",
            latitude=14.6000, longitude=121.0000,
            total_ports=8, used_ports=8, available_ports=0, status="active",
        )
        db.session.add(full_nap)
        db.session.commit()

        rows = recommend_naps(14.6001, 121.0001)
        assert rows == []


def test_inactive_nap_excluded_even_with_available_ports(app):
    """The status filter is applied independently of the port count —
    a 'maintenance'/'inactive' NAP is excluded even if available_ports
    still shows a nonzero count (see the module docstring's CANDIDATE
    POOL section)."""
    with app.app_context():
        maint_nap = Nap(
            nap_code="NAP-302", name="Under Maintenance",
            latitude=14.6000, longitude=121.0000,
            total_ports=8, used_ports=0, available_ports=8, status="maintenance",
        )
        db.session.add(maint_nap)
        db.session.commit()

        rows = recommend_naps(14.6001, 121.0001)
        assert rows == []


def test_multiple_available_naps_sorted_nearest_first(app):
    """phase_11.pdf case 3: with several suitable NAPs, all are
    returned, nearest first, only the top pick flagged."""
    with app.app_context():
        near = Nap(
            nap_code="NAP-303", name="Near NAP",
            latitude=14.6001, longitude=121.0001,
            total_ports=8, used_ports=0, available_ports=8, status="active",
        )
        mid = Nap(
            nap_code="NAP-304", name="Mid NAP",
            latitude=14.6100, longitude=121.0100,
            total_ports=8, used_ports=0, available_ports=8, status="active",
        )
        far = Nap(
            nap_code="NAP-305", name="Far NAP",
            latitude=14.7000, longitude=121.1000,
            total_ports=8, used_ports=0, available_ports=8, status="active",
        )
        db.session.add_all([far, near, mid])  # deliberately out of order
        db.session.commit()

        rows = recommend_naps(14.6000, 121.0000)
        assert len(rows) == 3
        assert [row["nap"].id for row in rows] == [near.id, mid.id, far.id]
        assert rows[0]["is_recommended"] is True
        assert rows[1]["is_recommended"] is False
        assert rows[2]["is_recommended"] is False
        # Nearest-first ordering: each distance strictly increases.
        assert rows[0]["distance_km"] < rows[1]["distance_km"] < rows[2]["distance_km"]


def test_no_available_nap_returns_empty_list(app):
    """phase_11.pdf case 4: no suitable NAP anywhere -> an empty list,
    not an error. Callers (recommend_nap()) render a friendly empty
    state for this, not a crash."""
    with app.app_context():
        naps = [
            Nap(
                nap_code="NAP-306", name="Full NAP", latitude=14.6000, longitude=121.0000,
                total_ports=4, used_ports=4, available_ports=0, status="active",
            ),
            Nap(
                nap_code="NAP-307", name="Inactive NAP", latitude=14.6100, longitude=121.0100,
                total_ports=4, used_ports=0, available_ports=4, status="inactive",
            ),
        ]
        db.session.add_all(naps)
        db.session.commit()

        rows = recommend_naps(14.6000, 121.0000)
        assert rows == []


def test_limit_returns_only_top_n(app):
    with app.app_context():
        near = Nap(
            nap_code="NAP-308", name="Near NAP", latitude=14.6001, longitude=121.0001,
            total_ports=8, used_ports=0, available_ports=8, status="active",
        )
        far = Nap(
            nap_code="NAP-309", name="Far NAP", latitude=14.7000, longitude=121.1000,
            total_ports=8, used_ports=0, available_ports=8, status="active",
        )
        db.session.add_all([near, far])
        db.session.commit()

        rows = recommend_naps(14.6000, 121.0000, limit=1)
        assert len(rows) == 1
        assert rows[0]["nap"].id == near.id


# ---------------------------------------------------------------------
# 2. Integration tests — real Flask app + in-memory SQLite
# ---------------------------------------------------------------------

def _seed_request(app, *, with_location=True):
    """One NAP with an available port and one service request, with
    or without a customer location set."""
    with app.app_context():
        nap = Nap(
            nap_code="NAP-400", name="Test NAP",
            latitude=14.6000, longitude=121.0000,
            total_ports=8, used_ports=0, available_ports=8, status="active",
        )
        db.session.add(nap)
        db.session.flush()

        sub = Subscriber(subscriber_code="SUB-400", full_name="Test Subscriber", nap_id=nap.id)
        db.session.add(sub)
        db.session.flush()

        service_request = ServiceRequest(
            request_type="new_installation",
            subscriber_id=sub.id,
            status="pending",
            latitude=14.6001 if with_location else None,
            longitude=121.0001 if with_location else None,
        )
        db.session.add(service_request)
        db.session.commit()

        return service_request.id, nap.id


def test_recommend_nap_route_requires_administrator(app, client):
    request_id, _ = _seed_request(app)
    login(client, "tech1", "Tech@12345")
    resp = client.get(f"/service-requests/{request_id}/recommend-nap")
    assert resp.status_code == 403


def test_recommend_nap_route_lists_candidates_for_administrator(app, client):
    request_id, nap_id = _seed_request(app)
    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/service-requests/{request_id}/recommend-nap")
    assert resp.status_code == 200
    assert b"NAP-400" in resp.data
    assert b"Nearest Available NAP" in resp.data


def test_recommend_nap_route_redirects_without_location(app, client):
    request_id, _ = _seed_request(app, with_location=False)
    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/service-requests/{request_id}/recommend-nap", follow_redirects=True)
    assert resp.status_code == 200
    assert b"Set a customer location" in resp.data


def test_assign_nap_sets_requested_nap_id(app, client):
    request_id, nap_id = _seed_request(app)
    login(client, "admin1", "Admin@12345")
    resp = client.post(
        f"/service-requests/{request_id}/assign-nap",
        data={"nap_id": nap_id},
        follow_redirects=True,
    )
    assert resp.status_code == 200
    with app.app_context():
        service_request = ServiceRequest.query.get(request_id)
        assert service_request.requested_nap_id == nap_id


def test_assign_nap_rechecks_nap_is_still_suitable(app, client):
    """The don't-trust-the-page pattern: a NAP that's gone
    inactive/full between the recommendation page rendering and the
    confirm click is rejected server-side, not silently assigned."""
    request_id, nap_id = _seed_request(app)
    login(client, "admin1", "Admin@12345")

    with app.app_context():
        nap = Nap.query.get(nap_id)
        nap.status = "inactive"
        db.session.commit()

    resp = client.post(
        f"/service-requests/{request_id}/assign-nap",
        data={"nap_id": nap_id},
        follow_redirects=True,
    )
    assert resp.status_code == 200
    with app.app_context():
        service_request = ServiceRequest.query.get(request_id)
        assert service_request.requested_nap_id is None


def test_recommend_nap_json_feed_requires_administrator(app, client):
    request_id, _ = _seed_request(app)
    login(client, "tech1", "Tech@12345")
    resp = client.get(f"/api/service-requests/{request_id}/recommend-nap")
    assert resp.status_code == 403


def test_recommend_nap_json_feed_404s_for_unknown_request(app, client):
    login(client, "admin1", "Admin@12345")
    resp = client.get("/api/service-requests/99999/recommend-nap")
    assert resp.status_code == 404


def test_recommend_nap_json_feed_400s_without_location(app, client):
    request_id, _ = _seed_request(app, with_location=False)
    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/api/service-requests/{request_id}/recommend-nap")
    assert resp.status_code == 400


def test_recommend_nap_json_feed_returns_ranked_candidates(app, client):
    request_id, nap_id = _seed_request(app)
    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/api/service-requests/{request_id}/recommend-nap")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["status"] == "success"
    assert data["service_request_id"] == request_id
    assert data["recommended_nap_id"] == nap_id
    assert len(data["candidates"]) == 1
    assert data["candidates"][0]["nap_id"] == nap_id
    assert data["candidates"][0]["is_recommended"] is True
