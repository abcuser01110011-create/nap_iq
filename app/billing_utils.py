"""Monthly billing helpers for the subscriber (customer) portal.

The schema has no dedicated due-date column, so the monthly due date is
derived, same idea as app/routes/collector.py's estimate but on a real
calendar month instead of 30 days: one month after the subscriber's most
recent confirmed payment, or -- before any payment exists -- one month
after the install date (falling back to the day the record was created).
"""

import calendar
from datetime import date

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


def monthly_due_info(subscriber, today=None):
    """Dict describing the subscriber's current monthly due date:

      due_date      -- date, or None when there is nothing to anchor it to
      is_due        -- True on the due date and after it (shown in red)
      days_overdue  -- whole days past the due date (0 on the day itself)
      days_until    -- whole days until it is due (0 when due/overdue)
      monthly_fee   -- the plan's fee, or None when the plan isn't priced
      amount_due    -- what is payable right now: 0 before installation and
                       while the current month is already paid
      installed     -- False for a new account whose installation isn't done
      can_pay       -- True only when there is an amount to pay
    """
    today = today or date.today()

    installed_on = installation_date(subscriber)
    last_confirmed = None
    if installed_on is not None:
        last_confirmed = (
            Payment.query.filter_by(subscriber_id=subscriber.id, status="confirmed")
            .order_by(Payment.payment_date.desc())
            .first()
        )
    if last_confirmed is not None:
        anchor = last_confirmed.payment_date
    else:
        anchor = installed_on  # None until the installation is done

    fee = None
    if subscriber.plan_type:
        plan = Plan.query.filter(
            func.lower(Plan.name) == subscriber.plan_type.strip().lower()
        ).first()
        if plan is not None and plan.monthly_fee is not None:
            fee = plan.monthly_fee

    if anchor is None:
        # New account, not installed yet: nothing to pay, no due date.
        return {"due_date": None, "is_due": False, "days_overdue": 0, "days_until": 0,
                "monthly_fee": fee, "amount_due": 0, "installed": False, "can_pay": False}

    due = add_one_month(anchor)
    delta = (today - due).days
    is_due = delta >= 0
    # Already paid for this month (a payment exists and the next due date
    # hasn't arrived) -> nothing to pay.
    paid_up = last_confirmed is not None and not is_due
    amount_due = 0 if (paid_up or fee is None) else fee
    return {
        "due_date": due,
        "is_due": is_due,
        "days_overdue": max(delta, 0),
        "days_until": max(-delta, 0),
        "monthly_fee": fee,
        "amount_due": amount_due,
        "installed": True,
        "can_pay": amount_due > 0,
    }
