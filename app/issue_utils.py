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

# issue_type -> priority for a *customer* self-reported issue (web
# portal's CustomerIssueReportForm and the mobile app's POST
# /api/v1/customer/issues). Both routes call
# resolve_customer_issue_priority() below instead of taking a
# priority value from the request, so this dict is the one place that
# rule lives.
#
# TechnicalIssue.priority (app/models.py) is a
# db.Enum("low", "medium", "high", "critical") column with no
# "urgent" value, so "urgent" is mapped to "critical", the highest
# priority the column supports.
_CRITICAL_CUSTOMER_ISSUE_TYPES = {"No Internet", "Cable Problem"}
_HIGH_CUSTOMER_ISSUE_TYPES = {"Slow Internet", "Router/Modem Problem"}


def resolve_customer_issue_priority(issue_type):
    """Returns the priority a customer-reported issue should get,
    based solely on its issue_type:

      - "No Internet" or "Cable Problem" -> "critical"
      - "Slow Internet" or "Router/Modem Problem" -> "high"
      - anything else (e.g. "Connection Problem", "Other", or any
        unrecognized value) -> "medium"

    Never raises -- an unrecognized issue_type just falls through to
    the "medium" default rather than erroring, since issue_type is
    already validated against CUSTOMER_ISSUE_TYPE_CHOICES
    (app/forms.py) by the caller before this is reached.
    """
    if issue_type in _CRITICAL_CUSTOMER_ISSUE_TYPES:
        return "critical"
    if issue_type in _HIGH_CUSTOMER_ISSUE_TYPES:
        return "high"
    return "medium"


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
