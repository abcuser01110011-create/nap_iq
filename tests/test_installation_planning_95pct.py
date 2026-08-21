"""Installation Planning integration, Phase 7 (95%) coverage.

Covers `POST /subscribers/quick-add`
(`app.routes.subscribers.quick_add_subscriber`) -- the create endpoint
behind the GeoMap's "Plan Installation" flow (Phase 5, 70%) -- against
`INSTALLATION_PLANNING_PHASES.md`'s Phase 7 checklist:

    * a non-administrator cannot reach the create endpoint by any
      route, including a direct request that bypasses the UI entirely
      (this file's `test_*_forbidden`/`test_requires_login` group);
    * submitting with invalid/missing data is rejected with real
      per-field errors, not a silent failure (`test_missing_*`,
      `test_*_too_long`);
    * a NAP that no longer has capacity by the time of submission is
      rejected rather than silently linked to (`test_nap_without_capacity_rejected`,
      `test_inactive_nap_rejected`, `test_nonexistent_nap_rejected`);
    * a duplicate subscriber code is rejected the same way
      `SubscriberForm` already rejects one for the regular
      Subscribers -> Add Subscriber flow (`test_duplicate_subscriber_code_rejected`);
    * a successful create does not perturb `naps.available_ports`/
      `used_ports` bookkeeping, matching `add_subscriber()`'s own
      documented behavior (`test_successful_create_leaves_nap_capacity_untouched`);
    * the existing Subscribers -> Add Subscriber route
      (`add_subscriber()`) is completely unaffected by this route's
      existence (`test_regular_add_subscriber_route_still_works`).

`GET /api/naps/nearest-available`'s own RBAC/parameter-validation
coverage already lives in `test_installation_planning_25pct.py` and is
not repeated here. The `requestSeq`-based stale-create-response guard
added to `app/static/js/nap-install-planner.js` this phase is
browser-side JavaScript with no server-observable behavior of its own
(it only decides whether the *client* re-renders a response it already
received) -- see `PLAN_INSTALL_95_PERCENT_NOTES.md` for why that fix
is verified by code trace rather than an automated test in this file,
and for the full item-by-item trace of every other Phase 7 checklist
item.
"""

from app.extensions import db
from app.models import Nap, Subscriber

from tests.conftest import login


def _seed_nap(**overrides):
    defaults = dict(
        nap_code="NAP-700",
        name="Test NAP",
        address="Test Address",
        latitude=14.6000,
        longitude=121.0000,
        total_ports=8,
        used_ports=2,
        available_ports=6,
        status="active",
    )
    defaults.update(overrides)
    nap = Nap(**defaults)
    db.session.add(nap)
    db.session.commit()
    return nap


def _quick_add_payload(nap, **overrides):
    payload = dict(
        subscriber_code="SUB-9001",
        full_name="Juan Dela Cruz",
        address="123 Test St, Barangay Test",
        plan_type="Home 25 Mbps",
        latitude="14.6001",
        longitude="121.0001",
        nap_id=str(nap.id),
    )
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------
# RBAC: the create endpoint must reject a non-administrator itself,
# not merely hide the "Plan Installation" button from one.
# ---------------------------------------------------------------------


def test_requires_login(app, client):
    with app.app_context():
        nap = _seed_nap()
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(nap))
        assert resp.status_code == 302  # redirected to /login
        assert Subscriber.query.count() == 0


def test_technician_forbidden(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "tech1", "Tech@12345")
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(nap))
        assert resp.status_code == 403
        assert Subscriber.query.count() == 0


def test_customer_forbidden(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "customer1", "User@12345")
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(nap))
        assert resp.status_code == 403
        assert Subscriber.query.count() == 0


def test_payment_collector_forbidden(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "collector1", "Collect@12345")
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(nap))
        assert resp.status_code == 403
        assert Subscriber.query.count() == 0


# ---------------------------------------------------------------------
# Invalid / missing data -- rejected with real field errors, not a
# silent failure or a fabricated success.
# ---------------------------------------------------------------------


def test_missing_full_name_rejected(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(nap, full_name="")
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["status"] == "error"
        assert "full_name" in body["errors"]
        assert Subscriber.query.count() == 0


def test_missing_subscriber_code_rejected(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(nap, subscriber_code="")
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        assert "subscriber_code" in resp.get_json()["errors"]
        assert Subscriber.query.count() == 0


def test_missing_latitude_rejected(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(nap, latitude="")
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        assert "latitude" in resp.get_json()["errors"]
        assert Subscriber.query.count() == 0


def test_missing_nap_id_rejected(app, client):
    with app.app_context():
        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(type("_", (), {"id": 1})())
        del payload["nap_id"]
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        assert "nap_id" in resp.get_json()["errors"]
        assert Subscriber.query.count() == 0


def test_out_of_range_latitude_rejected(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(nap, latitude="999")
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        assert "latitude" in resp.get_json()["errors"]
        assert Subscriber.query.count() == 0


def test_full_name_too_long_rejected(app, client):
    with app.app_context():
        nap = _seed_nap()
        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(nap, full_name="A" * 101)
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        assert "full_name" in resp.get_json()["errors"]
        assert Subscriber.query.count() == 0


# ---------------------------------------------------------------------
# The suggested NAP no longer being valid by submit time -- re-checked
# server-side rather than trusted from the page (matches
# quick_add_nap()/assign_nap()'s existing discipline for client-
# sourced values).
# ---------------------------------------------------------------------


def test_nap_without_capacity_rejected(app, client):
    with app.app_context():
        nap = _seed_nap(nap_code="NAP-701", available_ports=0)
        login(client, "admin1", "Admin@12345")
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(nap))
        assert resp.status_code == 409
        body = resp.get_json()
        assert body["status"] == "error"
        assert "nap_id" in body["errors"]
        assert Subscriber.query.count() == 0


def test_inactive_nap_rejected(app, client):
    with app.app_context():
        nap = _seed_nap(nap_code="NAP-702", status="maintenance", available_ports=5)
        login(client, "admin1", "Admin@12345")
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(nap))
        assert resp.status_code == 409
        assert Subscriber.query.count() == 0


def test_nonexistent_nap_rejected(app, client):
    with app.app_context():
        login(client, "admin1", "Admin@12345")
        fake_nap = type("_", (), {"id": 999999})()
        resp = client.post("/subscribers/quick-add", data=_quick_add_payload(fake_nap))
        assert resp.status_code == 400
        assert "nap_id" in resp.get_json()["errors"]
        assert Subscriber.query.count() == 0


def test_duplicate_subscriber_code_rejected(app, client):
    with app.app_context():
        nap = _seed_nap(nap_code="NAP-703")
        existing = Subscriber(
            subscriber_code="SUB-DUP-1",
            full_name="Existing Subscriber",
            status="active",
        )
        db.session.add(existing)
        db.session.commit()

        login(client, "admin1", "Admin@12345")
        payload = _quick_add_payload(nap, subscriber_code="SUB-DUP-1")
        resp = client.post("/subscribers/quick-add", data=payload)
        assert resp.status_code == 400
        assert "subscriber_code" in resp.get_json()["errors"]
        assert Subscriber.query.filter_by(subscriber_code="SUB-DUP-1").count() == 1


# ---------------------------------------------------------------------
# The success path: a real row, linked correctly, at the correct
# coordinates, with the NAP's own capacity bookkeeping left untouched
# (matching add_subscriber()'s documented behavior exactly).
# ---------------------------------------------------------------------


def test_successful_create_leaves_nap_capacity_untouched(app, client):
    with app.app_context():
        nap = _seed_nap(nap_code="NAP-704", available_ports=6, used_ports=2, total_ports=8)
        login(client, "admin1", "Admin@12345")

        resp = client.post(
            "/subscribers/quick-add",
            data=_quick_add_payload(nap, subscriber_code="SUB-9010", latitude="14.6002", longitude="121.0002"),
        )
        assert resp.status_code == 201
        body = resp.get_json()
        assert body["status"] == "success"
        assert body["subscriber"]["nap_id"] == nap.id
        assert body["subscriber"]["nap_code"] == "NAP-704"

        created = Subscriber.query.filter_by(subscriber_code="SUB-9010").first()
        assert created is not None
        assert created.nap_id == nap.id
        assert float(created.latitude) == 14.6002
        assert float(created.longitude) == 121.0002
        assert created.status == "active"

        refreshed_nap = Nap.query.get(nap.id)
        assert refreshed_nap.available_ports == 6
        assert refreshed_nap.used_ports == 2


def test_regular_add_subscriber_route_still_works(app, client):
    """Confirms Subscribers -> Add Subscriber (add_subscriber(),
    unmodified this phase) is unaffected by quick_add_subscriber()'s
    existence -- the two share validation shape but not a code path."""
    with app.app_context():
        nap = _seed_nap(nap_code="NAP-705")
        login(client, "admin1", "Admin@12345")

        resp = client.post(
            "/subscribers/add",
            data={
                "subscriber_code": "SUB-REG-1",
                "full_name": "Regular Flow Subscriber",
                "address": "456 Regular St",
                "latitude": "14.6100",
                "longitude": "121.0100",
                "contact_number": "",
                "email": "",
                "plan_type": "Home 25 Mbps",
                "nap_id": str(nap.id),
                "status": "active",
                "installed_at": "",
            },
            follow_redirects=False,
        )
        assert resp.status_code == 302
        assert Subscriber.query.filter_by(subscriber_code="SUB-REG-1").count() == 1
