"""Subscriber profile shows the linked subscriber's phone number; the
customer home shows a monthly due date that turns red once due."""

from datetime import date, datetime, timedelta

from app.billing_utils import add_one_month, monthly_due_info
from app.extensions import db
from app.models import Payment, Subscriber, User
from tests.conftest import login


def _subscriber(**kw):
    customer = User.query.filter_by(username="customer1").first()
    s = Subscriber(
        subscriber_code="SUB-0001", full_name="Mika Magsino", address="x",
        contact_number="09171234567", user_id=customer.id, **kw,
    )
    db.session.add(s)
    db.session.commit()
    return s


def test_add_one_month_clamps_to_month_end():
    assert add_one_month(date(2026, 1, 31)) == date(2026, 2, 28)
    assert add_one_month(date(2026, 12, 15)) == date(2027, 1, 15)


def test_due_logic(app):
    with app.app_context():
        s = _subscriber(installed_at=date(2026, 1, 10))
        today = date(2026, 2, 10)
        assert monthly_due_info(s, today)["is_due"] is True            # due today
        assert monthly_due_info(s, today)["days_overdue"] == 0
        assert monthly_due_info(s, date(2026, 2, 9))["is_due"] is False
        assert monthly_due_info(s, date(2026, 2, 15))["days_overdue"] == 5
        db.session.add(Payment(subscriber_id=s.id, amount=500, payment_date=date(2026, 2, 8), status="confirmed"))
        db.session.commit()
        assert monthly_due_info(s, date(2026, 2, 15))["due_date"] == date(2026, 3, 8)


def test_profile_shows_subscriber_phone(app, client):
    with app.app_context():
        _subscriber()
    login(client, "customer1", "User@12345")
    html = client.get("/profile/").get_data(as_text=True)
    assert "09171234567" in html
    edit = client.get("/profile/edit").get_data(as_text=True)
    assert "09171234567" in edit


def test_home_has_due_date_and_no_pending_requests_or_info_banner(app, client):
    with app.app_context():
        _subscriber(installed_at=date.today() - timedelta(days=90))   # long overdue
    login(client, "customer1", "User@12345")
    html = client.get("/portal/").get_data(as_text=True)
    assert "Monthly due date" in html
    assert "napiq-due-date--due" in html
    assert "Pending requests" not in html
    assert "from the sidebar" not in html


def test_home_due_date_not_red_when_not_due(app, client):
    with app.app_context():
        _subscriber(installed_at=date.today() - timedelta(days=3))
    login(client, "customer1", "User@12345")
    html = client.get("/portal/").get_data(as_text=True)
    assert "Monthly due date" in html
    assert "napiq-due-date--due" not in html
