"""Pure-logic tests for app/hitpay.py (no database, no network)."""
import hashlib
import hmac
import json

import pytest
from flask import Flask

from app import hitpay


@pytest.fixture()
def ctx():
    app = Flask(__name__)
    app.config.update(HITPAY_API_KEY="key", HITPAY_SALT="salt123", HITPAY_ENV="sandbox")
    with app.app_context():
        yield app


def _sig(body: bytes, salt="salt123"):
    return hmac.new(salt.encode(), body, hashlib.sha256).hexdigest()


def test_signature_valid_and_invalid(ctx):
    body = json.dumps({"id": "x", "status": "completed"}).encode()
    assert hitpay.verify_signature(body, _sig(body))
    assert not hitpay.verify_signature(body, _sig(body, salt="other"))
    assert not hitpay.verify_signature(body, "")
    assert not hitpay.verify_signature(body + b" ", _sig(body))


def test_signature_accepts_compact_reserialisation(ctx):
    pretty = b'{\n  "id": "x",\n  "status": "completed"\n}'
    compact = json.dumps(json.loads(pretty), separators=(",", ":")).encode()
    assert hitpay.verify_signature(pretty, _sig(compact))


def test_reference_roundtrip():
    assert hitpay.payment_id_from_reference(hitpay.reference_for(42)) == 42
    assert hitpay.payment_id_from_reference("OTHER-1") is None
    assert hitpay.payment_id_from_reference("NAPIQ-abc") is None
    assert hitpay.payment_id_from_reference(None) is None


def test_env_defaults(ctx):
    assert hitpay.is_configured() and hitpay.is_sandbox()
    assert hitpay.currency() == "SGD" and hitpay.api_base().startswith("https://api.sandbox.")
    ctx.config.update(HITPAY_ENV="production")
    assert hitpay.currency() == "PHP" and hitpay.api_base() == "https://api.hit-pay.com"
    ctx.config.update(HITPAY_CURRENCY="php", HITPAY_PAYMENT_METHODS="card, gcash")
    assert hitpay.currency() == "PHP" and hitpay.payment_methods() == ["card", "gcash"]
