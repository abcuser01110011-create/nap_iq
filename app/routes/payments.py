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
    GET  /payments/add            -> add_payment      (show add form)
    POST /payments/add            -> add_payment      (process add form)
    GET  /payments/<id>/edit      -> edit_payment     (show edit form)
    POST /payments/<id>/edit      -> edit_payment     (process edit form)
    POST /payments/<id>/void      -> void_payment     (quick action, pending/overdue -> voided)
"""

from datetime import datetime

from flask import Blueprint, render_template, redirect, url_for, request, flash, g

from app.extensions import db
from app.auth import role_required
from app.models import Payment, Subscriber
from app.forms import RecordPaymentForm
from app.notifications_utils import notify_payment_overdue, notify_payment_pending_confirmation

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


@payments_bp.route("/")
@role_required("administrator")
def list_payments():
    """Displays all payments regardless of which collector recorded
    them, with optional search (subscriber name/code or reference
    number) and payment-method/status filtering via query string
    parameters (?q=...&method=...&status=...)."""
    search_term = request.args.get("q", "").strip()
    method_filter = request.args.get("method", "").strip()
    status_filter = request.args.get("status", "").strip()

    query = Payment.query.join(Subscriber)

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.filter(
            db.or_(
                Subscriber.full_name.ilike(like_pattern),
                Subscriber.subscriber_code.ilike(like_pattern),
                Payment.reference_number.ilike(like_pattern),
            )
        )

    if method_filter:
        query = query.filter(Payment.payment_method == method_filter)

    if status_filter:
        query = query.filter(Payment.status == status_filter)

    payments = query.order_by(Payment.payment_date.desc(), Payment.created_at.desc()).all()

    return render_template(
        "payments/list.html",
        payments=payments,
        search_term=search_term,
        method_filter=method_filter,
        status_filter=status_filter,
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

        payment.subscriber_id = form.subscriber_id.data
        payment.amount = form.amount.data
        payment.payment_method = form.payment_method.data
        payment.payment_date = datetime.strptime(form.payment_date.data.strip(), "%Y-%m-%d").date()
        payment.reference_number = (form.reference_number.data or "").strip() or None
        payment.status = form.status.data

        if became_overdue:
            notify_payment_overdue(payment)
        elif became_pending:
            notify_payment_pending_confirmation(payment)

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
