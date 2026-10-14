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


def _world(app, tech_status="available"):
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


def test_parent_without_technician_gets_dispatched(app, client):
    """The oldest ticket was reported while nobody was available, so it has
    no assignment. When enough tickets pile up and fold into it, the group
    must still be dispatched once somebody is available."""
    with app.app_context():
        nap, subs, tech = _world(app, tech_status="offline")
        a = _report_like_the_route(subs[0], nap, 30)
        b = _report_like_the_route(subs[1], nap, 20)
        assert a.status == "pending" and b.status == "pending"
        tech.status = "available"
        db.session.commit()
        c = _report_like_the_route(subs[2], nap, 10)
        assert Assignment.query.filter(
            Assignment.technical_issue_id == a.id, Assignment.status == "assigned"
        ).count() == 1
        assert TechnicalIssue.query.get(a.id).status == "assigned"

    login(client, "admin1", "Admin@12345")
    data = client.get("/api/issues").get_json()
    assert {row["assigned_technician"] for row in data} == {"Tech One"}
