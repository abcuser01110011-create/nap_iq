"""
HitPay payment-gateway helper (sandbox demo + production).

Flow (https://docs.hitpayapp.com/apis/guide/online-payments):
    1. create_payment_request()  -> HitPay returns a hosted checkout `url`
    2. the customer is redirected to that url and pays
    3. HitPay POSTs a signed webhook to /webhooks/hitpay -> verify_signature()
       and only THEN is the Payment marked confirmed (the browser redirect
       back to our site can be triggered by anyone, so it is never trusted).

Configuration (environment variables, see HITPAY_SETUP.md):
    HITPAY_API_KEY, HITPAY_SALT   from the HitPay dashboard (Settings > API Keys)
    HITPAY_ENV                    "sandbox" (default) or "production"
    HITPAY_CURRENCY               optional; default SGD in sandbox, PHP in production
    HITPAY_PAYMENT_METHODS        optional comma list (e.g. "card,gcash"); empty = every
                                  method enabled on the HitPay account
    HITPAY_PUBLIC_BASE_URL        optional, e.g. https://pgnetworks.vercel.app -- used to
                                  build the return URL if Flask can't work out its own
                                  public address
"""

import hashlib
import hmac
import json
from decimal import Decimal

import requests
from flask import current_app

SANDBOX_BASE = "https://api.sandbox.hit-pay.com"
PRODUCTION_BASE = "https://api.hit-pay.com"
REFERENCE_PREFIX = "NAPIQ-"      # our Payment.id travels to HitPay as NAPIQ-<id>


class HitPayError(Exception):
    """HitPay refused the request or could not be reached."""


def _cfg(name, default=""):
    return (current_app.config.get(name) or default)


def is_configured() -> bool:
    return bool(_cfg("HITPAY_API_KEY") and _cfg("HITPAY_SALT"))


def is_sandbox() -> bool:
    return str(_cfg("HITPAY_ENV", "sandbox")).strip().lower() != "production"


def api_base() -> str:
    return SANDBOX_BASE if is_sandbox() else PRODUCTION_BASE


def currency() -> str:
    configured = str(_cfg("HITPAY_CURRENCY")).strip().upper()
    if configured:
        return configured
    # A sandbox account must be created as a Singapore business, so SGD is the
    # currency it reliably accepts; a live Philippine account charges PHP.
    return "SGD" if is_sandbox() else "PHP"


def payment_methods() -> list:
    raw = str(_cfg("HITPAY_PAYMENT_METHODS"))
    return [m.strip() for m in raw.split(",") if m.strip()]


def reference_for(payment_id: int) -> str:
    return f"{REFERENCE_PREFIX}{payment_id}"


def payment_id_from_reference(reference: str):
    """NAPIQ-12 -> 12; anything that isn't ours -> None."""
    reference = str(reference or "")
    if not reference.startswith(REFERENCE_PREFIX):
        return None
    tail = reference[len(REFERENCE_PREFIX):]
    return int(tail) if tail.isdigit() else None


def create_payment_request(*, amount: Decimal, name, email, purpose, reference_number, redirect_url) -> dict:
    """POST /v1/payment-requests and return HitPay's JSON (`id`, `url`, ...)."""
    fields = [
        ("amount", f"{Decimal(amount):.2f}"),
        ("currency", currency()),
        ("purpose", purpose),
        ("reference_number", reference_number),
        ("redirect_url", redirect_url),
    ]
    if name:
        fields.append(("name", name))
    if email:
        fields.append(("email", email))
    for method in payment_methods():
        fields.append(("payment_methods[]", method))

    try:
        response = requests.post(
            f"{api_base()}/v1/payment-requests",
            data=fields,
            headers={
                "X-BUSINESS-API-KEY": _cfg("HITPAY_API_KEY"),
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        raise HitPayError(f"Could not reach HitPay: {exc}") from exc

    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400 or not body.get("url") or not body.get("id"):
        message = body.get("message") if isinstance(body, dict) else None
        raise HitPayError(message or f"HitPay returned HTTP {response.status_code}.")
    return body


def verify_signature(raw_body: bytes, signature: str) -> bool:
    """HMAC-SHA256 of the JSON payload keyed with the account's salt,
    compared in constant time with the `Hitpay-Signature` header."""
    salt = _cfg("HITPAY_SALT")
    signature = (signature or "").strip().lower()
    if not salt or not signature:
        return False
    key = salt.encode("utf-8")

    candidates = [raw_body]
    try:   # tolerate a proxy re-spacing the JSON: also try the compact form
        candidates.append(json.dumps(json.loads(raw_body), separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    except ValueError:
        pass
    for body in candidates:
        expected = hmac.new(key, body, hashlib.sha256).hexdigest()
        if hmac.compare_digest(expected, signature):
            return True
    return False
