"""Forgot-password (staff) backend: emailed 6-digit code -> new password."""
from unittest.mock import patch

from app.extensions import db
from app.models import EmailVerification, User


def _staff(app):
    with app.app_context():
        u = User.query.filter(User.role != "user", User.status == "active").first()
        u.email = "staff.reset@example.com"
        db.session.commit()
        return "staff.reset@example.com", u.id


def test_full_reset_flow(app, client):
    email, uid = _staff(app)
    with patch("app.email_utils._send_email", return_value=True) as sent:
        r = client.post("/forgot-password/send", json={"email": email})
    assert r.status_code == 200 and sent.called
    with app.app_context():
        code = EmailVerification.query.filter_by(email="staff.reset@example.com").first().code
    assert client.post("/forgot-password/verify", json={"email": email, "code": "000000" if code != "000000" else "111111"}).status_code == 400
    assert client.post("/forgot-password/reset", json={"password": "Newpass1!", "confirm_password": "Newpass1!"}).status_code == 400
    assert client.post("/forgot-password/verify", json={"email": email, "code": code}).status_code == 200
    assert client.post("/forgot-password/reset", json={"password": "weak", "confirm_password": "weak"}).status_code == 400
    assert client.post("/forgot-password/reset", json={"password": "Newpass1!", "confirm_password": "Newpass1!"}).status_code == 200
    with app.app_context():
        assert db.session.get(User, uid).check_password("Newpass1!")


def test_unknown_email_is_generic(client):
    with patch("app.email_utils._send_email", return_value=True) as sent:
        r = client.post("/forgot-password/send", json={"email": "nobody@example.com"})
    assert r.status_code == 200 and not sent.called
