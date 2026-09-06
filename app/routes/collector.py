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
    GET  /collector/                -> index        (own recent payments + record form)
    POST /collector/record          -> record_payment
    GET  /collector/subscribers.json -> subscribers_json (search feed for the
                                         Record a Payment form's searchable
                                         Subscriber field)
"""

from datetime import datetime, date, timedelta

from flask import Blueprint, render_template, redirect, url_for, flash, g, jsonify
from sqlalchemy import func, extract

from app.extensions import db
from app.auth import role_required
from app.models import Payment, Subscriber
from app.forms import RecordPaymentForm
from app.notifications_utils import notify_payment_overdue, notify_payment_pending_confirmation

collector_bp = Blueprint("collector", __name__, url_prefix="/collector")


def _estimate_next_due_date(subscriber):
    """Rough "next due" estimate for the Record a Payment form's
    auto-fill panel only -- purely informational, never stored
    anywhere. The schema has no dedicated due-date column at all
    (see notifications_utils.py's notify_payment_overdue() docstring:
    a payment's `status` becoming 'overdue' is the only due/overdue
    signal that exists), so this estimates a 30-day billing cycle from
    the subscriber's most recent *confirmed* payment, falling back to
    their install date if they have no confirmed payment yet. Returns
    None if neither is on file, so the form can show "—" instead of a
    made-up date.
    """
    last_confirmed = (
        Payment.query.filter_by(subscriber_id=subscriber.id, status="confirmed")
        .order_by(Payment.payment_date.desc())
        .first()
    )
    anchor = last_confirmed.payment_date if last_confirmed else subscriber.installed_at
    if anchor is None:
        return None
    return anchor + timedelta(days=30)


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
    """Landing page: KPI summary, the record-a-payment form, the
    signed-in collector's own recent payments, and the subscriber
    roster for their assigned Coverage Area (see _coverage_barangays()
    above)."""
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

    # ---- KPI summary strip -------------------------------------------------
    # All scoped to this collector's own `collector_id`, never anyone
    # else's -- same "record and see your own work only" boundary the
    # rest of this blueprint keeps (see module docstring above).
    today = date.today()
    own_payments = Payment.query.filter_by(collector_id=g.user.id)

    collected_today = own_payments.filter(
        Payment.payment_date == today, Payment.status == "confirmed"
    ).with_entities(func.coalesce(func.sum(Payment.amount), 0)).scalar()

    collected_this_month = own_payments.filter(
        extract("year", Payment.payment_date) == today.year,
        extract("month", Payment.payment_date) == today.month,
        Payment.status == "confirmed",
    ).with_entities(func.coalesce(func.sum(Payment.amount), 0)).scalar()

    pending_count = own_payments.filter(Payment.status == "pending").count()

    return render_template(
        "collector/index.html",
        form=form,
        recent_payments=recent_payments,
        coverage_barangays=coverage_barangays,
        coverage_subscribers=coverage_subscribers,
        collected_today=collected_today,
        collected_this_month=collected_this_month,
        pending_count=pending_count,
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


@collector_bp.route("/subscribers.json")
@role_required("payment_collector")
def subscribers_json():
    """Coverage-scoped active-subscriber feed for the Record a Payment
    form's searchable Subscriber field (collector/index.html +
    static/js/collector-payment.js).

    Reuses the exact same `_coverage_barangays()` / `_coverage_subscribers_query()`
    helpers `_populate_subscriber_choices()`
    already uses to build the (now-hidden) `subscriber_id` SelectField's
    server-side choices, so a subscriber picked from this search box is
    always one of that field's valid, already-validated choices.

    Each entry also carries the fields the search box auto-fills once
    picked: `plan_type`, `address`, and an estimated `due_date` (see
    `_estimate_next_due_date()` above) -- informational only, not part
    of the submitted payment.
    """
    barangays = _coverage_barangays()
    subscribers = _coverage_subscribers_query(barangays).order_by(Subscriber.full_name).all()
    data = []
    for s in subscribers:
        due_date = _estimate_next_due_date(s)
        data.append(
            {
                "id": s.id,
                "subscriber_code": s.subscriber_code,
                "full_name": s.full_name,
                "address": s.address,
                "plan_type": s.plan_type,
                "due_date": due_date.isoformat() if due_date else None,
            }
        )
    return jsonify(data)
