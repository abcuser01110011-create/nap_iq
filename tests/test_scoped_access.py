"""Automates TESTING.md Section 4 — Technician / Customer scoped-access
spot checks (confirms *content* is narrowed, not just that the route
is reachable) plus the Phase 17 NAP-scoping 403 case."""

from datetime import date

from app.extensions import db
from app.models import Nap, Subscriber, Technician, TechnicalIssue, Assignment, User

from tests.conftest import login


def _seed_scoped_fixture(app):
    """Two NAPs, two subscribers, two technicians, one issue+assignment
    each — technician 1 (tech1) should only ever see NAP #1 / issue #1,
    never NAP #2 / issue #2, which belongs to tech2's assignment."""
    with app.app_context():
        nap1 = Nap(nap_code="NAP-001", name="Nap One", latitude=14.6, longitude=121.0)
        nap2 = Nap(nap_code="NAP-002", name="Nap Two", latitude=14.7, longitude=121.1)
        db.session.add_all([nap1, nap2])
        db.session.flush()

        sub1 = Subscriber(subscriber_code="SUB-001", full_name="Sub One", nap_id=nap1.id)
        sub2 = Subscriber(subscriber_code="SUB-002", full_name="Sub Two", nap_id=nap2.id)
        db.session.add_all([sub1, sub2])
        db.session.flush()

        tech1_user = User.query.filter_by(username="tech1").first()
        tech2_user = User.query.filter_by(username="tech2").first()
        tech1_profile = Technician(user_id=tech1_user.id, full_name="Tech One")
        tech2_profile = Technician(user_id=tech2_user.id, full_name="Tech Two")
        db.session.add_all([tech1_profile, tech2_profile])
        db.session.flush()

        issue1 = TechnicalIssue(issue_type="no_connection", subscriber_id=sub1.id, nap_id=nap1.id)
        issue2 = TechnicalIssue(issue_type="no_connection", subscriber_id=sub2.id, nap_id=nap2.id)
        db.session.add_all([issue1, issue2])
        db.session.flush()

        db.session.add_all([
            Assignment(technical_issue_id=issue1.id, technician_id=tech1_profile.id),
            Assignment(technical_issue_id=issue2.id, technician_id=tech2_profile.id),
        ])
        db.session.commit()

        return {"nap1_id": nap1.id, "nap2_id": nap2.id}


def test_technician_naps_list_only_shows_own_assigned_naps(app, client):
    ids = _seed_scoped_fixture(app)

    login(client, "tech1", "Tech@12345")
    resp = client.get("/naps/")
    assert resp.status_code == 200
    assert b"NAP-001" in resp.data
    assert b"NAP-002" not in resp.data


def test_administrator_naps_list_shows_every_nap(app, client):
    _seed_scoped_fixture(app)

    login(client, "admin1", "Admin@12345")
    resp = client.get("/naps/")
    assert resp.status_code == 200
    assert b"NAP-001" in resp.data
    assert b"NAP-002" in resp.data


def test_technician_view_nap_outside_own_set_is_403(app, client):
    ids = _seed_scoped_fixture(app)

    login(client, "tech1", "Tech@12345")
    resp = client.get(f"/naps/{ids['nap2_id']}")
    assert resp.status_code == 403


def test_technician_view_nap_inside_own_set_is_200(app, client):
    ids = _seed_scoped_fixture(app)

    login(client, "tech1", "Tech@12345")
    resp = client.get(f"/naps/{ids['nap1_id']}")
    assert resp.status_code == 200


def test_technician_geomap_is_unrestricted(app, client):
    """Deliberate exception documented in PHASE17_NOTES.md / api.py's
    naps_json() docstring — every technician sees the full GeoMap
    regardless of their own assignments."""
    _seed_scoped_fixture(app)

    login(client, "tech1", "Tech@12345")
    resp = client.get("/naps/map")
    assert resp.status_code == 200
