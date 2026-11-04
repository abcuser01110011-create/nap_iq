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
    GET  /collector/subscriber/<id>/payment.json -> subscriber_payment_json
                                         (read-only popup on the Dashboard's
                                         My Recent Collections list)
    GET  /collector/subscribers.json -> subscribers_json (search feed for the
                                         Record a Payment form's searchable
                                         Subscriber field)
"""

from datetime import datetime, date, timedelta
from decimal import Decimal

from flask import Blueprint, render_template, redirect, url_for, flash, g, jsonify, request, abort
from sqlalchemy import func, extract

from app.extensions import db
from app.auth import role_required
from app.models import Payment, Plan, Subscriber
from app.forms import RecordPaymentForm
from app.notifications_utils import notify_payment_confirmed

collector_bp = Blueprint("collector", __name__, url_prefix="/collector")


def _as_date(value):
    """date | datetime | None -> date | None."""
    if isinstance(value, datetime):
        return value.date()
    return value


def _plan_monthly_fee(plan_type):
    """Looks up the admin-priced Monthly Fee for a subscriber's
    `plan_type` (see the `Plan` model's `monthly_fee` column, set from
    Settings > Plans). `Subscriber.plan_type` is free text, not a
    foreign key to `plans` (same reasoning as `Plan`'s own docstring),
    so this is a case-insensitive name match rather than a join.
    Returns None -- never 0 -- when the subscriber has no plan_type,
    or when it doesn't match a plan an administrator has priced yet
    (e.g. a legacy free-text value), so the popups can show "—"
    instead of a made-up fee.
    """
    if not plan_type:
        return None
    plan = Plan.query.filter(func.lower(Plan.name) == plan_type.strip().lower()).first()
    return plan.monthly_fee if plan and plan.monthly_fee is not None else None


def _billing_state(subscriber):
    """Works out where a subscriber stands in their current 30-day billing
    cycle, from their confirmed payments. Purely derived -- nothing here
    is stored (the schema has no invoice/ledger table).

    How it works: confirmed payments are replayed oldest -> newest and
    added up toward the plan's monthly fee. Once the running total reaches
    the fee, that cycle is *settled* and the next due date becomes
    (settling payment's date + 30 days) -- the same rule as before.
    Anything less than the full fee is a PARTIAL payment: it does NOT move
    the due date, it just reduces the balance still owed. Extra money
    beyond one fee carries over (and pre-pays further 30-day cycles).

    If the plan has no priced monthly fee, there's nothing to measure a
    partial against, so any confirmed payment settles the cycle (the
    previous behaviour).

    Returns a dict:
        monthly_fee   Decimal | None
        due_date      date | None   (None = no payment/install date to anchor to)
        paid_in_cycle Decimal       paid so far toward the current cycle
        balance       Decimal | None  still owed right now (None = unpriced plan)
        status        'confirmed' (Paid) | 'pending' (Due today) |
                      'overdue' | 'partial'
        last_payment  Payment | None  (most recent confirmed payment)
    """
    fee = _plan_monthly_fee(subscriber.plan_type)
    payments = (
        Payment.query.filter_by(subscriber_id=subscriber.id, status="confirmed")
        .order_by(Payment.payment_date.asc(), Payment.id.asc())
        .all()
    )

    anchor = _as_date(subscriber.installed_at)
    paid = Decimal("0.00")
    for payment in payments:
        pay_date = _as_date(payment.payment_date)
        if fee is None or fee <= 0:
            anchor, paid = pay_date, Decimal("0.00")
            continue
        paid += payment.amount
        if paid >= fee:
            anchor = pay_date
            paid -= fee
            while paid >= fee:  # a big payment pre-pays further cycles
                anchor += timedelta(days=30)
                paid -= fee

    due_date = anchor + timedelta(days=30) if anchor else None
    today = date.today()

    if fee is None:
        balance = None
    elif due_date is None or due_date <= today:
        balance = max(fee - paid, Decimal("0.00"))
    else:
        balance = Decimal("0.00")  # still inside a cycle that is already paid for

    if due_date is None or due_date > today:
        status = "confirmed"
    elif paid > 0:
        status = "partial"
    else:
        status = "pending" if due_date == today else "overdue"

    return {
        "monthly_fee": fee,
        "due_date": due_date,
        "paid_in_cycle": paid,
        "balance": balance,
        "status": status,
        "last_payment": payments[-1] if payments else None,
    }


def _estimate_next_due_date(subscriber):
    """Next due date (see _billing_state). Used by the Collections page's
    "Due Today" list. None if there is no payment/install date on file, so
    screens can show "—" instead of a made-up date."""
    return _billing_state(subscriber)["due_date"]


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


def _kpis(coverage_barangays):
    """KPI numbers for the dashboard -- all scoped to this collector's own
    `collector_id`, never anyone else's."""
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
    subscriber_count = (
        _coverage_subscribers_query(coverage_barangays).count() if coverage_barangays else 0
    )
    return collected_today, collected_this_month, pending_count, subscriber_count


@collector_bp.route("/")
@role_required("payment_collector")
def index():
    """Collector home (Dashboard): greeting card, My Coverage Area (opens a
    popup), the four KPI cards and the collector's own recent collections."""
    coverage_barangays = _coverage_barangays()
    collected_today, collected_this_month, pending_count, subscriber_count = _kpis(coverage_barangays)

    # My Recent Collections: just the subscriber names (one row per
    # subscriber, most recently collected first), like the Collections tab.
    recent_rows = (
        Payment.query.filter_by(collector_id=g.user.id)
        .order_by(Payment.payment_date.desc(), Payment.created_at.desc())
        .limit(100)
        .all()
    )
    recent_subscribers, seen = [], set()
    for payment in recent_rows:
        if payment.subscriber and payment.subscriber_id not in seen:
            seen.add(payment.subscriber_id)
            recent_subscribers.append(payment.subscriber)
        if len(recent_subscribers) >= 20:
            break
    # Only subscribers inside this collector's coverage area have a detail page.
    linkable_ids = (
        {s.id for s in _coverage_subscribers_query(coverage_barangays).all()}
        if coverage_barangays else set()
    )

    return render_template(
        "collector/index.html",
        coverage_barangays=coverage_barangays,
        recent_subscribers=recent_subscribers,
        linkable_ids=linkable_ids,
        collected_today=collected_today,
        collected_this_month=collected_this_month,
        pending_count=pending_count,
        subscriber_count=subscriber_count,
    )


@collector_bp.route("/collections")
@role_required("payment_collector")
def collections():
    """My Collections: names of the subscribers in the collector's assigned
    coverage area; tapping one opens a popup with that subscriber's details."""
    coverage_barangays = _coverage_barangays()
    coverage_subscribers = (
        _coverage_subscribers_query(coverage_barangays).order_by(Subscriber.full_name).all()
        if coverage_barangays else []
    )

    # "Due Today": subscribers whose estimated next due date (30 days after
    # their last confirmed payment, or after install -- see
    # _estimate_next_due_date) is today.
    today = date.today()
    due_today = []
    for subscriber in coverage_subscribers:
        due = _estimate_next_due_date(subscriber)
        if isinstance(due, datetime):
            due = due.date()
        if due == today:
            due_today.append(subscriber)

    return render_template(
        "collector/collections.html",
        coverage_barangays=coverage_barangays,
        coverage_subscribers=coverage_subscribers,
        due_today=due_today,
    )


@collector_bp.route("/subscriber/<int:subscriber_id>")
@role_required("payment_collector")
def subscriber_detail(subscriber_id):
    """Subscriber page opened from My Collections: their address, contact
    and plan, a Navigate button, and an Add payment button that opens the
    Payment Details popup. Limited to subscribers inside this collector's
    own coverage area."""
    barangays = _coverage_barangays()
    if not barangays:
        abort(404)
    subscriber = (
        _coverage_subscribers_query(barangays).filter(Subscriber.id == subscriber_id).first_or_404()
    )
    form = RecordPaymentForm()
    _populate_subscriber_choices(form)
    form.subscriber_id.data = subscriber.id
    # Payment date is no longer asked for: it is always the day the
    # payment is recorded (the browser re-stamps it with the collector's
    # local date when the popup opens / submits).
    form.payment_date.data = date.today().isoformat()

    state = _billing_state(subscriber)
    due_date = state["due_date"]
    return render_template(
        "collector/subscriber.html",
        subscriber=subscriber,
        form=form,
        due_date_iso=due_date.isoformat() if due_date else "",
        due_date=due_date,
        monthly_fee=state["monthly_fee"],
        current_balance=state["balance"],
        paid_in_cycle=state["paid_in_cycle"],
        pay_status=state["status"],
    )


_STATUS_LABELS = {
    "confirmed": "Paid",
    "pending": "Due",
    "overdue": "Overdue",
    "partial": "Partial",
}


@collector_bp.route("/subscriber/<int:subscriber_id>/payment.json")
@role_required("payment_collector")
def subscriber_payment_json(subscriber_id):
    """Read-only payment summary shown in the popup that opens when a
    collector taps a name on the Dashboard's "My Recent Collections" list.
    Computed fresh on every tap, so a payment (or partial payment) that was
    just recorded is reflected immediately. Same coverage-area limit as the
    subscriber page."""
    barangays = _coverage_barangays()
    if not barangays:
        abort(404)
    subscriber = (
        _coverage_subscribers_query(barangays).filter(Subscriber.id == subscriber_id).first_or_404()
    )
    state = _billing_state(subscriber)
    last = state["last_payment"]
    due_date = state["due_date"]

    def money(value):
        return f"{value:,.2f}" if value is not None else None

    resp = jsonify(
        {
            "id": subscriber.id,
            "full_name": subscriber.full_name,
            "subscriber_code": subscriber.subscriber_code,
            "plan_type": subscriber.plan_type,
            "status": state["status"],
            "status_label": _STATUS_LABELS[state["status"]],
            "monthly_fee": money(state["monthly_fee"]),
            "balance": money(state["balance"]),
            # Shown only while a partial payment is outstanding.
            "paid_so_far": money(state["paid_in_cycle"]) if state["status"] == "partial" else None,
            "due_date": due_date.strftime("%b %d, %Y") if due_date else None,
            "last_payment": (
                {
                    "amount": money(last.amount),
                    "date": _as_date(last.payment_date).strftime("%b %d, %Y"),
                    "method": (last.payment_method or "").replace("_", " ").title(),
                }
                if last
                else None
            ),
            "detail_url": url_for("collector.subscriber_detail", subscriber_id=subscriber.id),
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


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
        # Money handed to the collector counts as collected right away, so it
        # is always saved as 'confirmed' (the browser-sent status is ignored).
        # That updates the subscriber's status on the collector side and
        # shows the payment on the Administrator's Payments tab.
        payment = Payment(
            subscriber_id=form.subscriber_id.data,
            collector_id=g.user.id,
            amount=form.amount.data,
            payment_method=form.payment_method.data,
            payment_date=datetime.strptime(form.payment_date.data.strip(), "%Y-%m-%d").date(),
            reference_number=(form.reference_number.data or "").strip() or None,
            remarks=(form.remarks.data or "").strip() or None,
            status="confirmed",
        )
        db.session.add(payment)
        db.session.commit()  # payment.id (and payment.subscriber) needed below

        notify_payment_confirmed(payment)
        db.session.commit()

        flash(f"Payment of {payment.amount} recorded successfully.", "success")
        return redirect(url_for("collector.subscriber_detail", subscriber_id=payment.subscriber_id))

    for field_errors in form.errors.values():
        for message in field_errors:
            flash(message, "danger")
    posted_id = request.form.get("subscriber_id", type=int)
    if posted_id:
        return redirect(url_for("collector.subscriber_detail", subscriber_id=posted_id))
    return redirect(url_for("collector.collections"))


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
        state = _billing_state(s)
        due_date, monthly_fee, current_balance = state["due_date"], state["monthly_fee"], state["balance"]
        data.append(
            {
                "id": s.id,
                "subscriber_code": s.subscriber_code,
                "full_name": s.full_name,
                "address": s.address,
                "plan_type": s.plan_type,
                "due_date": due_date.isoformat() if due_date else None,
                "monthly_fee": str(monthly_fee) if monthly_fee is not None else None,
                "current_balance": str(current_balance) if current_balance is not None else None,
            }
        )
    return jsonify(data)
