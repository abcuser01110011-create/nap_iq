"""
Manage Collectors Blueprint (Administrator only)
-----------------------------------------------------------------
Fills in the admin-facing "Collector" tab next to Personnel/Technician
on the sidebar: a read-only roster of every `payment_collector`
account, with each row's Subscribers / Collected Today / Collection
Rate / Status computed live from the `payments` table rather than
stored anywhere — there's no separate "collectors" roster table the
way Technician has one, since a payment-collector login is already a
full `users` row and that's the only profile this role needs (see
app/routes/collector.py's own docstring for why that blueprint is
intentionally narrow).

Metrics, per collector:
    Subscribers      — total active subscribers inside this collector's
                        coverage area (barangays), whether or not the
                        collector has collected from them yet. Same
                        address-contains-barangay match the collector's own
                        Collections page uses. 0 until a coverage area is
                        set.
    Collected Today  — sum of today's *confirmed* payments recorded by
                        this collector.
    Collection Rate  — of all non-voided payments this collector has
                        ever recorded, what percentage are 'confirmed'
                        (as opposed to still 'pending' or 'overdue').
    Status           — "Active" at a Collection Rate of 80% or above,
                        "Behind" below that, "No Activity" for a
                        collector with no recorded payments yet.
Coverage comes straight from `users.coverage_area` (see
app/models.py) — set via Manage Users > Edit for that account, blank
until an administrator fills it in.

Accounts whose login was deactivated are hidden from the main list and
shown via "View deactivated accounts" (?account=deactivated), same as the
Technician tab. Deactivate / Reactivate buttons live in the row's popup
(they post to users.deactivate_user / users.activate_user).

Routes:
    GET /collectors/ -> list_collectors
"""

from datetime import date

from flask import Blueprint, render_template, request
from sqlalchemy import func

from app.extensions import db
from app.auth import role_required
from app.models import User, Payment, Subscriber

collectors_bp = Blueprint("collectors", __name__, url_prefix="/collectors")

# Collection Rate at/above this percentage reads as "Active" rather
# than "Behind" — see the Status column in the docstring above.
ACTIVE_RATE_THRESHOLD = 80


@collectors_bp.route("/")
@role_required("administrator")
def list_collectors():
    """Displays every Payment Collector account with its live
    collection metrics for today."""
    # Deactivated logins are hidden here and shown only via
    # "View deactivated accounts" (?account=deactivated).
    show_deactivated = request.args.get("account", "").strip() == "deactivated"
    all_collectors = (
        User.query.filter_by(role="payment_collector")
        .order_by(User.full_name.asc())
        .all()
    )
    collector_users = [
        u for u in all_collectors if (u.status != "active") == show_deactivated
    ]

    today = date.today()
    collector_ids = [c.id for c in collector_users]

    # One aggregate query per metric (rather than one per collector
    # per metric) so this page doesn't fire N*3 queries for N
    # collectors — same "query once, look up by id in Python"
    # approach the Reports tabs use for their own summary rows.
    # Subscribers = every active subscriber inside the collector's coverage
    # (barangays), not just the ones they've collected from. Addresses are
    # loaded once and matched per collector in Python.
    active_addresses = (
        [(a or "").lower() for (a,) in db.session.query(Subscriber.address).filter_by(status="active").all()]
        if collector_users else []
    )

    def _coverage_subscriber_count(user):
        barangays = [b.strip().lower() for b in (user.coverage_area or "").split(",") if b.strip()]
        if not barangays:
            return 0
        return sum(1 for addr in active_addresses if any(b in addr for b in barangays))

    collected_today = dict(
        db.session.query(Payment.collector_id, func.coalesce(func.sum(Payment.amount), 0))
        .filter(
            Payment.collector_id.in_(collector_ids),
            Payment.payment_date == today,
            Payment.status == "confirmed",
        )
        .group_by(Payment.collector_id)
        .all()
    ) if collector_ids else {}

    status_counts = {}
    if collector_ids:
        rows = (
            db.session.query(Payment.collector_id, Payment.status, func.count(Payment.id))
            .filter(Payment.collector_id.in_(collector_ids), Payment.status != "voided")
            .group_by(Payment.collector_id, Payment.status)
            .all()
        )
        for collector_id, status, count in rows:
            status_counts.setdefault(collector_id, {})[status] = count

    collectors = []
    for user in collector_users:
        counts = status_counts.get(user.id, {})
        total_recorded = sum(counts.values())
        confirmed = counts.get("confirmed", 0)
        rate = round((confirmed / total_recorded) * 100) if total_recorded else None

        collectors.append({
            "user": user,
            "subscribers": _coverage_subscriber_count(user),
            "collected_today": collected_today.get(user.id, 0),
            "rate": rate,
            "status": (
                "no_activity" if rate is None
                else "active" if rate >= ACTIVE_RATE_THRESHOLD
                else "behind"
            ),
        })

    return render_template(
        "collectors/list.html", collectors=collectors, show_deactivated=show_deactivated
    )
