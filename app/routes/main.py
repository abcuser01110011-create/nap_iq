"""
Main Blueprint
---------------
Holds general-purpose routes that don't belong to a specific feature
module yet. For this foundation phase, this is just a landing route
and the /database-test diagnostic route.
"""

import re
import secrets
from functools import wraps

from flask import (
    Blueprint, current_app, jsonify, make_response, redirect, render_template,
    request, session, url_for, g, flash,
)

from app.extensions import db, limiter
from app.auth import role_required
from app.models import Plan, ServiceRequest, Subscriber, User
from app.nap_recommendation import recommend_naps
from app.subscriber_lookup import find_subscriber_for_link
from flask_wtf.csrf import CSRFError, generate_csrf
from sqlalchemy import text

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
def index():
    """Redirects to the right place depending on whether anyone is
    signed in, and if so, which role they have. Login/RBAC (Phase 7)
    means '/' can no longer always send everyone to the Administrator
    Dashboard the way it did before this phase."""
    if g.get("user") is not None:
        return redirect(url_for("auth.home"))
    # Guests get the public landing page (online application + account
    # login). Staff sign in at /login.
    plans = Plan.query.order_by(Plan.monthly_fee.is_(None), Plan.monthly_fee, Plan.name).all()
    resp = make_response(render_template("pages/landing.html", plans=plans))
    # The page embeds a per-session CSRF token; a cached copy (common on
    # phones / mobile data) would carry a token that no longer matches.
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


@main_bp.route("/database-test")
@role_required("administrator")
def database_test():
    """Confirms whether Flask can successfully connect to MySQL.

    Runs a trivial `SELECT 1` query through the SQLAlchemy engine.
    Returns JSON so it's easy to check from a browser, curl, or Postman.
    """
    try:
        db.session.execute(text("SELECT 1"))
        return jsonify(
            {
                "status": "success",
                "message": "Successfully connected to the MySQL database.",
                "database": db.engine.url.database,
            }
        )
    except Exception as exc:  # noqa: BLE001 - we want to surface any DB error here
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Failed to connect to the MySQL database.",
                    "details": str(exc),
                }
            ),
            500,
        )


# ---------------------------------------------------------------------------
# Landing-page popups (Log in / Apply online)
# ---------------------------------------------------------------------------
# These JSON endpoints back the two modals on pages/landing.html
# (static/js/landing-modals.js). Both are public (no login needed) and
# CSRF-protected through the X-CSRFToken header like every other POST.

_PHONE_RE = re.compile(r"^\d{11}$")
_GENERIC_LOGIN_ERROR = (
    "We couldn't find a subscriber record matching that account number or name "
    "and phone number. Please double-check both, or contact PG Networks "
    "support for help."
)


def _safe_json(view):
    """Any unexpected error inside a popup endpoint becomes a JSON 500
    (and is logged with its traceback) instead of an HTML error page the
    popup can't read."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        try:
            return view(*args, **kwargs)
        except Exception:  # noqa: BLE001
            db.session.rollback()
            ref = secrets.token_hex(3).upper()
            current_app.logger.exception("Landing popup endpoint failed [ref %s]: %s", ref, request.path)
            return jsonify(
                ok=False,
                message=f"Something went wrong on our side. Please try again in a moment. (Ref: {ref})",
            ), 500
    return wrapped


@main_bp.errorhandler(CSRFError)
def _public_csrf_failed(_error):
    return jsonify(
        ok=False,
        code="csrf",
        message="Your page was open too long or your session expired. Please refresh the page and try again.",
    ), 400


@main_bp.errorhandler(429)
def _public_rate_limited(_error):
    return jsonify(ok=False, message="Too many attempts. Please wait a minute and try again."), 429


def _json_body():
    return request.get_json(silent=True) or {}


def _unique_username(base):
    """`SUB-0123` -> that, or `SUB-0123-2`, `-3`... if somehow taken."""
    candidate, n = base, 1
    while User.query.filter_by(username=candidate).first() is not None:
        n += 1
        candidate = f"{base}-{n}"
    return candidate


@main_bp.route("/public/csrf-token")
def public_csrf_token():
    """Fresh CSRF token for the landing popups (used to retry once when the
    page's original token no longer matches the visitor's session)."""
    resp = jsonify(token=generate_csrf())
    resp.headers["Cache-Control"] = "no-store"
    return resp


@main_bp.route("/public/account-login", methods=["POST"])
@limiter.limit(lambda: current_app.config["LOGIN_RATE_LIMIT_PER_IP"])
@_safe_json
def public_account_login():
    """Popup "Log in": subscriber account number + phone number on file.

    Same two-factor match CustomerLinkAccountForm / customer.link_account
    uses (code AND phone, one generic error for every failure so it
    can't be used to enumerate account numbers).

    - Subscriber already has a portal login  -> sign in as that login.
    - Subscriber has no portal login yet     -> this *is* the linking
      step: a portal login is created for the record, linked, and
      signed in.
    """
    if g.get("user") is not None:
        return jsonify(ok=True, redirect=url_for("auth.home"))

    data = _json_body()
    code = str(data.get("subscriber_code") or "").strip()  # account number OR full name
    phone = str(data.get("contact_number") or "").strip()

    errors = {}
    if not code:
        errors["subscriber_code"] = "Your account number or full name is required."
    elif len(code) > 150:
        errors["subscriber_code"] = "Account number or name is too long."
    if not phone:
        errors["contact_number"] = "The phone number on your account is required."
    elif not _PHONE_RE.match(phone):
        errors["contact_number"] = "Phone number must be exactly 11 digits (numbers only)."
    if errors:
        return jsonify(ok=False, errors=errors), 400

    subscriber = find_subscriber_for_link(code, phone)
    if subscriber is None:
        return jsonify(ok=False, message=_GENERIC_LOGIN_ERROR), 401

    user = subscriber.user
    if user is not None:
        if user.role != "user":
            return jsonify(ok=False, message=_GENERIC_LOGIN_ERROR), 401
        if user.status != "active":
            return jsonify(
                ok=False,
                message="This account has been deactivated. Please contact an administrator.",
            ), 403
    else:
        user = User(
            username=_unique_username(subscriber.subscriber_code),
            full_name=subscriber.full_name,
            phone_number=phone,
            role="user",
            status="active",
        )
        # Random, never shown: the account is entered via account
        # number + phone. Staff can reset it from Manage Users if the
        # customer later wants a username/password login.
        user.set_password(secrets.token_urlsafe(24))
        db.session.add(user)
        db.session.flush()
        subscriber.user_id = user.id
        db.session.commit()

    session.clear()
    session["user_id"] = user.id
    session.permanent = True
    flash(f"Welcome back, {user.full_name}.", "success")
    return jsonify(ok=True, redirect=url_for("auth.home"))


@main_bp.route("/public/apply/coverage-check", methods=["GET"])
@limiter.limit("60 per hour")
@_safe_json
def public_apply_coverage_check():
    """Popup "Apply online" step 1: is this point covered? Read-only, so it
    is a GET (no CSRF token to expire; works the same on phones)."""
    try:
        latitude = float(request.args.get("latitude"))
        longitude = float(request.args.get("longitude"))
    except (TypeError, ValueError):
        return jsonify(error="Valid latitude and longitude are required."), 400
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return jsonify(error="Valid latitude and longitude are required."), 400

    matches = recommend_naps(latitude, longitude, limit=1)
    resp = jsonify(available=bool(matches),
                   **({"distance_km": matches[0]["distance_km"]} if matches else {}))
    resp.headers["Cache-Control"] = "no-store"
    return resp, 200


@main_bp.route("/public/apply", methods=["POST"])
@limiter.limit(lambda: current_app.config["REGISTER_RATE_LIMIT_PER_IP"])
@_safe_json
def public_apply():
    """Popup "Apply online" step 2: submit the installation application.

    Creates a `pending_review` Subscriber + a `new_installation`
    ServiceRequest exactly like customer.apply() does, but without a
    portal login (guest). The applicant gets their SUB-#### number back
    and can later use it with their phone number in the Log in popup,
    which creates/links their portal login at that point.
    Coverage is re-checked server-side; the browser's earlier answer is
    never trusted.
    """
    data = _json_body()
    full_name = str(data.get("full_name") or "").strip()
    address = str(data.get("address") or "").strip()
    phone = str(data.get("contact_number") or "").strip()
    plan_name = str(data.get("plan_name") or "").strip() or None

    errors = {}
    if not full_name:
        errors["full_name"] = "Full name is required."
    elif len(full_name) > 100:
        errors["full_name"] = "Full name must be at most 100 characters."
    if not address:
        errors["address"] = "Installation address is required."
    elif len(address) > 255:
        errors["address"] = "Address is too long."
    if not _PHONE_RE.match(phone):
        errors["contact_number"] = "Phone number must be exactly 11 digits (numbers only)."
    if plan_name and len(plan_name) > 50:
        errors["plan_name"] = "Invalid plan."
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Please detect your location and check coverage first."), 400
    if errors:
        return jsonify(ok=False, errors=errors), 400

    if not recommend_naps(latitude, longitude, limit=1):
        return jsonify(
            ok=False,
            message="Sorry, we don't currently have coverage at this location. "
                    "We'll notify you when service becomes available.",
        ), 409

    subscriber = Subscriber(
        subscriber_code=f"PENDING-{secrets.token_hex(6)}",  # <=20 chars, replaced below
        full_name=full_name,
        address=address,
        latitude=round(latitude, 7),
        longitude=round(longitude, 7),
        contact_number=phone,
        plan_type=plan_name,
        nap_id=None,
        user_id=None,
        status="pending_review",
    )
    db.session.add(subscriber)
    db.session.flush()
    subscriber.subscriber_code = f"SUB-{subscriber.id:04d}"

    db.session.add(ServiceRequest(
        request_type="new_installation",
        subscriber_id=subscriber.id,
        status="pending",
        priority="low",
        latitude=round(latitude, 7),
        longitude=round(longitude, 7),
        # Applicant details + plan, so the staff Service Request page shows
        # them the same way it does for walk-in requests.
        full_name=full_name,
        address=address,
        contact_number=phone,
        plan_label=plan_name,
        notes="Self-registered via public landing page.",
    ))
    db.session.commit()

    return jsonify(ok=True, subscriber_code=subscriber.subscriber_code), 201
