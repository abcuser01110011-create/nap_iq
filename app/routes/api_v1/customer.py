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
    GET  /api/v1/customer/issues             -> list_issues
    POST /api/v1/customer/issues             -> report_issue
    GET  /api/v1/customer/service-requests   -> list_service_requests
    GET  /api/v1/customer/payments           -> list_payments
"""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import current_user
from math import radians, sin, cos, sqrt, atan2

from app.extensions import db
from app.forms import ISSUE_TYPE_CHOICES
from app.jwt_auth import jwt_role_required
from app.models import Subscriber, TechnicalIssue, Nap, Plan
from app.notifications_utils import notify_new_issue_reported
from app.models import Plan, Subscriber, TechnicalIssue
from app.nap_recommendation import recommend_naps
from app.notifications_utils import notify_new_issue_reported

api_v1_customer_bp = Blueprint("api_v1_customer", __name__, url_prefix="/api/v1/customer")

# Kept in sync by hand with app/forms.py's CustomerIssueReportForm —
# same validation rule, just enforced here instead of by WTForms since
# this blueprint takes a JSON body, not a form post.
_VALID_ISSUE_TYPES = {value for value, _label in ISSUE_TYPE_CHOICES}
_VALID_PRIORITIES = {"low", "medium", "high", "critical"}
_DESCRIPTION_MAX_LENGTH = 2000


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


def _own_subscriber_or_none():
    """The JSON equivalent of customer.py's _own_subscriber_or_none —
    same lookup, same "never trust a client-supplied id" rule."""
    return Subscriber.query.filter_by(user_id=current_user.id).first()


def _no_subscriber_response():
    """The JSON equivalent of customer.py's _no_subscriber_redirect."""
    return jsonify(
        error="Your login isn't linked to a subscriber record yet. Please contact NAP-IQ support."
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
    for a customer to drop a pin on either."""
    subscriber = _own_subscriber_or_none()
    if subscriber is None:
        return _no_subscriber_response()

    data = request.get_json(silent=True) or {}
    issue_type = str(data.get("issue_type") or "").strip()
    priority = str(data.get("priority") or "medium").strip()
    description = str(data.get("description") or "").strip()

    errors = {}
    if issue_type not in _VALID_ISSUE_TYPES:
        errors["issue_type"] = "Issue type is required and must be one of the supported types."
    if priority not in _VALID_PRIORITIES:
        errors["priority"] = "Priority must be one of: low, medium, high, critical."
    if not description:
        errors["description"] = "Please describe the issue."
    elif len(description) > _DESCRIPTION_MAX_LENGTH:
        errors["description"] = "Description is too long."

    if errors:
        return jsonify(errors=errors), 400

    issue = TechnicalIssue(
        issue_type=issue_type,
        description=description,
        priority=priority,
        status="pending",
        address=subscriber.address,
        latitude=subscriber.latitude,
        longitude=subscriber.longitude,
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


@api_v1_customer_bp.route("/plans", methods=["GET"])
def list_plans():
    """Public (pre-login) list of available plan names, shown to a
    new customer after a successful coverage check."""
    plans = Plan.query.order_by(Plan.name).all()
    return jsonify(plans=[p.name for p in plans]), 200
