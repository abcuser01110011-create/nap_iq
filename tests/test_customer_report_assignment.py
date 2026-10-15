"""A customer-reported issue must show its technician in the admin views,
including when it was folded into a consolidated parent ticket, and the
dispatch must never be skipped when the consolidated parent has no
technician yet."""

import io
from datetime import datetime, timedelta

import pytest

from app.extensions import db
from app.issue_utils import consolidate_nap_issues
from app.models import Assignment, Nap, Subscriber, Technician, TechnicalIssue, User
from app.recommendation import auto_assign_recommended_technician
from tests.conftest import login


def _world(app, tech_status="available", with_technician=True):
    nap = Nap(nap_code="N-019", name="Parkside NAP", latitude=14.2790, longitude=121.4130)
    db.session.add(nap)
    db.session.flush()
    subs = []
    for i in range(3):
        s = Subscriber(
            subscriber_code=f"SUB-{i:04d}", full_name=f"Sub {i}", address=f"{i} Test St",
            contact_number=f"0900000000{i}", nap_id=nap.id,
            latitude=14.2790 + i * 0.0005, longitude=121.4130 + i * 0.0005,
        )
        db.session.add(s)
        subs.append(s)
    tech = None
    if with_technician:
        tech_user = User.query.filter_by(username="tech1").first()
        tech = Technician(user_id=tech_user.id, full_name="Tech One", status=tech_status)
        db.session.add(tech)
    customer = User.query.filter_by(username="customer1").first()
    subs[2].user_id = customer.id
    db.session.commit()
    return nap, subs, tech


def _report_like_the_route(sub, nap, minutes):
    """Same sequence customer.report_issue() runs after the photo upload."""
    issue = TechnicalIssue(
        issue_type="No Internet", priority="critical", status="pending",
        description="mahina", address=sub.address, latitude=sub.latitude,
        longitude=sub.longitude, subscriber_id=sub.id, nap_id=nap.id,
        photo_filename="https://example.com/p.jpg",
        created_at=datetime.utcnow() - timedelta(minutes=minutes),
    )
    db.session.add(issue)
    db.session.commit()
    issue.issue_code = f"ISS-{issue.id:04d}"
    db.session.commit()
    if consolidate_nap_issues(issue) is None:
        auto_assign_recommended_technician(issue)
    return issue


def test_folded_child_ticket_shows_parent_technician(app, client):
    with app.app_context():
        nap, subs, tech = _world(app)
        a = _report_like_the_route(subs[0], nap, 30)
        b = _report_like_the_route(subs[1], nap, 20)
        c = _report_like_the_route(subs[2], nap, 10)
        ids = [a.id, b.id, c.id]
        assert Assignment.query.filter_by(technical_issue_id=a.id, status="assigned").count() == 1

    login(client, "admin1", "Admin@12345")

    html = client.get("/issues/").get_data(as_text=True)
    assert html.count("Tech One") >= 3, "every folded ticket should list the technician"

    data = client.get("/api/issues").get_json()
    assert {row["assigned_technician"] for row in data} == {"Tech One"}

    # Folded children must not keep claiming "pending" while their parent is dispatched.
    with app.app_context():
        for i in ids:
            assert TechnicalIssue.query.get(i).status == "assigned"


def test_offline_technician_is_still_auto_assigned(app, client):
    with app.app_context():
        nap, subs, tech = _world(app, tech_status="offline")
        a = _report_like_the_route(subs[0], nap, 30)
        assert a.status == "assigned"
        assert Assignment.query.filter_by(technical_issue_id=a.id, status="assigned").count() == 1

    login(client, "admin1", "Admin@12345")
    data = client.get("/api/issues").get_json()
    assert {row["assigned_technician"] for row in data} == {"Tech One"}


def test_parent_without_technician_gets_dispatched(app, client):
    """The oldest ticket was reported while there was no technician at all,
    so it has no assignment. When enough tickets pile up and fold into it,
    the group must still be dispatched once a technician exists."""
    with app.app_context():
        nap, subs, _ = _world(app, with_technician=False)
        a = _report_like_the_route(subs[0], nap, 30)
        b = _report_like_the_route(subs[1], nap, 20)
        assert a.status == "pending" and b.status == "pending"
        tech_user = User.query.filter_by(username="tech1").first()
        tech = Technician(user_id=tech_user.id, full_name="Tech One", status="available")
        db.session.add(tech)
        db.session.commit()
        c = _report_like_the_route(subs[2], nap, 10)
        assert Assignment.query.filter(
            Assignment.technical_issue_id == a.id, Assignment.status == "assigned"
        ).count() == 1
        assert TechnicalIssue.query.get(a.id).status == "assigned"

    login(client, "admin1", "Admin@12345")
    data = client.get("/api/issues").get_json()
    assert {row["assigned_technician"] for row in data} == {"Tech One"}


# ---------------------------------------------------------------------
# Auto-assign rule: same NAP -> same technician; other NAP -> a free
# technician; everyone busy -> nearest technician.
# ---------------------------------------------------------------------

def _two_techs(app, t1_pos=(14.2790, 121.4130), t2_pos=(14.3500, 121.5000)):
    nap_a = Nap(nap_code="N-A", name="A", latitude=14.2790, longitude=121.4130)
    nap_b = Nap(nap_code="N-B", name="B", latitude=14.3500, longitude=121.5000)
    nap_c = Nap(nap_code="N-C", name="C", latitude=14.3400, longitude=121.4900)  # right next to B
    db.session.add_all([nap_a, nap_b, nap_c])
    db.session.flush()
    subs = {}
    for key, nap in (("a", nap_a), ("b", nap_b), ("c", nap_c)):
        s = Subscriber(subscriber_code=f"SUB-{key}", full_name=f"Sub {key}", address="x",
                       contact_number="09", nap_id=nap.id, latitude=nap.latitude, longitude=nap.longitude)
        db.session.add(s)
        subs[key] = s
    u1 = User.query.filter_by(username="tech1").first()
    u2 = User.query.filter_by(username="tech2").first()
    t1 = Technician(user_id=u1.id, full_name="Tech One", status="available",
                    current_latitude=t1_pos[0], current_longitude=t1_pos[1])
    t2 = Technician(user_id=u2.id, full_name="Tech Two", status="offline",
                    current_latitude=t2_pos[0], current_longitude=t2_pos[1])
    db.session.add_all([t1, t2])
    db.session.commit()
    return {"a": nap_a, "b": nap_b, "c": nap_c}, subs, t1, t2


def _report(sub, nap):
    issue = TechnicalIssue(
        issue_type="Slow Internet", priority="high", status="pending", description="x",
        address="x", latitude=sub.latitude, longitude=sub.longitude,
        subscriber_id=sub.id, nap_id=nap.id,
    )
    db.session.add(issue)
    db.session.commit()
    issue.issue_code = f"ISS-{issue.id:04d}"
    db.session.commit()
    a = auto_assign_recommended_technician(issue)
    return a.technician.full_name


def test_other_nap_goes_to_free_technician_even_if_offline(app):
    with app.app_context():
        naps, subs, t1, t2 = _two_techs(app)
        assert _report(subs["a"], naps["a"]) == "Tech One"   # nearest of two free ones
        # different NAP: Tech One is busy, Tech Two (offline) is free -> Tech Two
        assert _report(subs["b"], naps["b"]) == "Tech Two"


def test_same_nap_keeps_same_technician(app):
    with app.app_context():
        naps, subs, t1, t2 = _two_techs(app)
        assert _report(subs["a"], naps["a"]) == "Tech One"
        assert _report(subs["a"], naps["a"]) == "Tech One"


def test_everyone_busy_goes_to_nearest(app):
    with app.app_context():
        naps, subs, t1, t2 = _two_techs(app)
        _report(subs["a"], naps["a"])   # Tech One busy at A
        _report(subs["b"], naps["b"])   # Tech Two busy at B
        # new NAP C is right next to B -> nearest technician is Tech Two
        assert _report(subs["c"], naps["c"]) == "Tech Two"


def test_admin_recommend_page_follows_the_same_rule(app, client):
    with app.app_context():
        naps, subs, t1, t2 = _two_techs(app)
        _report(subs["a"], naps["a"])          # Tech One now busy at NAP A
        issue = TechnicalIssue(
            issue_type="No Internet", priority="critical", status="pending", description="x",
            address="x", latitude=subs["b"].latitude, longitude=subs["b"].longitude,
            subscriber_id=subs["b"].id, nap_id=naps["b"].id,
        )
        db.session.add(issue)
        db.session.commit()
        issue.issue_code = f"ISS-{issue.id:04d}"
        db.session.commit()
        issue_id = issue.id
        from app.recommendation import get_recommendations
        rows = get_recommendations(issue)
        # other NAP: the technician with no open jobs is the top pick, even though offline
        assert [r["technician"].full_name for r in rows] == ["Tech Two", "Tech One"]
        assert rows[0]["rule_label"] == "No open jobs"

    login(client, "admin1", "Admin@12345")
    html = client.get(f"/dispatch/issues/{issue_id}/recommend").get_data(as_text=True)
    assert html.index("Tech Two") < html.index("Tech One")
    assert "No open jobs" in html and "/ 100" not in html


def test_installation_recommend_page_renders_with_rule(app, client):
    from app.models import ServiceRequest
    with app.app_context():
        naps, subs, t1, t2 = _two_techs(app)
        _report(subs["a"], naps["a"])          # Tech One busy
        sr = ServiceRequest(request_type="new_installation", subscriber_id=subs["b"].id,
                            requested_nap_id=naps["b"].id, status="scheduled",
                            latitude=subs["b"].latitude, longitude=subs["b"].longitude)
        db.session.add(sr)
        db.session.commit()
        sr_id = sr.id
    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/dispatch/requests/{sr_id}/recommend")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert html.index("Tech Two") < html.index("Tech One")
    assert "No open jobs" in html
