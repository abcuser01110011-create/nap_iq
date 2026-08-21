"""
Notifications Blueprint — Phase 17
--------------------------------------
Fills in the "Notifications" sidebar placeholder that's been a
disabled "Coming soon" link since Phase 7 for both the Administrator
and the Customer — see PHASE7_NOTES.md through PHASE16_NOTES.md,
none of which built it; phase_7.pdf lists it as one of the Customer
role's pages.

Scope decisions (client-confirmed, see PHASE17_NOTES.md):
  - What generates a notification: service request status changes,
    payment due/overdue, and technical issue status changes. The
    actual `Notification` rows are created at the point each of those
    fields changes (app/routes/service_requests.py, payments.py,
    dispatch.py, technician.py) via app/notifications_utils.py's
    `notify()` — this module only ever *reads* and displays them.
  - Who sees which: a Customer only ever sees their own
    ('customer'-audience) notifications; an Administrator sees every
    notification system-wide ('administrator'-audience). Enforced by
    scoping the query to `g.user.role` below — a Customer can never
    see another subscriber's notifications, and there's no id-based
    URL that would let them try (mark_read/mark_all_read re-check
    ownership too, not just the list view).
  - Read/unread: tracked (`Notification.is_read`), with a "Mark all
    as read" action, matching how most Notifications inboxes work.

Technician and Payment Collector accounts have no Notifications page
in this round (their roles were never listed as a phase_7.pdf
Notifications audience) — `role_required` below reflects that.

Routes:
    GET  /notifications/                  -> index            (own notifications)
    POST /notifications/<id>/read         -> mark_read         (mark one read)
    POST /notifications/mark-all-read     -> mark_all_read     (mark every own one read)
"""

from flask import Blueprint, render_template, redirect, url_for, flash, abort, g

from app.extensions import db
from app.auth import role_required
from app.models import Notification

notifications_bp = Blueprint("notifications", __name__, url_prefix="/notifications")

_ROLES = ("administrator", "user")

# Where a notification's "view record" link should point, keyed by
# Notification.entity_type. Kept here (not on the model) since it's
# presentation, not data. Administrator links go straight to the
# specific record's edit/detail page; Customer links go to that
# category's own read-only list page (customer.py has no
# single-record detail route to link to — my_issues/my_service_requests/
# my_payments are each a full list, so that's the closest "go see it"
# destination for a Customer).
_ADMIN_ENTITY_LINKS = {
    "service_request": ("service_requests.edit_request", "request_id"),
    "payment": ("payments.edit_payment", "payment_id"),
    "issue": ("issues.view_issue", "issue_id"),
}
_CUSTOMER_ENTITY_LINKS = {
    "service_request": "customer.my_service_requests",
    "payment": "customer.my_payments",
    "issue": "customer.my_issues",
}


def _own_query():
    """The signed-in account's own notification query — every row for
    an Administrator (system-wide), only this Customer's own rows for
    a 'user'-role account. Kept as one helper so index()/mark_read()/
    mark_all_read() can't drift out of sync on what "own" means."""
    if g.user.role == "administrator":
        return Notification.query.filter_by(audience="administrator")
    return Notification.query.filter_by(audience="customer", user_id=g.user.id)


def _record_link(notification):
    """Returns a URL to the record a notification is about, or None if
    it doesn't point anywhere (no entity_type/id, or an entity_type
    this role has no matching page for)."""
    if g.user.role == "administrator":
        entry = _ADMIN_ENTITY_LINKS.get(notification.entity_type)
        if entry and notification.entity_id:
            endpoint, id_kwarg = entry
            return url_for(endpoint, **{id_kwarg: notification.entity_id})
        return None

    endpoint = _CUSTOMER_ENTITY_LINKS.get(notification.entity_type)
    return url_for(endpoint) if endpoint else None


@notifications_bp.route("/")
@role_required(*_ROLES)
def index():
    """Full chronological list of the signed-in account's own
    notifications, newest first."""
    notifications = _own_query().order_by(Notification.created_at.desc()).all()
    unread_count = sum(1 for n in notifications if not n.is_read)
    links = {n.id: _record_link(n) for n in notifications}

    return render_template(
        "notifications/list.html",
        notifications=notifications,
        unread_count=unread_count,
        links=links,
    )


@notifications_bp.route("/<int:notification_id>/read", methods=["POST"])
@role_required(*_ROLES)
def mark_read(notification_id):
    """Marks a single notification read. 404s (via get_or_404) if the
    id doesn't exist at all; 403s if it exists but isn't one of the
    signed-in account's own — same "look it up, then check ownership"
    shape app/routes/technician.py's `_get_own_assignment_or_403` uses,
    so a Customer can't mark (or infer the existence of) another
    subscriber's notification just by guessing an id in a POST."""
    notification = Notification.query.get_or_404(notification_id)
    _assert_own(notification)

    notification.is_read = True
    db.session.commit()
    return redirect(url_for("notifications.index"))


@notifications_bp.route("/mark-all-read", methods=["POST"])
@role_required(*_ROLES)
def mark_all_read():
    """Marks every one of the signed-in account's own unread
    notifications read in one action."""
    _own_query().filter_by(is_read=False).update({"is_read": True})
    db.session.commit()
    flash("All notifications marked as read.", "success")
    return redirect(url_for("notifications.index"))


def _assert_own(notification):
    """403s unless `notification` belongs to the signed-in account,
    using the same audience/user_id rule `_own_query()` filters by."""
    if g.user.role == "administrator":
        if notification.audience != "administrator":
            abort(403)
    else:
        if notification.audience != "customer" or notification.user_id != g.user.id:
            abort(403)
