"""Phase 15 (75%) coverage — the complete operational flow:
Complaint -> Technician assignment -> Job -> Navigate -> Route ->
Travel progress, exercised against real Flask routes/DB state (in-
memory SQLite, same approach as the rest of this suite), plus the
RBAC boundary the phase's own acceptance criteria call out by name:
"Unauthorized roles cannot access technician navigation actions."

This file does not re-test OSRM routing, demo travel, or GPS
progress themselves (already covered by earlier phases' own tests
where they exist as pure-JS/store logic) — it tests the *server-side*
seam Phase 15 is actually about: that a real assignment, created the
normal way, can be turned into a navigation destination by the right
person, that doing so never creates or mutates an Assignment row, and
that a Collector/Customer can't reach any of it.
"""

from app.extensions import db
from app.models import Nap, Subscriber, Technician, TechnicalIssue, Assignment, User

from tests.conftest import login


def _seed_pending_issue(app):
    """One NAP, one subscriber, one technician (tech1), one *pending*
    (unassigned) technical issue — the starting point of the plan's
    own flow diagram: Complaint -> Technician assignment -> ...
    """
    with app.app_context():
        nap = Nap(nap_code="NAP-200", name="Test NAP", latitude=14.6, longitude=121.0)
        db.session.add(nap)
        db.session.flush()

        sub = Subscriber(subscriber_code="SUB-200", full_name="Test Subscriber", nap_id=nap.id)
        db.session.add(sub)
        db.session.flush()

        tech1_user = User.query.filter_by(username="tech1").first()
        tech = Technician(user_id=tech1_user.id, full_name="Tech One")
        db.session.add(tech)
        db.session.flush()

        issue = TechnicalIssue(
            issue_code="ISS-0200",
            issue_type="No Internet",
            status="pending",
            subscriber_id=sub.id,
            nap_id=nap.id,
            latitude=14.6,
            longitude=121.0,
        )
        db.session.add(issue)
        db.session.commit()

        return {"issue_id": issue.id, "technician_id": tech.id}


def test_full_dispatch_to_navigation_flow(app, client):
    """The plan's own flow, end to end, using only existing routes:
    Complaint (seeded pending issue) -> Administrator dispatches a
    Technician (POST /dispatch/issues/<id>/assign) -> Job appears on
    the Technician's own "My Work" page with a Navigate link ->
    Technician follows it to GeoMap with the destination armed.
    """
    ids = _seed_pending_issue(app)

    # Complaint -> Technician assignment (Administrator).
    login(client, "admin1", "Admin@12345")
    resp = client.post(
        f"/dispatch/issues/{ids['issue_id']}/assign",
        data={"technician_id": ids["technician_id"], "note": ""},
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        assignments = Assignment.query.filter_by(technical_issue_id=ids["issue_id"]).all()
        assert len(assignments) == 1
        assert assignments[0].technician_id == ids["technician_id"]
        assert assignments[0].status == "assigned"
        issue = TechnicalIssue.query.get(ids["issue_id"])
        assert issue.status == "assigned"
    client.post("/logout")

    # Job -> Navigate (Technician, their own assignment).
    login(client, "tech1", "Tech@12345")
    resp = client.get("/technician/")
    assert resp.status_code == 200
    expected_link = (
        f"/naps/map?navigate_type=issue&amp;navigate_id={ids['issue_id']}"
    )
    assert expected_link.encode() in resp.data
    assert b"Navigate" in resp.data

    # -> Route (GeoMap page with the destination pre-armed).
    resp = client.get(
        f"/naps/map?navigate_type=issue&navigate_id={ids['issue_id']}"
    )
    assert resp.status_code == 200
    assert b'data-navigate-type="issue"' in resp.data
    assert f'data-navigate-id="{ids["issue_id"]}"'.encode() in resp.data
    client.post("/logout")

    # Navigating never creates or modifies an assignment.
    with app.app_context():
        assignments = Assignment.query.filter_by(technical_issue_id=ids["issue_id"]).all()
        assert len(assignments) == 1
        assert assignments[0].status == "assigned"


def test_dispatch_board_offers_navigate_link_once_assigned(app, client):
    """The Dispatch Board (Administrator) shows a Navigate link for an
    already-dispatched issue, so the same "correct technician/job/
    destination" preview a technician gets on their own page is also
    available at the point of dispatch — without duplicating any
    assignment logic, this only reads assignment_by_issue the route
    already builds.
    """
    ids = _seed_pending_issue(app)

    with app.app_context():
        assignment = Assignment(
            technical_issue_id=ids["issue_id"],
            technician_id=ids["technician_id"],
            status="assigned",
        )
        db.session.add(assignment)
        issue = TechnicalIssue.query.get(ids["issue_id"])
        issue.status = "assigned"
        db.session.commit()

    login(client, "admin1", "Admin@12345")
    resp = client.get("/dispatch/")
    assert resp.status_code == 200
    expected_link = (
        f"/naps/map?navigate_type=issue&amp;navigate_id={ids['issue_id']}"
    )
    assert expected_link.encode() in resp.data


def test_collector_and_customer_cannot_reach_navigation_or_dispatch(app, client):
    """Acceptance criterion, verified directly: "Collector/customer:
    must not gain technician-only navigation controls accidentally."
    Covers both the navigation entry point (GeoMap) and the dispatch
    workflow that feeds it, for both non-staff roles.
    """
    ids = _seed_pending_issue(app)

    for username, password in (("collector1", "Collect@12345"), ("customer1", "User@12345")):
        login(client, username, password)

        resp = client.get("/naps/map")
        assert resp.status_code == 403, f"{username} should be 403'd from /naps/map"

        resp = client.get(
            f"/naps/map?navigate_type=issue&navigate_id={ids['issue_id']}"
        )
        assert resp.status_code == 403, f"{username} should be 403'd from /naps/map even with navigate params"

        resp = client.get("/dispatch/")
        assert resp.status_code == 403, f"{username} should be 403'd from /dispatch/"

        resp = client.get("/technician/")
        assert resp.status_code == 403, f"{username} should be 403'd from /technician/"

        resp = client.post(
            f"/dispatch/issues/{ids['issue_id']}/assign",
            data={"technician_id": ids["technician_id"], "note": ""},
        )
        assert resp.status_code == 403, f"{username} should be 403'd from dispatch.assign"

        resp = client.get(f"/issues/{ids['issue_id']}")
        assert resp.status_code == 403, f"{username} should be 403'd from issue detail"

        client.post("/logout")

    # None of the above attempts created an assignment.
    with app.app_context():
        assert Assignment.query.filter_by(technical_issue_id=ids["issue_id"]).count() == 0


def test_technician_cannot_navigate_to_a_job_not_assigned_to_them(app, client):
    """A second technician (tech2), with no assignment on this issue,
    can still reach /naps/map (it's shared, per the module's own
    docstring) but cannot open the issue's own detail page — the
    place dispatch-scoped detail (who's assigned, resolution notes)
    actually lives. Confirms Phase 14's own "own assignment" scoping
    is intact and unaffected by this phase's additions.
    """
    ids = _seed_pending_issue(app)

    with app.app_context():
        assignment = Assignment(
            technical_issue_id=ids["issue_id"],
            technician_id=ids["technician_id"],
            status="assigned",
        )
        db.session.add(assignment)
        db.session.commit()

    login(client, "tech2", "Tech@12345")
    resp = client.get(f"/issues/{ids['issue_id']}")
    assert resp.status_code == 403

    # tech2's own "My Work" page has no Navigate link for someone
    # else's job — they simply have no assignment row to show one for.
    resp = client.get("/technician/")
    assert resp.status_code == 200
    assert b"ISS-0200" not in resp.data
