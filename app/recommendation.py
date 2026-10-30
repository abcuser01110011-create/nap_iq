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
Every `personnel_type == 'technician'` row is a candidate, including
'offline' ones, so a reported issue is never left without a technician
just because nobody is clocked in. An offline technician scores 0 on
availability and so only wins when nobody else is available or busy.
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
       offline   -> 0 (still a candidate, just ranked last)

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
     keep every row (see CANDIDATE POOL above). A roster is
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

from app.extensions import db
from app.models import Assignment, Technician
from app.notifications_utils import notify_issue_status_change

# Same tuple app/routes/dispatch.py and app/routes/reports.py already
# use — kept in sync by hand, same as those two already do with each
# other (see dispatch.py's own comment on this).
OPEN_ASSIGNMENT_STATUSES = ("assigned", "accepted", "in_progress")

# ---- Weights (sum to 1.0) ----
WEIGHT_AVAILABILITY = 0.15
WEIGHT_WORKLOAD = 0.30
WEIGHT_DISTANCE = 0.35
WEIGHT_PERFORMANCE = 0.20

# Same-NAP stickiness (a technician already working a NAP keeps new tickets
# for it) only applies while that technician is not carrying more than this
# many open jobs above the least-loaded technician. Without this cap one
# technician snowballs: every report on "their" NAP, and every "nearest"
# tie-break (their open jobs make them nearest everywhere), lands on them.
SAME_NAP_MAX_EXTRA_LOAD = 1

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
    completed_count, performance_known).

    `completed_count` (and the volume component below) is the length
    of `completed_for_tech` -- every 'completed' Assignment row for
    this technician, installation and repair alike -- not
    `technician.resolved_issues_count`. That counter is only
    incremented inside complete_assignment()'s technical_issue branch
    (app/routes/technician.py), so a technician who mostly does
    installations would otherwise look like they'd never finished
    anything. `completed_for_tech` has no such gap: it comes straight
    from `assignments.status = 'completed'`, which is set the same
    way regardless of whether the assignment is linked to a
    `technical_issue` or a `service_request`."""
    completed_count = len(completed_for_tech)
    if completed_count < MIN_COMPLETED_FOR_PERFORMANCE:
        return NEUTRAL_PERFORMANCE_SCORE, None, completed_count, False

    total_hours = sum(
        (a.completed_at - a.assigned_at).total_seconds() / 3600.0
        for a in completed_for_tech
    )
    avg_hours = total_hours / completed_count

    speed_component = max(0, 100 - (avg_hours / PERFORMANCE_CEILING_HOURS) * 100)
    volume_component = min(100, (completed_count / VOLUME_CAP) * 100)
    score = (0.7 * speed_component) + (0.3 * volume_component)
    return round(score, 1), round(avg_hours, 1), completed_count, True


def _rule_label(row, everyone_busy):
    """Short name of the dispatch rule that put this technician where they
    are in the list."""
    if row["tier"] == 0:
        return "Already working this NAP"
    if row["tier"] == 1:
        return "No open jobs"
    return "Nearest (everyone is busy)" if everyone_busy else "Busy elsewhere"


def _build_reason(row):
    """One human-readable sentence for the recommendation page."""
    parts = [row["rule_label"]]
    n = row["open_assignment_count"]
    parts.append(f"{n} open job{'s' if n != 1 else ''}")
    if row["distance_known"]:
        parts.append(f"{row['distance_km']} km away")
    else:
        parts.append("distance unknown")
    if row["technician_status"] == "offline":
        parts.append("currently offline")
    return ", ".join(parts) + "."


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

    # personnel_type == 'technician' only — that's the one with a
    # linked mobile login (see app/jwt_auth.py's MOBILE_API_ROLES and
    # app/routes/technicians.py's module docstring: role='technician'
    # is the one MOBILE_API_ROLES issues mobile tokens to; a
    # 'field_assistant' profile is web-dashboard-only). Recommending a
    # field_assistant here would let an administrator confirm a
    # dispatch that can never appear on any mobile Assignments screen.
    # Same restriction app/routes/dispatch.py's
    # _populate_technician_choices() applies to the manual dropdown
    # these recommendations are ultimately submitted through.
    # Offline technicians are deliberately NOT filtered out: an issue
    # must always end up with somebody assigned. They simply score lowest
    # on availability, so any available/busy technician still outranks them.
    technicians = Technician.query.filter_by(personnel_type="technician").all()

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

    issue_nap_id = getattr(issue, "nap_id", None)
    if issue_nap_id is None and getattr(issue, "nap", None) is not None:
        issue_nap_id = issue.nap.id

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

        # Where the technician is: their saved position and every open job
        # (installations too). Replaces the saved-position-only distance above.
        positions = _technician_positions(tech, open_for_tech)
        if issue_coords is not None and positions:
            distance_km = round(
                min(haversine_km(p[0], p[1], issue_coords[0], issue_coords[1]) for p in positions), 2
            )
            distance_known = True
        else:
            distance_km, distance_known = None, False

        # Dispatch rule tier: 0 = already has an open job on this NAP,
        # 1 = no open jobs at all, 2 = busy elsewhere.
        if issue_nap_id is not None and any(
            a.technical_issue is not None and a.technical_issue.nap_id == issue_nap_id
            for a in open_for_tech
        ):
            tier = 0
        elif not open_for_tech:
            tier = 1
        else:
            tier = 2

        total_score = round(
            (WEIGHT_AVAILABILITY * availability_score)
            + (WEIGHT_WORKLOAD * workload_score)
            + (WEIGHT_DISTANCE * distance_score)
            + (WEIGHT_PERFORMANCE * performance_score),
            1,
        )

        row = {
            "technician": tech,
            "technician_status": tech.effective_status,
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
            "tier": tier,
        }
        rows.append(row)

    # Load balancing: demote a same-NAP technician who is far more loaded
    # than the lightest-loaded technician.
    if rows:
        min_open = min(r["open_assignment_count"] for r in rows)
        for r in rows:
            if r["tier"] == 0 and r["open_assignment_count"] > min_open + SAME_NAP_MAX_EXTRA_LOAD:
                r["tier"] = 2
    everyone_busy = bool(rows) and all(r["tier"] == 2 for r in rows)
    for row in rows:
        row["rule_label"] = _rule_label(row, everyone_busy)
        row["reason"] = _build_reason(row)

    def _sort_key(row):
        # Dispatch rule, not a score: same-NAP technician first, then a
        # technician with no open jobs, then the rest; inside each group
        # the nearest first (unknown distance last), then fewest open
        # jobs, then name -- always deterministic.
        distance_key = row["distance_km"] if row["distance_known"] else float("inf")
        return (
            row["tier"],
            # busy-elsewhere group: fewest open jobs first, THEN nearest
            row["open_assignment_count"] if row["tier"] == 2 else 0,
            distance_key,
            row["open_assignment_count"],
            row["technician"].full_name.lower(),
            row["technician"].id,
        )

    rows.sort(key=_sort_key)

    if limit is not None:
        rows = rows[:limit]

    return rows


def _assignment_coordinates(assignment):
    """(lat, lon) of the job an assignment sends a technician to: the
    repair ticket's location, or -- for an installation -- the request's
    own pin, its requested NAP, or the subscriber's location/NAP."""
    job = assignment.technical_issue
    if job is not None:
        return _issue_coordinates(job)
    sr = assignment.service_request
    if sr is None:
        return None
    if sr.latitude is not None and sr.longitude is not None:
        return (sr.latitude, sr.longitude)
    nap = getattr(sr, "requested_nap", None)
    if nap is not None and nap.latitude is not None and nap.longitude is not None:
        return (nap.latitude, nap.longitude)
    sub = sr.subscriber
    if sub is not None:
        if sub.latitude is not None and sub.longitude is not None:
            return (sub.latitude, sub.longitude)
        if sub.nap is not None and sub.nap.latitude is not None and sub.nap.longitude is not None:
            return (sub.nap.latitude, sub.nap.longitude)
    return None


def _technician_positions(technician, open_assignments):
    """Every place a technician is known to be: their own saved position
    plus the location of each job they currently have open (installations
    included). Distance to a new issue is the shortest of these."""
    positions = []
    if technician.current_latitude is not None and technician.current_longitude is not None:
        positions.append((technician.current_latitude, technician.current_longitude))
    for a in open_assignments:
        coords = _assignment_coordinates(a)
        if coords is not None:
            positions.append(coords)
    return positions


def choose_technician_for_issue(issue):
    """The technician auto-dispatch gives `issue` to: the top row of
    get_recommendations(), so the automatic choice is always exactly the
    one the admin Recommend page lists first. The rule (not a score):

      1. A technician who already has an open job on the SAME NAP keeps
         it (nearest of them, if several).
      2. Otherwise a technician with NO open jobs (nearest, if several).
      3. If every technician has open jobs, the NEAREST technician.

    Offline technicians are candidates too. None when no technician
    profile exists."""
    rows = get_recommendations(issue, limit=1)
    return rows[0]["technician"] if rows else None


def auto_assign_recommended_technician(issue):
    """Auto-dispatch -- self-reported issues only.

    A `technical_issue` filed through the customer's own "Report an
    Issue" flow (web portal and mobile app) is handed straight to a
    technician chosen by `choose_technician_for_issue()` (same NAP ->
    that NAP's technician; different NAP -> a technician with no open
    job; everyone busy -> the nearest one), so it lands on that
    technician's job list without an Administrator assigning it. When
    that technician is on a team, the whole team gets the job (see below).

    Creates the same kind of `assignments` row a manual dispatch does
    (see app/routes/dispatch.py's `assign()`), with `dispatch_score`
    left NULL since no score is involved. Returns the Assignment, or
    `None` when there is no technician profile at all (the issue then
    stays 'pending' for an Administrator to dispatch by hand).

    Callers must have already committed the issue (so it has an id);
    this function commits the new assignment and status change itself.
    """
    # Teams: use the same dispatch rule as always, but hand the job to the
    # whole team of the best-ranked technician who is on one -- every member
    # gets their own Assignment, so it shows in each member's account. If no
    # ranked technician belongs to a team, fall back to the single top pick.
    rows = get_recommendations(issue)
    if not rows:
        return None

    team = None
    for row in rows:
        teams = getattr(row["technician"], "teams", None) or []
        if teams:
            team = sorted(teams, key=lambda t: t.id)[0]
            break

    if team is not None and team.members:
        recipients = sorted(
            team.members,
            key=lambda m: (m.id != team.leader_id, m.full_name.lower(), m.id),
        )
    else:
        recipients = [rows[0]["technician"]]

    assignments = []
    for member in recipients:
        a = Assignment(
            technical_issue_id=issue.id,
            technician_id=member.id,
            status="assigned",
        )
        db.session.add(a)
        assignments.append(a)
    issue.status = "assigned"
    notify_issue_status_change(issue)
    db.session.commit()

    # First assignment (the team leader's, when there is one) is returned so
    # existing callers keep working; the team name is on its technician's
    # `.teams`.
    return assignments[0]
