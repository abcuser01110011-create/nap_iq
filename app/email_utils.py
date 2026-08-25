"""
Email Helper — Applicant Email Verification & Status Emails
-------------------------------------------------------------
Small, standalone module (same pattern as app/settings_utils.py and
app/notifications_utils.py) so all outbound-email logic lives in one
place: sending real mail via Resend's HTTPS API, plus the
one-time-code (OTP) generation/storage/checking used to verify an
applicant's email address during mobile self-registration
(app/routes/api_v1/auth.py).

Why Resend instead of Gmail SMTP: Railway (like most PaaS free/hobby
tiers) blocks outbound SMTP entirely on every plan below Pro — raw
`smtplib` connections to smtp.gmail.com fail with a network-level
"Network is unreachable" error, before authentication is even
attempted. Resend sends over plain HTTPS (port 443) instead, which is
never blocked. See https://docs.railway.com/networking/outbound-networking.

Setup required (see .env.example):
    1. Sign up at https://resend.com (free tier: 3,000 emails/month,
       100/day, no credit card).
    2. Create an API key from the Resend dashboard and put it in .env
       (or Railway's Variables tab) as RESEND_API_KEY.
    3. Out of the box, RESEND_FROM_EMAIL defaults to
       "onboarding@resend.dev" (Resend's shared sandbox sender), which
       can only send TO the email address you signed up to Resend
       with — fine for development. To send to real applicants, verify
       your own domain in the Resend dashboard (Domains -> Add Domain
       -> add the SPF/DKIM DNS records they give you), then set
       RESEND_FROM_EMAIL to an address on that domain, e.g.
       "NAP-IQ <no-reply@yourdomain.com>".

Only the `requests` library is used to call Resend's API — no Resend-
specific SDK dependency needed.
"""

import random
from datetime import datetime, timedelta

import requests
from flask import current_app

from app.extensions import db
from app.models import EmailVerification

_RESEND_API_URL = "https://api.resend.com/emails"


def _send_email(to_address: str, subject: str, html_body: str, text_body: str | None = None) -> bool:
    """Sends one email through Resend's HTTPS API. Returns True on
    success, False on any failure (missing API key, network error,
    Resend rejecting the request, etc.) instead of raising, so a mail
    hiccup never turns into a 500 for the applicant — callers decide
    what a failed send should mean for their own flow (e.g. the
    verification-code endpoint below still returns success to the
    client without leaking whether the address exists/works, but logs
    the failure server-side).

    Returns False immediately, without making a request, if
    RESEND_API_KEY hasn't been configured — this is what happens out
    of the box in local dev before .env is filled in.
    """
    api_key = current_app.config.get("RESEND_API_KEY")

    if not api_key:
        current_app.logger.warning(
            "email_utils: RESEND_API_KEY not configured — "
            "skipping send of %r to %s.", subject, to_address,
        )
        return False

    sender_name = current_app.config.get("MAIL_DEFAULT_SENDER_NAME", "NAP-IQ")
    from_email = current_app.config.get("RESEND_FROM_EMAIL", "onboarding@resend.dev")
    # Only prefix a display name if the config value is a bare address
    # (Resend also accepts "Name <email>" directly in RESEND_FROM_EMAIL
    # if someone sets it that way instead).
    from_header = from_email if "<" in from_email else f"{sender_name} <{from_email}>"

    payload = {
        "from": from_header,
        "to": [to_address],
        "subject": subject,
        "html": html_body,
    }
    if text_body:
        payload["text"] = text_body

    try:
        response = requests.post(
            _RESEND_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=10,
        )
        if response.status_code >= 400:
            current_app.logger.error(
                "email_utils: Resend rejected %r to %s (status %s): %s",
                subject, to_address, response.status_code, response.text,
            )
            return False
        return True
    except requests.RequestException:
        current_app.logger.exception(
            "email_utils: failed to send %r to %s via Resend", subject, to_address
        )
        return False


def _generate_code() -> str:
    """A 6-digit numeric code, zero-padded (e.g. '004821'). Numeric
    (not alphanumeric) so it's easy to read back and type on a phone
    keyboard's number pad."""
    return f"{random.randint(0, 999999):06d}"


def send_verification_code(email: str, purpose: str = "registration") -> bool:
    """Generates a fresh 6-digit code for `email`, stores it (replacing
    any previous unconsumed code for the same email+purpose so only
    the most recently sent code is ever valid), and emails it via
    Resend. Returns whatever `_send_email` returned — True if the send
    succeeded, False otherwise. The code row is still saved even if
    sending fails, so config/logging is consistent, but callers should
    treat a False return as "could not deliver" server-side.
    """
    code = _generate_code()
    ttl_minutes = current_app.config.get("EMAIL_VERIFICATION_CODE_TTL_MINUTES", 10)
    expires_at = datetime.utcnow() + timedelta(minutes=ttl_minutes)

    # Invalidate any earlier, still-unconsumed codes for this exact
    # email+purpose so a stale earlier code can't be replayed after a
    # new one has been sent.
    EmailVerification.query.filter_by(
        email=email, purpose=purpose, is_verified=False
    ).delete()

    record = EmailVerification(
        email=email,
        purpose=purpose,
        code=code,
        expires_at=expires_at,
        attempts=0,
        is_verified=False,
    )
    db.session.add(record)
    db.session.commit()

    subject = "Your NAP-IQ verification code"
    html_body = f"""
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #0B1F3A;">Verify your email</h2>
          <p>Use the code below to verify your email address and continue your
          NAP-IQ service application.</p>
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;
                    background: #F1F5F9; padding: 16px 24px; border-radius: 8px;
                    text-align: center; color: #0B1F3A;">{code}</p>
          <p>This code expires in {ttl_minutes} minutes. If you didn't request
          this, you can safely ignore this email.</p>
        </div>
    """
    text_body = (
        f"Your NAP-IQ verification code is {code}. "
        f"It expires in {ttl_minutes} minutes."
    )
    return _send_email(email, subject, html_body, text_body)


def verify_code(email: str, code: str, purpose: str = "registration") -> tuple[bool, str]:
    """Checks a submitted code against the most recent record for
    email+purpose. Returns (True, "") on success, or (False, message)
    on failure — expired, wrong, already used, or never requested.

    On success, marks the record `is_verified=True` (rather than
    deleting it) so app/routes/api_v1/auth.py's register() can check
    "was this exact email verified recently" at submit time without
    a second code exchange.

    Each wrong attempt increments `attempts`; once
    EMAIL_VERIFICATION_MAX_ATTEMPTS is reached the code is invalidated
    outright (deleted) so it can't be brute-forced by retrying the same
    6-digit code — the applicant must request a fresh one.
    """
    record = (
        EmailVerification.query.filter_by(email=email, purpose=purpose, is_verified=False)
        .order_by(EmailVerification.created_at.desc())
        .first()
    )

    if record is None:
        return False, "No verification code was requested for this email. Please request a new one."

    if record.expires_at < datetime.utcnow():
        db.session.delete(record)
        db.session.commit()
        return False, "This code has expired. Please request a new one."

    max_attempts = current_app.config.get("EMAIL_VERIFICATION_MAX_ATTEMPTS", 5)
    if record.attempts >= max_attempts:
        db.session.delete(record)
        db.session.commit()
        return False, "Too many incorrect attempts. Please request a new code."

    if record.code != str(code).strip():
        record.attempts += 1
        db.session.commit()
        return False, "Incorrect code. Please try again."

    record.is_verified = True
    db.session.commit()
    return True, ""


def is_email_verified(email: str, purpose: str = "registration") -> bool:
    """True if `email` has a verified (and not yet consumed-by-register)
    record for `purpose`. Used by api_v1/auth.py's register() to refuse
    account creation for an email that never completed the verification
    step, without re-checking the actual code.
    """
    return (
        EmailVerification.query.filter_by(email=email, purpose=purpose, is_verified=True)
        .order_by(EmailVerification.created_at.desc())
        .first()
        is not None
    )


def consume_verification(email: str, purpose: str = "registration") -> None:
    """Deletes the verified record for email+purpose once it's been
    used to complete registration, so the same verification can't be
    reused for a second account later.
    """
    EmailVerification.query.filter_by(email=email, purpose=purpose, is_verified=True).delete()
    db.session.commit()


def send_status_email(to_address: str, subject: str, heading: str, body_text: str) -> bool:
    """Generic "your application status changed" email — used by
    app/routes/service_requests.py's `_notify_status_change()` for the
    approved / scheduled / rejected transitions, alongside (not instead
    of) the existing in-app Notification row app/notifications_utils.py
    already creates.
    """
    html_body = f"""
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #0B1F3A;">{heading}</h2>
          <p>{body_text}</p>
          <p style="color: #64748B; font-size: 12px;">This is an automated message from NAP-IQ.</p>
        </div>
    """
    return _send_email(to_address, subject, html_body, body_text)
