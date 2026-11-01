"""
Administrator Reports Blueprint — Phase 13 (original 2 reports),
Phase 20 (+1 report), Phase 23 (phase_12.pdf: the remaining 4 reports
phase_12.pdf names, plus per-report filtering)
------------------------------------------------------------------------
phase_12.pdf asks for seven reports, each filterable by whichever of
(Date, Status, Type, NAP, Technician) actually applies to it. This
module now provides all seven, organized as tabs on one page
(`?report=<key>` selects the active tab) rather than seven separate
pages, since they're all read-only, all Administrator-only, and a
tabbed layout keeps the sidebar's single "Reports" link meaningful
instead of needing seven new sidebar entries — same "review the whole
system for a consistent sidebar" instruction phase_12.pdf's own UI/UX
section asks for, applied here rather than contradicted by adding six
more top-level nav items for what's still conceptually one page.

Only the ACTIVE tab's data is queried per request (not all seven every
time, the way the original two-report page queried both unconditionally)
— switching tabs is a normal GET with its own query string, so this is
both simpler and cheaper than computing seven reports' worth of queries
on every page load.

Report keys (the `report=` query value, also each tab's id):
    overview     — Reports & Analytics dashboard: KPI cards, subscriber
                    growth, issue overview, NAP utilization and recent
                    activity for a selectable range (`?range=7|30|90|365`).
                    This is the default tab.
    issues       — Technical Issue Report (Phase 13, extended)
    nap_inventory — NAP Inventory Report (Phase 23, new)
    port_availability — NAP Port Availability Report (Phase 13's
                    original "NAP Utilization", renamed to match
                    phase_12.pdf's own wording; behavior unchanged)
    subscribers  — Subscriber Report (Phase 23, new)
    service_requests — Service Request Report (Phase 23, new)
    payments     — Payment Report (Phase 23, new)
    technicians  — Technician Workload Report (Phase 20, extended
                    with a technician filter)

Every report's own filter form only ever submits `report=<its key>`
plus that report's own filter fields — no cross-tab query-string
collisions, and switching tabs never carries a stale filter from a
different report along with it.

This module intentionally does no writing to the database — it is a
read-only reporting surface, same as app/routes/dashboard.py.

Routes:
    GET /reports/ -> index   (the only route this module has ever needed)
"""

from datetime import datetime, timedelta, date

from flask import Blueprint, render_template, request, flash

from app.extensions import db
from app.auth import role_required
from app.models import (
    Nap,
    TechnicalIssue,
    Technician,
    Assignment,
    Subscriber,
    ServiceRequest,
    Payment,
)

reports_bp = Blueprint("reports", __name__, url_prefix="/reports")

REPORT_KEYS = (
    "overview",
    "issues",
    "nap_inventory",
    "port_availability",
    "subscribers",
    "service_requests",
    "payments",
    "technicians",
)

# Same fixed display order dashboard.py uses, so pages that share a
# status vocabulary don't disagree about what order it renders in.
ISSUE_STATUS_ORDER = ["pending", "assigned", "in_progress", "resolved", "closed"]
ISSUE_PRIORITY_ORDER = ["critical", "high", "medium", "low"]
NAP_STATUS_ORDER = ["active", "inactive", "full", "maintenance"]
SUBSCRIBER_STATUS_ORDER = ["active", "inactive", "disconnected"]
SERVICE_REQUEST_STATUS_ORDER = ["pending", "approved", "scheduled", "completed", "rejected"]
SERVICE_REQUEST_TYPE_ORDER = ["new_installation", "disconnection", "relocation", "upgrade", "add_nap"]
PAYMENT_STATUS_ORDER = ["pending", "confirmed", "overdue", "voided"]
PAYMENT_METHOD_ORDER = ["cash", "gcash", "bank_transfer", "other"]

# Phase 20: kept in sync by hand with technician.py's own
# OPEN_ASSIGNMENT_STATUSES — same reasoning as every other module that
# duplicates this tuple rather than sharing a constants module.
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")

# A NAP at or above this percentage of its ports used is flagged in
# the Port Availability report's "Near Capacity" callout, in addition
# to any NAP an administrator has already manually marked 'full'
# (always flagged regardless of the exact port count, since that
# status was a deliberate human call, not just a derived number).
NEAR_CAPACITY_THRESHOLD_PCT = 90


# -----------------------------------------------------------------------
# OVERVIEW (Reports & Analytics dashboard) — read-only aggregates for the
# default tab. Everything is computed in Python from a handful of simple
# queries so it stays portable between SQLite (tests) and Postgres/MySQL.
# -----------------------------------------------------------------------
OVERVIEW_RANGES = {7: "Last 7 Days", 30: "Last 30 Days", 90: "Last 90 Days", 365: "Last 12 Months"}
OPEN_ISSUE_STATUSES = ("pending", "assigned", "in_progress")
OVERVIEW_BUCKETS = 8

# Share of a NAP's ports in use that puts it in each utilization class.
NAP_HEALTHY_BELOW_PCT = 60
NAP_LOW_PORTS_BELOW_PCT = 80


def _pct_change(current, previous):
    """Percent change vs the previous period, rounded to 1 decimal, or
    None when there is no previous-period value to compare against."""
    if not previous:
        return None
    return round((current - previous) / previous * 100, 1)


def _bucket_index(moment, start, step_seconds, buckets):
    idx = int((moment - start).total_seconds() // step_seconds)
    return max(0, min(buckets - 1, idx))


def _time_ago(moment, now):
    seconds = max(0, int((now - moment).total_seconds()))
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    if seconds < 86400 * 30:
        return f"{seconds // 86400}d ago"
    return moment.strftime("%b %d, %Y")


def _build_overview_report():
    try:
        range_days = int(request.args.get("range", 30))
    except (TypeError, ValueError):
        range_days = 30
    if range_days not in OVERVIEW_RANGES:
        range_days = 30

    now = datetime.utcnow()
    start = now - timedelta(days=range_days)
    prev_start = start - timedelta(days=range_days)
    step = (now - start).total_seconds() / OVERVIEW_BUCKETS
    label_fmt = "%b %d" if range_days < 365 else "%b %Y"

    # ---- Subscribers -------------------------------------------------
    installed = [row[0] for row in db.session.query(Subscriber.installed_at).all()]
    total_subscribers = len(installed)
    undated = sum(1 for d in installed if d is None)
    dated = sorted(d for d in installed if d is not None)

    def subscribers_as_of(moment):
        cutoff = moment.date()
        return undated + sum(1 for d in dated if d <= cutoff)

    growth_points = []
    for i in range(OVERVIEW_BUCKETS + 1):
        moment = start + timedelta(seconds=step * i)
        growth_points.append({"label": moment.strftime(label_fmt), "value": subscribers_as_of(moment)})
    subscribers_at_start = growth_points[0]["value"]
    subscriber_growth_pct = _pct_change(total_subscribers, subscribers_at_start)
    subscriber_spark = [p["value"] for p in growth_points]

    # ---- Issues ------------------------------------------------------
    issue_rows = db.session.query(
        TechnicalIssue.status, TechnicalIssue.created_at
    ).filter(TechnicalIssue.created_at >= prev_start).all()
    open_issues = TechnicalIssue.query.filter(
        TechnicalIssue.status.in_(OPEN_ISSUE_STATUSES)
    ).count()

    issues_now = [r for r in issue_rows if r.created_at >= start]
    issues_prev_count = len(issue_rows) - len(issues_now)
    issue_spark = [0] * OVERVIEW_BUCKETS
    for r in issues_now:
        issue_spark[_bucket_index(r.created_at, start, step, OVERVIEW_BUCKETS)] += 1
    issues_change_pct = _pct_change(len(issues_now), issues_prev_count)

    resolved_n = sum(1 for r in issues_now if r.status in ("resolved", "closed"))
    progress_n = sum(1 for r in issues_now if r.status in ("assigned", "in_progress"))
    pending_n = sum(1 for r in issues_now if r.status == "pending")
    issues_total = len(issues_now)

    def share(n):
        return round(n / issues_total * 100, 1) if issues_total else 0

    issue_breakdown = [
        {"key": "resolved", "label": "Resolved", "count": resolved_n, "pct": share(resolved_n)},
        {"key": "progress", "label": "In Progress", "count": progress_n, "pct": share(progress_n)},
        {"key": "open", "label": "Open", "count": pending_n, "pct": share(pending_n)},
    ]

    # ---- Collections -------------------------------------------------
    pay_rows = db.session.query(Payment.payment_date, Payment.amount).filter(
        Payment.status == "confirmed", Payment.payment_date >= prev_start.date()
    ).all()
    collections_now = 0.0
    collections_prev = 0.0
    collections_spark = [0.0] * OVERVIEW_BUCKETS
    for pay_date, amount in pay_rows:
        moment = datetime.combine(pay_date, datetime.min.time())
        if moment >= datetime.combine(start.date(), datetime.min.time()):
            collections_now += float(amount)
            collections_spark[_bucket_index(moment, start, step, OVERVIEW_BUCKETS)] += float(amount)
        else:
            collections_prev += float(amount)
    collections_change_pct = _pct_change(collections_now, collections_prev)

    # ---- NAP ports / utilization ------------------------------------
    naps = Nap.query.all()
    usable = [n for n in naps if n.status != "inactive"]
    available_ports = sum(n.available_ports or 0 for n in usable if n.status != "maintenance")
    ports_total = sum(n.total_ports or 0 for n in usable)
    ports_used = sum(n.used_ports or 0 for n in usable)
    capacity_pct = round(ports_used / ports_total * 100) if ports_total else 0

    classes = {"healthy": 0, "low": 0, "high": 0, "full": 0}
    for n in usable:
        pct = (n.used_ports / n.total_ports * 100) if n.total_ports else 0
        if n.status == "full" or pct >= 100:
            classes["full"] += 1
        elif pct >= NAP_LOW_PORTS_BELOW_PCT:
            classes["high"] += 1
        elif pct >= NAP_HEALTHY_BELOW_PCT:
            classes["low"] += 1
        else:
            classes["healthy"] += 1
    nap_total = len(usable)
    nap_classes = [
        {"key": "healthy", "label": "Healthy", "count": classes["healthy"]},
        {"key": "low", "label": "Low Ports", "count": classes["low"]},
        {"key": "high", "label": "High Usage", "count": classes["high"]},
        {"key": "full", "label": "Full", "count": classes["full"]},
    ]
    for c in nap_classes:
        c["pct"] = round(c["count"] / nap_total * 100) if nap_total else 0

    # ---- Recent activity --------------------------------------------
    events = []
    for issue in TechnicalIssue.query.order_by(TechnicalIssue.created_at.desc()).limit(5).all():
        events.append({
            "when": issue.created_at,
            "kind": "New Ticket",
            "text": f"{issue.issue_code or '#' + str(issue.id)} - {str(issue.issue_type).replace('_', ' ').title()}",
            "sub": f"Status: {str(issue.status).replace('_', ' ').title()}",
        })
    for pay in Payment.query.order_by(Payment.created_at.desc()).limit(5).all():
        code = pay.subscriber.subscriber_code if pay.subscriber else ""
        events.append({
            "when": pay.created_at,
            "kind": "Payment " + ("Received" if pay.status == "confirmed" else pay.status.title()),
            "text": f"\u20b1{float(pay.amount):,.2f}" + (f" \u2013 {code}" if code else ""),
            "sub": "",
        })
    for sr in ServiceRequest.query.order_by(ServiceRequest.created_at.desc()).limit(5).all():
        events.append({
            "when": sr.created_at,
            "kind": "Service Request",
            "text": ("Nap Installation" if sr.request_type == "add_nap" else str(sr.request_type).replace("_", " ").title()),
            "sub": f"Status: {str(sr.status).title()}",
        })
    events.sort(key=lambda e: e["when"], reverse=True)
    recent_activity = [dict(e, ago=_time_ago(e["when"], now)) for e in events[:5]]

    chart_data = {
        "growth": growth_points,
        "sparks": {
            "subscribers": subscriber_spark,
            "issues": issue_spark,
            "collections": [round(v, 2) for v in collections_spark],
        },
        "issues": issue_breakdown,
        "issues_total": issues_total,
        "nap_capacity_pct": capacity_pct,
        "nap_classes": nap_classes,
        "export": {
            "range": OVERVIEW_RANGES[range_days],
            "kpis": [
                ["Total Subscribers", total_subscribers],
                ["Open Issues", open_issues],
                ["Collections (confirmed, " + OVERVIEW_RANGES[range_days] + ")", round(collections_now, 2)],
                ["Available NAP Ports", available_ports],
                ["NAP Capacity Used %", capacity_pct],
            ],
        },
    }

    return {
        "range_days": range_days,
        "range_options": OVERVIEW_RANGES,
        "total_subscribers": total_subscribers,
        "subscriber_growth_pct": subscriber_growth_pct,
        "open_issues": open_issues,
        "issues_change_pct": issues_change_pct,
        "collections_now": collections_now,
        "collections_change_pct": collections_change_pct,
        "available_ports": available_ports,
        "capacity_pct": capacity_pct,
        "issue_breakdown": issue_breakdown,
        "issues_total": issues_total,
        "nap_classes": nap_classes,
        "recent_activity": recent_activity,
        "chart_data": chart_data,
    }


def _parse_date_range(prefix):
    """Parses `?{prefix}_start=` / `?{prefix}_end=` (YYYY-MM-DD) query
    params for one report's date filter. Returns a 5-tuple: (start,
    end_exclusive, start_raw, end_raw, error). `end_exclusive` is the
    end date plus one day so filtering a DateTime/Date column with `<`
    includes the entire end day rather than stopping at its midnight
    instant. Bad input (unparsable date, or a start on or after the
    end) is reported back via `error` and both bounds are dropped, so
    a malformed query string degrades to "no filter" instead of a 500.
    Namespaced by `prefix` so two different reports' date filters on
    one page never collide in the query string.
    """
    start_raw = request.args.get(f"{prefix}_start", "").strip()
    end_raw = request.args.get(f"{prefix}_end", "").strip()

    start = None
    end_exclusive = None
    error = None

    try:
        if start_raw:
            start = datetime.strptime(start_raw, "%Y-%m-%d")
        if end_raw:
            end_exclusive = datetime.strptime(end_raw, "%Y-%m-%d") + timedelta(days=1)
    except ValueError:
        error = "Invalid date — please use the date picker or YYYY-MM-DD format."
        start, end_exclusive = None, None
        start_raw, end_raw = "", ""

    if start and end_exclusive and start >= end_exclusive:
        error = "Start date must be before end date."
        start, end_exclusive = None, None

    return start, end_exclusive, start_raw, end_raw, error


def _nap_choices():
    """Shared `(id, "CODE — Name")` NAP dropdown source for every
    report below that filters by NAP, so the wording is identical
    everywhere it appears."""
    return [(n.id, f"{n.nap_code} — {n.name}") for n in Nap.query.order_by(Nap.nap_code).all()]


def _technician_choices():
    """Shared technician dropdown source for the Issues and
    Technician Workload reports' technician filters."""
    return [
        (t.id, t.full_name) for t in Technician.query.order_by(Technician.full_name).all()
    ]


# -----------------------------------------------------------------------
# REPORT 1: TECHNICAL ISSUE REPORT (Phase 13, extended in Phase 23 with
# type/NAP/technician filters — the date+status filtering already existed)
# -----------------------------------------------------------------------
def _build_issues_report():
    start, end_exclusive, start_date, end_date, date_error = _parse_date_range("iss")
    if date_error:
        flash(date_error, "warning")

    status_filter = request.args.get("iss_status", "").strip()
    type_filter = request.args.get("iss_type", "").strip()
    nap_filter = request.args.get("iss_nap", type=int)
    technician_filter = request.args.get("iss_technician", type=int)

    query = TechnicalIssue.query
    if start:
        query = query.filter(TechnicalIssue.created_at >= start)
    if end_exclusive:
        query = query.filter(TechnicalIssue.created_at < end_exclusive)
    if status_filter:
        query = query.filter(TechnicalIssue.status == status_filter)
    if type_filter:
        query = query.filter(TechnicalIssue.issue_type == type_filter)
    if nap_filter:
        query = query.filter(TechnicalIssue.nap_id == nap_filter)
    if technician_filter:
        # Any assignment (past or present) tying this issue to the
        # selected technician — not just the current open one — so
        # the filter also surfaces issues a technician has since been
        # reassigned off of, matching what "issues this technician has
        # touched" means for a report rather than a live dispatch view.
        issue_ids = (
            db.session.query(Assignment.technical_issue_id)
            .filter(Assignment.technician_id == technician_filter)
            .subquery()
        )
        query = query.filter(TechnicalIssue.id.in_(issue_ids))

    issues = query.order_by(TechnicalIssue.created_at.desc()).all()
    total_issues_in_range = len(issues)

    status_counts = {}
    priority_counts = {}
    for issue in issues:
        status_counts[issue.status] = status_counts.get(issue.status, 0) + 1
        priority_counts[issue.priority] = priority_counts.get(issue.priority, 0) + 1

    issue_status_summary = [
        {
            "status": status,
            "count": status_counts.get(status, 0),
            "pct": round(status_counts.get(status, 0) / total_issues_in_range * 100)
            if total_issues_in_range
            else 0,
        }
        for status in ISSUE_STATUS_ORDER
    ]
    issue_priority_summary = [
        {
            "priority": priority,
            "count": priority_counts.get(priority, 0),
            "pct": round(priority_counts.get(priority, 0) / total_issues_in_range * 100)
            if total_issues_in_range
            else 0,
        }
        for priority in ISSUE_PRIORITY_ORDER
    ]

    issue_types = [
        row[0]
        for row in db.session.query(TechnicalIssue.issue_type).distinct().order_by(TechnicalIssue.issue_type).all()
    ]

    return {
        "iss_start_date": start_date,
        "iss_end_date": end_date,
        "iss_status_filter": status_filter,
        "iss_type_filter": type_filter,
        "iss_nap_filter": nap_filter,
        "iss_technician_filter": technician_filter,
        "issue_types": issue_types,
        "issue_nap_choices": _nap_choices(),
        "issue_technician_choices": _technician_choices(),
        "total_issues_in_range": total_issues_in_range,
        "issues_rows": issues,
        "issue_status_summary": issue_status_summary,
        "issue_priority_summary": issue_priority_summary,
        "issue_status_order": ISSUE_STATUS_ORDER,
    }


# -----------------------------------------------------------------------
# REPORT 2: NAP INVENTORY REPORT (Phase 23, new) — a full listing of
# every NAP, distinct from the Port Availability report below (that one
# is about capacity/utilization; this one is "what NAPs exist, where,
# and in what state" — the two things phase_12.pdf names separately).
# -----------------------------------------------------------------------
def _build_nap_inventory_report():
    status_filter = request.args.get("inv_status", "").strip()

    query = Nap.query
    if status_filter:
        query = query.filter(Nap.status == status_filter)

    naps = query.order_by(Nap.nap_code.asc()).all()

    status_counts = {}
    for nap in naps:
        status_counts[nap.status] = status_counts.get(nap.status, 0) + 1

    return {
        "inv_status_filter": status_filter,
        "inventory_naps": naps,
        "inventory_status_counts": status_counts,
        "nap_status_order": NAP_STATUS_ORDER,
    }


# -----------------------------------------------------------------------
# REPORT 3: NAP PORT AVAILABILITY REPORT (Phase 13's "NAP Utilization",
# renamed and given a status filter in Phase 23 — logic unchanged)
# -----------------------------------------------------------------------
def _build_port_availability_report():
    status_filter = request.args.get("port_status", "").strip()

    query = Nap.query
    if status_filter:
        query = query.filter(Nap.status == status_filter)

    naps = query.order_by(Nap.nap_code.asc()).all()

    nap_utilization = []
    for nap in naps:
        pct = round((nap.used_ports / nap.total_ports) * 100, 1) if nap.total_ports else 0
        nap_utilization.append(
            {
                "id": nap.id,
                "nap_code": nap.nap_code,
                "name": nap.name,
                "status": nap.status,
                "used_ports": nap.used_ports,
                "total_ports": nap.total_ports,
                "available_ports": nap.available_ports,
                "pct": pct,
            }
        )
    # Worst-utilized (closest to full) first, so the list an
    # administrator most needs to act on is right at the top.
    nap_utilization.sort(key=lambda row: row["pct"], reverse=True)

    near_capacity = [
        row
        for row in nap_utilization
        if row["pct"] >= NEAR_CAPACITY_THRESHOLD_PCT or row["status"] == "full"
    ]

    total_ports = sum(row["total_ports"] for row in nap_utilization)
    total_used_ports = sum(row["used_ports"] for row in nap_utilization)
    overall_utilization_pct = (
        round((total_used_ports / total_ports) * 100, 1) if total_ports else 0
    )

    return {
        "port_status_filter": status_filter,
        "nap_utilization": nap_utilization,
        "near_capacity": near_capacity,
        "near_capacity_threshold": NEAR_CAPACITY_THRESHOLD_PCT,
        "total_naps": len(nap_utilization),
        "total_ports": total_ports,
        "total_used_ports": total_used_ports,
        "overall_utilization_pct": overall_utilization_pct,
        "nap_status_order": NAP_STATUS_ORDER,
    }


# -----------------------------------------------------------------------
# REPORT 4: SUBSCRIBER REPORT (Phase 23, new)
# -----------------------------------------------------------------------
def _build_subscribers_report():
    start, end_exclusive, start_date, end_date, date_error = _parse_date_range("sub")
    if date_error:
        flash(date_error, "warning")

    status_filter = request.args.get("sub_status", "").strip()
    nap_filter = request.args.get("sub_nap", type=int)

    query = Subscriber.query
    # installed_at is a Date column (not DateTime) — compare against
    # .date() bounds rather than the datetime `start`/`end_exclusive`
    # values _parse_date_range() returns, which are sized for the
    # DateTime columns every other report filters on.
    if start:
        query = query.filter(Subscriber.installed_at >= start.date())
    if end_exclusive:
        query = query.filter(Subscriber.installed_at < end_exclusive.date())
    if status_filter:
        query = query.filter(Subscriber.status == status_filter)
    if nap_filter:
        query = query.filter(Subscriber.nap_id == nap_filter)

    subscribers = query.order_by(Subscriber.full_name.asc()).all()

    status_counts = {}
    for s in subscribers:
        status_counts[s.status] = status_counts.get(s.status, 0) + 1

    return {
        "sub_start_date": start_date,
        "sub_end_date": end_date,
        "sub_status_filter": status_filter,
        "sub_nap_filter": nap_filter,
        "subscriber_nap_choices": _nap_choices(),
        "subscribers_rows": subscribers,
        "subscriber_status_counts": status_counts,
        "subscriber_status_order": SUBSCRIBER_STATUS_ORDER,
        "total_subscribers": len(subscribers),
    }


# -----------------------------------------------------------------------
# REPORT 5: SERVICE REQUEST REPORT (Phase 23, new)
# -----------------------------------------------------------------------
def _build_service_requests_report():
    start, end_exclusive, start_date, end_date, date_error = _parse_date_range("sr")
    if date_error:
        flash(date_error, "warning")

    status_filter = request.args.get("sr_status", "").strip()
    type_filter = request.args.get("sr_type", "").strip()
    nap_filter = request.args.get("sr_nap", type=int)

    query = ServiceRequest.query
    if start:
        query = query.filter(ServiceRequest.created_at >= start)
    if end_exclusive:
        query = query.filter(ServiceRequest.created_at < end_exclusive)
    if status_filter:
        query = query.filter(ServiceRequest.status == status_filter)
    if type_filter:
        query = query.filter(ServiceRequest.request_type == type_filter)
    if nap_filter:
        query = query.filter(ServiceRequest.requested_nap_id == nap_filter)

    requests_ = query.order_by(ServiceRequest.created_at.desc()).all()

    status_counts = {}
    for r in requests_:
        status_counts[r.status] = status_counts.get(r.status, 0) + 1

    return {
        "sr_start_date": start_date,
        "sr_end_date": end_date,
        "sr_status_filter": status_filter,
        "sr_type_filter": type_filter,
        "sr_nap_filter": nap_filter,
        "sr_nap_choices": _nap_choices(),
        "service_requests_rows": requests_,
        "service_request_status_counts": status_counts,
        "service_request_status_order": SERVICE_REQUEST_STATUS_ORDER,
        "service_request_type_order": SERVICE_REQUEST_TYPE_ORDER,
        "total_service_requests": len(requests_),
    }


# -----------------------------------------------------------------------
# REPORT 6: PAYMENT REPORT (Phase 23, new). "Type" here is
# `payment_method` (cash/gcash/bank_transfer/other) — this schema has
# no other per-payment "type" field, and phase_12.pdf's own filter list
# names Type generically for every report rather than defining it once,
# so each report maps it to whatever its own closest equivalent is.
# -----------------------------------------------------------------------
def _build_payments_report():
    start, end_exclusive, start_date, end_date, date_error = _parse_date_range("pay")
    if date_error:
        flash(date_error, "warning")

    status_filter = request.args.get("pay_status", "").strip()
    method_filter = request.args.get("pay_method", "").strip()

    query = Payment.query
    # payment_date is a Date column — same .date()-bound comparison
    # reasoning as the Subscriber report's installed_at filter above.
    if start:
        query = query.filter(Payment.payment_date >= start.date())
    if end_exclusive:
        query = query.filter(Payment.payment_date < end_exclusive.date())
    if status_filter:
        query = query.filter(Payment.status == status_filter)
    if method_filter:
        query = query.filter(Payment.payment_method == method_filter)

    payments = query.order_by(Payment.payment_date.desc(), Payment.created_at.desc()).all()

    status_counts = {}
    total_amount_by_status = {}
    for p in payments:
        status_counts[p.status] = status_counts.get(p.status, 0) + 1
        total_amount_by_status[p.status] = total_amount_by_status.get(p.status, 0) + float(p.amount)

    total_amount = sum(float(p.amount) for p in payments)
    confirmed_amount = total_amount_by_status.get("confirmed", 0)

    return {
        "pay_start_date": start_date,
        "pay_end_date": end_date,
        "pay_status_filter": status_filter,
        "pay_method_filter": method_filter,
        "payments_rows": payments,
        "payment_status_counts": status_counts,
        "payment_status_order": PAYMENT_STATUS_ORDER,
        "payment_method_order": PAYMENT_METHOD_ORDER,
        "total_payments": len(payments),
        "total_amount": total_amount,
        "confirmed_amount": confirmed_amount,
    }


# -----------------------------------------------------------------------
# REPORT 7: TECHNICIAN WORKLOAD REPORT (Phase 20, given a technician
# filter and a completed-work date filter in Phase 23 — the underlying
# snapshot logic is unchanged)
# -----------------------------------------------------------------------
def _build_technician_workload_report():
    start, end_exclusive, start_date, end_date, date_error = _parse_date_range("wl")
    if date_error:
        flash(date_error, "warning")

    technician_filter = request.args.get("wl_technician", type=int)

    tech_query = Technician.query
    if technician_filter:
        tech_query = tech_query.filter(Technician.id == technician_filter)
    technicians = tech_query.order_by(Technician.full_name.asc()).all()

    # One query for every open assignment rather than N+1 per
    # technician row — same approach dispatch.index()/list_issues()
    # already use.
    open_assignments = Assignment.query.filter(
        Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES)
    ).all()
    open_by_technician = {}
    for a in open_assignments:
        open_by_technician.setdefault(a.technician_id, []).append(a)

    # Average resolution time is computed here in Python (rather than
    # a SQL AVG(TIMESTAMPDIFF(...))) so this stays portable between
    # the SQLite test suite and real MySQL — see PHASE20_NOTES.md. The
    # date filter (if any) narrows this to assignments *completed*
    # within the range, so "workload in March" only counts March's
    # completed work, not all-time history.
    completed_query = Assignment.query.filter(
        Assignment.status == "completed", Assignment.completed_at.isnot(None)
    )
    if start:
        completed_query = completed_query.filter(Assignment.completed_at >= start)
    if end_exclusive:
        completed_query = completed_query.filter(Assignment.completed_at < end_exclusive)
    completed_assignments = completed_query.all()
    completed_by_technician = {}
    for a in completed_assignments:
        completed_by_technician.setdefault(a.technician_id, []).append(a)

    technician_workload = []
    for tech in technicians:
        open_for_tech = open_by_technician.get(tech.id, [])
        open_counts = {status: 0 for status in OPEN_ASSIGNMENT_STATUSES}
        for a in open_for_tech:
            open_counts[a.status] = open_counts.get(a.status, 0) + 1

        completed_for_tech = completed_by_technician.get(tech.id, [])
        if completed_for_tech:
            total_seconds = sum(
                (a.completed_at - a.assigned_at).total_seconds() for a in completed_for_tech
            )
            avg_resolution_hours = round((total_seconds / len(completed_for_tech)) / 3600, 1)
        else:
            avg_resolution_hours = None

        technician_workload.append(
            {
                "id": tech.id,
                "full_name": tech.full_name,
                "status": tech.status,
                "open_counts": open_counts,
                "total_open": len(open_for_tech),
                # Within the date range if one is set, not the
                # all-time counter on the Technician row itself —
                # see PHASE20_NOTES.md for why that counter exists
                # separately (it's incremented at completion time
                # regardless of any report's date filter).
                "completed_in_range": len(completed_for_tech),
                "resolved_issues_count": tech.resolved_issues_count or 0,
                "avg_resolution_hours": avg_resolution_hours,
            }
        )
    # Busiest (most open work) first, so the technician most likely to
    # need a rebalanced workload is right at the top.
    technician_workload.sort(key=lambda row: row["total_open"], reverse=True)

    return {
        "wl_start_date": start_date,
        "wl_end_date": end_date,
        "wl_technician_filter": technician_filter,
        "wl_technician_choices": _technician_choices(),
        "technician_workload": technician_workload,
        "open_assignment_statuses": OPEN_ASSIGNMENT_STATUSES,
    }


_REPORT_BUILDERS = {
    "overview": _build_overview_report,
    "issues": _build_issues_report,
    "nap_inventory": _build_nap_inventory_report,
    "port_availability": _build_port_availability_report,
    "subscribers": _build_subscribers_report,
    "service_requests": _build_service_requests_report,
    "payments": _build_payments_report,
    "technicians": _build_technician_workload_report,
}


@reports_bp.route("/")
@role_required("administrator")
def index():
    """Renders the tabbed Reports page. `?report=<key>` selects which
    of the reports is active (defaults to `overview`); an unknown
    key falls back to `overview` too rather than 404ing, so a stale or
    hand-edited link degrades gracefully instead of breaking."""
    active_report = request.args.get("report", "overview")
    if active_report not in REPORT_KEYS:
        active_report = "overview"

    context = _REPORT_BUILDERS[active_report]()
    context["active_report"] = active_report
    context["report_keys"] = REPORT_KEYS

    return render_template("reports/index.html", **context)
