"""Monthly billing helpers for the subscriber (customer) portal.

The schema has no dedicated due-date column, so the monthly due date is
derived, same idea as app/routes/collector.py's estimate but on a real
calendar month instead of 30 days: one month after the subscriber's most
recent confirmed payment, or -- before any payment exists -- one month
after the install date (falling back to the day the record was created).
"""

import calendar
from datetime import date
from decimal import Decimal

from sqlalchemy import func

from app.models import Assignment, Payment, Plan, ServiceRequest


def add_one_month(d):
    """`d` plus one calendar month, clamped to the target month's last day
    (Jan 31 -> Feb 28/29)."""
    year = d.year + (d.month // 12)
    month = d.month % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def installation_date(subscriber):
    """The date the subscriber's connection was installed, or None while it
    is still a new/pending application: the explicit `installed_at`, else
    the completion date of a finished installation job."""
    if subscriber.installed_at is not None:
        return subscriber.installed_at
    done = (
        Assignment.query.join(ServiceRequest, Assignment.service_request_id == ServiceRequest.id)
        .filter(
            ServiceRequest.subscriber_id == subscriber.id,
            ServiceRequest.request_type == "new_installation",
            Assignment.status == "completed",
            Assignment.completed_at.isnot(None),
        )
        .order_by(Assignment.completed_at.desc())
        .first()
    )
    return done.completed_at.date() if done is not None else None


STATUS_LABELS = {"paid": "Paid", "partial": "Partial", "unpaid": "Unpaid", "overdue": "Overdue"}


def monthly_due_info(subscriber, today=None):
    """Dict describing the subscriber's current monthly bill:

      due_date      -- date, or None when there is nothing to anchor it to
      is_due        -- True on the due date and after it (shown in red)
      days_overdue  -- whole days past the due date (0 on the day itself)
      days_until    -- whole days until it is due (0 when due/overdue)
      monthly_fee   -- the plan's fee, or None when the plan isn't priced
      amount_due    -- what is still payable right now (the remaining
                       balance): 0 before installation and once the
                       current bill is fully paid
      paid_in_cycle -- money already received toward the current bill
      balance       -- same as amount_due (kept as its own name for templates)
      status        -- 'paid' | 'partial' | 'unpaid' | 'overdue'
                       (None for an account that isn't installed yet)
      status_label  -- 'Paid' / 'Partial' / 'Unpaid' / 'Overdue'
      installed     -- False for a new account whose installation isn't done
      can_pay       -- True only when there is an amount to pay

    How the status is worked out: confirmed payments are replayed oldest ->
    newest and added up toward the plan's monthly fee. Once the running total
    reaches the fee the bill is settled and the next due date moves one month
    after that payment. Less than the full fee is a PARTIAL payment: the due
    date stays, the balance just goes down. Anything over one fee carries
    over as credit. A plan with no priced fee can't be measured against, so
    any confirmed payment settles the bill (the previous behaviour).
    Only *confirmed* payments count, so a payment shows up here the moment
    it is confirmed -- by HitPay, a collector or an administrator.
    """
    today = today or date.today()

    installed_on = installation_date(subscriber)

    fee = None
    if subscriber.plan_type:
        plan = Plan.query.filter(
            func.lower(Plan.name) == subscriber.plan_type.strip().lower()
        ).first()
        if plan is not None and plan.monthly_fee is not None:
            fee = plan.monthly_fee

    if installed_on is None:
        # New account, not installed yet: nothing to pay, no due date.
        return {"due_date": None, "is_due": False, "days_overdue": 0, "days_until": 0,
                "monthly_fee": fee, "amount_due": 0, "paid_in_cycle": 0, "balance": 0,
                "status": None, "status_label": None, "installed": False, "can_pay": False}

    confirmed = (
        Payment.query.filter_by(subscriber_id=subscriber.id, status="confirmed")
        .order_by(Payment.payment_date.asc(), Payment.id.asc())
        .all()
    )
    anchor = installed_on
    paid = Decimal("0.00")
    settled_by_last = False
    for payment in confirmed:
        if fee is None or fee <= 0:
            anchor, paid, settled_by_last = payment.payment_date, Decimal("0.00"), True
            continue
        paid += payment.amount
        settled_by_last = False
        if paid >= fee:
            anchor = payment.payment_date
            paid -= fee
            settled_by_last = True
            while paid >= fee:          # a big payment pre-pays further months
                anchor = add_one_month(anchor)
                paid -= fee

    due = add_one_month(anchor)
    delta = (today - due).days
    is_due = delta >= 0

    if confirmed and settled_by_last and not is_due:
        status = "paid"                 # settled; anything left over is credit
    elif paid > 0:
        status = "partial"
    elif is_due and delta > 0:
        status = "overdue"
    else:
        status = "unpaid"               # nothing paid yet (not late / due today)

    if status == "paid" or fee is None or fee <= 0:
        amount_due, paid_in_cycle = Decimal("0.00"), Decimal("0.00")
    else:
        amount_due, paid_in_cycle = max(fee - paid, Decimal("0.00")), paid

    return {
        "due_date": due,
        "is_due": is_due,
        "days_overdue": max(delta, 0),
        "days_until": max(-delta, 0),
        "monthly_fee": fee,
        "amount_due": amount_due,
        "paid_in_cycle": paid_in_cycle,
        "balance": amount_due,
        "status": status,
        "status_label": STATUS_LABELS[status],
        "installed": True,
        "can_pay": amount_due > 0,
    }
