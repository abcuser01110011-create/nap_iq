"""Shared lookup for the "Link Existing Account" flow (web + mobile API).

A customer identifies their subscriber record by ACCOUNT NUMBER only (a
full name is NOT accepted), and the phone number on file must also match
exactly.
"""

from sqlalchemy import func

from app.models import Subscriber


def _norm(text):
    return " ".join((text or "").split()).lower()


def find_subscriber_for_link(identifier, phone):
    """Return the Subscriber matching the account number AND phone, or
    None. Names are never matched, even when the phone number is correct."""
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
    return None
