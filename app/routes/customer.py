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

Phase 31 adds two routes for the "no subscriber yet" empty state
(customer/index.html) that self-registration (Phase 30) left with
nothing to do besides "contact support": `apply` (the web counterpart
to the mobile app's Apply for Service wizard) and `link_account` (new
on both platforms — a self-registered login reconnecting to service it
already has). `link_account` deliberately keeps this module's original
Phase 10 "not just by knowing the code" rule intact by also requiring
the phone number on file to match; see that route's own docstring.

Routes:
    GET  /portal/                    -> index               (customer portal home)
    GET  /portal/apply               -> apply                (show self-service "apply for installation" form)
    POST /portal/apply               -> apply                (process it, create the subscriber + request)
    POST /portal/apply/coverage-check -> apply_coverage_check (AJAX: is this point covered?)
    GET  /portal/link-account        -> link_account          (show self-service "link existing account" form)
    POST /portal/link-account        -> link_account          (process it, attach the subscriber record)
    GET  /portal/report-issue        -> report_issue         (show self-service report form)
    POST /portal/report-issue        -> report_issue         (process self-service report form)
    GET  /portal/issues              -> my_issues             (own technical issues, full list)
    GET  /portal/service-requests    -> my_service_requests   (own service requests, full list)
    GET  /portal/payments            -> my_payments           (own payment history)
"""

import uuid

import cloudinary
import cloudinary.uploader
from flask import Blueprint, current_app, render_template, redirect, url_for, flash, g, request, jsonify

from app.extensions import db, limiter
from app.auth import role_required
from app.models import Plan, ServiceRequest, Subscriber, TechnicalIssue
from app.forms import CustomerApplyForInstallationForm, CustomerIssueReportForm, CustomerLinkAccountForm
from app.nap_recommendation import recommend_naps
from app.notifications_utils import notify_new_issue_reported

customer_bp = Blueprint("customer", __name__, url_prefix="/portal")

# Same allowed set as app/routes/technician.py's completion-photo upload —
# kept as its own copy here since this is a separate self-service flow.
ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png", "heic", "webp"}


def _populate_plan_choices(form):
    """Fills in the Apply-for-Installation form's "Plan" dropdown from
    the current `plans` table (Settings > App Settings > Plans), same
    dynamic-choices pattern as routes/subscribers.py's own
    _populate_plan_choices() — duplicated here rather than imported
    since the two forms/routes don't otherwise share code."""
    plans = Plan.query.order_by(Plan.name).all()
    form.plan_name.choices = [("", "-- No preference --")] + [(p.name, p.name) for p in plans]


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


@customer_bp.route("/apply/coverage-check", methods=["POST"])
@role_required("user")
def apply_coverage_check():
    """AJAX coverage check for the Apply-for-Installation page's
    "Check coverage" step — thin wrapper around the same
    app.nap_recommendation engine the mobile app's own pre-registration
    coverage-check and the admin's install planner already use. Purely
    a read (recommend_naps never writes), so it's safe to call as many
    times as the customer re-detects their location, and it's re-run
    server-side again at actual submit time in apply() below rather
    than trusted from this call alone.
    """
    if _own_subscriber_or_none() is not None:
        return jsonify(error="Your login is already linked to a subscriber record."), 409

    data = request.get_json(silent=True) or {}
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        return jsonify(error="Valid latitude and longitude are required."), 400

    matches = recommend_naps(latitude, longitude, limit=1)
    if not matches:
        return jsonify(available=False), 200

    return jsonify(available=True, distance_km=matches[0]["distance_km"]), 200


@customer_bp.route("/apply", methods=["GET", "POST"])
@role_required("user")
# Same per-IP ceiling the mobile app's POST /api/v1/customer/apply and
# POST /api/v1/auth/register use — applying for service is still the
# spam/fake-application-prone step even on the web.
@limiter.limit(lambda: current_app.config["REGISTER_RATE_LIMIT_PER_IP"], methods=["POST"])
def apply():
    """Self-service "Apply for Installation" — the web counterpart to
    the mobile app's ApplyForServiceScreen / POST
    /api/v1/customer/apply (Phase 30's "apply for service" step,
    split out from registration itself). Reached from the portal home
    page's "Apply for Installation" button, shown only when the
    signed-in login has no subscriber record yet.

    One page instead of mobile's three-step wizard: static/js/
    apply-installation.js drives a "Detect my location" -> "Check
    coverage" sequence (against apply_coverage_check() above) before
    the rest of the form is even shown, but this route re-validates
    coverage itself at submit time regardless of what that AJAX call
    said — the browser-reported result is never trusted for the actual
    write, same discipline apply() on the mobile API enforces.

    Refuses outright if the signed-in account already has a subscriber
    on file — one application per account, same rule as mobile.
    """
    if _own_subscriber_or_none() is not None:
        flash("Your login is already linked to a subscriber record.", "info")
        return redirect(url_for("customer.index"))

    form = CustomerApplyForInstallationForm()
    _populate_plan_choices(form)

    if form.validate_on_submit():
        latitude = float(form.latitude.data)
        longitude = float(form.longitude.data)

        if not recommend_naps(latitude, longitude, limit=1):
            flash(
                "Sorry, we don't currently have coverage at this location. "
                "We'll notify you when service becomes available.",
                "danger",
            )
            return render_template("customer/apply.html", form=form)

        full_name = form.full_name.data.strip()
        address = form.address.data.strip() if form.address.data else None
        contact_number = form.contact_number.data.strip() if form.contact_number.data else None
        plan_name = form.plan_name.data or None

        # Same "this also completes the account's profile" reasoning
        # apply() on the mobile API uses — pure registration never
        # collected a real name or phone number.
        g.user.full_name = full_name
        if contact_number:
            g.user.phone_number = contact_number

        subscriber = Subscriber(
            # Temporary unique placeholder, same trick apply() on the
            # mobile API uses — overwritten with the real SUB-####
            # code right after this row gets its own id.
            subscriber_code=f"PENDING-{g.user.id}",
            full_name=full_name,
            address=address,
            latitude=latitude,
            longitude=longitude,
            contact_number=contact_number,
            plan_type=plan_name,
            nap_id=None,  # set later by admin via the existing assign-nap flow
            user_id=g.user.id,
            status="pending_review",
        )
        db.session.add(subscriber)
        db.session.flush()  # assigns subscriber.id
        subscriber.subscriber_code = f"SUB-{subscriber.id:04d}"

        service_request = ServiceRequest(
            request_type="new_installation",
            subscriber_id=subscriber.id,
            latitude=latitude,
            longitude=longitude,
            status="pending",
            notes=f"Self-registered via web portal. Plan requested: {plan_name or 'not specified'}.",
        )
        db.session.add(service_request)
        db.session.commit()

        flash(
            f"Your application '{subscriber.subscriber_code}' has been submitted for review. "
            "We'll notify you once it's approved.",
            "success",
        )
        return redirect(url_for("customer.index"))

    return render_template("customer/apply.html", form=form)


@customer_bp.route("/link-account", methods=["GET", "POST"])
@role_required("user")
# Same two rate-limit values login() uses (per-IP here; this form is a
# credential-guessing-shaped surface — account code + phone — not a
# read-only lookup, now that it can change who a subscriber record
# belongs to).
@limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"], methods=["POST"])
def link_account():
    """Self-service "Link Existing Account" — lets a signed-in login
    with no subscriber record yet attach itself to an existing
    `subscribers` row, for a customer who already has service from
    before creating this portal login.

    This module's docstring explains Phase 10's original decision to
    make subscriber linking staff-only specifically so a customer
    couldn't attach themselves to somebody else's record just by
    knowing its code. Phase 30 later added self-registration on top of
    that model without giving a self-registered-but-already-a-
    subscriber customer any way to reconnect the two — this route
    closes that gap without reopening the original one: it requires
    both the subscriber code AND the phone number already on file to
    match before linking, and gives the same generic failure message
    whichever part was wrong (unknown code, mismatched phone, or a
    code that's real but already linked to a different login) so this
    form can't be used to enumerate which subscriber codes exist or
    are already taken — the same reasoning login()'s own generic
    "Invalid username or password" message follows.
    """
    if _own_subscriber_or_none() is not None:
        flash("Your login is already linked to a subscriber record.", "info")
        return redirect(url_for("customer.index"))

    form = CustomerLinkAccountForm()

    if form.validate_on_submit():
        code = form.subscriber_code.data.strip().upper()
        phone = form.contact_number.data.strip()

        subscriber = Subscriber.query.filter_by(subscriber_code=code).first()

        generic_error = (
            "We couldn't find a subscriber record matching that account number "
            "and phone number. Please double-check both, or contact PG Networks "
            "support for help linking your account."
        )

        if subscriber is None or (subscriber.contact_number or "").strip() != phone:
            flash(generic_error, "danger")
        elif subscriber.user_id is not None:
            flash(generic_error, "danger")
        else:
            subscriber.user_id = g.user.id
            db.session.commit()
            flash(
                f"Your login is now linked to subscriber account {subscriber.subscriber_code}.",
                "success",
            )
            return redirect(url_for("customer.index"))

    return render_template("customer/link_account.html", form=form)


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
