"""
Notification Helper — Phase 17
----------------------------------
Small, standalone module (same pattern as app/settings_utils.py) so
the notification-creation logic lives in exactly one place rather than
being copy-pasted into every route that changes a service request,
payment, or technical issue's status.

`notify()` only ever calls `db.session.add(...)` — it deliberately does
NOT call `db.session.commit()` itself. Every call site already commits
once, right after making its own change (e.g. `service_request.status
= ...`), so the notification row(s) are added to that same pending
transaction and saved together with it in a single commit — not a
separate database round-trip, and not left half-committed if
something later in the same request rolls back.
"""

from app.extensions import db
from app.models import Notification


def notify(category, title, message, *, customer_user_id=None, entity_type=None, entity_id=None):
    """Records a notification for an event.

    Always creates one 'administrator'-audience row (system-wide —
    every Administrator account sees it). If `customer_user_id` is
    given (the affected subscriber's linked `users.id`, if they have
    a portal login), also creates a matching 'customer'-audience row
    so that specific subscriber sees it in their own portal. A
    subscriber with no linked login (`customer_user_id=None`) simply
    gets no customer-facing row — same "not linked yet" situation
    app/routes/customer.py already handles elsewhere in the portal.

    `entity_type`/`entity_id` are optional pointers back to the record
    this notification is about (e.g. "service_request", 42) so the
    notifications list can link to it.
    """
    db.session.add(
        Notification(
            audience="administrator",
            user_id=None,
            category=category,
            title=title,
            message=message,
            entity_type=entity_type,
            entity_id=entity_id,
        )
    )

    if customer_user_id:
        db.session.add(
            Notification(
                audience="customer",
                user_id=customer_user_id,
                category=category,
                title=title,
                message=message,
                entity_type=entity_type,
                entity_id=entity_id,
            )
        )


def notify_payment_overdue(payment):
    """Records a "payment overdue" notification. Called whenever a
    payment's status is set (or changes) to 'overdue' — this schema
    has no separate "due date" concept, so 'overdue' is the trigger
    point for the "payment due/overdue" notification category the
    client scoped in (see PHASE17_NOTES.md). Shared by
    app/routes/payments.py (add_payment/edit_payment) and
    app/routes/collector.py (record_payment) so the message text lives
    in exactly one place rather than being copy-pasted a third time.
    """
    notify(
        "payment",
        f"Payment overdue — {payment.subscriber.subscriber_code}",
        f"A payment of {payment.amount} for {payment.subscriber.full_name} "
        f"is now marked overdue.",
        customer_user_id=payment.subscriber.user_id,
        entity_type="payment",
        entity_id=payment.id,
    )


def notify_new_issue_reported(issue):
    """Records a Phase 23 (phase_12.pdf) "new issue reported"
    notification — fired once, at creation, from both places a
    technical issue can originate: a staff member logging one on the
    GeoMap (app/routes/issues.py's `report_issue()`) and a customer
    self-reporting one from the portal (app/routes/customer.py's
    `report_issue()`). Distinct from `notify_issue_status_change()`
    below, which fires on every later status transition — this one
    fires exactly once, at the moment an Administrator first needs to
    know a new issue exists at all, before it has a status to change.

    Always administrator-facing only (`customer_user_id` is never
    passed) — the reporting customer/staff member already sees their
    own "reported successfully" flash/JSON response inline, so a
    duplicate self-notification would be noise, not new information.
    """
    label = issue.issue_code or f"#{issue.id}"
    subscriber_label = issue.subscriber.full_name if issue.subscriber else "an unlinked subscriber"
    notify(
        "issue",
        f"New issue reported — {label}",
        f"{issue.issue_type.replace('_', ' ').capitalize()} issue reported for "
        f"{subscriber_label} ({issue.priority} priority).",
        entity_type="issue",
        entity_id=issue.id,
    )


def notify_payment_pending_confirmation(payment):
    """Records a Phase 23 (phase_12.pdf) "payment requiring
    confirmation" notification — fired whenever a payment is saved
    with `status == 'pending'`, whether newly recorded (a field
    collector's `collector.record_payment()`, or an Administrator's
    own `payments.add_payment()`) or edited into that state
    (`payments.edit_payment()`). 'pending' is this schema's "recorded,
    not yet confirmed" state (see app/models.py's `Payment.status`
    enum), so this is the trigger point for "payment requiring
    confirmation" the client scoped in for this phase — same "one
    status value is the trigger" shape `notify_payment_overdue()`
    above already uses for 'overdue'.

    Administrator-facing only, same reasoning as
    `notify_new_issue_reported()` above: the subscriber isn't the one
    who needs to act on a pending confirmation, an Administrator is.
    """
    notify(
        "payment",
        f"Payment requires confirmation — {payment.subscriber.subscriber_code}",
        f"A payment of {payment.amount} from {payment.subscriber.full_name} "
        f"is recorded as pending and needs to be reviewed and confirmed.",
        entity_type="payment",
        entity_id=payment.id,
    )


def notify_issue_status_change(issue):
    """Records a Phase 17 notification for a technical issue's status
    change — same `notify()` call shape as
    app/routes/service_requests.py's `_notify_status_change()`. Shared
    by app/routes/dispatch.py (assign/reassign/cancel) and
    app/routes/technician.py (start_assignment/complete_assignment)
    rather than duplicated in both, since both fire on the same event
    (`issue.status` changing) and notify the same audience (the
    issue's subscriber, via `issue.subscriber.user_id`, plus the
    admin-broadcast row)."""
    label = issue.issue_code or f"#{issue.id}"
    customer_user_id = issue.subscriber.user_id if issue.subscriber else None
    notify(
        "issue",
        f"Technical issue {label} — {issue.status.replace('_', ' ')}",
        f"Your reported issue is now '{issue.status.replace('_', ' ')}'."
        if customer_user_id
        else f"Technical issue {label} ({issue.issue_type}) is now "
        f"'{issue.status.replace('_', ' ')}'.",
        customer_user_id=customer_user_id,
        entity_type="issue",
        entity_id=issue.id,
    )


def unread_count_for(user):
    """Returns how many unread notifications `user` currently has, for
    the sidebar/topbar badge. Returns 0 for a logged-out visitor or a
    role with no Notifications page (Technician, Payment Collector) —
    same roles that don't get a `notifications.index` sidebar link in
    dashboard_base.html.
    """
    if user is None:
        return 0
    if user.role == "administrator":
        return Notification.query.filter_by(audience="administrator", is_read=False).count()
    if user.role == "user":
        return Notification.query.filter_by(
            audience="customer", user_id=user.id, is_read=False
        ).count()
    return 0
