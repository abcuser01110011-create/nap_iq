"""Shared TechnicalIssue helpers used by more than one blueprint.

Kept in their own module (rather than duplicated in, or imported
between, app/routes/technician.py and app/routes/api_v1/technician.py)
since both the desktop web technician UI and the mobile app's
completion flow need the exact same behaviour here.
"""

import math

from app.extensions import db
from app.models import Assignment, TechnicalIssue

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


# ---------------------------------------------------------------------
# Ticket consolidation
# ---------------------------------------------------------------------
# Once a NAP has this many open tickets of the same issue_type, they are
# folded into ONE job: the first-reported ticket becomes the parent and
# every other one becomes a child of it. A field assistant then makes one
# trip and sees every affected location on the parent's detail page.
CONSOLIDATION_THRESHOLD = 3

# Fiber Break already has its own NAP-wide grouping (shared issue_code,
# see resolve_fiber_break_siblings above), so it's left alone here.
_NOT_CONSOLIDATED_TYPES = {"Fiber Break"}

_OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")
# An assignment the technician hasn't started yet can safely be pulled
# back when its ticket is folded into a parent.
_WITHDRAWABLE_ASSIGNMENT_STATUSES = ("assigned", "accepted")


def _release_technician_if_idle(technician):
    if technician is None or technician.status != "busy":
        return
    still_open = Assignment.query.filter(
        Assignment.technician_id == technician.id,
        Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES),
    ).count()
    if still_open == 0:
        technician.status = "available"


def _withdraw_unstarted_assignments(issue):
    """Cancels `issue`'s own not-yet-started assignments (it is now
    covered by its parent's single trip). Returns True if the issue
    still has an in-progress assignment of its own (i.e. a technician is
    already out on it), in which case it must NOT be folded in."""
    own = Assignment.query.filter(
        Assignment.technical_issue_id == issue.id,
        Assignment.status.in_(_OPEN_ASSIGNMENT_STATUSES),
    ).all()
    if any(a.status == "in_progress" for a in own):
        return True
    for a in own:
        if a.status in _WITHDRAWABLE_ASSIGNMENT_STATUSES:
            a.status = "cancelled"
            _release_technician_if_idle(a.technician)
    return False


def open_issue_for_subscriber(subscriber_id):
    """The subscriber's oldest not-yet-completed ticket, or None. A
    customer may only have ONE such ticket at a time (the self-service
    report routes refuse a new report while this returns something)."""
    return (
        TechnicalIssue.query.filter(
            TechnicalIssue.subscriber_id == subscriber_id,
            # NOTE: "accepted" is an *assignment* status, not a technical_issues.status
            # value. MySQL silently ignored it inside IN (...); PostgreSQL rejects the
            # query ("invalid input value for enum issue_status"), so it must not be here.
            TechnicalIssue.status.in_(("pending", "assigned", "in_progress")),
        )
        .order_by(TechnicalIssue.created_at, TechnicalIssue.id)
        .first()
    )


def effective_open_assignment(issue):
    """The open Assignment responsible for `issue`: its own, or -- when it
    was folded into a consolidated parent ticket -- the parent's.

    A folded child never keeps an assignment of its own (its unstarted
    ones are cancelled so only one technician is sent), so anything that
    shows "who is handling this ticket" must look through to the parent,
    otherwise the child reads as Unassigned even though a technician is
    on the way."""
    if issue is None:
        return None
    for source in (issue, issue.parent_issue):
        if source is None:
            continue
        for assignment in source.assignments:
            if assignment.status in _OPEN_ASSIGNMENT_STATUSES:
                return assignment
    return None


def effective_technician_name(issue):
    """Full name of the technician handling `issue` (see
    effective_open_assignment), or None."""
    assignment = effective_open_assignment(issue)
    if assignment is not None and assignment.technician is not None:
        return assignment.technician.full_name
    return None


def _finish_consolidation(parent):
    """After tickets were folded into `parent`: make sure the group has a
    technician, and keep every child's status in step with the parent.

    Without the first part, a parent that was reported while nobody was
    available has no assignment, the children's own assignments were
    just cancelled, and the whole group ends up with nobody dispatched.
    """
    if parent is None:
        return
    if parent.status in ("pending", "assigned") and effective_open_assignment(parent) is None:
        # Imported here to avoid a circular import at module load.
        from app.recommendation import auto_assign_recommended_technician

        auto_assign_recommended_technician(parent)

    if effective_open_assignment(parent) is not None:
        for child in parent.child_issues:
            if child.status == "pending":
                child.status = "assigned"
    db.session.commit()


def consolidate_nap_issues(new_issue):
    """Folds `new_issue` into its NAP's consolidated ticket when needed
    (see _consolidate_nap_issues below) and then makes sure the resulting
    group has a technician. Same return value as _consolidate_nap_issues."""
    parent = _consolidate_nap_issues(new_issue)
    if parent is not None:
        _finish_consolidation(parent)
    return parent


def _consolidate_nap_issues(new_issue):
    """Call right after a TechnicalIssue has been committed (so it has an
    id). Returns the parent TechnicalIssue if `new_issue` ended up as a
    CHILD of a consolidated ticket (callers then skip dispatching it --
    the parent's technician covers it), or None if it is still a
    standalone ticket (or is itself the parent).

    Rules, per NAP + issue_type:
      * If an open consolidated parent already exists, the new ticket
        simply joins it.
      * Otherwise, once CONSOLIDATION_THRESHOLD open standalone tickets
        exist, the oldest one becomes the parent and the rest join it.
        Tickets that already have a technician in progress stay
        standalone. Children's not-yet-started assignments are cancelled
        so only one technician is sent.

    Caller is responsible for the final commit-after (this commits its
    own changes too, so it is safe to call and move on).
    """
    if new_issue is None or new_issue.nap_id is None:
        return None
    if new_issue.issue_type in _NOT_CONSOLIDATED_TYPES:
        return None
    if new_issue.parent_issue_id is not None:
        return new_issue.parent_issue

    base = TechnicalIssue.query.filter(
        TechnicalIssue.nap_id == new_issue.nap_id,
        TechnicalIssue.issue_type == new_issue.issue_type,
        TechnicalIssue.status.in_(OPEN_ISSUE_STATUSES),
        TechnicalIssue.parent_issue_id.is_(None),
    )

    # 1) Join an existing open parent (a standalone-looking open ticket
    #    that already has children).
    existing_parent = (
        base.filter(
            TechnicalIssue.id != new_issue.id,
            TechnicalIssue.id.in_(
                db.session.query(TechnicalIssue.parent_issue_id).filter(
                    TechnicalIssue.parent_issue_id.isnot(None)
                )
            ),
        )
        .order_by(TechnicalIssue.created_at, TechnicalIssue.id)
        .first()
    )
    if existing_parent is not None:
        if _withdraw_unstarted_assignments(new_issue):
            return None
        new_issue.parent_issue_id = existing_parent.id
        db.session.commit()
        return existing_parent

    # 2) Threshold reached -> oldest becomes the parent.
    group = base.order_by(TechnicalIssue.created_at, TechnicalIssue.id).all()
    if len(group) < CONSOLIDATION_THRESHOLD:
        return None
    parent = group[0]
    for child in group[1:]:
        if _withdraw_unstarted_assignments(child):
            continue
        child.parent_issue_id = parent.id
    db.session.commit()
    return parent if new_issue.parent_issue_id == parent.id else None


def resolve_consolidated_children(resolved_issue):
    """When a consolidated parent ticket is resolved, every child ticket
    still open is resolved with it (same idea as
    resolve_fiber_break_siblings). Returns the list of children that were
    changed so the caller can notify their subscribers. Caller commits."""
    if resolved_issue is None:
        return []
    changed = []
    for child in resolved_issue.child_issues:
        if child.status in OPEN_ISSUE_STATUSES:
            child.status = "resolved"
            changed.append(child)
    return changed


def consolidated_missing_proof_count(parent_issue, assignment):
    """How many still-open locations of a consolidated job have no proof
    photo yet (0 for a non-consolidated ticket). complete_assignment()
    refuses to finish the job while this is above zero."""
    if parent_issue is None or not parent_issue.child_issues:
        return 0
    missing = 0
    for issue in [parent_issue] + list(parent_issue.child_issues):
        if issue.status not in OPEN_ISSUE_STATUSES:
            continue
        proof = issue.proof_photo
        if not proof and issue.id == parent_issue.id and assignment is not None:
            proof = assignment.photo_filename
        if not proof:
            missing += 1
    return missing


def _haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build_consolidated_locations(parent_issue, assignment=None):
    """View-model for the "Affected locations" section: a list of dicts
    (parent first in the data, then ordered into a suggested visit route
    by nearest-neighbour starting from the NAP). Returns None when the
    ticket has no children, i.e. isn't a consolidated ticket."""
    if parent_issue is None or not parent_issue.child_issues:
        return None

    # Imported here (not at module top) to avoid a utils -> routes circular import.
    from app.routes.api_v1.technician import _parse_ticket_extras, _subscriber_installed_port_number
    from app.routes.technician import PRIORITY_LABELS

    nap = parent_issue.nap
    members = [parent_issue] + list(parent_issue.child_issues)
    rows = []
    for issue in members:
        sub = issue.subscriber
        # Per-subscriber details shown in each row's dropdown.
        extras, clean_desc = _parse_ticket_extras(issue.description)
        row_nap = issue.nap or (sub.nap if sub else None)
        if issue.issue_type == "Fiber Break" and issue.priority == "critical":
            prio_label = "Critical"
        else:
            prio_label = PRIORITY_LABELS.get(issue.priority, issue.priority) if issue.priority else None
        if issue.id == parent_issue.id and assignment is not None and assignment.port_number is not None:
            port = assignment.port_number
        else:
            port = _subscriber_installed_port_number(sub) if sub else None
        # The parent's proof falls back to the assignment's completion photo
        # so a photo uploaded before consolidation still counts.
        proof = issue.proof_photo
        if not proof and issue.id == parent_issue.id and assignment is not None:
            proof = assignment.photo_filename
        lat = (sub.latitude if sub and sub.latitude is not None else issue.latitude)
        lng = (sub.longitude if sub and sub.longitude is not None else issue.longitude)
        rows.append(
            {
                "issue_id": issue.id,
                "ticket_code": f"TN {issue.id:05d}",
                "is_parent": issue.id == parent_issue.id,
                "subscriber_code": sub.subscriber_code if sub else None,
                "subscriber_name": sub.full_name if sub else None,
                "address": (sub.address if sub and sub.address else issue.address),
                "contact_number": sub.contact_number if sub else None,
                "port_number": port,
                "nap_label": f"{row_nap.nap_code} — {row_nap.name}" if row_nap else None,
                "priority": issue.priority,
                "priority_label": prio_label,
                "assisted_by": extras["technicians"],
                "description": clean_desc or None,
                "assigned_tech": (
                    assignment.technician.full_name
                    if assignment is not None and assignment.technician else None
                ),
                "proof_photo": proof,
                "status": issue.status,
                "status_label": issue.status.replace("_", " ").title(),
                "reported_label": issue.created_at.strftime("%b %d, %H:%M") if issue.created_at else "",
                "lat": float(lat) if lat is not None else None,
                "lng": float(lng) if lng is not None else None,
            }
        )

    # Suggested visit order: nearest-neighbour from the NAP (the fault
    # is usually there, so the tech starts at the NAP and works outward).
    located = [r for r in rows if r["lat"] is not None]
    unlocated = [r for r in rows if r["lat"] is None]
    ordered = []
    if located:
        cur = (float(nap.latitude), float(nap.longitude)) if nap else (located[0]["lat"], located[0]["lng"])
        remaining = list(located)
        while remaining:
            nxt = min(remaining, key=lambda r: _haversine_km(cur[0], cur[1], r["lat"], r["lng"]))
            remaining.remove(nxt)
            ordered.append(nxt)
            cur = (nxt["lat"], nxt["lng"])
    ordered += unlocated
    for i, r in enumerate(ordered, start=1):
        r["stop"] = i

    route_pts = [r for r in ordered if r["lat"] is not None]
    route_url = None
    if route_pts:
        # Google Maps URLs allow at most 9 waypoints + 1 destination.
        pts = route_pts[:10]
        dest = pts[-1]
        wp = "|".join(f"{r['lat']},{r['lng']}" for r in pts[:-1])
        route_url = (
            "https://www.google.com/maps/dir/?api=1&travelmode=driving"
            f"&destination={dest['lat']},{dest['lng']}" + (f"&waypoints={wp}" if wp else "")
        )

    open_count = sum(1 for r in ordered if r["status"] in OPEN_ISSUE_STATUSES)
    # Resolved/closed locations need no (more) proof; every open one does.
    missing_proofs = sum(
        1 for r in ordered if r["status"] in OPEN_ISSUE_STATUSES and not r["proof_photo"]
    )
    return {
        "missing_proofs": missing_proofs,
        "proofs_done": sum(1 for r in ordered if r["proof_photo"]),
        "parent_id": parent_issue.id,
        "issue_type": parent_issue.issue_type,
        "total": len(ordered),
        "open_count": open_count,
        "locations": ordered,
        "route_url": route_url,
        "route_truncated": len(route_pts) > 10,
        "nap": (
            {
                "label": f"{nap.nap_code} — {nap.name}",
                "lat": float(nap.latitude),
                "lng": float(nap.longitude),
            }
            if nap and nap.latitude is not None
            else None
        ),
    }


def other_in_progress_assignment(technician, assignment=None):
    """The technician's own in-progress assignment other than `assignment`,
    or None. A technician may only work one ticket at a time: starting a
    second one is refused while this returns something."""
    if technician is None:
        return None
    query = Assignment.query.filter(
        Assignment.technician_id == technician.id,
        Assignment.status == "in_progress",
    )
    if assignment is not None and assignment.id is not None:
        query = query.filter(Assignment.id != assignment.id)
    return query.order_by(Assignment.assigned_at.asc(), Assignment.id.asc()).first()


def assignment_ticket_label(assignment):
    """Short ticket code for messages (ISS-0002 / SO-0007)."""
    if assignment is None:
        return ""
    issue = assignment.technical_issue
    if issue is not None:
        return issue.issue_code or f"ISS-{issue.id:04d}"
    if assignment.service_request_id is not None:
        return f"SO-{assignment.service_request_id:04d}"
    return f"Job #{assignment.id}"


def sync_team_assignments(assignment, new_status):
    """Team jobs create one Assignment per team member (see
    recommendation.auto_assign_recommended_technician()). When one member
    accepts/starts the job, move every teammate's still-waiting copy to the
    same status so it is reflected in all their accounts (and the teammates
    show as busy once the work is in progress). Call before commit."""
    if assignment.technical_issue_id is not None:
        same_job = Assignment.technical_issue_id == assignment.technical_issue_id
    else:
        same_job = Assignment.service_request_id == assignment.service_request_id
    waiting = ("assigned",) if new_status == "accepted" else ("assigned", "accepted")
    for sibling in Assignment.query.filter(
        same_job, Assignment.id != assignment.id, Assignment.status.in_(waiting)
    ).all():
        sibling.status = new_status
        if new_status == "in_progress" and sibling.technician is not None:
            sibling.technician.status = "busy"
