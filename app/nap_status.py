"""Keeps a NAP's stored `status` column honest against its actual slot
occupancy.

Background: `naps.status` (active/inactive/full/maintenance) is a
plain stored column that, until now, only ever changed when an admin
manually edited a NAP and picked a new value from the Status dropdown
(app/routes/naps.py). Nothing recalculated it when a subscriber
actually filled the last open slot, so a NAP could sit at 1/1 slots
used (100%, as shown live on the GeoMap panel -- see
`_slot_usage()` in app/routes/api.py) while its stored status stayed
"active" -- which is what the Dashboard's Status Distribution reads,
so a genuinely full NAP would never show up in the "Full" bucket
there, in NAP Management's status badges, or in Reports.

`sync_nap_status()` is the single place that recomputes "active" vs.
"full" from real occupancy (same "disconnected subscribers don't
occupy a slot" rule `_slot_usage()` already uses, so the two stay
consistent), and every write path that can change occupancy --
linking/unlinking a subscriber, changing a subscriber's status, or
editing a NAP's total_ports -- calls it before commit.

"inactive" and "maintenance" are left alone: those are deliberate
manual overrides (Deactivate/Reactivate, or picked directly in the
Edit NAP form) and shouldn't be silently clobbered back to
"active"/"full" just because occupancy happens to change while a NAP
is down for maintenance.
"""

from app.extensions import db

_MANUAL_OVERRIDE_STATUSES = ("inactive", "maintenance")


def _refresh_subscribers(nap):
    """Forces `nap.subscribers` to be reloaded from the database on its
    next access, discarding any copy of that collection already cached
    on `nap` earlier in this same request/session.

    This is the actual fix for a real bug: a capacity check earlier in
    the same request (e.g. `slot_usage()` being called once to check
    "is there room for one more subscriber?" before a new Subscriber
    row is created) touches `nap.subscribers` and caches it. Setting a
    new subscriber's `nap_id` directly (every write path here uses the
    raw foreign key column, not the `nap` relationship attribute) does
    NOT refresh that cache — so a *second* access on the same `nap`
    object later in the same request (sync_nap_status()'s own count,
    right after the new row is flushed) silently reused the stale,
    pre-insert collection and missed the subscriber that request had
    just created. The practical symptom: a NAP that just filled its
    very last open slot stayed stored as "active" instead of flipping
    to "full", even though every *live*-computed number elsewhere
    (GeoMap, Dashboard's port totals) correctly showed it at 100%,
    because those recompute from a fresh request/session every time
    and never hit this particular staleness.

    No-op if `nap` isn't a persistent, session-tracked object yet
    (nothing to expire in that case).
    """
    if nap in db.session:
        db.session.expire(nap, ["subscribers"])


def sync_nap_status(nap):
    """Recomputes `nap.status` ("active" <-> "full") from the NAP's
    actual connected subscribers. No-op if the NAP is currently
    "inactive" or "maintenance" -- those only change via an explicit
    admin action, never automatically."""
    if nap is None or nap.status in _MANUAL_OVERRIDE_STATUSES:
        return

    _refresh_subscribers(nap)
    occupied = sum(1 for s in nap.subscribers if s.status != "disconnected")
    total = nap.total_ports or 0
    nap.status = "full" if total and occupied >= total else "active"


def slot_usage(nap):
    """Live (used, available) slot counts derived from actual linked
    subscribers -- the same source of truth `sync_nap_status()` above
    and the GeoMap feed's `_slot_usage()` both use, exposed here too
    so write paths can check *real* remaining capacity instead of the
    stale `available_ports` column."""
    _refresh_subscribers(nap)
    used = sum(1 for s in nap.subscribers if s.status != "disconnected")
    total = nap.total_ports or 0
    return used, max(total - used, 0)
