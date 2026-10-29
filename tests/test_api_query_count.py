"""GeoMap feeds must not issue one query per NAP/subscriber (each query is a
network round trip to the hosted database)."""

from datetime import date

from sqlalchemy import event

from app.extensions import db
from app.models import Nap, Subscriber


def _login_admin(client):
    return client.post("/login", data={"username": "admin1", "password": "Admin@12345"})


def _count(app, fn):
    n = {"q": 0}

    def hook(*a, **k):
        n["q"] += 1

    with app.app_context():
        event.listen(db.engine, "before_cursor_execute", hook)
        try:
            fn()
        finally:
            event.remove(db.engine, "before_cursor_execute", hook)
    return n["q"]


def test_naps_and_subscribers_feeds_use_constant_queries(app, client):
    with app.app_context():
        for i in range(12):
            nap = Nap(nap_code=f"NAP-{i}", name=f"Nap {i}", address="x", latitude=14.28, longitude=121.41,
                      total_ports=16, used_ports=0, available_ports=16, status="active")
            db.session.add(nap)
            db.session.flush()
            for j in range(5):
                db.session.add(Subscriber(subscriber_code=f"SUB-{i}-{j}", full_name=f"S{i}{j}", address="x",
                                          latitude=14.28, longitude=121.41, nap_id=nap.id, status="active",
                                          installed_at=date(2025, 1, 1)))
        db.session.commit()
    _login_admin(client)

    q_naps = _count(app, lambda: client.get("/api/naps"))
    q_subs = _count(app, lambda: client.get("/api/subscribers"))
    assert client.get("/api/naps").status_code == 200
    assert len(client.get("/api/subscribers").get_json()) == 60
    # 12 NAPs / 60 subscribers: previously ~50 and ~60+ queries.
    assert q_naps <= 12, q_naps
    assert q_subs <= 12, q_subs
