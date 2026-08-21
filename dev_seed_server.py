"""
One-off dev server for VISUAL verification only (Outstanding item 1 from
PHASE20_NOTES.md). Boots the real Flask app against a fresh on-disk
SQLite DB seeded with enough data to exercise:
  - Technician Workload & Performance report (multiple technicians,
    multiple open-status counts, one with a real average resolution time)
  - Assignment History table with a genuinely long resolution_notes value
    (to see real column wrapping under real Bootstrap CSS)
  - technician/history.html empty state (tech2, no profile) and populated
    state (tech1)
Not part of the test suite and not shipped to app/ — safe to delete
after the manual check.
"""
import os
import sys
from datetime import datetime, timedelta

os.environ.setdefault("SECRET_KEY", "dev-visual-check")

sys.path.insert(0, os.path.dirname(__file__))

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import User, Nap, Subscriber, Technician, TechnicalIssue, Assignment


class VisualCheckConfig(Config):
    TESTING = False
    DEBUG = False
    SQLALCHEMY_DATABASE_URI = "sqlite:///" + os.path.join(os.path.dirname(__file__), "dev_visual_check.db")
    SECRET_KEY = "dev-visual-check"
    WTF_CSRF_ENABLED = True
    FORCE_HTTPS = False
    RATELIMIT_STORAGE_URI = "memory://"


def seed(app):
    with app.app_context():
        db.drop_all()
        db.create_all()

        accounts = [
            ("admin1", "Admin@12345", "administrator", "active"),
            ("tech1", "Tech@12345", "technician", "active"),
            ("tech2", "Tech@12345", "technician", "active"),
        ]
        users = {}
        for username, password, role, status in accounts:
            u = User(username=username, full_name=username.title(),
                     email=f"{username}@example.test", role=role, status=status)
            u.set_password(password)
            db.session.add(u)
            db.session.flush()
            users[username] = u

        nap = Nap(nap_code="NAP-0100", name="Barangay San Isidro NAP", latitude=14.281, longitude=121.415)
        db.session.add(nap)
        db.session.flush()

        sub = Subscriber(subscriber_code="SUB-0100", full_name="Maria Santos", nap_id=nap.id)
        db.session.add(sub)
        db.session.flush()

        tech1 = Technician(user_id=users["tech1"].id, full_name="Tech One")
        db.session.add(tech1)
        db.session.flush()
        # tech2 deliberately gets no Technician profile row -> exercises
        # the "no profile linked" branch on /technician/history and /technician/

        # Issue currently in_progress, assigned to tech1 (for GeoMap + dashboard)
        issue1 = TechnicalIssue(issue_code="ISS-0100", issue_type="No Internet", status="in_progress",
                                 subscriber_id=sub.id, nap_id=nap.id, latitude=14.281, longitude=121.415)
        db.session.add(issue1)
        db.session.flush()
        a1 = Assignment(technical_issue_id=issue1.id, technician_id=tech1.id, status="in_progress")
        db.session.add(a1)

        # A resolved issue for the admin "Close Issue" button check
        issue2 = TechnicalIssue(issue_code="ISS-0101", issue_type="Slow Connection", status="resolved",
                                 subscriber_id=sub.id, nap_id=nap.id, latitude=14.282, longitude=121.416)
        db.session.add(issue2)
        db.session.flush()
        long_notes = (
            "Replaced the drop cable from the NAP to the subscriber's ONU after confirming "
            "signal loss with an OPM reading of -29dBm at the port. Re-terminated both ends, "
            "verified sync at -19dBm, ran a sustained speed test for 15 minutes with no drops, "
            "and confirmed with the subscriber over the phone that the connection has been "
            "stable since the visit. Recommended a follow-up check in 30 days given the age of "
            "the existing drop cable elsewhere on this NAP's other ports."
        )
        a2 = Assignment(technical_issue_id=issue2.id, technician_id=tech1.id, status="completed",
                         resolution_notes=long_notes,
                         assigned_at=datetime.utcnow() - timedelta(hours=5),
                         completed_at=datetime.utcnow() - timedelta(hours=2))
        db.session.add(a2)

        # A couple more completed assignments so the Workload report has
        # a real average-resolution-time and busiest-first sort to show.
        for i in range(2):
            issue = TechnicalIssue(issue_code=f"ISS-020{i}", issue_type="Intermittent", status="closed",
                                    subscriber_id=sub.id, nap_id=nap.id, latitude=14.28, longitude=121.41)
            db.session.add(issue)
            db.session.flush()
            asg = Assignment(technical_issue_id=issue.id, technician_id=tech1.id, status="completed",
                              resolution_notes=f"Fixed intermittent drop #{i}.",
                              assigned_at=datetime.utcnow() - timedelta(hours=4 + i),
                              completed_at=datetime.utcnow() - timedelta(hours=1 + i))
            db.session.add(asg)

        db.session.commit()
        print("Seeded OK. Issue1 id:", issue1.id)


if __name__ == "__main__":
    app = create_app(VisualCheckConfig)
    seed(app)
    app.run(host="127.0.0.1", port=5055, debug=False, use_reloader=False)
