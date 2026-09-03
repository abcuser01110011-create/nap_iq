"""
Payment Collector Blueprint (Phase 10)
------------------------------------------
Resolves PHASE7_NOTES.md follow-up #2: the `payment_collector` role
could log in but landed on a "no dashboard yet" message. Rather than
migrate existing `payment_collector` accounts to one of the other
three roles (which would mean discarding the role and rewriting
`database/seed.sql`'s `collector1` account), this phase gives it a
real, if intentionally narrow, landing page: a payment-collector can
see the payments *they personally* recorded, and log a new one.

This is NOT the full Payments management module still marked "Coming
Soon" on the Administrator dashboard sidebar (that would mean editing/
voiding other collectors' payments, reporting, reconciliation, etc.) —
it's scoped to exactly what a field collector needs: record what you
collected today, see your own recent history.

Routes:
    GET  /collector/          -> index        (own recent payments + record form)
    POST /collector/record    -> record_payment
"""

from datetime import datetime

from flask import Blueprint, render_template, redirect, url_for, flash, g

from app.extensions import db
from app.auth import role_required
from app.models import Payment, Subscriber
from app.forms import RecordPaymentForm
from app.notifications_utils import notify_payment_overdue, notify_payment_pending_confirmation

collector_bp = Blueprint("collector", __name__, url_prefix="/collector")


def _coverage_barangays():
    """Splits the signed-in collector's `users.coverage_area` (a
    comma-separated string of barangay names, e.g. "Alipit,
    Bagumbayan" -- see the chip picker in app/templates/users/form.html)
    into a clean list. Returns an empty list if no coverage area has
    been set yet."""
    coverage_area = (g.user.coverage_area or "").strip()
    if not coverage_area:
        return []
    return [b.strip() for b in coverage_area.split(",") if b.strip()]


def _coverage_subscribers_query(barangays):
    """Active subscribers whose free-text `address` mentions one of the
    given barangay names. A subscriber's address is always built as
    "Street, Barangay, City/Municipality, Province" (see the cascading
    Province/City/Barangay picker in service_requests.py /
    naps/map.html), so the barangay name is reliably present as a
    substring even though there's no dedicated barangay column on
    `subscribers` to filter on directly."""
    query = Subscriber.query.filter_by(status="active")
    if barangays:
        query = query.filter(
            db.or_(*[Subscriber.address.ilike(f"%{b}%") for b in barangays])
        )
    return query


def _populate_subscriber_choices(form):
    """Fills in the Subscriber dropdown from active subscribers, same
    pattern as issues.py's _populate_dynamic_choices.

    Scoped to the signed-in collector's Coverage Area when one is set
    (see _coverage_barangays() above) -- a collector only records
    payments for subscribers in the barangay(s) an administrator
    assigned them. A collector with no coverage area configured yet
    still sees every active subscriber, so this can't lock an account
    out before an admin has set it up."""
    barangays = _coverage_barangays()
    subscribers = _coverage_subscribers_query(barangays).order_by(Subscriber.full_name).all()
    form.subscriber_id.choices = [(0, "-- Select Subscriber --")] + [
        (s.id, f"{s.subscriber_code} — {s.full_name}") for s in subscribers
    ]


@collector_bp.route("/")
@role_required("payment_collector")
def index():
    """Landing page: the signed-in collector's own recent payments,
    the record-a-payment form, and the subscriber roster for their
    assigned Coverage Area (see _coverage_barangays() above)."""
    form = RecordPaymentForm()
    _populate_subscriber_choices(form)

    recent_payments = (
        Payment.query.filter_by(collector_id=g.user.id)
        .order_by(Payment.payment_date.desc(), Payment.created_at.desc())
        .limit(20)
        .all()
    )

    coverage_barangays = _coverage_barangays()
    coverage_subscribers = (
        _coverage_subscribers_query(coverage_barangays).order_by(Subscriber.full_name).all()
        if coverage_barangays else []
    )

    return render_template(
        "collector/index.html",
        form=form,
        recent_payments=recent_payments,
        coverage_barangays=coverage_barangays,
        coverage_subscribers=coverage_subscribers,
    )


@collector_bp.route("/record", methods=["POST"])
@role_required("payment_collector")
def record_payment():
    """Processes the record-a-payment form. `collector_id` is always
    the signed-in collector's own id — never a value taken from the
    submitted form — so one collector can't attribute a payment to
    someone else.

    Phase 17: a collector can submit a brand-new payment with
    status='overdue' directly (see forms.py's RecordPaymentForm
    `status` choices), so this fires the same "payment overdue"
    notification payments.py's add_payment does on that transition —
    reusing notify_payment_overdue() rather than a copy of the message
    text. Since this is a new row (not an edit), there's no prior
    status to compare against: any submission of status='overdue'
    notifies.

    Phase 23 (phase_12.pdf): the same reasoning now also covers
    status='pending' — a field collector's payment sits unconfirmed
    until an Administrator reviews it, so this fires
    notify_payment_pending_confirmation() on any submission of
    status='pending', same "new row, no prior status to compare"
    logic as the 'overdue' case above."""
    form = RecordPaymentForm()
    _populate_subscriber_choices(form)

    if form.validate_on_submit():
        payment = Payment(
            subscriber_id=form.subscriber_id.data,
            collector_id=g.user.id,
            amount=form.amount.data,
            payment_method=form.payment_method.data,
            payment_date=datetime.strptime(form.payment_date.data.strip(), "%Y-%m-%d").date(),
            reference_number=(form.reference_number.data or "").strip() or None,
            status=form.status.data,
        )
        db.session.add(payment)
        db.session.commit()  # payment.id (and payment.subscriber) needed below

        if payment.status == "overdue":
            notify_payment_overdue(payment)
            db.session.commit()
        elif payment.status == "pending":
            notify_payment_pending_confirmation(payment)
            db.session.commit()

        flash(f"Payment of {payment.amount} recorded successfully.", "success")
        return redirect(url_for("collector.index"))

    for field_errors in form.errors.values():
        for message in field_errors:
            flash(message, "danger")
    return redirect(url_for("collector.index"))
