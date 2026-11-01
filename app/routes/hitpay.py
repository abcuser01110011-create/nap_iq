"""
HitPay online payments (sandbox demo) -- customer "Pay online" + webhook.

Routes:
    POST /customer/payments/pay-online   -> pay_online     (customer; creates a pending
                                            Payment + HitPay payment request, redirects to checkout)
    GET  /customer/payments/online/return -> pay_return    (customer lands back here after checkout)
    POST /webhooks/hitpay                 -> hitpay_webhook (called by HitPay, CSRF-exempt,
                                            signature-verified; this is what confirms a payment)

No schema change: an online payment is a normal `payments` row with
payment_method='other', status 'pending' until the webhook arrives, and
reference_number = the HitPay payment-request id (so it can be looked up in
the HitPay dashboard).
"""

from datetime import date
from decimal import Decimal, InvalidOperation

from flask import Blueprint, current_app, flash, g, redirect, request, url_for

from app import hitpay
from app.auth import role_required
from app.billing_utils import monthly_due_info
from app.extensions import db
from app.models import Payment
from app.notifications_utils import notify_online_payment_needs_review, notify_online_payment_received
from app.routes.customer import _no_subscriber_redirect, _own_subscriber_or_none

hitpay_bp = Blueprint("hitpay", __name__, url_prefix="/customer/payments")
hitpay_webhook_bp = Blueprint("hitpay_webhook", __name__)   # kept separate so only it is CSRF-exempt

MIN_AMOUNT = Decimal("1.00")
MAX_AMOUNT = Decimal("100000.00")


def _back_to_payments():
    return redirect(url_for("customer.my_payments"))


def _return_url() -> str:
    base = (current_app.config.get("HITPAY_PUBLIC_BASE_URL") or "").strip().rstrip("/")
    path = url_for("hitpay.pay_return")
    return f"{base}{path}" if base else url_for("hitpay.pay_return", _external=True)


@hitpay_bp.route("/pay-online", methods=["POST"])
@role_required("user")
def pay_online():
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_redirect()
    if not hitpay.is_configured():
        flash("Online payment isn't available right now.", "warning")
        return _back_to_payments()

    if request.form.get("use_due"):
        # Dashboard "PAY NOW": the amount comes from the server, never the browser.
        due = monthly_due_info(subscriber)
        if not due["can_pay"]:
            flash("You have nothing to pay right now.", "info")
            return redirect(url_for("customer.index"))
        raw_amount = str(due["amount_due"])
    else:
        raw_amount = (request.form.get("amount") or "").strip()
    try:
        amount = Decimal(raw_amount).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        amount = None
    if amount is None or not (MIN_AMOUNT <= amount <= MAX_AMOUNT):
        flash(f"Enter an amount between {MIN_AMOUNT} and {MAX_AMOUNT:,.2f}.", "warning")
        return _back_to_payments()

    payment = Payment(
        subscriber_id=subscriber.id,
        amount=amount,
        payment_method="other",
        payment_date=date.today(),
        status="pending",
        remarks="HitPay online payment - awaiting payment",
    )
    db.session.add(payment)
    db.session.flush()      # need payment.id for the HitPay reference

    try:
        request_data = hitpay.create_payment_request(
            amount=amount,
            name=subscriber.full_name,
            email=subscriber.email,
            purpose=f"PG Networks payment - {subscriber.full_name}",
            reference_number=hitpay.reference_for(payment.id),
            redirect_url=_return_url(),
        )
    except hitpay.HitPayError as exc:
        current_app.logger.warning("HitPay create_payment_request failed: %s", exc)
        payment.status = "voided"
        payment.remarks = "HitPay online payment - could not start checkout"
        db.session.commit()
        flash("We couldn't start the online payment. Please try again in a moment.", "danger")
        return _back_to_payments()

    payment.reference_number = str(request_data["id"])[:50]
    db.session.commit()
    return redirect(request_data["url"])


@hitpay_bp.route("/online/return")
@role_required("user")
def pay_return():
    """Where HitPay sends the customer back. Informational only -- a payment
    is confirmed by the signed webhook, never by this redirect."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_redirect()

    ref = (request.args.get("reference") or "").strip()
    status = (request.args.get("status") or "").strip().lower()
    payment = None
    if ref:
        payment = Payment.query.filter_by(reference_number=ref, subscriber_id=subscriber.id).first()

    if payment is not None and payment.status == "confirmed":
        flash("Payment received - thank you! It now shows as Confirmed.", "success")
    elif status == "completed":
        flash("Payment received. It will show as Confirmed in a few moments - refresh this page.", "success")
    elif status in ("canceled", "cancelled", "failed"):
        if payment is not None and payment.status == "pending":
            payment.status = "voided"
            payment.remarks = "HitPay online payment - cancelled or failed"
            db.session.commit()
        flash("The online payment wasn't completed. You haven't been charged.", "warning")
    else:
        flash("We're waiting for HitPay to confirm your payment.", "info")
    return _back_to_payments()


@hitpay_webhook_bp.route("/webhooks/hitpay", methods=["POST"])
def hitpay_webhook():
    raw = request.get_data()
    if not hitpay.verify_signature(raw, request.headers.get("Hitpay-Signature", "")):
        current_app.logger.warning("HitPay webhook rejected: bad signature")
        return "invalid signature", 401

    data = request.get_json(silent=True) or {}
    if str(data.get("status", "")).lower() != "completed":
        return "ignored", 200

    payment_id = hitpay.payment_id_from_reference(data.get("reference_number"))
    payment = db.session.get(Payment, payment_id) if payment_id else None
    if payment is None:
        current_app.logger.warning("HitPay webhook for unknown reference %r", data.get("reference_number"))
        return "unknown reference", 200          # 200 so HitPay stops retrying

    if payment.status == "confirmed":            # HitPay can deliver a webhook more than once
        return "already confirmed", 200

    try:
        paid = Decimal(str(data.get("amount", "0"))).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        paid = None
    if paid is None or paid != Decimal(payment.amount).quantize(Decimal("0.01")):
        current_app.logger.warning("HitPay amount mismatch on payment %s: got %s, expected %s", payment.id, paid, payment.amount)
        payment.remarks = "HitPay online payment - amount mismatch, needs review"[:500]
        notify_online_payment_needs_review(payment)
        db.session.commit()
        return "amount mismatch", 200

    method = ""
    payments = data.get("payments")
    if isinstance(payments, list) and payments and isinstance(payments[0], dict):
        method = str(payments[0].get("payment_type") or "")
    payment.status = "confirmed"
    payment.payment_date = date.today()
    payment.reference_number = str(data.get("id") or payment.reference_number or "")[:50] or None
    payment.remarks = ("HitPay online payment" + (f" ({method})" if method else ""))[:500]
    notify_online_payment_received(payment)
    db.session.commit()
    return "ok", 200
