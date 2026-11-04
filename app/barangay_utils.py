"""Helpers for the "Barangay" dropdown filter on the Subscribers and
Payments tabs.

Subscribers don't have a dedicated barangay column -- the barangay lives
inside the free-text address ("Brgy. Poblacion III, Sta. Cruz, Laguna").
These helpers pull it back out so both tabs can filter by it.
"""
import re

_BRGY_RE = re.compile(r"(?:\bbrgy\.?|\bbarangay)\s+([^,]+)", re.IGNORECASE)


def extract_barangay(address):
    """Return the barangay name from an address string ('' if none)."""
    if not address:
        return ""
    m = _BRGY_RE.search(address)
    return m.group(1).strip() if m else ""


def barangay_options(addresses):
    """Sorted, de-duplicated (case-insensitive) barangay names found in
    an iterable of addresses."""
    seen = {}
    for addr in addresses:
        name = extract_barangay(addr)
        if name:
            seen.setdefault(name.lower(), name)
    return sorted(seen.values(), key=str.lower)
