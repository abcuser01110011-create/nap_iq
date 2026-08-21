"""
Navigation Data Contract (Phase 23, 10%)
------------------------------------------
Read-only JSON shaping helpers for the "route line" feature ported
from the napV4-route-line prototype's `src/types/index.ts` +
`src/store/NavigationStore.tsx`.

This module intentionally contains **no Flask routes, no new
SQLAlchemy models, and no database writes**. It exists purely to give
every later phase (and the eventual `nav-route.js`) one shared,
documented JSON shape to build against, instead of each call site
inventing its own dict layout ad hoc.

Every function here takes an existing NAP-IQ model instance (already
fetched by an existing, RBAC-scoped query elsewhere) and returns a
plain JSON-serializable dict. Nothing in this module queries the
database itself — callers own their own queries/scoping, exactly like
app/routes/api.py already does for /api/naps, /api/issues, and
/api/subscribers.

See PHASE23_10_PERCENT_NOTES.md for the full contract writeup, the
prototype -> NAP-IQ field mapping, and open questions.
"""

# ---------------------------------------------------------------------------
# Enums (prototype: NavigationRouteStatus / NavigationMode /
# NavigationOriginMode / DemoTravelStatus / DeviceLocationStatus).
# Kept as plain string tuples (not db.Enum) because none of these are
# ever persisted — they only ever travel client-side, in JSON
# responses or in nav-route.js's own module-scope state object.
# ---------------------------------------------------------------------------

NAVIGATION_ROUTE_STATUSES = ("idle", "loading", "ready", "error")
NAVIGATION_MODES = ("demo", "device")
NAVIGATION_ORIGIN_MODES = ("manual", "device")
DEMO_TRAVEL_STATUSES = ("idle", "running", "paused", "complete")
DEVICE_LOCATION_STATUSES = ("idle", "requesting", "tracking", "error")

# Prototype: NavigationDestinationType ('subscriber' | 'nap' | 'complaint').
# NAP-IQ's equivalent of the prototype's "complaint" is a TechnicalIssue.
NAVIGATION_DESTINATION_TYPES = ("subscriber", "nap", "issue")


def latlng_json(latitude, longitude):
    """Prototype: `LatLng { lat, lng }`.

    Accepts Decimal (as SQLAlchemy returns for db.Numeric columns),
    float, or None. Returns None if either coordinate is missing, so
    callers can filter out unplottable records the same way
    /api/naps and /api/issues already do.
    """
    if latitude is None or longitude is None:
        return None
    return {"lat": float(latitude), "lng": float(longitude)}


def destination_json(dest_type, entity_id, label, subtitle, latitude, longitude, issue_id=None):
    """Prototype: `NavigationDestination { id, type, label, subtitle,
    position, complaintId? }`.

    `entity_id` is prefixed with `dest_type` in the returned `id` so a
    destination picker can tell a subscriber #12 apart from a NAP #12
    without a second lookup (the prototype's own ids were opaque
    strings for the same reason). `issue_id` mirrors the prototype's
    optional `complaintId` — NAP-IQ's TechnicalIssue is the equivalent
    of the prototype's Complaint (see PHASE23_5_PERCENT_NOTES.md §3).
    """
    position = latlng_json(latitude, longitude)
    if position is None:
        return None
    data = {
        "id": f"{dest_type}-{entity_id}",
        "type": dest_type,
        "label": label,
        "subtitle": subtitle or "",
        "position": position,
    }
    if issue_id is not None:
        data["issueId"] = issue_id
    return data


def destination_from_subscriber(subscriber):
    """Builds a NavigationDestination from an existing Subscriber row."""
    return destination_json(
        dest_type="subscriber",
        entity_id=subscriber.id,
        label=subscriber.full_name,
        subtitle=subscriber.subscriber_code,
        latitude=subscriber.latitude,
        longitude=subscriber.longitude,
    )


def destination_from_nap(nap):
    """Builds a NavigationDestination from an existing Nap row."""
    return destination_json(
        dest_type="nap",
        entity_id=nap.id,
        label=nap.name,
        subtitle=nap.nap_code,
        latitude=nap.latitude,
        longitude=nap.longitude,
    )


def destination_from_issue(issue):
    """Builds a NavigationDestination from an existing TechnicalIssue
    row — NAP-IQ's equivalent of the prototype's Complaint-derived
    destination. `subtitle` prefers the linked subscriber's name (the
    same "who this job is for" context the prototype showed), falling
    back to the issue's own address.
    """
    subtitle = issue.address or ""
    if issue.subscriber is not None:
        subtitle = issue.subscriber.full_name
    return destination_json(
        dest_type="issue",
        entity_id=issue.id,
        label=issue.issue_code or f"Issue #{issue.id}",
        subtitle=subtitle,
        latitude=issue.latitude,
        longitude=issue.longitude,
        issue_id=issue.id,
    )


def origin_json(origin_id, label, subtitle, latitude, longitude):
    """Prototype: `NavigationOrigin { id, label, subtitle, position }`.

    Used for both a "manual" origin (a mapped subscriber/NAP address,
    or a technician's own last-known position) and a "device" origin
    (the browser's live GPS reading, built client-side by nav-route.js
    — this helper is for the server-rendered/manual cases only).
    """
    position = latlng_json(latitude, longitude)
    if position is None:
        return None
    return {
        "id": origin_id,
        "label": label,
        "subtitle": subtitle or "",
        "position": position,
    }


def origin_from_technician(technician):
    """Builds a NavigationOrigin from a Technician's
    `current_latitude`/`current_longitude` — the DB-backed fallback
    starting point for a route, matching PHASE23_5_PERCENT_NOTES.md's
    conclusion that no new column is needed for this. Returns None if
    the technician has no known position yet (nothing keeps this pair
    live today — see that file's §8 limitations).
    """
    return origin_json(
        origin_id=f"technician-{technician.id}",
        label=technician.full_name,
        subtitle="Last known technician location",
        latitude=technician.current_latitude,
        longitude=technician.current_longitude,
    )


def route_json(points, distance_meters, duration_seconds):
    """Prototype: `NavigationRoute { points, distanceMeters,
    durationSeconds }`.

    `points` must already be a list of `{lat, lng}` dicts (e.g. built
    from an OSRM `geometry.coordinates` response client-side, exactly
    as the prototype does — this is never computed or stored
    server-side; see PHASE23_5_PERCENT_NOTES.md §8). This helper only
    exists so a future server-side stub/proxy endpoint, if one is ever
    added, returns the same shape nav-route.js already expects.
    """
    return {
        "points": points,
        "distanceMeters": distance_meters,
        "durationSeconds": duration_seconds,
    }


def technician_location_json(technician):
    """Read-only JSON representation of a technician's current
    position, for the new `GET /api/technicians/<id>/location`
    endpoint (see app/routes/api.py). Combines the plain lat/lng (for
    callers that just want the raw numbers) with the same
    NavigationOrigin shape `origin_from_technician` produces (for
    callers building a navigation origin directly from the response).
    """
    position = latlng_json(technician.current_latitude, technician.current_longitude)
    return {
        "technician_id": technician.id,
        "full_name": technician.full_name,
        "status": technician.status,
        "position": position,
        "origin": origin_from_technician(technician) if position else None,
    }
