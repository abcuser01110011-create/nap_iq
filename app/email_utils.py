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
       "PG Networks <no-reply@yourdomain.com>".

Only the `requests` library is used to call Resend's API — no Resend-
specific SDK dependency needed.
"""

import html as _html
import os
import random
import smtplib
import threading
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import requests
from flask import current_app, has_app_context, url_for
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.extensions import db
from app.models import EmailVerification

_RESEND_API_URL = "https://api.resend.com/emails"
_BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def _pick_provider() -> str:
    """Which mail provider to use: EMAIL_PROVIDER ("resend" | "gmail" |
    "brevo") if set, otherwise whichever one has credentials configured
    (Gmail, then Brevo, then Resend)."""
    cfg = current_app.config
    chosen = (cfg.get("EMAIL_PROVIDER") or "").strip().lower()
    if chosen in ("resend", "gmail", "brevo"):
        return chosen
    if cfg.get("GMAIL_USER") and cfg.get("GMAIL_APP_PASSWORD"):
        return "gmail"
    if cfg.get("BREVO_API_KEY"):
        return "brevo"
    return "resend"


def _send_email(to_address: str, subject: str, html_body: str, text_body: str | None = None) -> bool:
    """Sends one email with the configured provider (see _pick_provider).
    Resend's free sandbox can only deliver to the owner's own address;
    Gmail SMTP and Brevo can deliver to any recipient, which is what you
    want for testing with several inboxes. Returns False (never raises)
    on any failure."""
    provider = _pick_provider()
    if provider == "gmail":
        return _send_via_gmail(to_address, subject, html_body, text_body)
    if provider == "brevo":
        return _send_via_brevo(to_address, subject, html_body, text_body)
    return _send_via_resend(to_address, subject, html_body, text_body)


def _send_via_gmail(to_address, subject, html_body, text_body=None) -> bool:
    """Gmail SMTP (smtp.gmail.com:465) using an App Password. Delivers to
    any address (about 500 emails/day on a normal Gmail account)."""
    user = current_app.config.get("GMAIL_USER")
    app_password = (current_app.config.get("GMAIL_APP_PASSWORD") or "").replace(" ", "")
    if not user or not app_password:
        current_app.logger.warning(
            "email_utils: GMAIL_USER/GMAIL_APP_PASSWORD not configured — skipping %r to %s.",
            subject, to_address,
        )
        return False
    sender_name = current_app.config.get("MAIL_DEFAULT_SENDER_NAME", "PG Networks")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{sender_name} <{user}>"
    msg["To"] = to_address
    if text_body:
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as server:
            server.login(user, app_password)
            server.sendmail(user, [to_address], msg.as_string())
        return True
    except (smtplib.SMTPException, OSError):
        current_app.logger.exception("email_utils: Gmail SMTP failed sending %r to %s", subject, to_address)
        return False


def _send_via_brevo(to_address, subject, html_body, text_body=None) -> bool:
    """Brevo (Sendinblue) HTTPS API. Free plan (~300 emails/day) can send to
    any address once one sender email is verified in the Brevo dashboard."""
    api_key = current_app.config.get("BREVO_API_KEY")
    sender_email = current_app.config.get("BREVO_SENDER_EMAIL")
    if not api_key or not sender_email:
        current_app.logger.warning(
            "email_utils: BREVO_API_KEY/BREVO_SENDER_EMAIL not configured — skipping %r to %s.",
            subject, to_address,
        )
        return False
    payload = {
        "sender": {"name": current_app.config.get("MAIL_DEFAULT_SENDER_NAME", "PG Networks"), "email": sender_email},
        "to": [{"email": to_address}],
        "subject": subject,
        "htmlContent": html_body,
    }
    if text_body:
        payload["textContent"] = text_body
    try:
        response = requests.post(
            _BREVO_API_URL,
            headers={"api-key": api_key, "Content-Type": "application/json", "accept": "application/json"},
            json=payload,
            timeout=10,
        )
        if response.status_code >= 400:
            current_app.logger.error(
                "email_utils: Brevo rejected %r to %s (status %s): %s",
                subject, to_address, response.status_code, response.text,
            )
            return False
        return True
    except requests.RequestException:
        current_app.logger.exception("email_utils: failed to send %r to %s via Brevo", subject, to_address)
        return False


def _send_via_resend(to_address: str, subject: str, html_body: str, text_body: str | None = None) -> bool:
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

    sender_name = current_app.config.get("MAIL_DEFAULT_SENDER_NAME", "PG Networks")
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

    if purpose == "password_reset":
        subject = "Your PG Networks password reset code"
        intro = ("Use the code below to reset your PG Networks staff password. "
                 "Never share this code with anyone.")
        heading = "Reset your password"
    else:
        subject = "Your PG Networks verification code"
        intro = ("Use the code below to verify your email address and continue your "
                 "PG Networks service application.")
        heading = "Verify your email"
    html_body = f"""
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #0B1F3A;">{heading}</h2>
          <p>{intro}</p>
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;
                    background: #F1F5F9; padding: 16px 24px; border-radius: 8px;
                    text-align: center; color: #0B1F3A;">{code}</p>
          <p>This code expires in {ttl_minutes} minutes. If you didn't request
          this, you can safely ignore this email.</p>
        </div>
    """
    text_body = (
        f"Your PG Networks code is {code}. "
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
          <p style="color: #64748B; font-size: 12px;">This is an automated message from PG Networks.</p>
        </div>
    """
    return _send_email(to_address, subject, html_body, body_text)


# =====================================================================
# Subscriber technical-issue emails (Gmail / any provider above)
# =====================================================================
# Three emails go to the SUBSCRIBER who owns a technical issue:
#   1. "We received your report"      -> email_issue_reported()
#   2. "Your report was added to an   -> email_issue_merged()
#       issue we're already handling"
#   3. "Your issue is now <status>"   -> email_issue_status_changed()
#
# They are called from app/notifications_utils.py, right next to the
# in-app Notification rows, so every place that already notifies about an
# issue (customer portal, mobile API, staff GeoMap, dispatch, technician
# web + mobile, admin close) also sends the email — no route changes.
#
# Emails are NOT sent immediately. `queue_email()` parks them on the DB
# session and they are only sent in the session's `after_commit` hook:
#   * if the request later rolls back, no email goes out for a change
#     that never happened;
#   * a slow/failing SMTP server can never break the transaction.
# Nothing in here ever raises into the request.

_PENDING_EMAILS_KEY = "pending_emails"
_PENDING_APP_KEY = "pending_emails_app"


def queue_email(to_address, subject, html_body, text_body=None, dedupe_key=None):
    """Queues one email to be sent right after the current transaction
    commits. `dedupe_key`: a later email with the same key in the same
    transaction replaces the earlier one (e.g. an issue that goes
    pending -> assigned within one request only emails the last status).
    Silently ignores a missing/obviously invalid address."""
    to_address = (to_address or "").strip()
    if "@" not in to_address or not has_app_context():
        return
    info = db.session.info
    pending = info.setdefault(_PENDING_EMAILS_KEY, [])
    if dedupe_key is not None:
        pending[:] = [p for p in pending if p["dedupe_key"] != dedupe_key]
    pending.append(
        {"to": to_address, "subject": subject, "html": html_body, "text": text_body, "dedupe_key": dedupe_key}
    )
    info[_PENDING_APP_KEY] = current_app._get_current_object()


def _send_async_enabled(app) -> bool:
    """Background thread by default (the request doesn't wait on SMTP).
    Sent inline instead when EMAIL_SEND_ASYNC=false, under pytest, and on
    Vercel — serverless freezes the process once the response is returned,
    so a background thread would often never finish there."""
    explicit = os.environ.get("EMAIL_SEND_ASYNC", "").strip().lower()
    if explicit in ("1", "true", "yes"):
        return True
    if explicit in ("0", "false", "no"):
        return False
    return not (app.config.get("TESTING") or os.environ.get("VERCEL"))


def _deliver(app, emails):
    with app.app_context():
        for item in emails:
            try:
                _send_email(item["to"], item["subject"], item["html"], item["text"])
            except Exception:  # never let a mail problem escape
                app.logger.exception("email_utils: unexpected error sending %r", item["subject"])


@event.listens_for(Session, "after_commit")
def _flush_queued_emails(session):
    emails = session.info.pop(_PENDING_EMAILS_KEY, None)
    app = session.info.pop(_PENDING_APP_KEY, None)
    if not emails or app is None:
        return
    if _send_async_enabled(app):
        threading.Thread(target=_deliver, args=(app, emails), daemon=True).start()
    else:
        _deliver(app, emails)


@event.listens_for(Session, "after_rollback")
def _discard_queued_emails(session):
    session.info.pop(_PENDING_EMAILS_KEY, None)
    session.info.pop(_PENDING_APP_KEY, None)


# ---- issue email content ---------------------------------------------

_ISSUE_STATUS_COPY = {
    "pending": (
        "Your issue is waiting for a technician",
        "Your reported issue is in our queue and will be assigned to a technician shortly.",
    ),
    "assigned": (
        "A technician has been assigned",
        "Good news — a technician has been assigned to your reported issue and will "
        "take care of it soon.",
    ),
    "in_progress": (
        "A technician is working on your issue",
        "Our technician has started working on your reported issue.",
    ),
    "resolved": (
        "Your issue has been resolved",
        "Our technician has marked your reported issue as resolved. If the problem "
        "is still happening, please report it again or contact PG Networks support.",
    ),
    "closed": (
        "Your issue has been closed",
        "Your reported issue is now closed. Thank you for your patience — if you "
        "need further help, you can always submit a new report.",
    ),
}


def _issue_recipient(issue):
    """The subscriber's own email, else the email of their linked portal
    login. None if neither is on file."""
    subscriber = issue.subscriber
    if subscriber is None:
        return None
    if subscriber.email and "@" in subscriber.email:
        return subscriber.email.strip()
    user = subscriber.user
    if user is not None and user.email and "@" in user.email:
        return user.email.strip()
    return None


def _issue_link():
    """Absolute link to the customer's issue list, or None outside a request."""
    try:
        return url_for("customer.my_issues", _external=True)
    except Exception:
        return None


def _issue_email(heading, intro, issue, status_text, link):
    """(html, text) for an issue email. Every dynamic value is escaped."""
    esc = _html.escape
    code = issue.issue_code or f"#{issue.id}"
    issue_type = (issue.issue_type or "").replace("_", " ")
    name = esc(issue.subscriber.full_name) if issue.subscriber else "there"
    reported = ""
    if issue.created_at:
        # Stored in UTC; subscribers are in the Philippines (UTC+8).
        reported = (issue.created_at + timedelta(hours=8)).strftime("%b %d, %Y %I:%M %p (PH time)")

    rows = [("Ticket no.", code), ("Issue type", issue_type), ("Status", status_text)]
    if reported:
        rows.append(("Reported", reported))
    rows_html = "".join(
        f'<tr><td style="padding:6px 12px 6px 0;color:#64748B;">{esc(k)}</td>'
        f'<td style="padding:6px 0;color:#0B1F3A;font-weight:bold;">{esc(v)}</td></tr>'
        for k, v in rows
    )
    button = (
        f'<p><a href="{esc(link)}" style="display:inline-block;background:#0B1F3A;color:#fff;'
        f'padding:10px 18px;border-radius:6px;text-decoration:none;">View my issues</a></p>'
        if link else ""
    )
    html_body = f"""
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #0B1F3A;">{esc(heading)}</h2>
          <p>Hi {name},</p>
          <p>{esc(intro)}</p>
          <table style="border-collapse:collapse;margin:12px 0;">{rows_html}</table>
          {button}
          <p style="color: #64748B; font-size: 12px;">This is an automated message from PG Networks.</p>
        </div>
    """
    text_body = (
        f"Hi {issue.subscriber.full_name if issue.subscriber else 'there'},\n\n{intro}\n\n"
        + "\n".join(f"{k}: {v}" for k, v in rows)
        + (f"\n\nView your issues: {link}" if link else "")
        + "\n\n— PG Networks (automated message)"
    )
    return html_body, text_body


def _is_fiber_break(issue):
    # A Fiber Break is logged by staff for a whole NAP and fanned out to
    # every connected subscriber — those subscribers didn't report anything,
    # so "we received your report" would be wrong. (Customers can't pick
    # this type themselves.)
    return issue.issue_type == "Fiber Break"


def email_issue_reported(issue):
    """'We received your report' — queued when an issue is first created."""
    to = _issue_recipient(issue)
    if not to or _is_fiber_break(issue):
        return
    code = issue.issue_code or f"#{issue.id}"
    html_body, text_body = _issue_email(
        "We received your report",
        "Thank you for reporting your issue. Your report was successfully submitted "
        "and our team is on it. We'll email you again whenever its status changes.",
        issue, "Pending", _issue_link(),
    )
    queue_email(to, f"PG Networks — Report received ({code})", html_body, text_body,
                dedupe_key=("issue-reported", issue.id))


def email_issue_merged(issue):
    """A new report was merged into the subscriber's already-open issue."""
    to = _issue_recipient(issue)
    if not to or _is_fiber_break(issue):
        return
    code = issue.issue_code or f"#{issue.id}"
    status_text = (issue.status or "").replace("_", " ").capitalize()
    html_body, text_body = _issue_email(
        "Your report was added to an existing issue",
        "We received your new report. You already have an open issue with us, so "
        "we've added your report to it instead of opening a duplicate.",
        issue, status_text, _issue_link(),
    )
    queue_email(to, f"PG Networks — Report received ({code})", html_body, text_body,
                dedupe_key=("issue-merged", issue.id))


def email_issue_status_changed(issue):
    """'Your issue is now <status>' — queued on every status change."""
    to = _issue_recipient(issue)
    if not to or issue.status not in _ISSUE_STATUS_COPY:
        return
    code = issue.issue_code or f"#{issue.id}"
    heading, intro = _ISSUE_STATUS_COPY[issue.status]
    status_text = issue.status.replace("_", " ").capitalize()
    if issue.status == "closed" and getattr(issue, "voided_at", None):
        heading = "Your issue was closed by our team"
        intro = ("Your reported issue was closed by our support team. If you still need "
                 "help, please submit a new report or contact PG Networks support.")
        status_text = "Closed"
    html_body, text_body = _issue_email(heading, intro, issue, status_text, _issue_link())
    queue_email(to, f"PG Networks — Issue {code}: {status_text}", html_body, text_body,
                dedupe_key=("issue-status", issue.id))


# =====================================================================
# Online-application emails (optional email on the landing-page form)
# =====================================================================

def _simple_email(heading, paragraphs):
    """(html, text) for a short status email. Every value is escaped."""
    esc = _html.escape
    body = "".join(f'<p style="color:#0B1F3A;">{esc(p)}</p>' for p in paragraphs)
    html_body = (
        '<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">'
        f'<h2 style="color: #0B1F3A;">{esc(heading)}</h2>{body}'
        '<p style="color: #64748B; font-size: 12px;">This is an automated message from PG Networks.</p>'
        "</div>"
    )
    return html_body, "\n\n".join([heading, *paragraphs])


def email_application_received(subscriber):
    """"We received your application" -- sent when an applicant who gave
    an email submits the landing-page Apply form. Queued, never raises."""
    if subscriber is None or not subscriber.email:
        return
    html_body, text_body = _simple_email(
        "We received your application",
        [
            f"Hi {subscriber.full_name}, thank you for applying to PG Networks.",
            f"Your application number is {subscriber.subscriber_code}. Keep it handy: "
            "you can use it with your phone number to log in to your account.",
            "We will email you here whenever the status of your application changes.",
        ],
    )
    queue_email(subscriber.email, "PG Networks — We received your application", html_body, text_body)


def email_team_assigned(service_request, team_name):
    """"A team was assigned to your installation" -- sent when an
    administrator assigns a team after approving the application."""
    subscriber = service_request.subscriber
    if subscriber is None or not subscriber.email:
        return
    html_body, text_body = _simple_email(
        "A team has been assigned to your installation",
        [
            f"Hi {subscriber.full_name}, good news: {team_name} has been assigned to your installation.",
            "They will contact you on the phone number you provided to arrange the visit.",
        ],
    )
    queue_email(
        subscriber.email, "PG Networks — Your installation team is assigned", html_body, text_body,
        dedupe_key=f"team-assigned-{service_request.id}",
    )
