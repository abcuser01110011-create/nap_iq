"""
Small query helpers shared by the list/filter screens.

Why this exists (MySQL -> PostgreSQL migration)
-----------------------------------------------
The list screens take a filter straight from the URL (``?status=...``,
``?role=...``) and compare it against an ENUM column. MySQL quietly
returns "no rows" when the value isn't a valid enum member; PostgreSQL
instead raises ``invalid input value for enum ...`` and the page 500s
(e.g. from an old bookmark or a hand-edited URL). ``filter_enum_eq``
keeps the old behaviour: a valid value filters normally, anything else
matches nothing.
"""

from app.extensions import db


def filter_enum_eq(query, column, value):
    """Return ``query`` filtered to ``column == value``; if ``value`` is not
    one of the enum column's allowed values, return an always-empty result
    instead of sending an invalid enum literal to the database."""
    if value in column.type.enums:
        return query.filter(column == value)
    return query.filter(db.false())
