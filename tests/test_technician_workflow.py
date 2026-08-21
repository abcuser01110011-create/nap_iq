"""Phase 20 coverage: technician assignment history, resolution notes
becoming required on complete_assignment, the Resolved -> Closed
issue transition, the issue detail page's assignment-history section,
GeoMap issue-focus support, and the Technician Workload & Performance
report.

Same in-memory-SQLite-via-app.test_client() approach as the rest of
this suite (see conftest.py's docstring) — these are functional/
workflow tests rather than pure RBAC probes, so (unlike
test_rbac_matrix.py) several of them POST/mutate state.
"""

from datetime import datetime, timedelta

import pytest

from app.extensions import db
from app.models import Nap, Subscriber, Technician, TechnicalIssue, Assignment, User

from tests.conftest import login


def _seed(app):
    """One NAP, one subscriber, one technician (tech1), one technical
    issue with an 'in_progress' assignment already routed to tech1 —
    i.e. right at the point complete_assignment() is meant to be
    called from."""
    with app.app_context():
        nap = Nap(nap_code="NAP-100", name="Test NAP", latitude=14.6, longitude=121.0)
        db.session.add(nap)
        db.session.flush()

        sub = Subscriber(subscriber_code="SUB-100", full_name="Test Subscriber", nap_id=nap.id)
        db.session.add(sub)
        db.session.flush()

        tech1_user = User.query.filter_by(username="tech1").first()
        tech = Technician(user_id=tech1_user.id, full_name="Tech One")
        db.session.add(tech)
        db.session.flush()

        issue = TechnicalIssue(
            issue_code="ISS-0100",
            issue_type="No Internet",
            status="in_progress",
            subscriber_id=sub.id,
            nap_id=nap.id,
            latitude=14.6,
            longitude=121.0,
        )
        db.session.add(issue)
        db.session.flush()

        assignment = Assignment(
            technical_issue_id=issue.id,
            technician_id=tech.id,
            status="in_progress",
        )
        db.session.add(assignment)
        db.session.commit()

        return {"issue_id": issue.id, "technician_id": tech.id, "assignment_id": assignment.id}


# ---------------------------------------------------------------------
# 1. technician/history.html exists and renders
# ---------------------------------------------------------------------


def test_technician_history_page_renders_empty_state(app, client):
    # A linked profile with zero closed assignments — distinct from
    # the "no profile linked" warning branch, which has its own state
    # and isn't what this test is checking.
    with app.app_context():
        tech1_user = User.query.filter_by(username="tech1").first()
        db.session.add(Technician(user_id=tech1_user.id, full_name="Tech One"))
        db.session.commit()

    login(client, "tech1", "Tech@12345")
    resp = client.get("/technician/history")
    assert resp.status_code == 200
    assert b"No past assignments yet" in resp.data


def test_technician_history_page_shows_completed_assignment(app, client):
    ids = _seed(app)
    with app.app_context():
        assignment = Assignment.query.get(ids["assignment_id"])
        assignment.status = "completed"
        assignment.resolution_notes = "Replaced the drop cable."
        assignment.completed_at = datetime.utcnow()
        db.session.commit()

    login(client, "tech1", "Tech@12345")
    resp = client.get("/technician/history")
    assert resp.status_code == 200
    assert b"ISS-0100" in resp.data
    assert b"Replaced the drop cable." in resp.data


# ---------------------------------------------------------------------
# 2. complete_assignment now requires resolution_notes
# ---------------------------------------------------------------------


def test_complete_assignment_without_notes_is_rejected(app, client):
    ids = _seed(app)
    login(client, "tech1", "Tech@12345")

    resp = client.post(
        f"/technician/assignments/{ids['assignment_id']}/complete",
        data={},
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        assignment = Assignment.query.get(ids["assignment_id"])
        assert assignment.status == "in_progress"  # unchanged
        issue = TechnicalIssue.query.get(ids["issue_id"])
        assert issue.status == "in_progress"  # unchanged


def test_complete_assignment_with_notes_succeeds(app, client):
    ids = _seed(app)
    login(client, "tech1", "Tech@12345")

    resp = client.post(
        f"/technician/assignments/{ids['assignment_id']}/complete",
        data={"resolution_notes": "Found and fixed a bad splice."},
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        assignment = Assignment.query.get(ids["assignment_id"])
        assert assignment.status == "completed"
        assert assignment.resolution_notes == "Found and fixed a bad splice."
        issue = TechnicalIssue.query.get(ids["issue_id"])
        assert issue.status == "resolved"


# ---------------------------------------------------------------------
# 3. Resolved -> Closed transition
# ---------------------------------------------------------------------


def test_close_issue_requires_administrator(app, client):
    ids = _seed(app)
    with app.app_context():
        issue = TechnicalIssue.query.get(ids["issue_id"])
        issue.status = "resolved"
        db.session.commit()

    login(client, "tech1", "Tech@12345")
    resp = client.post(f"/issues/{ids['issue_id']}/close")
    assert resp.status_code == 403


def test_close_issue_only_valid_from_resolved(app, client):
    ids = _seed(app)  # issue starts 'in_progress'
    login(client, "admin1", "Admin@12345")

    resp = client.post(f"/issues/{ids['issue_id']}/close", follow_redirects=True)
    assert resp.status_code == 200

    with app.app_context():
        issue = TechnicalIssue.query.get(ids["issue_id"])
        assert issue.status == "in_progress"  # unchanged


def test_close_issue_from_resolved_succeeds(app, client):
    ids = _seed(app)
    with app.app_context():
        issue = TechnicalIssue.query.get(ids["issue_id"])
        issue.status = "resolved"
        db.session.commit()

    login(client, "admin1", "Admin@12345")
    resp = client.post(f"/issues/{ids['issue_id']}/close", follow_redirects=True)
    assert resp.status_code == 200

    with app.app_context():
        issue = TechnicalIssue.query.get(ids["issue_id"])
        assert issue.status == "closed"


def test_close_issue_button_only_shown_when_resolved(app, client):
    ids = _seed(app)  # issue is 'in_progress'
    login(client, "admin1", "Admin@12345")

    resp = client.get(f"/issues/{ids['issue_id']}")
    assert b"Close Issue" not in resp.data

    with app.app_context():
        issue = TechnicalIssue.query.get(ids["issue_id"])
        issue.status = "resolved"
        db.session.commit()

    resp = client.get(f"/issues/{ids['issue_id']}")
    assert b"Close Issue" in resp.data


# ---------------------------------------------------------------------
# 4. Assignment history on the admin issue detail page
# ---------------------------------------------------------------------


def test_issue_detail_shows_assignment_history_with_resolution_notes(app, client):
    ids = _seed(app)
    with app.app_context():
        assignment = Assignment.query.get(ids["assignment_id"])
        assignment.status = "completed"
        assignment.resolution_notes = "Swapped the ONT."
        assignment.completed_at = datetime.utcnow()
        db.session.commit()

    login(client, "admin1", "Admin@12345")
    resp = client.get(f"/issues/{ids['issue_id']}")
    assert resp.status_code == 200
    assert b"Assignment History" in resp.data
    assert b"Swapped the ONT." in resp.data


# ---------------------------------------------------------------------
# 5. GeoMap issue-focus support
# ---------------------------------------------------------------------


def test_geomap_with_issue_id_does_not_500(app, client):
    ids = _seed(app)
    login(client, "tech1", "Tech@12345")

    resp = client.get(f"/naps/map?issue_id={ids['issue_id']}")
    assert resp.status_code == 200
    assert (f'data-focus-issue-id="{ids["issue_id"]}"').encode() in resp.data


def test_geomap_without_issue_id_still_works(app, client):
    login(client, "tech1", "Tech@12345")
    resp = client.get("/naps/map")
    assert resp.status_code == 200
    assert b'data-focus-issue-id=""' in resp.data


# ---------------------------------------------------------------------
# 6. Technician Workload & Performance report
# ---------------------------------------------------------------------


def test_reports_page_shows_technician_workload(app, client):
    ids = _seed(app)
    with app.app_context():
        assignment = Assignment.query.get(ids["assignment_id"])
        assignment.status = "completed"
        assignment.resolution_notes = "Done."
        assignment.assigned_at = datetime.utcnow() - timedelta(hours=2)
        assignment.completed_at = datetime.utcnow()
        technician = Technician.query.get(ids["technician_id"])
        technician.resolved_issues_count = 1
        db.session.commit()

    login(client, "admin1", "Admin@12345")
    resp = client.get("/reports/")
    assert resp.status_code == 200
    assert b"Technician Workload" in resp.data
    assert b"Tech One" in resp.data
    assert b"hrs" in resp.data
