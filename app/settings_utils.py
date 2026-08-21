"""
Dynamic Settings Helper — Phase 15
-------------------------------------
Applies the admin-configurable values kept in `app_settings` to the
running app. Deliberately its own tiny module and its own
`before_request` hook (registered in app/__init__.py) rather than
folded into app/auth.py's `load_logged_in_user` — this keeps the
verified Phase 7 auth/session core completely untouched. This hook
only ever adjusts `current_app.permanent_session_lifetime`; it never
touches session contents, login logic, or the `role_required`
decorator.
"""

from datetime import timedelta

from flask import current_app


def apply_dynamic_settings() -> None:
    """Reads the current `app_settings` row and applies
    `session_timeout_minutes` to `current_app.permanent_session_lifetime`
    for this request. Runs before `load_logged_in_user` (see
    app/__init__.py's before_request registration order) so a fresh
    session started later in the same request already uses the
    up-to-date lifetime.

    A local import of AppSettings avoids a circular import at module
    load time (app/models.py doesn't need to know this module exists).
    """
    from app.models import AppSettings

    settings = AppSettings.get_current()
    current_app.permanent_session_lifetime = timedelta(minutes=settings.session_timeout_minutes)
