"""Ticket consolidation: 3+ open same-type tickets on one NAP fold into
the first-reported one; the parent's detail page lists every location;
completing the parent resolves them all."""

import io
from datetime import datetime, timedelta

from app.extensions import db
from app.issue_utils import (
    CONSOLIDATION_THRESHOLD,
    consolidate_nap_issues,
)
from app.models import Assignment, Nap, Subscriber, Technician, TechnicalIssue, User
from tests.conftest import login


def _world(app, n_subs=5):
    nap = Nap(nap_code="N-019", name="Parkside NAP", latitude=14.2790, longitude=121.4130)
    db.session.add(nap)
    db.session.flush()
    other_nap = Nap(nap_code="N-020", name="Other NAP", latitude=14.30, longitude=121.40)
    db.session.add(other_nap)
    db.session.flush()
    subs = []
    for i in range(n_subs):
        s = Subscriber(
            subscriber_code=f"SUB-{i:04d}", full_name=f"Sub {i}", address=f"{i} Test St",
            contact_number=f"0900000000{i}", nap_id=nap.id,
            latitude=14.2790 + i * 0.0005, longitude=121.4130 + i * 0.0005,
        )
        db.session.add(s)
        subs.append(s)
    tech_user = User.query.filter_by(username="tech1").first()
    tech = Technician(user_id=tech_user.id, full_name="Tech One", status="busy")
    db.session.add(tech)
    db.session.commit()
    return nap, other_nap, subs, tech


def _issue(sub, nap, minutes, issue_type="No Internet", assign_to=None):
    i = TechnicalIssue(
        issue_type=issue_type, status="pending", subscriber_id=sub.id, nap_id=nap.id,
        created_at=datetime.utcnow() - timedelta(minutes=minutes),
    )
    db.session.add(i)
    db.session.commit()
    i.issue_code = f"ISS-{i.id:04d}"
    if assign_to is not None:
        db.session.add(Assignment(technical_issue_id=i.id, technician_id=assign_to.id, status="assigned"))
        i.status = "assigned"
    db.session.commit()
    return i


def test_threshold_folds_into_first_reported(app):
    with app.app_context():
        nap, other, subs, tech = _world(app)
        a = _issue(subs[0], nap, 30, assign_to=tech)
        b = _issue(subs[1], nap, 20, assign_to=tech)
        assert consolidate_nap_issues(a) is None
        assert consolidate_nap_issues(b) is None  # only 2 so far
        c = _issue(subs[2], nap, 10)
        parent = consolidate_nap_issues(c)
        assert CONSOLIDATION_THRESHOLD == 3
        assert parent.id == a.id
        db.session.refresh(b)
        assert b.parent_issue_id == a.id and c.parent_issue_id == a.id
        assert a.parent_issue_id is None
        # b's un-started assignment is withdrawn, a's stays
        assert Assignment.query.filter_by(technical_issue_id=b.id).first().status == "cancelled"
        assert Assignment.query.filter_by(technical_issue_id=a.id).first().status == "assigned"
        # 4th ticket joins the existing parent directly
        d = _issue(subs[3], nap, 1)
        assert consolidate_nap_issues(d).id == a.id


def test_other_type_or_nap_not_grouped(app):
    with app.app_context():
        nap, other, subs, tech = _world(app)
        _issue(subs[0], nap, 30)
        _issue(subs[1], nap, 20, issue_type="Slow Internet")
        x = _issue(subs[2], other, 10)
        assert consolidate_nap_issues(x) is None
        assert TechnicalIssue.query.filter(TechnicalIssue.parent_issue_id.isnot(None)).count() == 0


def test_in_progress_ticket_stays_standalone(app):
    with app.app_context():
        nap, other, subs, tech = _world(app)
        a = _issue(subs[0], nap, 30, assign_to=tech)
        b = _issue(subs[1], nap, 20, assign_to=tech)
        Assignment.query.filter_by(technical_issue_id=b.id).first().status = "in_progress"
        db.session.commit()
        c = _issue(subs[2], nap, 10)
        consolidate_nap_issues(c)
        db.session.refresh(b)
        assert b.parent_issue_id is None  # technician already on it
        assert c.parent_issue_id == a.id


def test_detail_page_and_resolve_children(app, client):
    with app.app_context():
        nap, other, subs, tech = _world(app)
        a = _issue(subs[0], nap, 30, assign_to=tech)
        _issue(subs[1], nap, 20)
        c = _issue(subs[2], nap, 10)
        consolidate_nap_issues(c)
        asg = Assignment.query.filter_by(technical_issue_id=a.id).first()
        asg.status = "in_progress"
        # complete_assignment() refuses to finish a job without a photo,
        # and a consolidated job needs one per location.
        asg.photo_filename = "https://example.com/proof.jpg"
        for i in TechnicalIssue.query.all():
            i.proof_photo = f"https://example.com/proof-{i.id}.jpg"
        db.session.commit()
        aid, a_id = asg.id, a.id

    login(client, "tech1", "Tech@12345")
    for url in (f"/technician/tickets/{aid}", f"/technician/mobile/jobs/{aid}"):
        html = client.get(url).get_data(as_text=True)
        assert "Consolidated ticket" in html, url
        assert "3 location" in html
        assert "Sub 0" in html and "Sub 1" in html and "Sub 2" in html
        assert "Start route" in html and "FIRST REPORTED" in html

    resp = client.post(
        f"/technician/assignments/{aid}/complete",
        data={"resolution_notes": "Replaced splitter"}, follow_redirects=False,
    )
    assert resp.status_code in (302, 303), resp.status_code
    with app.app_context():
        statuses = {i.status for i in TechnicalIssue.query.all()}
        assert statuses == {"resolved"}


def test_dispatch_board_hides_children(app, client):
    with app.app_context():
        nap, other, subs, tech = _world(app)
        a = _issue(subs[0], nap, 30)
        _issue(subs[1], nap, 20)
        c = _issue(subs[2], nap, 10)
        consolidate_nap_issues(c)
        a_id, c_id = a.id, c.id  # read inside the app context (instances detach after it)
    login(client, "admin1", "Admin@12345")
    html = client.get("/dispatch/").get_data(as_text=True)
    assert html.count("ISS-") >= 1
    assert f"ISS-{a_id:04d}" in html
    assert f"ISS-{c_id:04d}" not in html


def test_per_location_proof_photos_gate_completion(app, client, monkeypatch):
    import app.routes.technician as tech_routes

    counter = {"n": 0}

    def fake_upload(photo, public_id=None, overwrite=True):
        counter["n"] += 1
        return {"secure_url": f"https://cdn.example.com/upload/v1/{public_id}.jpg"}

    monkeypatch.setattr(tech_routes.cloudinary.uploader, "upload", fake_upload)
    monkeypatch.setattr(tech_routes.cloudinary.uploader, "destroy", lambda *a, **k: None)

    with app.app_context():
        nap, other, subs, tech = _world(app)
        a = _issue(subs[0], nap, 30, assign_to=tech)
        b = _issue(subs[1], nap, 20)
        c = _issue(subs[2], nap, 10)
        consolidate_nap_issues(c)
        asg = Assignment.query.filter_by(technical_issue_id=a.id).first()
        asg.status = "in_progress"
        db.session.commit()
        aid, ids = asg.id, [a.id, b.id, c.id]
        outsider = _issue(subs[3], other, 5)
        outsider_id = outsider.id

    login(client, "tech1", "Tech@12345")

    def upload(issue_id):
        return client.post(
            f"/technician/assignments/{aid}/stops/{issue_id}/photo",
            data={"photo": (io.BytesIO(b"img"), "house.jpg")},
            content_type="multipart/form-data", follow_redirects=False,
        )

    def complete():
        return client.post(
            f"/technician/assignments/{aid}/complete",
            data={"resolution_notes": "Replaced splitter"}, follow_redirects=False,
        )

    def statuses():
        with app.app_context():
            return {i.status for i in TechnicalIssue.query.filter(TechnicalIssue.id.in_(ids))}

    # No photos at all -> blocked.
    assert complete().status_code in (302, 303)
    assert "in_progress" in statuses() or "assigned" in statuses()
    with app.app_context():
        assert Assignment.query.get(aid).status == "in_progress"

    # Page tells the technician what is missing and offers an upload per stop.
    html = client.get(f"/technician/tickets/{aid}").get_data(as_text=True)
    assert "3 still missing" in html and html.count("Add proof photo") == 3

    # Photos for 2 of 3 stops -> still blocked.
    assert upload(ids[0]).status_code in (302, 303)
    assert upload(ids[1]).status_code in (302, 303)
    complete()
    with app.app_context():
        assert Assignment.query.get(aid).status == "in_progress"
        # The parent's photo doubles as the assignment's completion photo.
        assert Assignment.query.get(aid).photo_filename
        assert TechnicalIssue.query.get(ids[0]).proof_photo
        assert TechnicalIssue.query.get(ids[1]).proof_photo
        assert TechnicalIssue.query.get(ids[2]).proof_photo is None
    assert "1 still missing" in client.get(f"/technician/tickets/{aid}").get_data(as_text=True)

    # A ticket that is not part of this job can't be photographed.
    assert upload(outsider_id).status_code == 404

    # Last photo -> job can be completed; every ticket keeps its own proof.
    upload(ids[2])
    resp = complete()
    assert resp.status_code in (302, 303)
    with app.app_context():
        assert Assignment.query.get(aid).status == "completed"
        issues = TechnicalIssue.query.filter(TechnicalIssue.id.in_(ids)).all()
        assert {i.status for i in issues} == {"resolved"}
        assert len({i.proof_photo for i in issues}) == 3
