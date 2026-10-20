"""Shared lookup for the "Link Existing Account" flow (web + mobile API).

A customer may identify their subscriber record by account number OR by
the full name on file, but in both cases the phone number on file must
also match exactly.
"""

from sqlalchemy import func

from app.models import Subscriber


def _norm(text):
    return " ".join((text or "").split()).lower()


def find_subscriber_for_link(identifier, phone):
    """Return the Subscriber matching (account number OR full name) AND
    phone, or None. A name that matches more than one record with that
    phone is treated as not found (ambiguous) -- the account number must
    be used instead."""
    ident = _norm(identifier)
    phone = (phone or "").strip()
    if not ident or not phone:
        return None

    candidates = Subscriber.query.filter(
        func.trim(Subscriber.contact_number) == phone
    ).all()

    by_code = [s for s in candidates if _norm(s.subscriber_code) == ident]
    if len(by_code) == 1:
        return by_code[0]

    by_name = [s for s in candidates if _norm(s.full_name) == ident]
    # Prefer a not-yet-linked record if several share the same name.
    free = [s for s in by_name if s.user_id is None]
    if len(free) == 1:
        return free[0]
    if len(by_name) == 1:
        return by_name[0]
    return None
