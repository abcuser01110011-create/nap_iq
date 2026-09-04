"""
Customer Blueprint
--------------------
The User/Customer-role interface introduced in Phase 7, wired up in
Phase 10 to show a signed-in customer's *actual* subscriber record --
their plan, connected NAP, and technical issues -- instead of the
placeholder page from Phase 7-9.

Linking model (Phase 10 decision -- see PHASE10_NOTES.md for the full
rationale): staff-created accounts, not self-registration. An
Administrator creates the `user` login (Manage Users -> Add User,
already built in Phase 8) and, on that same form, optionally links it
to an existing `subscribers` row via the new `subscribers.user_id`
column. There is no public sign-up form; a customer can't create their
own portal login or attach themselves to somebody else's subscriber
record just by knowing its code. This mirrors how `technicians`
profiles are paired with technician `users` accounts (also
staff-only, also not self-service) rather than inventing a new
pattern.

A `user` account with no linked subscriber yet (e.g. just created,
not linked, or a subscriber record with no portal login at all) still
gets a friendly explicit state here -- same as Technician.index()
handles a technician with no linked profile.

Phase 12 adds a self-service "Report an Issue" route. Reporting a
technical issue was previously staff-only by design (see
app/routes/issues.py's `_STAFF_ROLES` and its own docstring) — this is
a deliberately separate, narrower route rather than opening
issues.report_issue up to the "user" role: a customer can only ever
file an issue against *their own* linked subscriber record (never one
picked from a dropdown, unlike the staff version), and latitude/
longitude/address are taken from the subscriber's own stored location
rather than a map click, since the portal has no map.

Phase 14 adds three dedicated, read-only pages for a customer's own
service requests, technical issues, and payments — the sidebar links
for these existed but were disabled "Coming soon" placeholders, and
the portal home page's data (subscriber.technical_issues /
.service_requests / .payments) had nowhere but that one inline summary
to be seen. Each new route re-does its own `Subscriber.query.filter_by
(user_id=g.user.id)` lookup rather than trusting a subscriber_id from
the URL or session, same as index()/report_issue() already do — a
customer can only ever see their own record's data this way, never
another subscriber's by guessing an id.

Routes:
    GET  /portal/                    -> index               (customer portal home)
    GET  /portal/report-issue        -> report_issue         (show self-service report form)
    POST /portal/report-issue        -> report_issue         (process self-service report form)
    GET  /portal/issues              -> my_issues             (own technical issues, full list)
    GET  /portal/service-requests    -> my_service_requests   (own service requests, full list)
    GET  /portal/payments            -> my_payments           (own payment history)
"""

import uuid

import cloudinary
import cloudinary.uploader
from flask import Blueprint, render_template, redirect, url_for, flash, g, request

from app.extensions import db
from app.auth import role_required
from app.models import Subscriber, TechnicalIssue
from app.forms import CustomerIssueReportForm
from app.notifications_utils import notify_new_issue_reported

customer_bp = Blueprint("customer", __name__, url_prefix="/portal")

# Same allowed set as app/routes/technician.py's completion-photo upload —
# kept as its own copy here since this is a separate self-service flow.
ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png", "heic", "webp"}


def _own_subscriber_or_none():
    """Looks up the signed-in customer's own linked subscriber record,
    same lookup used by index()/report_issue() — kept as its own
    helper now that three more routes need it too."""
    return Subscriber.query.filter_by(user_id=g.user.id).first()


@customer_bp.route("/")
@role_required("user")
def index():
    """Customer portal home page: the signed-in customer's own
    subscriber record (NAP, plan, status) and their technical issues,
    looked up via `subscribers.user_id`. Shows an explicit empty state
    if no subscriber record has been linked to this login yet."""
    subscriber = _own_subscriber_or_none()

    return render_template(
        "customer/index.html",
        subscriber=subscriber,
        # subscriber.technical_issues / subscriber.service_requests /
        # subscriber.payments are already ordered newest-first by the
        # relationship definitions in app/models.py.
        technical_issues=subscriber.technical_issues if subscriber else [],
        service_requests=subscriber.service_requests if subscriber else [],
        payments=subscriber.payments if subscriber else [],
    )


@customer_bp.route("/report-issue", methods=["GET", "POST"])
@role_required("user")
def report_issue():
    """Self-service technical-issue reporting for a signed-in customer.

    Always attributes the new issue to `g.user`'s own linked
    subscriber (looked up server-side, never taken from the submitted
    form) — a customer can never file an issue against another
    subscriber's account this way. A customer with no linked
    subscriber yet is shown the same "not linked" explanation as the
    portal home page instead of the form, since there's no subscriber
    to attach an issue to.
    """
    subscriber = _own_subscriber_or_none()

    if subscriber is None:
        flash(
            "Your login isn't linked to a subscriber record yet, so you can't "
            "report an issue here. Please contact PG Networks support.",
            "warning",
        )
        return redirect(url_for("customer.index"))

    form = CustomerIssueReportForm()

    if form.validate_on_submit():
        # A photo is required (upload from the device's gallery, or
        # take one on the spot — both come through this same file
        # input). Handled as a plain `request.files` field rather than
        # a WTForms FileField, same approach as
        # app/routes/technician.py's upload_photo().
        photo = request.files.get("photo")
        if photo is None or photo.filename == "":
            flash("Please attach a photo of the issue before submitting.", "warning")
            return render_template("customer/report_issue.html", form=form, subscriber=subscriber)

        ext = photo.filename.rsplit(".", 1)[-1].lower() if "." in photo.filename else ""
        if ext not in ALLOWED_PHOTO_EXTENSIONS:
            flash("Unsupported photo format. Use JPG, PNG, HEIC, or WEBP.", "danger")
            return render_template("customer/report_issue.html", form=form, subscriber=subscriber)

        public_id = f"issue-photos/subscriber-{subscriber.id}-{uuid.uuid4().hex}"
        try:
            upload_result = cloudinary.uploader.upload(photo, public_id=public_id, overwrite=True)
        except Exception:
            flash("Photo upload failed. Please try again.", "danger")
            return render_template("customer/report_issue.html", form=form, subscriber=subscriber)

        issue = TechnicalIssue(
            issue_type=form.issue_type.data,
            description=form.description.data.strip(),
            priority=form.priority.data,
            status="pending",  # every newly reported issue starts here
            address=subscriber.address,
            latitude=subscriber.latitude,
            longitude=subscriber.longitude,
            photo_filename=upload_result["secure_url"],
            subscriber_id=subscriber.id,
            nap_id=subscriber.nap_id,
        )
        db.session.add(issue)
        db.session.commit()  # issue.id is now populated by MySQL

        # Same issue_code convention as the staff-facing report route
        # (app/routes/issues.py) — generated from the real primary key.
        issue.issue_code = f"ISS-{issue.id:04d}"
        notify_new_issue_reported(issue)
        db.session.commit()

        flash(f"Your issue '{issue.issue_code}' was reported successfully.", "success")
        return redirect(url_for("customer.index"))

    return render_template("customer/report_issue.html", form=form, subscriber=subscriber)


def _no_subscriber_redirect():
    """Same "not linked" explanation/redirect used by index() and
    report_issue(), reused here so all three new pages behave
    identically for a customer with no linked subscriber record."""
    flash(
        "Your login isn't linked to a subscriber record yet, so there's nothing "
        "to show here. Please contact PG Networks support.",
        "warning",
    )
    return redirect(url_for("customer.index"))


@customer_bp.route("/issues")
@role_required("user")
def my_issues():
    """Full list of the signed-in customer's own technical issues.
    Already ordered newest-first by the Subscriber.technical_issues
    relationship definition in app/models.py."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_redirect()

    return render_template(
        "customer/issues.html",
        subscriber=subscriber,
        technical_issues=subscriber.technical_issues,
    )


@customer_bp.route("/service-requests")
@role_required("user")
def my_service_requests():
    """Full list of the signed-in customer's own service requests
    (new installation / relocation / upgrade / disconnection).
    Already ordered newest-first by the Subscriber.service_requests
    relationship definition in app/models.py."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_redirect()

    return render_template(
        "customer/service_requests.html",
        subscriber=subscriber,
        service_requests=subscriber.service_requests,
    )


@customer_bp.route("/payments")
@role_required("user")
def my_payments():
    """The signed-in customer's own payment history. Read-only — a
    customer views what's been recorded against their account but
    can't record a payment themself (that stays a payment_collector /
    Administrator action, same as everywhere else in the app)."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_redirect()

    return render_template(
        "customer/payments.html",
        subscriber=subscriber,
        payments=subscriber.payments,
    )
