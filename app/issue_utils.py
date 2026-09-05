"""Shared TechnicalIssue helpers used by more than one blueprint.

Kept in their own module (rather than duplicated in, or imported
between, app/routes/technician.py and app/routes/api_v1/technician.py)
since both the desktop web technician UI and the mobile app's
completion flow need the exact same behaviour here.
"""

from app.models import TechnicalIssue

# Same "still open" statuses app/routes/issues.py's _OPEN_ISSUE_STATUSES
# uses -- kept as its own tuple here (instead of importing that one)
# to avoid a routes-module-importing-routes-module circular import.
OPEN_ISSUE_STATUSES = ("pending", "assigned", "in_progress")


def resolve_fiber_break_siblings(resolved_issue):
    """When a Fiber Break issue is marked resolved, every other
    connected subscriber's issue from that same outage is resolved
    right along with it.

    report_fiber_break() (app/routes/issues.py) fans one NAP-wide
    outage out into one TechnicalIssue per connected subscriber, all
    sharing the same issue_code, but only ever dispatches (creates an
    Assignment for) the first one -- a field assistant only needs to
    go out once, not once per connected line. That means nothing else
    ever touches the other connected subscribers' issue rows: left
    alone, their map markers/tickets would keep showing the outage as
    open (still pulsing red/"CRITICAL") forever, even after the fiber
    is actually fixed and the dispatched ticket is completed.

    Matches siblings by the same NAP + "Fiber Break" issue_type +
    shared issue_code, so this only resolves the *current* outage's
    issues -- a later, separate Fiber Break on the same NAP gets its
    own new shared issue_code and isn't touched by this.

    No-op for any issue that isn't a Fiber Break, or has no
    issue_code to match siblings on. Caller is still responsible for
    committing the session afterwards.
    """
    if resolved_issue is None or resolved_issue.issue_type != "Fiber Break":
        return
    if not resolved_issue.issue_code:
        return

    siblings = TechnicalIssue.query.filter(
        TechnicalIssue.nap_id == resolved_issue.nap_id,
        TechnicalIssue.issue_type == "Fiber Break",
        TechnicalIssue.issue_code == resolved_issue.issue_code,
        TechnicalIssue.status.in_(OPEN_ISSUE_STATUSES),
        TechnicalIssue.id != resolved_issue.id,
    ).all()
    for sibling in siblings:
        sibling.status = "resolved"
