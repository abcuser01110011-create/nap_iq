"""
Failed-login attempt limiter
------------------------------
Counts wrong sign-in attempts and temporarily locks the sign-in after
too many, so the person sees "N attempts left" warnings instead of
just hitting a bare 429 page.

Used by every credential entry point:
    * staff sign-in        POST /login
    * customer sign-in     POST /account/login
    * landing-page popup   POST /public/account-login

Design notes
    * The counter is keyed by portal + username/account number. (Not by
      IP: behind Vercel's proxy the client IP is not reliable, and a
      guesser could simply change it.)
    * State lives in the DATABASE (table `login_attempts`), not in
      memory. On Vercel every request can run in a different
      serverless instance, so an in-memory counter never reaches 5.
      The table is created automatically on first use; the same SQL is
      in database/add_login_attempts.sql if you prefer to run it by hand.
    * If the database is unavailable the limiter fails open (logs the
      error) rather than blocking everyone from signing in.
    * LOGIN_MAX_ATTEMPTS can never go below 5.
"""

import time
from datetime import datetime, timedelta

from flask import current_app
from sqlalchemy.exc import IntegrityError

from app.extensions import db

MIN_ATTEMPTS = 5


class LoginAttempt(db.Model):
    __tablename__ = "login_attempts"

    key = db.Column(db.String(255), primary_key=True)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    expires_at = db.Column(db.DateTime, nullable=False)


_table_ready = False


def _ensure_table():
    """Create the table once per process if it doesn't exist yet."""
    global _table_ready
    if not _table_ready:
        LoginAttempt.__table__.create(bind=db.engine, checkfirst=True)
        _table_ready = True


def _max_attempts() -> int:
    return max(MIN_ATTEMPTS, int(current_app.config.get("LOGIN_MAX_ATTEMPTS", MIN_ATTEMPTS)))


def _lockout_seconds() -> int:
    return max(60, int(current_app.config.get("LOGIN_LOCKOUT_MINUTES", 15)) * 60)


def _key(portal: str, identifier: str) -> str:
    ident = (identifier or "").strip().lower() or "no-identifier"
    return f"{portal}:{ident}"[:255]


def _live_row(key):
    row = db.session.get(LoginAttempt, key)
    if row is not None and row.expires_at <= datetime.utcnow():
        db.session.delete(row)
        db.session.commit()
        return None
    return row


def seconds_locked(portal: str, identifier: str) -> int:
    """Seconds left on the lockout, or 0 if sign-in is allowed."""
    try:
        _ensure_table()
        row = _live_row(_key(portal, identifier))
        if row is None or row.attempts < _max_attempts():
            return 0
        return max(1, int((row.expires_at - datetime.utcnow()).total_seconds()))
    except Exception:
        db.session.rollback()
        current_app.logger.exception("login_attempts: seconds_locked failed (failing open)")
        return 0


def register_failure(portal: str, identifier: str) -> int:
    """Record one wrong attempt. Returns attempts left (0 = now locked).

    The window starts at the first failure and expires on its own after
    the lockout period, which also resets the count for later tries.
    """
    key = _key(portal, identifier)
    try:
        _ensure_table()
        for _ in range(2):
            row = _live_row(key)
            if row is None:
                db.session.add(LoginAttempt(
                    key=key, attempts=1,
                    expires_at=datetime.utcnow() + timedelta(seconds=_lockout_seconds()),
                ))
                try:
                    db.session.commit()
                    return max(0, _max_attempts() - 1)
                except IntegrityError:  # a parallel request created it first
                    db.session.rollback()
                    continue
            row.attempts = LoginAttempt.attempts + 1  # atomic increment in SQL
            db.session.commit()
            db.session.refresh(row)
            return max(0, _max_attempts() - row.attempts)
    except Exception:
        db.session.rollback()
        current_app.logger.exception("login_attempts: register_failure failed (failing open)")
    return _max_attempts()


def reset(portal: str, identifier: str) -> None:
    """Forget failures after a successful sign-in."""
    try:
        _ensure_table()
        LoginAttempt.query.filter_by(key=_key(portal, identifier)).delete()
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception("login_attempts: reset failed")


def format_wait(seconds: int) -> str:
    minutes = -(-seconds // 60)
    return "1 minute" if minutes <= 1 else f"{minutes} minutes"


def locked_message(seconds: int) -> str:
    return (
        "Too many failed sign-in attempts. Sign-in is temporarily locked. "
        f"Please try again in {format_wait(seconds)}."
    )


def warning_message(attempts_left: int) -> str:
    """Text for the remaining-attempts warning ("" once locked)."""
    if attempts_left <= 0:
        return ""
    noun = "attempt" if attempts_left == 1 else "attempts"
    return f"Warning: {attempts_left} {noun} left before sign-in is temporarily locked."
