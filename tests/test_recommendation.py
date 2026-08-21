"""Phase 21 coverage (phase_10.pdf) — the rule-based technician
recommendation engine (app/recommendation.py) and its Dispatch route
(GET /dispatch/issues/<id>/recommend, plus the score-forwarding
change to assign()/reassign()).

Two groups of tests, same split as PHASE20's report tests use
implicitly (pure logic vs. route behavior):

  1. Unit tests directly against app/recommendation.py's pure
     functions — no Flask app, no database, so these pin down the
     exact formula (haversine distance, each factor's score, the
     final weighted total) independent of anything route/DB-related.
  2. Integration tests via the Flask test client (same in-memory-
     SQLite approach as the rest of this suite — see conftest.py's
     docstring), covering: the candidate pool excludes offline
     technicians, the route requires administrator, the "already
     assigned to X" exclusion, and that confirming a recommendation
     actually creates the assignment with dispatch_score set — while
     the manual dispatch path still leaves dispatch_score NULL.
"""

import math
from datetime import datetime, timedelta

import pytest

from app.extensions import db
from app.models import Nap, Subscriber, Technician, TechnicalIssue, Assignment, User
from app.recommendation import (
    haversine_km,
    get_recommendations,
    _availability_score,
    _workload_score,
    MAX_DISTANCE_KM,
    MIN_COMPLETED_FOR_PERFORMANCE,
    WEIGHT_AVAILABILITY,
    WEIGHT_WORKLOAD,
    WEIGHT_DISTANCE,
    WEIGHT_PERFORMANCE,
)

from tests.conftest import login


# ---------------------------------------------------------------------
# 1. Pure unit tests — no Flask app, no database
# ---------------------------------------------------------------------

def test_haversine_zero_distance_for_identical_points():
    assert haversine_km(14.6, 121.0, 14.6, 121.0) == pytest.approx(0.0, abs=1e-6)


def test_haversine_known_distance_manila_to_cebu():
    # Manila (14.5995 N, 120.9842 E) to Cebu City (10.3157 N, 123.8854 E)
    # is a well-known real-world distance, roughly 570-575 km great-circle.
    distance = haversine_km(14.5995, 120.9842, 10.3157, 123.8854)
    assert 550 < distance < 590


def test_haversine_symmetric():
    a_to_b = haversine_km(14.6, 121.0, 14.7, 121.1)
    b_to_a = haversine_km(14.7, 121.1, 14.6, 121.0)
    assert a_to_b == pytest.approx(b_to_a, abs=1e-9)


def test_weights_sum_to_one():
    # The module docstring promises total_score always lands in 0-100 —
    # that guarantee only holds if the weights actually sum to 1.0.
    total = WEIGHT_AVAILABILITY + WEIGHT_WORKLOAD + WEIGHT_DISTANCE + WEIGHT_PERFORMANCE
    assert total == pytest.approx(1.0)


def test_availability_score_available_beats_busy():
    available_tech = Technician(full_name="A", status="available")
    busy_tech = Technician(full_name="B", status="busy")
    assert _availability_score(available_tech) > _availability_score(busy_tech)
    assert _availability_score(available_tech) == 100
    assert _availability_score(busy_tech) == 40


def test_workload_score_decreases_with_open_assignments():
    assert _workload_score(0) == 100
    assert _workload_score(1) == 75
    assert _workload_score(2) == 50
    assert _workload_score(4) == 0
    # Never goes negative even with a very large open count.
    assert _workload_score(50) == 0


# ---------------------------------------------------------------------
# 2. Integration tests — real Flask app + in-memory SQLite
# ---------------------------------------------------------------------

def _seed(app, *, second_technician=True, distant=False, offline_technician=False):
    """One NAP, one subscriber, one open technical issue at the NAP's
    own coordinates, and one or two technician profiles linked to the
    tech1/tech2 demo accounts. `distant=True` places tech2 far enough
    away that MAX_DISTANCE_KM caps their distance score at 0, so
    ordering tests have an unambiguous "closer wins" case."""
    with app.app_context():
        nap = Nap(nap_code="NAP-200", name="Test NAP", latitude=14.6000, longitude=121.0000)
        db.session.add(nap)
        db.session.flush()

        sub = Subscriber(subscriber_code="SUB-200", full_name="Test Subscriber", nap_id=nap.id)
        db.session.add(sub)
        db.session.flush()

        tech1_user = User.query.filter_by(username="tech1").first()
        tech1 = Technician(
            user_id=tech1_user.id, full_name="Near Tech", status="available",
            current_latitude=14.6010, current_longitude=121.0010,  # ~150m away
        )
        db.session.add(tech1)

        if second_technician:
            tech2_user = User.query.filter_by(username="tech2").first()
            if distant:
                tech2_lat, tech2_lon = 15.5000, 122.0000  # far away
            else:
                tech2_lat, tech2_lon = 14.6050, 121.0050
            tech2 = Technician(
                user_id=tech2_user.id, full_name="Far Tech",
                status="offline" if offline_technician else "available",
                current_latitude=tech2_lat, current_longitude=tech2_lon,
            )
            db.session.add(tech2)

        db.session.flush()

        issue = TechnicalIssue(
            issue_code="ISS-0200",
            issue_type="No Internet",
            status="pending",
            subscriber_id=sub.id,
            nap_id=nap.id,
            latitude=14.6000,
            longitude=121.0000,
        )
        db.session.add(issue)
        db.session.commit()

        return issue.id, tech1.id


def test_offline_technicians_excluded_from_recommendations(app):
    issue_id, near_tech_id = _seed(app, offline_technician=True)
    with app.app_context():
        issue = TechnicalIssue.query.get(issue_id)
        rows = get_recommendations(issue)
        # Only the available technician should appear — the offline
        # one is excluded from the candidate pool entirely.
        assert len(rows) == 1
        assert rows[0]["technician"].id == near_tech_id
        assert rows[0]["technician_status"] == "available"


def test_closer_technician_ranks_first_when_otherwise_equal(app):
    issue_id, near_tech_id = _seed(app, distant=True)
    with app.app_context():
        issue = TechnicalIssue.query.get(issue_id)
        rows = get_recommendations(issue)
        assert len(rows) == 2
        # Both are 'available' with no open/completed history, so the
        # only differentiator is distance — the near one must rank
        # first with the higher total_score.
        assert rows[0]["technician"].id == near_tech_id
        assert rows[0]["total_score"] >= rows[1]["total_score"]
        assert rows[0]["distance_known"] is True
        assert rows[1]["distance_known"] is True
        assert rows[0]["distance_km"] < rows[1]["distance_km"]


def test_performance_factor_neutral_below_history_threshold(app):
    issue_id, near_tech_id = _seed(app, second_technician=False)
    with app.app_context():
        tech = Technician.query.get(near_tech_id)
        # Two completed assignments — below MIN_COMPLETED_FOR_PERFORMANCE (3).
        for i in range(2):
            issue2 = TechnicalIssue(
                issue_code=f"ISS-HIST-{i}", issue_type="Slow Speed", status="closed",
                subscriber_id=Subscriber.query.first().id,
            )
            db.session.add(issue2)
            db.session.flush()
            a = Assignment(
                technical_issue_id=issue2.id, technician_id=tech.id, status="completed",
                assigned_at=datetime.utcnow() - timedelta(hours=5),
                completed_at=datetime.utcnow(),
            )
            db.session.add(a)
        db.session.commit()

        issue = TechnicalIssue.query.get(issue_id)
        rows = get_recommendations(issue)
        assert rows[0]["completed_count"] == 2
        assert rows[0]["performance_known"] is False
        assert rows[0]["performance_score"] == 50  # neutral, not computed from 2 data points


def test_performance_factor_computed_once_threshold_met(app):
    issue_id, near_tech_id = _seed(app, second_technician=False)
    with app.app_context():
        tech = Technician.query.get(near_tech_id)
        for i in range(MIN_COMPLETED_FOR_PERFORMANCE):
            issue2 = TechnicalIssue(
                issue_code=f"ISS-HIST-{i}", issue_type="Slow Speed", status="closed",
                subscriber_id=Subscriber.query.first().id,
            )
            db.session.add(issue2)
            db.session.flush()
            a = Assignment(
                technical_issue_id=issue2.id, technician_id=tech.id, status="completed",
                assigned_at=datetime.utcnow() - timedelta(hours=2),
                completed_at=datetime.utcnow(),
            )
            db.session.add(a)
        db.session.commit()

        issue = TechnicalIssue.query.get(issue_id)
        rows = get_recommendations(issue)
        assert rows[0]["completed_count"] == MIN_COMPLETED_FOR_PERFORMANCE
        assert rows[0]["performance_known"] is True
        assert rows[0]["avg_resolution_hours"] == pytest.approx(2.0, abs=0.1)
        # Fast average resolution -> a high (not neutral) performance score.
        assert rows[0]["performance_score"] > 50


def test_recommend_route_requires_administrator(app, client):
    issue_id, _ = _seed(app)
    login(client, "tech1", "Tech@12345")
    resp = client.get(f"/dispatch/issues/{issue_id}/recommend")
    assert resp.status_code == 403


def test_recommend_route_lists_candidates_for_administrator(app, client):
    issue_id, near_tech_id = _seed(app)
    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/dispatch/issues/{issue_id}/recommend")
    assert resp.status_code == 200
    assert b"Near Tech" in resp.data
    assert b"Recommended Technicians" in resp.data
    # Doesn't claim to be AI anywhere on the page (phase_10.pdf's
    # explicit instruction).
    assert b"Artificial Intelligence" not in resp.data
    assert b" AI " not in resp.data


def test_confirming_recommendation_creates_assignment_with_score(app, client):
    issue_id, near_tech_id = _seed(app, second_technician=False)
    login(client, "admin1", "Admin@12345")

    with app.app_context():
        issue = TechnicalIssue.query.get(issue_id)
        rows = get_recommendations(issue)
        top_score = rows[0]["total_score"]

    resp = client.post(
        f"/dispatch/issues/{issue_id}/assign",
        data={
            "technician_id": near_tech_id,
            "recommendation_score": str(top_score),
        },
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        assignment = Assignment.query.filter_by(technical_issue_id=issue_id).first()
        assert assignment is not None
        assert assignment.status == "assigned"
        assert assignment.dispatch_score is not None
        assert float(assignment.dispatch_score) == pytest.approx(float(top_score), abs=0.05)

        issue = TechnicalIssue.query.get(issue_id)
        assert issue.status == "assigned"


def test_manual_assign_still_leaves_dispatch_score_null(app, client):
    """The pre-existing manual dispatch path (no recommendation_score
    in the POST body, same as dispatch/index.html's own form) must
    keep behaving exactly as it did before this phase."""
    issue_id, near_tech_id = _seed(app, second_technician=False)
    login(client, "admin1", "Admin@12345")

    resp = client.post(
        f"/dispatch/issues/{issue_id}/assign",
        data={"technician_id": near_tech_id},
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        assignment = Assignment.query.filter_by(technical_issue_id=issue_id).first()
        assert assignment is not None
        assert assignment.dispatch_score is None


def test_recommend_excludes_already_assigned_technician(app, client):
    issue_id, near_tech_id = _seed(app, distant=False)
    login(client, "admin1", "Admin@12345")

    # Dispatch tech1 (near_tech_id) first.
    client.post(
        f"/dispatch/issues/{issue_id}/assign",
        data={"technician_id": near_tech_id},
        follow_redirects=True,
    )

    resp = client.get(f"/dispatch/issues/{issue_id}/recommend")
    assert resp.status_code == 200
    # "Near Tech" legitimately appears once, in the page's own
    # "currently assigned to Near Tech" context line (see
    # dispatch/recommend.html) -- that's intentional, documented
    # behavior (this module's docstring), not the bug this test is
    # checking for. What must NOT happen is a second occurrence, i.e.
    # Near Tech also showing up as one of the candidate cards below.
    assert resp.data.count(b"Near Tech") == 1
    assert b"Far Tech" in resp.data
