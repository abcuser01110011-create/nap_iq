"""
Mobile API — Customer Portal (Phase 25)
--------------------------------------------
The JSON counterpart to app/routes/customer.py, for the Customer
mobile app. Same ownership rule as that module throughout: every
endpoint here looks the signed-in customer's own subscriber record up
server-side via `subscribers.user_id`, never trusting a subscriber id
supplied by the client — a customer can only ever see or act on their
own record this way, same as the HTML portal.

Routes:
    GET  /api/v1/customer/me                -> me
                                                (own subscriber record + linked NAP)
    POST /api/v1/customer/apply              -> apply
                                                (Phase 30: apply for service —
                                                 for an already-registered,
                                                 signed-in account with no
                                                 subscriber yet)
    POST /api/v1/customer/link-account       -> link_account
                                                (Phase 31: attach an
                                                 already-registered login
                                                 to an existing subscriber
                                                 record it already has)
    GET  /api/v1/customer/issues             -> list_issues
    POST /api/v1/customer/issues             -> report_issue
    GET  /api/v1/customer/service-requests   -> list_service_requests
    GET  /api/v1/customer/payments           -> list_payments
"""
import re
import uuid

import cloudinary
import cloudinary.uploader
from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import current_user

from app.extensions import db, limiter
from app.email_utils import consume_verification, is_email_verified
from app.forms import ISSUE_TYPE_CHOICES
from app.jwt_auth import jwt_role_required
from app.models import Plan, ServiceRequest, Subscriber, TechnicalIssue, User
from app.nap_recommendation import recommend_naps
from app.notifications_utils import notify_new_issue_reported

api_v1_customer_bp = Blueprint("api_v1_customer", __name__, url_prefix="/api/v1/customer")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Same purpose string app/routes/api_v1/auth.py's send-verification-code
# / verify-email-code endpoints already use — apply() is just the step
# that used to be the second half of register() before Phase 30 split
# them, so it reads/consumes verification records under that same
# purpose rather than introducing a second one.
_APPLICATION_EMAIL_PURPOSE = "registration"

# Kept in sync by hand with app/forms.py's CustomerIssueReportForm —
# same validation rule, just enforced here instead of by WTForms since
# this blueprint doesn't use Flask-WTF forms.
_VALID_ISSUE_TYPES = {value for value, _label in ISSUE_TYPE_CHOICES}
_VALID_PRIORITIES = {"low", "medium", "high", "critical"}
_DESCRIPTION_MAX_LENGTH = 2000
# Same allow-list as api_v1/technician.py's ALLOWED_PHOTO_EXTENSIONS,
# duplicated here rather than imported since the two blueprints don't
# otherwise share code.
_ALLOWED_PHOTO_EXTENSIONS = {"jpg", "jpeg", "png", "heic", "webp"}


# Phase 26 — deliberately NOT behind @jwt_role_required: a prospective
# customer needs to check coverage and see plan options *before* they
# have an account. Everything else in this blueprint stays
# authenticated; these two are the only public routes here.
@api_v1_customer_bp.route("/coverage-check", methods=["POST"])
def coverage_check():
    """Pre-registration coverage check for the mobile app's Register
    flow. Thin wrapper around the existing app.nap_recommendation
    engine (built in Phase 22 for the admin's service-request NAP
    assignment) — reused as-is, not reimplemented."""
    data = request.get_json(silent=True) or {}
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        return jsonify(error="Valid latitude and longitude are required."), 400

    matches = recommend_naps(latitude, longitude, limit=1)
    if not matches:
        return jsonify(available=False), 200

    nearest = matches[0]
    return jsonify(
        available=True,
        nearest_nap_code=nearest["nap_code"],
        distance_km=nearest["distance_km"],
    ), 200


@api_v1_customer_bp.route("/plans", methods=["GET"])
def list_plans():
    """Public plan list for the Register flow's plan-selection step.
    Same source table (Settings > App Settings > Plans) the admin
    dropdowns already read from — see Plan's docstring in app/models.py."""
    plans = Plan.query.order_by(Plan.name).all()
    return jsonify(plans=[p.name for p in plans]), 200


def _validate_application(data: dict) -> dict:
    """Returns a field -> message dict of validation errors, empty if
    the payload is clean. Same rules POST /api/v1/auth/register used
    to enforce pre-Phase-30 for everything past username/password —
    moved here as-is since applying for service, not creating the
    login, is what these fields actually belong to.
    """
    errors = {}

    full_name = str(data.get("full_name") or "").strip()
    if not full_name or len(full_name) > 100:
        errors["full_name"] = "Full name is required (max 100 characters)."

    # Email is currently not collected by the mobile app's Apply for
    # Service form (email + its verification step were pulled "for
    # now" — see ApplyForServiceScreen.tsx), so it's optional here too:
    # still validated/verified if a caller does send one, but a missing
    # email is no longer a submission blocker.
    email = str(data.get("email") or "").strip() or None
    if email:
        if len(email) > 100 or not _EMAIL_RE.match(email):
            errors["email"] = "Enter a valid email address."
        elif current_user.email != email and User.query.filter_by(email=email).first() is not None:
            errors["email"] = "This email is already registered."
        elif not is_email_verified(email, purpose=_APPLICATION_EMAIL_PURPOSE):
            # Applicant must have completed the send-code / verify-code
            # exchange (POST /api/v1/auth/send-verification-code and
            # /verify-email-code) for this exact email before the
            # application can be submitted — see
            # app/email_utils.py's is_email_verified().
            errors["email"] = "Please verify this email address before submitting."

    phone_number = str(data.get("phone_number") or "").strip() or None
    if phone_number and len(phone_number) > 20:
        errors["phone_number"] = "Phone number is too long."

    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        errors["location"] = "A valid installation location (latitude/longitude) is required."

    plan_name = str(data.get("plan_name") or "").strip() or None
    if plan_name and Plan.query.filter_by(name=plan_name).first() is None:
        errors["plan_name"] = "Selected plan is no longer available."

    address = str(data.get("address") or "").strip() or None
    if address and len(address) > 255:
        errors["address"] = "Address is too long."

    return errors


def _own_subscriber_or_none():
    """The JSON equivalent of customer.py's _own_subscriber_or_none —
    same lookup, same "never trust a client-supplied id" rule."""
    return Subscriber.query.filter_by(user_id=current_user.id).first()


def _no_subscriber_response():
    """The JSON equivalent of customer.py's _no_subscriber_redirect."""
    return jsonify(
        error="Your login isn't linked to a subscriber record yet. Please contact PG Networks support."
    ), 404


def _serialize_subscriber(subscriber: Subscriber) -> dict:
    nap = subscriber.nap
    return {
        "id": subscriber.id,
        "subscriber_code": subscriber.subscriber_code,
        "full_name": subscriber.full_name,
        "address": subscriber.address,
        "contact_number": subscriber.contact_number,
        "email": subscriber.email,
        "plan_type": subscriber.plan_type,
        "status": subscriber.status,
        "installed_at": subscriber.installed_at.isoformat() if subscriber.installed_at else None,
        "nap": {
            "id": nap.id,
            "nap_code": nap.nap_code,
            "name": nap.name,
        }
        if nap
        else None,
    }


def _serialize_issue(issue: TechnicalIssue) -> dict:
    return {
        "id": issue.id,
        "issue_code": issue.issue_code,
        "issue_type": issue.issue_type,
        "description": issue.description,
        "priority": issue.priority,
        "status": issue.status,
        # issue.photo_filename stores the full Cloudinary secure_url
        # (see the TechnicalIssue model), not a bare filename --
        # same convention as Assignment.photo_filename /
        # _serialize_assignment()'s "photo_url" in api_v1/technician.py.
        "photo_url": issue.photo_filename,
        "created_at": issue.created_at.isoformat() if issue.created_at else None,
        "updated_at": issue.updated_at.isoformat() if issue.updated_at else None,
    }


def _serialize_service_request(sr) -> dict:
    nap = sr.requested_nap
    return {
        "id": sr.id,
        "request_type": sr.request_type,
        "status": sr.status,
        "notes": sr.notes,
        "created_at": sr.created_at.isoformat() if sr.created_at else None,
        "requested_nap": {"id": nap.id, "nap_code": nap.nap_code, "name": nap.name} if nap else None,
    }


def _serialize_payment(payment) -> dict:
    return {
        "id": payment.id,
        "amount": float(payment.amount) if payment.amount is not None else None,
        "payment_method": payment.payment_method,
        "payment_date": payment.payment_date.isoformat() if payment.payment_date else None,
        "reference_number": payment.reference_number,
        "status": payment.status,
    }


@api_v1_customer_bp.route("/me", methods=["GET"])
@jwt_role_required("user")
def me():
    """The signed-in customer's own subscriber record — the mobile
    equivalent of the portal home page's top summary."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_response()
    return jsonify(subscriber=_serialize_subscriber(subscriber)), 200


@api_v1_customer_bp.route("/apply", methods=["POST"])
@jwt_role_required("user")
# Same per-IP ceiling register() used pre-Phase-30 — applying for
# service is still the spam/fake-application-prone step, even though
# the account itself now exists beforehand.
@limiter.limit(lambda: current_app.config["REGISTER_RATE_LIMIT_PER_IP"])
def apply():
    """Apply for service (Phase 30). Splits what POST /api/v1/auth/register
    used to do in one step into its own call: this one runs for an
    *already signed-in* account and creates the Subscriber (status
    'pending_review' — see app/models.py's Subscriber.status comment)
    and the ServiceRequest(request_type='new_installation') that puts
    the application in front of staff, via the same
    service_requests review queue (app/routes/service_requests.py)
    staff-created requests already land in.

    Refuses if the signed-in account already has a subscriber on file
    — one application per account, same as before; a customer who
    wants to change details on an existing application does that
    through the existing service-request/profile flows, not a second
    apply() call.

    Re-checks coverage at submit time via app.nap_recommendation (not
    just trusting whatever the app's earlier coverage-check call
    said), same reasoning register() used to apply here.

    Also fills in full_name/email/phone_number on the signed-in User
    row itself, since the pure-registration step (POST
    /api/v1/auth/register) never collected them — so applying for
    service is also what completes the account's profile.
    """
    if _own_subscriber_or_none() is not None:
        return jsonify(error="You already have an application on file."), 409

    data = request.get_json(silent=True) or {}
    errors = _validate_application(data)
    if errors:
        return jsonify(errors=errors), 400

    latitude = float(data["latitude"])
    longitude = float(data["longitude"])

    if not recommend_naps(latitude, longitude, limit=1):
        return (
            jsonify(
                error="Sorry, we don't currently have coverage at this location. "
                "We'll notify you when service becomes available."
            ),
            422,
        )

    full_name = str(data.get("full_name")).strip()
    email = str(data.get("email") or "").strip() or None
    phone_number = str(data.get("phone_number") or "").strip() or None
    plan_name = str(data.get("plan_name") or "").strip() or None
    address = str(data.get("address") or "").strip() or None

    current_user.full_name = full_name
    current_user.email = email
    current_user.phone_number = phone_number

    subscriber = Subscriber(
        # Temporary unique placeholder — current_user.id is already
        # unique at this point, so this can never collide with a
        # concurrent application the way a shared constant like
        # "PENDING" could. Overwritten with the real SUB-#### code
        # right after this row gets its own id.
        subscriber_code=f"PENDING-{current_user.id}",
        full_name=full_name,
        address=address,
        latitude=latitude,
        longitude=longitude,
        contact_number=phone_number,
        email=email,
        plan_type=plan_name,
        nap_id=None,  # set later by admin via the existing assign-nap flow
        user_id=current_user.id,
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
        notes=f"Self-registered via mobile app. Plan requested: {plan_name or 'not specified'}.",
    )
    db.session.add(service_request)
    db.session.commit()

    # The email's verification record has now done its job — remove it
    # so it can't be replayed against a second application.
    if email:
        consume_verification(email, purpose=_APPLICATION_EMAIL_PURPOSE)

    return jsonify(subscriber=_serialize_subscriber(subscriber)), 201


@api_v1_customer_bp.route("/link-account", methods=["POST"])
@jwt_role_required("user")
# Same rate-limit ceiling app/routes/customer.py's link_account() uses
# for the HTML portal form (see that route's docstring for why: this
# is a credential-guessing-shaped surface -- account code + phone --
# not a read-only lookup).
@limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"])
def link_account():
    """The mobile equivalent of app/routes/customer.py's link_account()
    -- lets a signed-in account with no subscriber yet attach itself to
    an existing `subscribers` row, for a customer who already has
    service from before creating this login.

    Same rule that route's docstring explains: requires both the
    subscriber code AND the phone number already on file to match, and
    returns the same generic error whichever part was wrong (unknown
    code, mismatched phone, or a code that's real but already linked
    to a different login), so this can't be used to enumerate which
    subscriber codes exist or are already taken.
    """
    if _own_subscriber_or_none() is not None:
        return jsonify(error="Your login is already linked to a subscriber record."), 409

    data = request.get_json(silent=True) or {}
    code = str(data.get("subscriber_code") or "").strip().upper()
    phone = str(data.get("contact_number") or "").strip()

    if not code or not phone:
        return jsonify(
            errors={
                **({"subscriber_code": "Subscriber account number is required."} if not code else {}),
                **({"contact_number": "Phone number is required."} if not phone else {}),
            }
        ), 400

    generic_error = (
        "We couldn't find a subscriber record matching that account number "
        "and phone number. Please double-check both, or contact PG Networks "
        "support for help linking your account."
    )

    subscriber = Subscriber.query.filter_by(subscriber_code=code).first()

    if (
        subscriber is None
        or (subscriber.contact_number or "").strip() != phone
        or subscriber.user_id is not None
    ):
        return jsonify(error=generic_error), 400

    subscriber.user_id = current_user.id
    db.session.commit()

    return jsonify(subscriber=_serialize_subscriber(subscriber)), 200


@api_v1_customer_bp.route("/issues", methods=["GET"])
@jwt_role_required("user")
def list_issues():
    """Full list of the signed-in customer's own technical issues,
    already newest-first via Subscriber.technical_issues (app/models.py)."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_response()
    return jsonify(issues=[_serialize_issue(i) for i in subscriber.technical_issues]), 200


@api_v1_customer_bp.route("/issues", methods=["POST"])
@jwt_role_required("user")
def report_issue():
    """Self-service issue reporting. Always attributed to the signed-in
    customer's own linked subscriber, and always uses that
    subscriber's stored address/coordinates — exactly as
    customer.py's report_issue() does, since the mobile app has no map
    for a customer to drop a pin on either.

    Expects multipart/form-data (issue_type, priority, description
    fields plus a required "photo" file field) rather than a JSON
    body, since a photo isn't JSON — mirrors
    upload_assignment_photo()'s file handling in api_v1/technician.py.
    This blueprint is already csrf-exempt as a whole (see this
    module's docstring), so that isn't a concern here either.
    """
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_response()

    issue_type = str(request.form.get("issue_type") or "").strip()
    priority = str(request.form.get("priority") or "medium").strip()
    description = str(request.form.get("description") or "").strip()
    photo = request.files.get("photo")

    errors = {}
    if issue_type not in _VALID_ISSUE_TYPES:
        errors["issue_type"] = "Issue type is required and must be one of the supported types."
    if priority not in _VALID_PRIORITIES:
        errors["priority"] = "Priority must be one of: low, medium, high, critical."
    if not description:
        errors["description"] = "Please describe the issue."
    elif len(description) > _DESCRIPTION_MAX_LENGTH:
        errors["description"] = "Description is too long."

    if photo is None or photo.filename == "":
        errors["photo"] = "Please attach or take a photo of the issue."
    else:
        ext = photo.filename.rsplit(".", 1)[-1].lower() if "." in photo.filename else ""
        if ext not in _ALLOWED_PHOTO_EXTENSIONS:
            errors["photo"] = "Unsupported photo format. Use JPG, PNG, HEIC, or WEBP."

    if errors:
        return jsonify(errors=errors), 400

    # Uploaded to Cloudinary before the issue row is created — same
    # "serverless has no writable local disk" reasoning as
    # upload_assignment_photo() — so a failed upload never leaves a
    # half-reported issue behind.
    public_id = f"issue-photos/issue-{uuid.uuid4().hex}"
    try:
        upload_result = cloudinary.uploader.upload(photo, public_id=public_id, overwrite=True)
    except Exception:
        return jsonify(error="Photo upload failed. Please try again."), 502

    issue = TechnicalIssue(
        issue_type=issue_type,
        description=description,
        priority=priority,
        status="pending",
        address=subscriber.address,
        latitude=subscriber.latitude,
        longitude=subscriber.longitude,
        photo_filename=upload_result["secure_url"],
        subscriber_id=subscriber.id,
        nap_id=subscriber.nap_id,
    )
    db.session.add(issue)
    db.session.commit()

    # Same issue_code convention as the staff and portal HTML routes.
    issue.issue_code = f"ISS-{issue.id:04d}"
    notify_new_issue_reported(issue)
    db.session.commit()

    return jsonify(issue=_serialize_issue(issue)), 201


@api_v1_customer_bp.route("/service-requests", methods=["GET"])
@jwt_role_required("user")
def list_service_requests():
    """Full list of the signed-in customer's own service requests,
    already newest-first via Subscriber.service_requests (app/models.py)."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_response()
    return jsonify(
        service_requests=[_serialize_service_request(sr) for sr in subscriber.service_requests]
    ), 200


@api_v1_customer_bp.route("/payments", methods=["GET"])
@jwt_role_required("user")
def list_payments():
    """The signed-in customer's own payment history — read-only, same
    as the HTML portal (a customer never records a payment themself)."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_response()
    return jsonify(payments=[_serialize_payment(p) for p in subscriber.payments]), 200

# Coverage radius (km) — a location is "covered" if it falls within
# this distance of at least one active NAP. Adjust as needed once
# real service-area rules are defined.
_COVERAGE_RADIUS_KM = 2.0


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance between two lat/lon points, in km."""
    R = 6371.0  # Earth's radius in km
    lat1, lon1, lat2, lon2 = map(radians, [float(lat1), float(lon1), float(lat2), float(lon2)])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


@api_v1_customer_bp.route("/coverage-check", methods=["POST"])
def check_coverage():
    """Public (pre-login) endpoint used by the registration flow's
    location step. Finds the nearest active NAP to the submitted
    coordinates and reports whether it falls within service range."""
    data = request.get_json(silent=True) or {}
    latitude = data.get("latitude")
    longitude = data.get("longitude")

    if latitude is None or longitude is None:
        return jsonify(error="Latitude and longitude are required."), 400

    naps = Nap.query.filter_by(status="active").all()
    if not naps:
        return jsonify(available=False), 200

    nearest_km = min(
        _haversine_km(latitude, longitude, nap.latitude, nap.longitude) for nap in naps
    )

    return jsonify(
        available=nearest_km <= _COVERAGE_RADIUS_KM,
        distance_km=round(nearest_km, 2),
    ), 200
