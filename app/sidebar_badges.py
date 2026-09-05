"""
Sidebar Nav Badge Counts
------------------------
Small, standalone module (same pattern as app/settings_utils.py and
app/notifications_utils.py) computing the little count pill shown on
a dashboard_base.html sidebar link — e.g. "3" on Subscribers when 3
new customers are awaiting review, or "5" on Dispatch Board when 5
jobs still need a technician assigned.

Deliberately NOT built on top of the Notification/is_read system
(app/notifications_utils.py): these badges answer "how many things in
this section currently need action", a live count straight off each
table's own status column, not "how many notifications about this
section have you not clicked yet". The two can disagree on purpose —
e.g. an Administrator who has already read the "new issue reported"
notification but hasn't dispatched anyone yet should still see a
Dispatch Board badge, since the underlying issue is still undispatched
regardless of whether its notification was read.

The one place this module DOES reuse the Notification system is the
Customer-facing badges (my_service_requests/my_issues/my_payments),
where "how many unread updates do I have about my own things" IS
exactly what Notification.is_read already tracks per category for
that customer — recomputing it a second way would just be two
sources of truth for the same fact.

Each `sidebar_badge_counts(user)` call is a handful of small, indexed
COUNT queries (never a full table scan of issues/requests/payments
themselves), same cost class as the existing `unread_count_for()` /
`recent_for()` calls this same context processor pattern already
makes on every request.
"""

from app.models import (
    Assignment,
    Notification,
    Payment,
    ServiceRequest,
    Technician,
    TechnicalIssue,
)

# Mirrors app/routes/dispatch.py's OPEN_ASSIGNMENT_STATUSES /
# DISPATCHABLE_REQUEST_STATUSES — kept as its own copy (not imported
# from there) since importing a routes module from a utils module
# would invert this app's existing dependency direction (routes ->
# utils, never the other way), same reasoning app/notifications_utils.py
# already documents for its own constants.
_OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")
_DISPATCHABLE_REQUEST_STATUSES = ("scheduled",)


def _admin_badges():
    """Live "needs action" counts for the Administrator sidebar.

    - issues: technical issues reported but not yet assigned to
      anyone ('pending' — see TechnicalIssue.status's docstring in
      app/models.py). Once assigned, it's no longer "new", it's "in
      the dispatch pipeline" (see `dispatch` below instead).
    - dispatch: everything currently sitting on the dispatch board
      with nobody dispatched yet — unassigned issues, plus scheduled
      service requests (installs) with no open assignment. Same
      "what needs a technician right now" question dispatch/index.html
      answers, just as a single number instead of a full board.
    - subscribers: pending installation requests awaiting a decision
      ('pending' new_installation ServiceRequest rows) — the same
      count the Subscribers page's own "Installation Request" dropdown
      badge shows (see app/routes/subscribers.py's list_subscribers()),
      so the sidebar number and the dropdown number never disagree.
    - service_requests: newly submitted requests awaiting a decision
      ('pending' — not yet approved/scheduled/rejected).
    - payments: payments recorded but not yet confirmed ('pending').
    """
    issues_pending = TechnicalIssue.query.filter_by(status="pending").count()

    dispatchable_requests = ServiceRequest.query.filter(
        ServiceRequest.status.in_(_DISPATCHABLE_REQUEST_STATUSES)
    ).all()
    if dispatchable_requests:
        request_ids_with_open_assignment = {
            a.service_request_id
            for a in Assignment.query.filter(
                Assignment.service_request_id.in_([r.id for r in dispatchable_requests]),
                Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES),
            ).all()
        }
        unassigned_requests = sum(
            1 for r in dispatchable_requests if r.id not in request_ids_with_open_assignment
        )
    else:
        unassigned_requests = 0

    pending_installation_requests = ServiceRequest.query.filter_by(
        request_type="new_installation", status="pending"
    ).count()

    return {
        "issues": issues_pending,
        "dispatch": issues_pending + unassigned_requests,
        "subscribers": pending_installation_requests,
        "service_requests": ServiceRequest.query.filter_by(status="pending").count(),
        "payments": Payment.query.filter_by(status="pending").count(),
    }


def _technician_badges(user):
    """Live "needs action" count for the Technician sidebar: assignments
    dispatched to them that they haven't accepted yet ('assigned' —
    see Assignment.status's enum in app/models.py). Once accepted, it's
    a job they're already working, not a new one waiting on them.
    """
    profile = Technician.query.filter_by(user_id=user.id).first()
    if profile is None:
        return {"technician_dashboard": 0}

    return {
        "technician_dashboard": Assignment.query.filter_by(
            technician_id=profile.id, status="assigned"
        ).count()
    }


def _customer_badges(user):
    """Unread-notification counts for the Customer sidebar, one per
    category — reuses the Notification system directly (see this
    module's docstring for why the Customer case is the one exception
    to "live status count, not notification count")."""
    counts = {
        category: Notification.query.filter_by(
            audience="customer", user_id=user.id, category=category, is_read=False
        ).count()
        for category in ("service_request", "issue", "payment")
    }
    return {
        "customer_service_requests": counts["service_request"],
        "customer_issues": counts["issue"],
        "customer_payments": counts["payment"],
    }


def sidebar_badge_counts(user):
    """Returns a dict of sidebar badge counts for `user`'s role,
    keyed by the nav item each count belongs to (see dashboard_base.html
    for where each key is used). Returns {} for a logged-out visitor or
    a role with no badges defined (Payment Collector currently has
    nothing badge-worthy — see app/routes/collector.py's docstring:
    `index()` only shows the signed-in collector's own already-recorded
    payments, there's no "assigned to you, not yet actioned" queue to
    count). Template lookups use `sidebar_badges.get('key')`-style
    Jinja access, so a missing key renders as falsy (no badge) rather
    than erroring.
    """
    if user is None:
        return {}
    if user.role == "administrator":
        return _admin_badges()
    if user.role == "technician":
        return _technician_badges(user)
    if user.role == "user":
        return _customer_badges(user)
    return {}
