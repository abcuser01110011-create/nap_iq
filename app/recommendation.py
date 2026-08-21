"""
Technician Recommendation Engine (Phase 21 — phase_10.pdf)
------------------------------------------------------------
Builds a ranked list of technicians for a given `technical_issue`, so
an Administrator can pick a good one on the Dispatch board without
manually cross-checking who's free, who's already busy, who's
nearby, and who's historically fast at this kind of work.

WHAT THIS IS — AND ISN'T
=========================
This is a transparent, rule-based scoring formula: fixed weights
applied to a handful of plain arithmetic factors computed straight
from the `technicians` / `assignments` / `technical_issues` tables.
There is no machine learning, no trained model, and no LLM call
anywhere in this module — per phase_10.pdf's explicit instruction,
NAP-IQ does not describe this feature as "AI" anywhere in the code,
UI copy, or docs. Every number a technician is ranked by is shown to
the Administrator on the recommendation page (see
app/routes/dispatch.py:recommend() and
app/templates/dispatch/recommend.html), and every score can be
recomputed by hand from the formula documented below.

THIS MODULE NEVER CREATES AN ASSIGNMENT
=========================================
`get_recommendations()` is read-only — it only queries and returns
Python data. Creating the actual `assignments` row (the one
irreversible step) stays exactly where it already lived before this
phase: app/routes/dispatch.py's existing `assign()` / `reassign()`
routes, which already require an Administrator to submit a real POST
form with a CSRF token. This phase's recommend() route renders a page
of ranked candidates with a plain HTML form per candidate that POSTs
to those same existing routes — nothing here bypasses that
confirmation step or writes to the database on the Administrator's
behalf. See app/routes/dispatch.py's module docstring for how the
recommended score (if any) is threaded through to
`Assignment.dispatch_score` once the Administrator actually confirms.

CANDIDATE POOL
================
`Technician.query` rows with `status == 'offline'` are excluded
entirely — an offline technician isn't working right now, so
recommending them isn't useful (this matches how `status` is already
used everywhere else in the app: PHASE9/PHASE10_NOTES.md's dispatch
workflow only ever flips a technician to 'busy'/'available' while
they're actively clocked into assignments; 'offline' is a deliberate
"not working" state a technician/administrator sets elsewhere). Both
'available' and 'busy' technicians are scored — a busy technician
close by with a light-ish load can still legitimately outscore a
distant idle one; that tradeoff is exactly what the weighted formula
below is for, rather than a hard availability filter deciding it
up front.

THE FOUR FACTORS AND THEIR SCORES (each 0-100)
=================================================
1. Availability — `technician.status`:
       available -> 100
       busy      -> 40
   (offline is excluded from the candidate pool entirely, above.)

2. Workload — count of that technician's currently-OPEN assignments
   (status in 'assigned'/'accepted'/'in_progress' — the exact same
   OPEN_ASSIGNMENT_STATUSES tuple app/routes/dispatch.py and
   app/routes/reports.py already use):
       workload_score = max(0, 100 - (open_count * 25))
   i.e. 0 open -> 100, 1 open -> 75, 2 open -> 50, 3 open -> 25,
   4+ open -> 0. A technician already juggling several open jobs
   scores low here even if they're technically 'available'.

3. Distance — great-circle distance in kilometers between the
   technician's last known location (`technicians.current_latitude`/
   `current_longitude`) and the issue's location (see
   `_issue_coordinates()` below for exactly which coordinates that
   is), via the haversine formula (see `haversine_km()`):
       distance_score = max(0, 100 - (distance_km / MAX_DISTANCE_KM) * 100)
   MAX_DISTANCE_KM = 50 -> a technician 50km+ away scores 0 here; one
   right on top of the issue scores ~100. If either location is
   unknown (technician has never logged a location, or neither the
   issue nor its NAP has coordinates), distance can't be computed —
   this factor falls back to a neutral 50 and the recommendation page
   says so explicitly rather than silently treating "unknown" as
   "close" or "far".

4. Relevant performance — ONLY computed from real history; phase_10.pdf
   is explicit that this factor should only count "if the database
   contains sufficient historical data". A technician needs at least
   MIN_COMPLETED_FOR_PERFORMANCE (3) completed assignments
   (`assignments.status = 'completed'`) before this factor is scored
   at all; below that threshold it's neutral (50) and flagged as
   "not enough history yet" rather than making up a number from one
   or two data points. When there IS enough history:
       avg_hours = mean(completed_at - assigned_at) across their
                   completed assignments, in hours
       speed_component  = max(0, 100 - (avg_hours / PERFORMANCE_CEILING_HOURS) * 100)
       volume_component = min(100, (resolved_issues_count / VOLUME_CAP) * 100)
       performance_score = (0.7 * speed_component) + (0.3 * volume_component)
   PERFORMANCE_CEILING_HOURS = 72 (a technician averaging 3+ days per
   job scores 0 on the speed half); VOLUME_CAP = 20 (20+ resolved
   issues maxes out the volume half). Speed is weighted higher than
   raw volume since a technician who resolves things quickly is more
   useful for a NEW issue than one who's simply been on the roster
   longer.

FINAL SCORE
=============
    total_score = (WEIGHT_AVAILABILITY * availability_score)
                 + (WEIGHT_WORKLOAD     * workload_score)
                 + (WEIGHT_DISTANCE     * distance_score)
                 + (WEIGHT_PERFORMANCE  * performance_score)

    WEIGHT_AVAILABILITY = 0.15
    WEIGHT_WORKLOAD      = 0.30
    WEIGHT_DISTANCE      = 0.35
    WEIGHT_PERFORMANCE   = 0.20
    (weights sum to 1.0, so total_score is always 0-100)

Distance and workload are weighted highest since they're the two
factors that most directly answer "who can actually get there and
take this on soonest" — the practical dispatch question — while
availability and performance act as secondary tie-breakers. These
weights are plain module constants (see below), not hidden anywhere,
so a future phase can retune them in one place if the client wants a
different balance.

`total_score` is rounded to 1 decimal place and fits directly in
`assignments.dispatch_score` (`DECIMAL(5,2)`, already defined in
database/schema.sql since Phase 9/10 — this phase is the first to
actually populate it).

Candidates are ranked by `total_score` descending. Ties break first
by known distance ascending (closer wins), then by full_name
ascending, so the ordering is always deterministic — never by
insertion/id order, which would silently favor whichever technician
happened to be added to the roster first.

DATABASE QUERIES
===================
Three queries total, all against tables that already existed before
this phase (no schema change needed):
  1. `Technician.query` — the full roster, then filtered in Python to
     drop 'offline' rows (see CANDIDATE POOL above). A roster is
     small (single/low-double-digit rows for this app's scale), so
     filtering in Python rather than a second WHERE clause keeps this
     module's only technician query identical to the one every other
     admin page (dispatch.py, reports.py, technicians.py) already
     runs, rather than introducing a subtly different one.
  2. One `Assignment.query` for every OPEN assignment
     (`status IN ('assigned','accepted','in_progress')`), grouped by
     `technician_id` in Python — same "one query, not N+1" approach
     app/routes/dispatch.py's `index()` and app/routes/reports.py's
     `index()` already use for the exact same open-assignment-by-
     technician grouping.
  3. One `Assignment.query` for every COMPLETED assignment
     (`status = 'completed'`), also grouped by `technician_id` in
     Python — same pattern reports.py's workload report already uses
     for its average-resolution-time figure (computed in Python
     rather than a SQL AVG(TIMESTAMPDIFF(...)) so the exact same code
     path works unchanged against both the SQLite test suite and real
     MySQL — see PHASE20_NOTES.md's reasoning for that same choice).
No new indexes or tables were needed — `assignments.technician_id`
and `assignments.status` are both already indexed by
`database/schema.sql`'s existing foreign key / enum columns.
"""

import math
from datetime import datetime

from app.models import Assignment, Technician

# Same tuple app/routes/dispatch.py and app/routes/reports.py already
# use — kept in sync by hand, same as those two already do with each
# other (see dispatch.py's own comment on this).
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")

# ---- Weights (sum to 1.0) ----
WEIGHT_AVAILABILITY = 0.15
WEIGHT_WORKLOAD = 0.30
WEIGHT_DISTANCE = 0.35
WEIGHT_PERFORMANCE = 0.20

# ---- Availability factor ----
AVAILABILITY_SCORES = {"available": 100, "busy": 40}

# ---- Workload factor ----
WORKLOAD_PENALTY_PER_OPEN_ASSIGNMENT = 25

# ---- Distance factor ----
MAX_DISTANCE_KM = 50.0
EARTH_RADIUS_KM = 6371.0
NEUTRAL_DISTANCE_SCORE = 50

# ---- Performance factor ----
MIN_COMPLETED_FOR_PERFORMANCE = 3
PERFORMANCE_CEILING_HOURS = 72.0
VOLUME_CAP = 20
NEUTRAL_PERFORMANCE_SCORE = 50


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance between two lat/lon points, in kilometers.

    Standard haversine formula:
        a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
        c = 2 · atan2(√a, √(1−a))
        distance = R · c        (R = Earth's mean radius, 6371 km)

    Inputs may be `int`, `float`, or SQLAlchemy's `Decimal` (that's
    what `db.Numeric` columns hand back) — all four are cast to
    `float` up front since `math` functions don't accept `Decimal`.
    Straight-line ("as the crow flies") distance, not driving/routing
    distance — there's no routing service wired into this app, and a
    straight-line distance is a reasonable, honest proxy for "who's
    nearby" given what data NAP-IQ actually has (see the module
    docstring's DISTANCE factor section for how this feeds the score).
    """
    lat1, lon1, lat2, lon2 = float(lat1), float(lon1), float(lat2), float(lon2)

    lat1_rad, lat2_rad = math.radians(lat1), math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def _issue_coordinates(issue):
    """The (lat, lon) to measure distance from for this issue, or
    `None` if no usable coordinates exist anywhere.

    Prefers the issue's own reported `latitude`/`longitude` (set when
    the issue was filed — see app/routes/issues.py). Falls back to
    the issue's linked NAP's coordinates (`naps.latitude`/
    `longitude`, always required on a NAP row) when the issue itself
    has none — a technical issue is nearly always at or very near its
    subscriber's NAP, so that's a reasonable stand-in rather than
    refusing to estimate distance at all just because the specific
    report didn't include a pin."""
    if issue.latitude is not None and issue.longitude is not None:
        return (issue.latitude, issue.longitude)
    if issue.nap is not None and issue.nap.latitude is not None and issue.nap.longitude is not None:
        return (issue.nap.latitude, issue.nap.longitude)
    return None


def _availability_score(technician):
    return AVAILABILITY_SCORES.get(technician.status, 0)


def _workload_score(open_count):
    return max(0, 100 - (open_count * WORKLOAD_PENALTY_PER_OPEN_ASSIGNMENT))


def _distance_score_and_km(technician, issue_coords):
    """Returns (distance_score, distance_km_or_None, distance_known)."""
    if issue_coords is None or technician.current_latitude is None or technician.current_longitude is None:
        return NEUTRAL_DISTANCE_SCORE, None, False

    distance_km = haversine_km(
        technician.current_latitude, technician.current_longitude,
        issue_coords[0], issue_coords[1],
    )
    score = max(0, 100 - (distance_km / MAX_DISTANCE_KM) * 100)
    return round(score, 1), round(distance_km, 2), True


def _performance_score(technician, completed_for_tech):
    """Returns (performance_score, avg_resolution_hours_or_None,
    completed_count, performance_known)."""
    completed_count = len(completed_for_tech)
    if completed_count < MIN_COMPLETED_FOR_PERFORMANCE:
        return NEUTRAL_PERFORMANCE_SCORE, None, completed_count, False

    total_hours = sum(
        (a.completed_at - a.assigned_at).total_seconds() / 3600.0
        for a in completed_for_tech
    )
    avg_hours = total_hours / completed_count

    speed_component = max(0, 100 - (avg_hours / PERFORMANCE_CEILING_HOURS) * 100)
    volume_component = min(100, ((technician.resolved_issues_count or 0) / VOLUME_CAP) * 100)
    score = (0.7 * speed_component) + (0.3 * volume_component)
    return round(score, 1), round(avg_hours, 1), completed_count, True


def _build_reason(row):
    """A short, human-readable sentence explaining the score — shown
    directly on the recommendation page next to the number, so an
    Administrator never has to take the score on faith. Names the
    1-2 factors that most helped or hurt this candidate rather than
    restating every number (the full breakdown is already in the
    table columns beside it)."""
    parts = []

    if row["technician_status"] == "available":
        parts.append("currently available")
    else:
        parts.append(f"currently busy with {row['open_assignment_count']} open job"
                      f"{'s' if row['open_assignment_count'] != 1 else ''}")

    if row["distance_known"]:
        parts.append(f"{row['distance_km']} km away")
    else:
        parts.append("distance unknown")

    if row["performance_known"]:
        parts.append(f"avg {row['avg_resolution_hours']}h to resolve past jobs")
    else:
        parts.append("not enough completed-job history yet to score performance")

    return ", ".join(parts).capitalize() + "."


def get_recommendations(issue, limit=None):
    """Returns a ranked list of recommendation dicts for `issue`,
    highest `total_score` first. Each dict contains every number
    shown on the recommendation page — nothing is hidden from the
    Administrator that fed into the ranking.

    Purely a read — does not touch the database beyond SELECTs, and
    creates nothing. See the module docstring for the full formula
    and the three queries this runs.

    `limit`: if given, only the top N rows are returned (the
    recommendation page defaults to showing everyone in the candidate
    pool, so this is mainly for callers that only want a quick top
    pick, e.g. a future phase's dashboard widget).
    """
    issue_coords = _issue_coordinates(issue)

    technicians = [t for t in Technician.query.all() if t.status != "offline"]

    open_assignments = Assignment.query.filter(
        Assignment.status.in_(OPEN_ASSIGNMENT_STATUSES)
    ).all()
    open_by_technician = {}
    for a in open_assignments:
        open_by_technician.setdefault(a.technician_id, []).append(a)

    completed_assignments = Assignment.query.filter(
        Assignment.status == "completed", Assignment.completed_at.isnot(None)
    ).all()
    completed_by_technician = {}
    for a in completed_assignments:
        completed_by_technician.setdefault(a.technician_id, []).append(a)

    rows = []
    for tech in technicians:
        open_for_tech = open_by_technician.get(tech.id, [])
        completed_for_tech = completed_by_technician.get(tech.id, [])

        availability_score = _availability_score(tech)
        workload_score = _workload_score(len(open_for_tech))
        distance_score, distance_km, distance_known = _distance_score_and_km(tech, issue_coords)
        performance_score, avg_resolution_hours, completed_count, performance_known = (
            _performance_score(tech, completed_for_tech)
        )

        total_score = round(
            (WEIGHT_AVAILABILITY * availability_score)
            + (WEIGHT_WORKLOAD * workload_score)
            + (WEIGHT_DISTANCE * distance_score)
            + (WEIGHT_PERFORMANCE * performance_score),
            1,
        )

        row = {
            "technician": tech,
            "technician_status": tech.status,
            "open_assignment_count": len(open_for_tech),
            "availability_score": availability_score,
            "workload_score": workload_score,
            "distance_km": distance_km,
            "distance_known": distance_known,
            "distance_score": distance_score,
            "completed_count": completed_count,
            "avg_resolution_hours": avg_resolution_hours,
            "performance_known": performance_known,
            "performance_score": performance_score,
            "resolved_issues_count": tech.resolved_issues_count or 0,
            "total_score": total_score,
        }
        row["reason"] = _build_reason(row)
        rows.append(row)

    def _sort_key(row):
        # Higher score first; among ties, known-shorter-distance first
        # (unknown distance sorts after every known one); then name,
        # so ordering is always deterministic (see module docstring).
        distance_key = row["distance_km"] if row["distance_known"] else float("inf")
        return (-row["total_score"], distance_key, row["technician"].full_name.lower())

    rows.sort(key=_sort_key)

    if limit is not None:
        rows = rows[:limit]

    return rows
