"""Landing-page Apply form: optional email + status emails."""

import pytest

from app.models import Subscriber


@pytest.fixture()
def sent(monkeypatch, app):
    mails = []
    monkeypatch.setattr("app.email_utils._send_email", lambda to, subj, html, text=None: mails.append((to, subj)) or True)
    monkeypatch.setattr("app.routes.main.recommend_naps", lambda *a, **k: [{"distance_km": 1}])
    app.config["REGISTER_RATE_LIMIT_PER_IP"] = "1000 per hour"
    return mails


def _body(**extra):
    b = {"full_name": "Ann Cruz", "address": "Purok 1", "contact_number": "09123456789",
         "latitude": 14.5, "longitude": 121.0}
    b.update(extra)
    return b


def test_email_is_optional(app, client, sent):
    r = client.post("/public/apply", json=_body())
    assert r.status_code == 201 and sent == []


def test_valid_email_saved_and_received_mail_sent(app, client, sent):
    r = client.post("/public/apply", json=_body(email="Ann@Example.com"))
    assert r.status_code == 201
    with app.app_context():
        assert Subscriber.query.one().email == "ann@example.com"
    assert [m[0] for m in sent] == ["ann@example.com"]
    assert "received" in sent[0][1].lower()


def test_invalid_email_rejected(app, client, sent):
    r = client.post("/public/apply", json=_body(email="not-an-email"))
    assert r.status_code == 400 and "email" in r.get_json()["errors"]
