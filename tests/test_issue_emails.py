"""Subscriber email notifications for technical issues: report received,
report merged into an open issue, and status changes. Emails are queued
and only sent after the DB commit succeeds."""

import pytest

from app import email_utils
from app.extensions import db
from app.models import Subscriber, TechnicalIssue
from app.notifications_utils import (
    notify_issue_status_change,
    notify_issue_updated,
    notify_new_issue_reported,
)


@pytest.fixture
def sent(monkeypatch):
    box = []
    monkeypatch.setattr(
        email_utils, "_send_email",
        lambda to, subject, html, text=None: box.append((to, subject, html, text)) or True,
    )
    return box


def _issue(email="sub@example.com", issue_type="No Internet", status="pending", name="Ana <b>Cruz</b>"):
    sub = Subscriber(subscriber_code="SUB-9001", full_name=name, email=email)
    db.session.add(sub)
    db.session.flush()
    issue = TechnicalIssue(issue_type=issue_type, status=status, subscriber_id=sub.id)
    db.session.add(issue)
    db.session.commit()
    issue.issue_code = f"ISS-{issue.id:04d}"
    db.session.commit()
    return issue


def test_report_received_email_sent_after_commit(app, sent):
    with app.app_context():
        issue = _issue()
        notify_new_issue_reported(issue)
        assert sent == []  # nothing before commit
        db.session.commit()
        assert len(sent) == 1
        to, subject, html, text = sent[0]
        assert to == "sub@example.com"
        assert issue.issue_code in subject and "Report received" in subject
        assert "successfully submitted" in text
        assert "<b>Cruz" not in html and "&lt;b&gt;Cruz" in html  # escaped


def test_status_change_email_and_dedupe(app, sent):
    with app.app_context():
        issue = _issue()
        issue.status = "assigned"
        notify_issue_status_change(issue)
        issue.status = "in_progress"
        notify_issue_status_change(issue)  # same transaction -> only the last is sent
        db.session.commit()
        assert len(sent) == 1
        assert "In progress" in sent[0][1]


def test_merged_report_email(app, sent):
    with app.app_context():
        issue = _issue(status="assigned")
        notify_issue_updated(issue)
        db.session.commit()
        assert len(sent) == 1 and "existing issue" in sent[0][2]


def test_rollback_sends_nothing(app, sent):
    with app.app_context():
        issue = _issue()
        issue.status = "resolved"
        notify_issue_status_change(issue)
        db.session.rollback()
        db.session.commit()
        assert sent == []


def test_falls_back_to_linked_user_email(app, sent):
    from app.models import User
    with app.app_context():
        issue = _issue(email=None)
        user = User.query.filter_by(username="customer1").first()
        user.email = "login@example.com"
        issue.subscriber.user_id = user.id
        db.session.commit()
        issue.status = "resolved"
        notify_issue_status_change(issue)
        db.session.commit()
        assert [s[0] for s in sent] == ["login@example.com"]


def test_no_email_when_none_on_file_or_fiber_break(app, sent):
    with app.app_context():
        no_email = _issue(email=None)
        notify_new_issue_reported(no_email)
        db.session.commit()
        assert sent == []
    with app.app_context():
        sub = Subscriber(subscriber_code="SUB-9002", full_name="B", email="b@example.com")
        db.session.add(sub)
        db.session.flush()
        fb = TechnicalIssue(issue_type="Fiber Break", status="pending", subscriber_id=sub.id)
        db.session.add(fb)
        db.session.commit()
        notify_new_issue_reported(fb)  # staff-logged outage, not the subscriber's report
        db.session.commit()
        assert sent == []


def test_voided_ticket_wording(app, sent):
    from datetime import datetime
    with app.app_context():
        issue = _issue()
        issue.status = "closed"
        issue.voided_at = datetime.utcnow()
        notify_issue_status_change(issue)
        db.session.commit()
        assert "closed by our" in sent[0][3]
