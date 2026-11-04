"""
Administrator Payments Blueprint — Phase 15
-------------------------------------------------
Fills in the "Payments" sidebar placeholder that was deliberately left
disabled ("Coming soon"). collector.py's own docstring (Phase 10)
explicitly called this module out as future work: "This is NOT the
full Payments management module still marked 'Coming Soon' on the
Administrator dashboard sidebar (that would mean editing/voiding
other collectors' payments, reporting, reconciliation, etc.)". This
module is that full module — an administrator can see, search, and
filter every payment regardless of which collector recorded it, add
one on behalf of any subscriber, and edit any field on an existing
payment (including correcting a collector's mistake or changing its
status) — none of which `collector.index()` allows, since that page
is deliberately scoped to a collector's own recorded payments only.

Reuses `RecordPaymentForm` as-is (same form `collector.py` already
uses) rather than a new form — the fields an administrator needs to
set are identical, and having one form for "record a payment" keeps
validation rules in exactly one place. `collector_id` still defaults
to the signed-in user's own id when *adding* a payment here (same
rule collector.record_payment() uses — a payment is always attributed
to whoever is actually entering it), but unlike collector.py, editing
an existing payment here never touches `collector_id` — correcting a
payment's amount/date/status shouldn't silently reassign who
collected it.

Phase 16: a "voided" state was added to the `payments.status` enum
(schema.sql + `database/migration_phase16.sql` for existing
databases), plus a dedicated one-click **Void** quick action
(`void_payment`, below) — same confirm-then-POST-redirect shape as
naps.py's activate/deactivate. Only a `pending` or `overdue` payment
can be voided this way (an already-`confirmed` payment shouldn't be
silently voided without going through the full edit form, and an
already-`voided` payment has nothing left to void). The full edit
form's Status field also gained "Voided" as a selectable option —
but only here in payments.py, not in `RecordPaymentForm`'s base
choices, which collector.py (Phase 10) still uses unmodified: a
payment collector was never meant to void payments (see collector.py's
own docstring), so "Voided" is appended onto the form's choices in
`add_payment`/`edit_payment` below rather than being part of the
shared form class.

Routes:
    GET  /payments/               -> list_payments  (search + method/status filter)
    GET  /payments/billing        -> billing          (per-subscriber paid/partial/unpaid view)
    GET  /payments/add            -> add_payment      (show add form)
    POST /payments/add            -> add_payment      (process add form)
    GET  /payments/<id>/edit      -> edit_payment     (show edit form)
    POST /payments/<id>/edit      -> edit_payment     (process edit form)
    POST /payments/<id>/void      -> void_payment     (quick action, pending/overdue -> voided)
"""

import calendar
from datetime import datetime, date, timedelta

from sqlalchemy.orm import joinedload
from flask import Blueprint, render_template, redirect, url_for, request, flash, g

from app.extensions import db
from app.query_utils import filter_enum_eq
from app.barangay_utils import barangay_options, extract_barangay
from app.auth import role_required
from app.models import Payment, Subscriber, Plan
from app.forms import RecordPaymentForm
from app.notifications_utils import notify_payment_confirmed, notify_payment_overdue, notify_payment_pending_confirmation

payments_bp = Blueprint("payments", __name__, url_prefix="/payments")


def _populate_subscriber_choices(form):
    """Fills in the Subscriber dropdown. Not restricted to 'active'
    (unlike collector.py's version of this helper) — an administrator
    may need to record or correct a payment for a subscriber who has
    since gone inactive/disconnected."""
    subscribers = Subscriber.query.order_by(Subscriber.full_name).all()
    form.subscriber_id.choices = [(0, "-- Select Subscriber --")] + [
        (s.id, f"{s.subscriber_code} — {s.full_name}") for s in subscribers
    ]




def _is_online(payment):
    """HitPay checkout payments are created by hitpay.py with no
    collector and a 'HitPay online payment' remark."""
    return payment.collector_id is None and "hitpay" in (payment.remarks or "").lower()


# -----------------------------------------------------------------------
# SUBSCRIBERS BILLING VIEW — one row per subscriber for a chosen month
# -----------------------------------------------------------------------
BILLING_STATUS_ORDER = ("overdue", "unpaid", "partial", "pending", "paid", "unpriced")
BILLING_STATUS_LABELS = {
    "": "All",
    "paid": "Paid",
    "partial": "Partial",
    "pending": "Pending",
    "unpaid": "Unpaid",
    "overdue": "Overdue",
}


def _parse_month(raw, today):
    try:
        first = datetime.strptime(raw, "%Y-%m").date().replace(day=1)
    except (TypeError, ValueError):
        first = today.replace(day=1)
    last = first.replace(day=calendar.monthrange(first.year, first.month)[1])
    return first, last


def _month_key(d):
    return d.strftime("%Y-%m")


def _due_date_for(subscriber, first, last):
    """Monthly due date: the subscriber's install day-of-month (same
    anniversary idea billing_utils.py uses), clamped to the month."""
    day = subscriber.installed_at.day if subscriber.installed_at else 1
    return first.replace(day=min(day, last.day))


@payments_bp.route("/")
@role_required("administrator")
def list_payments():
    """Payments home: every billable subscriber with what they owe for
    the selected month, what they've paid, and a Paid / Partial / Pending /
    Unpaid / Overdue status (`?month=YYYY-MM&status=...`).

    Amount owed = the subscriber's Plan.monthly_fee. "Paid" counts
    confirmed payments dated inside the month; "pending" payments are
    shown separately (awaiting confirmation) and voided ones are ignored.
    """
    today = date.today()
    first, last = _parse_month(request.args.get("month", ""), today)
    status_filter = request.args.get("status", "").strip()
    if status_filter not in BILLING_STATUS_LABELS:
        status_filter = ""
    barangay_filter = request.args.get("barangay", "").strip()

    fees = {
        (p.name or "").strip().lower(): float(p.monthly_fee)
        for p in Plan.query.all() if p.monthly_fee is not None
    }

    pay_rows = (
        db.session.query(Payment.subscriber_id, Payment.status, Payment.amount)
        .filter(Payment.payment_date >= first, Payment.payment_date <= last)
        .all()
    )
    paid_by, pending_by, overdue_flag = {}, {}, set()
    for sub_id, status, amount in pay_rows:
        amount = float(amount)
        if status == "confirmed":
            paid_by[sub_id] = paid_by.get(sub_id, 0.0) + amount
        elif status == "pending":
            pending_by[sub_id] = pending_by.get(sub_id, 0.0) + amount
        elif status == "overdue":
            overdue_flag.add(sub_id)

    last_paid = dict(
        db.session.query(Payment.subscriber_id, db.func.max(Payment.payment_date))
        .filter(Payment.status == "confirmed")
        .group_by(Payment.subscriber_id)
        .all()
    )

    subscribers = Subscriber.query.options(joinedload(Subscriber.nap)).order_by(Subscriber.full_name).all()
    barangays = barangay_options(s.address for s in subscribers)
    rows = []
    for sub in subscribers:
        has_activity = sub.id in paid_by or sub.id in pending_by
        if sub.status != "active" and not has_activity:
            continue
        if sub.installed_at and sub.installed_at > last:
            continue   # not installed yet in that month

        fee = fees.get((sub.plan_type or "").strip().lower())
        paid = round(paid_by.get(sub.id, 0.0), 2)
        pending = round(pending_by.get(sub.id, 0.0), 2)
        due_date = _due_date_for(sub, first, last)
        is_late = last < today or today > due_date

        if fee is None:
            status = "unpriced"
            balance = 0.0
        else:
            balance = round(max(fee - paid, 0.0), 2)
            if paid >= fee:
                status = "paid"
            elif paid > 0:
                status = "partial"
            elif pending > 0:
                status = "pending"
            elif is_late or sub.id in overdue_flag:
                status = "overdue"
            else:
                status = "unpaid"

        rows.append({
            "sub": sub,
            "barangay": extract_barangay(sub.address),
            "fee": fee,
            "paid": paid,
            "pending": pending,
            "balance": balance,
            "pct": min(100, round(paid / fee * 100)) if fee else 0,
            "due_date": due_date,
            "late": is_late and balance > 0 and status in ("partial", "overdue"),
            "last_paid": last_paid.get(sub.id),
            "status": status,
        })

    counts = {k: 0 for k in BILLING_STATUS_LABELS}
    counts[""] = len(rows)
    for r in rows:
        if r["status"] in counts:
            counts[r["status"]] += 1

    priced = [r for r in rows if r["fee"] is not None]
    expected = sum(r["fee"] for r in priced)
    collected = sum(r["paid"] for r in priced)
    outstanding = sum(r["balance"] for r in priced)
    rate = round(collected / expected * 100) if expected else 0
    unpriced = sum(1 for r in rows if r["fee"] is None)

    if status_filter:
        rows = [r for r in rows if r["status"] == status_filter]
    order = {k: i for i, k in enumerate(BILLING_STATUS_ORDER)}
    rows.sort(key=lambda r: (order[r["status"]], r["sub"].full_name.lower()))

    prev_month = (first - timedelta(days=1)).replace(day=1)
    next_month = last + timedelta(days=1)

    return render_template(
        "payments/billing.html",
        rows=rows,
        counts=counts,
        status_labels=BILLING_STATUS_LABELS,
        status_filter=status_filter,
        barangays=barangays,
        barangay_filter=barangay_filter,
        month=first,
        month_value=_month_key(first),
        prev_month=_month_key(prev_month),
        next_month=_month_key(next_month),
        is_current_month=(first == today.replace(day=1)),
        current_month=_month_key(today),
        expected=expected,
        collected=collected,
        outstanding=outstanding,
        rate=rate,
        unpriced=unpriced,
        today=today,
    )


@payments_bp.route("/add", methods=["GET", "POST"])
@role_required("administrator")
def add_payment():
    """Shows and processes the Add Payment form. `collector_id` is
    always the signed-in administrator's own id — same rule
    collector.record_payment() uses — never a value taken from the
    submitted form."""
    form = RecordPaymentForm()
    form.status.choices = form.status.choices + [("voided", "Voided")]
    _populate_subscriber_choices(form)

    if request.method == "GET":
        # Prefill from the Subscribers billing view's "Record payment"
        # button (?subscriber_id=..&amount=..).
        pre_sub = request.args.get("subscriber_id", type=int)
        if pre_sub:
            form.subscriber_id.data = pre_sub
        pre_amount = request.args.get("amount", type=float)
        if pre_amount and pre_amount > 0:
            form.amount.data = round(pre_amount, 2)

    if form.validate_on_submit():
        payment = Payment(
            subscriber_id=form.subscriber_id.data,
            collector_id=g.user.id,
            amount=form.amount.data,
            payment_method=form.payment_method.data,
            payment_date=datetime.strptime(form.payment_date.data.strip(), "%Y-%m-%d").date(),
            reference_number=(form.reference_number.data or "").strip() or None,
            remarks=(form.remarks.data or "").strip() or None,
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
        return redirect(url_for("payments.list_payments"))

    return render_template("payments/form.html", form=form, mode="add", payment=None)


@payments_bp.route("/<int:payment_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_payment(payment_id):
    """Shows and processes the Edit Payment form. Deliberately never
    touches `collector_id` — correcting a payment's details shouldn't
    silently reassign who originally collected it."""
    payment = Payment.query.get_or_404(payment_id)

    form = RecordPaymentForm(obj=payment)
    form.status.choices = form.status.choices + [("voided", "Voided")]
    _populate_subscriber_choices(form)
    if request.method == "GET":
        form.subscriber_id.data = payment.subscriber_id
        form.payment_date.data = payment.payment_date.strftime("%Y-%m-%d")

    if form.validate_on_submit():
        became_overdue = form.status.data == "overdue" and payment.status != "overdue"
        # Phase 23 (phase_12.pdf): same "watch for the transition, not
        # just the end state" shape as became_overdue above — an
        # edit that leaves a payment pending (never touching status)
        # doesn't re-notify, only one that newly sets it to 'pending'.
        became_pending = form.status.data == "pending" and payment.status != "pending"
        # An admin confirming a pending/overdue payment: tell the subscriber.
        became_confirmed = form.status.data == "confirmed" and payment.status in ("pending", "overdue")

        payment.subscriber_id = form.subscriber_id.data
        payment.amount = form.amount.data
        payment.payment_method = form.payment_method.data
        payment.payment_date = datetime.strptime(form.payment_date.data.strip(), "%Y-%m-%d").date()
        payment.reference_number = (form.reference_number.data or "").strip() or None
        payment.remarks = (form.remarks.data or "").strip() or None
        payment.status = form.status.data

        if became_overdue:
            notify_payment_overdue(payment)
        elif became_pending:
            notify_payment_pending_confirmation(payment)
        elif became_confirmed:
            notify_payment_confirmed(payment)

        db.session.commit()
        flash("Payment was updated successfully.", "success")
        return redirect(url_for("payments.list_payments"))

    return render_template("payments/form.html", form=form, mode="edit", payment=payment)


@payments_bp.route("/<int:payment_id>/void", methods=["POST"])
@role_required("administrator")
def void_payment(payment_id):
    """Quick action: marks a payment 'voided' without opening the full
    edit form. Only valid from 'pending' or 'overdue' — an already-
    confirmed payment shouldn't be silently voided outside the full
    edit form, and an already-voided payment has nothing left to do."""
    payment = Payment.query.get_or_404(payment_id)
    if payment.status not in ("pending", "overdue"):
        flash("Only a pending or overdue payment can be voided this way.", "warning")
        return redirect(request.referrer or url_for("payments.list_payments"))

    payment.status = "voided"
    db.session.commit()
    flash("Payment was voided.", "success")
    return redirect(request.referrer or url_for("payments.list_payments"))


@payments_bp.route("/billing")
@role_required("administrator")
def billing():
    """Old URL of the Subscribers view; it is now the Payments home."""
    return redirect(url_for("payments.list_payments", **request.args))


@payments_bp.route("/subscriber/<int:subscriber_id>/history")
@role_required("administrator")
def subscriber_history(subscriber_id):
    """HTML fragment for the transactions popup: every payment of one
    subscriber, newest first (loaded by payments.js)."""
    sub = Subscriber.query.get_or_404(subscriber_id)
    payments = (
        Payment.query.options(joinedload(Payment.collector))
        .filter(Payment.subscriber_id == sub.id)
        .order_by(Payment.payment_date.desc(), Payment.created_at.desc())
        .all()
    )
    total = sum(float(p.amount) for p in payments if p.status == "confirmed")
    return render_template(
        "payments/_history.html",
        sub=sub,
        payments=payments,
        online_ids={p.id for p in payments if _is_online(p)},
        total=total,
        today=date.today(),
    )
