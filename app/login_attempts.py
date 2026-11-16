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
    * The counter is keyed by portal + identifier + client IP, so one
      person mistyping cannot lock a real user out from a different
      device/network (and a stranger cannot lock the owner out).
      Spreading guesses across many IPs is still caught by the existing
      Flask-Limiter per-username limit in routes/auth.py.
    * State lives in Flask-Limiter's own storage backend, so it honours
      RATELIMIT_STORAGE_URI (memory:// by default, Redis for multi-
      worker deployments) and needs NO database change.
    * LOGIN_MAX_ATTEMPTS can never go below 5.
"""

import time

from flask import current_app, request

from app.extensions import limiter

MIN_ATTEMPTS = 5


def _max_attempts() -> int:
    return max(MIN_ATTEMPTS, int(current_app.config.get("LOGIN_MAX_ATTEMPTS", MIN_ATTEMPTS)))


def _lockout_seconds() -> int:
    return max(60, int(current_app.config.get("LOGIN_LOCKOUT_MINUTES", 15)) * 60)


def _storage():
    return limiter.limiter.storage


def _key(portal: str, identifier: str) -> str:
    ident = (identifier or "").strip().lower() or "no-identifier"
    ip = request.remote_addr or "unknown-ip"
    return f"login-fail:{portal}:{ident}:{ip}"


def seconds_locked(portal: str, identifier: str) -> int:
    """Seconds left on the lockout, or 0 if sign-in is allowed."""
    key = _key(portal, identifier)
    if _storage().get(key) < _max_attempts():
        return 0
    return max(1, int(round(_storage().get_expiry(key) - time.time())))


def register_failure(portal: str, identifier: str) -> int:
    """Record one wrong attempt. Returns attempts left (0 = now locked).

    The window starts at the first failure and expires on its own after
    the lockout period, which also resets the count for later tries.
    """
    count = _storage().incr(_key(portal, identifier), _lockout_seconds())
    return max(0, _max_attempts() - count)


def reset(portal: str, identifier: str) -> None:
    """Forget failures after a successful sign-in."""
    _storage().clear(_key(portal, identifier))


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
