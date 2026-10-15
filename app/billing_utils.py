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

from app.models import Payment, Plan


def add_one_month(d):
    """`d` plus one calendar month, clamped to the target month's last day
    (Jan 31 -> Feb 28/29)."""
    year = d.year + (d.month // 12)
    month = d.month % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def monthly_due_info(subscriber, today=None):
    """Dict describing the subscriber's current monthly due date:

      due_date      -- date, or None when there is nothing to anchor it to
      is_due        -- True on the due date and after it (shown in red)
      days_overdue  -- whole days past the due date (0 on the day itself)
      days_until    -- whole days until it is due (0 when due/overdue)
      monthly_fee   -- the plan's fee, or None when the plan isn't priced
    """
    today = today or date.today()

    last_confirmed = (
        Payment.query.filter_by(subscriber_id=subscriber.id, status="confirmed")
        .order_by(Payment.payment_date.desc())
        .first()
    )
    if last_confirmed is not None:
        anchor = last_confirmed.payment_date
    elif subscriber.installed_at is not None:
        anchor = subscriber.installed_at
    elif subscriber.created_at is not None:
        anchor = subscriber.created_at.date()
    else:
        anchor = None

    fee = None
    if subscriber.plan_type:
        plan = Plan.query.filter(
            func.lower(Plan.name) == subscriber.plan_type.strip().lower()
        ).first()
        if plan is not None and plan.monthly_fee is not None:
            fee = plan.monthly_fee

    if anchor is None:
        return {"due_date": None, "is_due": False, "days_overdue": 0, "days_until": 0, "monthly_fee": fee}

    due = add_one_month(anchor)
    delta = (today - due).days
    return {
        "due_date": due,
        "is_due": delta >= 0,
        "days_overdue": max(delta, 0),
        "days_until": max(-delta, 0),
        "monthly_fee": fee,
    }
