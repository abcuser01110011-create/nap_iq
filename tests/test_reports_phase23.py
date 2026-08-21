"""Phase 23 coverage (phase_12.pdf) — the four new Reports tabs
(NAP Inventory, Subscriber, Service Request, Payment reports),
their filters, the unknown-`report=` fallback, and the two new
notification events (new issue reported, payment requiring
confirmation).

Same two-group split the rest of this suite uses (see
tests/test_nap_recommendation.py): plain integration tests via the
Flask `client` fixture, in-memory SQLite (conftest.py). Reports are
read-only so there's no separate pure-logic group here — every test
goes through the real `/reports/` route.

Scope, matching PHASE23 continuation notes item 2 exactly:
  - each of the 4 new reports (nap_inventory, subscribers,
    service_requests, payments): 200 for an administrator, 403 for a
    non-administrator
  - each new report's filters actually narrow results (at least one
    filter test per report)
  - the unknown-`report=` key fallback to `issues`
  - notification coverage: test_new_issue_reported (staff route +
    customer route, one admin-audience Notification row each),
    test_payment_pending_confirmation_on_create (collector + admin
    add_payment), test_payment_pending_confirmation_on_edit_transition
    (only fires when status changes INTO pending)
"""

from datetime import date

from app.extensions import db
from app.models import Nap, Subscriber, ServiceRequest, Payment, User, Notification

from tests.conftest import login


# ---------------------------------------------------------------------
# Shared seed helpers
# ---------------------------------------------------------------------

def _seed_nap(app, *, code="NAP-500", status="active"):
    with app.app_context():
        nap = Nap(
            nap_code=code, name=f"{code} Test NAP",
            latitude=14.6000, longitude=121.0000,
            total_ports=8, used_ports=2, available_ports=6, status=status,
        )
        db.session.add(nap)
        db.session.commit()
        return nap.id


def _seed_subscriber(app, nap_id, *, code="SUB-500", status="active",
                      installed_at=date(2026, 1, 1), user_id=None):
    with app.app_context():
        sub = Subscriber(
            subscriber_code=code, full_name=f"{code} Subscriber",
            nap_id=nap_id, status=status, installed_at=installed_at,
            user_id=user_id,
        )
        db.session.add(sub)
        db.session.commit()
        return sub.id


# ---------------------------------------------------------------------
# 1. Report access — 200 for administrator, 403 for non-administrator
# ---------------------------------------------------------------------

def test_nap_inventory_report_requires_administrator(client):
    login(client, "tech1", "Tech@12345")
    resp = client.get("/reports/?report=nap_inventory")
    assert resp.status_code == 403


def test_nap_inventory_report_renders_for_administrator(app, client):
    nap_id = _seed_nap(app)
    login(client, "admin1", "Admin@12345")
    resp = client.get("/reports/?report=nap_inventory")
    assert resp.status_code == 200
    assert b"NAP-500" in resp.data


def test_subscribers_report_requires_administrator(client):
    login(client, "collector1", "Collect@12345")
    resp = client.get("/reports/?report=subscribers")
    assert resp.status_code == 403


def test_subscribers_report_renders_for_administrator(app, client):
    nap_id = _seed_nap(app, code="NAP-501")
    _seed_subscriber(app, nap_id, code="SUB-501")
    login(client, "admin1", "Admin@12345")
    resp = client.get("/reports/?report=subscribers")
    assert resp.status_code == 200
    assert b"SUB-501" in resp.data


def test_service_requests_report_requires_administrator(client):
    login(client, "customer1", "User@12345")
    resp = client.get("/reports/?report=service_requests")
    assert resp.status_code == 403


def test_service_requests_report_renders_for_administrator(app, client):
    nap_id = _seed_nap(app, code="NAP-502")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-502")
    with app.app_context():
        sr = ServiceRequest(
            request_type="new_installation", subscriber_id=sub_id,
            requested_nap_id=nap_id, status="pending",
        )
        db.session.add(sr)
        db.session.commit()
    login(client, "admin1", "Admin@12345")
    resp = client.get("/reports/?report=service_requests")
    assert resp.status_code == 200
    assert b"SUB-502" in resp.data


def test_payments_report_requires_administrator(client):
    login(client, "tech2", "Tech@12345")
    resp = client.get("/reports/?report=payments")
    assert resp.status_code == 403


def test_payments_report_renders_for_administrator(app, client):
    nap_id = _seed_nap(app, code="NAP-503")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-503")
    with app.app_context():
        payment = Payment(
            subscriber_id=sub_id, amount=250.00, payment_method="cash",
            payment_date=date(2026, 5, 1), status="confirmed",
        )
        db.session.add(payment)
        db.session.commit()
    login(client, "admin1", "Admin@12345")
    resp = client.get("/reports/?report=payments")
    assert resp.status_code == 200
    assert b"SUB-503" in resp.data


# ---------------------------------------------------------------------
# 2. Each new report's own filter actually narrows results
# ---------------------------------------------------------------------

def test_nap_inventory_report_status_filter_narrows_results(app, client):
    _seed_nap(app, code="NAP-510", status="active")
    _seed_nap(app, code="NAP-511", status="maintenance")
    login(client, "admin1", "Admin@12345")

    resp_all = client.get("/reports/?report=nap_inventory")
    assert b"NAP-510" in resp_all.data
    assert b"NAP-511" in resp_all.data

    resp_filtered = client.get("/reports/?report=nap_inventory&inv_status=maintenance")
    assert resp_filtered.status_code == 200
    assert b"NAP-511" in resp_filtered.data
    assert b"NAP-510" not in resp_filtered.data


def test_subscribers_report_status_filter_narrows_results(app, client):
    nap_id = _seed_nap(app, code="NAP-512")
    _seed_subscriber(app, nap_id, code="SUB-510", status="active")
    _seed_subscriber(app, nap_id, code="SUB-511", status="disconnected")
    login(client, "admin1", "Admin@12345")

    resp_all = client.get("/reports/?report=subscribers")
    assert b"SUB-510" in resp_all.data
    assert b"SUB-511" in resp_all.data

    resp_filtered = client.get("/reports/?report=subscribers&sub_status=disconnected")
    assert resp_filtered.status_code == 200
    assert b"SUB-511" in resp_filtered.data
    assert b"SUB-510" not in resp_filtered.data


def test_service_requests_report_status_filter_narrows_results(app, client):
    nap_id = _seed_nap(app, code="NAP-513")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-512")
    with app.app_context():
        db.session.add_all([
            ServiceRequest(request_type="new_installation", subscriber_id=sub_id, status="pending"),
            ServiceRequest(request_type="upgrade", subscriber_id=sub_id, status="completed"),
        ])
        db.session.commit()
    login(client, "admin1", "Admin@12345")

    resp_all = client.get("/reports/?report=service_requests")
    # The table cell only wraps `request_type|replace('_', ' ')` in a
    # `text-capitalize` CSS class (visual only) — the raw response
    # bytes stay lowercase, unlike the Issues/Payments tables which
    # apply Jinja's `|capitalize` filter server-side. Assert on the
    # actual rendered text, not the on-screen appearance.
    assert b"new installation" in resp_all.data
    assert b"upgrade" in resp_all.data

    resp_filtered = client.get("/reports/?report=service_requests&sr_status=completed")
    assert resp_filtered.status_code == 200
    assert b"upgrade" in resp_filtered.data
    assert b"new installation" not in resp_filtered.data


def test_payments_report_method_filter_narrows_results(app, client):
    nap_id = _seed_nap(app, code="NAP-514")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-513")
    with app.app_context():
        db.session.add_all([
            Payment(subscriber_id=sub_id, amount=100, payment_method="cash",
                    payment_date=date(2026, 5, 1), status="confirmed"),
            Payment(subscriber_id=sub_id, amount=200, payment_method="gcash",
                    payment_date=date(2026, 5, 2), status="confirmed"),
        ])
        db.session.commit()
    login(client, "admin1", "Admin@12345")

    resp_all = client.get("/reports/?report=payments")
    assert b"100.00" in resp_all.data
    assert b"200.00" in resp_all.data

    resp_filtered = client.get("/reports/?report=payments&pay_method=gcash")
    assert resp_filtered.status_code == 200
    assert b"200.00" in resp_filtered.data
    assert b"100.00" not in resp_filtered.data


# ---------------------------------------------------------------------
# 3. Unknown `report=` key falls back to `issues`
# ---------------------------------------------------------------------

def test_unknown_report_key_falls_back_to_issues(client):
    login(client, "admin1", "Admin@12345")
    resp = client.get("/reports/?report=not_a_real_report")
    assert resp.status_code == 200
    assert b"Technical Issue Report" in resp.data


# ---------------------------------------------------------------------
# 4. Notifications — "New issue reported"
# ---------------------------------------------------------------------

def test_new_issue_reported_notification_staff_route(app, client):
    nap_id = _seed_nap(app, code="NAP-520")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-520")
    login(client, "admin1", "Admin@12345")

    resp = client.post(
        "/issues/report",
        data={
            "issue_type": "No Internet",
            "subscriber_id": sub_id,
            "nap_id": 0,
            "address": "",
            "latitude": "14.6000",
            "longitude": "121.0000",
            "priority": "high",
            "description": "No connectivity for this subscriber.",
        },
    )
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "success"

    with app.app_context():
        rows = Notification.query.filter_by(
            audience="administrator", category="issue"
        ).all()
        assert len(rows) == 1
        assert rows[0].title.startswith("New issue reported")


def test_new_issue_reported_notification_customer_route(app, client):
    nap_id = _seed_nap(app, code="NAP-521")
    with app.app_context():
        user = User(
            username="portaluser1", full_name="Portal User",
            email="portaluser1@example.test", role="user", status="active",
        )
        user.set_password("Portal@12345")
        db.session.add(user)
        db.session.flush()
        sub = Subscriber(
            subscriber_code="SUB-521", full_name="Portal User Sub",
            nap_id=nap_id, status="active", user_id=user.id,
        )
        db.session.add(sub)
        db.session.commit()

    login(client, "portaluser1", "Portal@12345")
    resp = client.post(
        "/customer/report-issue",
        data={
            "issue_type": "Slow Internet",
            "priority": "medium",
            "description": "Connection has been slow all week.",
        },
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        rows = Notification.query.filter_by(
            audience="administrator", category="issue"
        ).all()
        assert len(rows) == 1
        assert rows[0].title.startswith("New issue reported")
        # Administrator-facing only — no customer-audience row for this
        # event (see notifications_utils.py's notify_new_issue_reported).
        customer_rows = Notification.query.filter_by(audience="customer").all()
        assert customer_rows == []


# ---------------------------------------------------------------------
# 5. Notifications — "Payment requiring confirmation"
# ---------------------------------------------------------------------

def test_payment_pending_confirmation_on_create_by_collector(app, client):
    nap_id = _seed_nap(app, code="NAP-522")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-522")
    login(client, "collector1", "Collect@12345")

    resp = client.post(
        "/collector/record",
        data={
            "subscriber_id": sub_id,
            "amount": "500.00",
            "payment_method": "cash",
            "payment_date": "2026-05-10",
            "reference_number": "",
            "status": "pending",
        },
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        rows = Notification.query.filter_by(
            audience="administrator", category="payment"
        ).all()
        assert len(rows) == 1
        assert rows[0].title.startswith("Payment requires confirmation")


def test_payment_pending_confirmation_on_create_by_administrator(app, client):
    nap_id = _seed_nap(app, code="NAP-523")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-523")
    login(client, "admin1", "Admin@12345")

    resp = client.post(
        "/payments/add",
        data={
            "subscriber_id": sub_id,
            "amount": "300.00",
            "payment_method": "gcash",
            "payment_date": "2026-05-11",
            "reference_number": "",
            "status": "pending",
        },
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        rows = Notification.query.filter_by(
            audience="administrator", category="payment"
        ).all()
        assert len(rows) == 1
        assert rows[0].title.startswith("Payment requires confirmation")


def test_payment_pending_confirmation_on_edit_transition(app, client):
    """Only fires when a payment's status changes INTO 'pending' — an
    edit that leaves it pending (or moves it between two other
    statuses) must not (re-)notify."""
    nap_id = _seed_nap(app, code="NAP-524")
    sub_id = _seed_subscriber(app, nap_id, code="SUB-524")
    with app.app_context():
        payment = Payment(
            subscriber_id=sub_id, amount=150.00, payment_method="cash",
            payment_date=date(2026, 5, 12), status="confirmed",
        )
        db.session.add(payment)
        db.session.commit()
        payment_id = payment.id

    login(client, "admin1", "Admin@12345")

    # Transition confirmed -> pending: should notify.
    resp = client.post(
        f"/payments/{payment_id}/edit",
        data={
            "subscriber_id": sub_id,
            "amount": "150.00",
            "payment_method": "cash",
            "payment_date": "2026-05-12",
            "reference_number": "",
            "status": "pending",
        },
        follow_redirects=True,
    )
    assert resp.status_code == 200

    with app.app_context():
        rows = Notification.query.filter_by(
            audience="administrator", category="payment"
        ).all()
        assert len(rows) == 1
        assert rows[0].title.startswith("Payment requires confirmation")

    # A second edit that leaves it pending (status untouched) must NOT
    # add another "requires confirmation" notification.
    resp2 = client.post(
        f"/payments/{payment_id}/edit",
        data={
            "subscriber_id": sub_id,
            "amount": "175.00",
            "payment_method": "cash",
            "payment_date": "2026-05-12",
            "reference_number": "",
            "status": "pending",
        },
        follow_redirects=True,
    )
    assert resp2.status_code == 200

    with app.app_context():
        rows = Notification.query.filter_by(
            audience="administrator", category="payment"
        ).all()
        assert len(rows) == 1
