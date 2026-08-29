"""
Administrator Dashboard Blueprint
------------------------------------
Renders the single-page operations dashboard for administrators. Every
number and list on this page is computed live from MySQL through the
existing SQLAlchemy models — nothing here is hard-coded or mocked, so
the page always reflects whatever is currently in the database
(including an empty database, which the template renders as explicit
empty states rather than fake placeholder numbers).

Routes:
    GET /dashboard -> index   (the only route this phase adds)

This module intentionally does no writing to the database — it is a
read-only reporting surface. As of Phase 7, it is restricted to the
Administrator role via `@role_required("administrator")`.
"""

from flask import Blueprint, render_template
from sqlalchemy import case, func

from app.extensions import db
from app.auth import role_required
from app.models import (
    Nap,
    Subscriber,
    Technician,
    TechnicalIssue,
    ServiceRequest,
    Assignment,
)

dashboard_bp = Blueprint("dashboard", __name__, url_prefix="/dashboard")

# Issue statuses that count as "still open" / unresolved work for a
# technician or the ops team. Defined once here so the summary card,
# the status breakdown, and the technician workload count all agree on
# exactly the same definition of "open".
OPEN_ISSUE_STATUSES = ("pending", "assigned", "in_progress")
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")

# Fixed display order for status/priority breakdown bars, so the UI
# doesn't reshuffle itself based on whatever order MySQL happens to
# GROUP BY results in.
NAP_STATUS_ORDER = ["active", "full", "maintenance", "inactive"]

# Fixed colors for each NAP status, shared by the status-distribution
# donut and its legend on the dashboard's NAP Status Summary panel.
NAP_STATUS_COLORS = {
    "active": "#22c55e",
    "full": "#f59e0b",
    "maintenance": "#f87171",
    "inactive": "#9aa2ad",
}


@dashboard_bp.route("/")
@role_required("administrator")
def index():
    """Builds and renders the Administrator Dashboard.

    Every value passed to the template is either a scalar computed by
    a SQL aggregate (COUNT / SUM / GROUP BY) or a short list of the
    most recent ORM records — see the inline comments below for how
    each one maps to a specific query.
    """

    # ---------------------------------------------------------------
    # SUMMARY CARDS
    # ---------------------------------------------------------------

    total_naps = db.session.scalar(db.select(func.count(Nap.id))) or 0

    total_available_ports = (
        db.session.scalar(db.select(func.coalesce(func.sum(Nap.available_ports), 0))) or 0
    )

    active_subscribers = (
        db.session.scalar(
            db.select(func.count(Subscriber.id)).where(Subscriber.status == "active")
        )
        or 0
    )

    open_technical_issues = (
        db.session.scalar(
            db.select(func.count(TechnicalIssue.id)).where(
                TechnicalIssue.status.in_(OPEN_ISSUE_STATUSES)
            )
        )
        or 0
    )

    available_technicians = (
        db.session.scalar(
            db.select(func.count(Technician.id)).where(Technician.status == "available")
        )
        or 0
    )

    pending_service_requests = (
        db.session.scalar(
            db.select(func.count(ServiceRequest.id)).where(ServiceRequest.status == "pending")
        )
        or 0
    )

    summary_cards = {
        "total_naps": total_naps,
        "available_ports": total_available_ports,
        "active_subscribers": active_subscribers,
        "open_technical_issues": open_technical_issues,
        "available_technicians": available_technicians,
        "pending_service_requests": pending_service_requests,
    }

    # ---------------------------------------------------------------
    # NAP STATUS SUMMARY (+ overall port utilization)
    # ---------------------------------------------------------------

    nap_status_rows = db.session.execute(
        db.select(Nap.status, func.count(Nap.id)).group_by(Nap.status)
    ).all()
    nap_status_counts = {status: count for status, count in nap_status_rows}
    nap_status_summary = [
        {"status": status, "count": nap_status_counts.get(status, 0)}
        for status in NAP_STATUS_ORDER
    ]

    port_totals = db.session.execute(
        db.select(
            func.coalesce(func.sum(Nap.total_ports), 0),
            func.coalesce(func.sum(Nap.used_ports), 0),
        )
    ).first()
    total_ports, used_ports = port_totals if port_totals else (0, 0)
    port_utilization_pct = round((used_ports / total_ports) * 100, 1) if total_ports else 0
    ports_available = total_ports - used_ports

    # Donut-chart segments for the NAP status ring on the redesigned
    # "NAP Status Summary" panel: each status's share of the ring
    # (start/end expressed as a cumulative % of the full circle) plus
    # the color it should render in, so the template can build a
    # single CSS conic-gradient() without doing any math itself.
    cumulative_pct = 0.0
    nap_status_segments = []
    for row in nap_status_summary:
        pct = (row["count"] / total_naps * 100) if total_naps else 0
        nap_status_segments.append(
            {
                "status": row["status"],
                "count": row["count"],
                "pct": round(pct, 1),
                "color": NAP_STATUS_COLORS[row["status"]],
                "start": round(cumulative_pct, 4),
                "end": round(cumulative_pct + pct, 4),
            }
        )
        cumulative_pct += pct

    conic_stops = [
        f"{segment['color']} {segment['start']}% {segment['end']}%"
        for segment in nap_status_segments
        if segment["pct"] > 0
    ]
    nap_status_conic_gradient = ", ".join(conic_stops) if conic_stops else "#232c47 0% 100%"

    # Simple health read on overall port utilization, shown as a badge
    # next to the port-utilization gauge.
    if total_naps == 0:
        port_health_label, port_health_class = "No Data", "nap-health-neutral"
    elif port_utilization_pct >= 90:
        port_health_label, port_health_class = "Critical", "nap-health-critical"
    elif port_utilization_pct >= 75:
        port_health_label, port_health_class = "Near Full", "nap-health-warning"
    else:
        port_health_label, port_health_class = "Healthy", "nap-health-good"

    # ---------------------------------------------------------------
    # RECENT REPORTED ISSUES (latest 5)
    # ---------------------------------------------------------------

    recent_issues = (
        TechnicalIssue.query.order_by(TechnicalIssue.created_at.desc()).limit(5).all()
    )

    # ---------------------------------------------------------------
    # RECENT NAP ACTIVITY (latest 5 by last update — covers both newly
    # added NAPs and NAPs whose status/ports were recently edited)
    # ---------------------------------------------------------------

    recent_naps = Nap.query.order_by(Nap.updated_at.desc()).limit(5).all()

    # ---------------------------------------------------------------
    # TECHNICIAN WORKLOAD SUMMARY
    # ---------------------------------------------------------------
    # Active-assignment count per technician, computed with a LEFT JOIN
    # + conditional SUM so technicians with zero current assignments
    # still show up (as 0), rather than being silently dropped like a
    # plain INNER JOIN + GROUP BY would do.

    workload_rows = db.session.execute(
        db.select(
            Technician.id,
            Technician.full_name,
            Technician.status,
            Technician.resolved_issues_count,
            func.coalesce(
                func.sum(
                    case(
                        (Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES), 1),
                        else_=0,
                    )
                ),
                0,
            ).label("active_assignments"),
        )
        .select_from(Technician)
        .outerjoin(Assignment, Assignment.technician_id == Technician.id)
        .group_by(
            Technician.id,
            Technician.full_name,
            Technician.status,
            Technician.resolved_issues_count,
        )
        .order_by(Technician.full_name.asc())
    ).all()

    technician_workload = [
        {
            "id": row.id,
            "full_name": row.full_name,
            "status": row.status,
            "resolved_issues_count": row.resolved_issues_count,
            "active_assignments": int(row.active_assignments),
        }
        for row in workload_rows
    ]

    return render_template(
        "dashboard/index.html",
        summary_cards=summary_cards,
        nap_status_summary=nap_status_summary,
        nap_status_segments=nap_status_segments,
        nap_status_conic_gradient=nap_status_conic_gradient,
        total_naps=total_naps,
        total_ports=total_ports,
        used_ports=used_ports,
        ports_available=ports_available,
        port_utilization_pct=port_utilization_pct,
        port_health_label=port_health_label,
        port_health_class=port_health_class,
        recent_issues=recent_issues,
        recent_naps=recent_naps,
        technician_workload=technician_workload,
    )
