"""
Manage Subscribers Blueprint (Administrator only) — Phase 12
-----------------------------------------------------------------
Fills in the "Subscribers" sidebar placeholder flagged as a follow-up
in PHASE10_NOTES.md / PHASE11_NOTES.md: an Administrator-only UI for
creating and editing `subscribers` rows (an ISP customer's
service/billing record), which previously only existed via direct SQL
/ seed data.

This module manages `subscribers` rows only. It does NOT manage the
`subscribers.user_id` login link — that stays owned by the Manage
Users "Linked Subscriber" dropdown (Phase 10, app/routes/users.py),
which already reconciles the link both ways and enforces one-user-
per-subscriber uniqueness. Keeping that logic in exactly one place
avoids two forms racing to set the same column. This page shows the
linked account (if any) as read-only info and links to Manage Users
for changing it.

Records are never physically deleted — a subscriber that leaves is
`disconnected` via the `status` column (same soft-delete-by-status
pattern `naps.status` already uses), not row-deleted, so historical
issues/payments/service-requests attached to it stay intact.

Routes:
    GET  /subscribers/               -> list_subscribers  (search + status filter)
    GET  /subscribers/add            -> add_subscriber     (show add form)
    POST /subscribers/add            -> add_subscriber     (process add form)
    POST /subscribers/quick-add      -> quick_add_subscriber (create subscriber
                                          from the GeoMap "Plan Installation"
                                          flow, JSON — Installation Planning
                                          integration, Phase 5 / 70%)
    GET  /subscribers/<id>           -> view_subscriber    (view details)
    GET  /subscribers/<id>/edit      -> edit_subscriber    (show edit form)
    POST /subscribers/<id>/edit      -> edit_subscriber    (process edit form)
"""

from datetime import datetime
from decimal import Decimal, InvalidOperation

from flask import Blueprint, render_template, redirect, url_for, request, flash, jsonify

from app.extensions import db
from app.auth import role_required
from app.models import Subscriber, Nap, Plan, ServiceRequest
from app.forms import SubscriberForm, MapQuickInstallSubscriberForm

subscribers_bp = Blueprint("subscribers", __name__, url_prefix="/subscribers")


def _populate_nap_choices(form):
    """Fills in the 'Connected NAP' dropdown from the current contents
    of the `naps` table, same dynamic-choices pattern used everywhere
    else in the app (IssueReportForm.nap_id, AssignTechnicianForm)."""
    naps = Nap.query.order_by(Nap.name).all()
    form.nap_id.choices = [(0, "-- Not connected --")] + [
        (n.id, f"{n.nap_code} — {n.name}") for n in naps
    ]


def _populate_plan_choices(form, current_value=None):
    """Fills in the 'Plan Type' dropdown from the current contents of
    the `plans` table (Settings > App Settings > Plans), same
    dynamic-choices pattern as `_populate_nap_choices()` above.

    `current_value` is the subscriber's existing `plan_type` when
    editing (None when adding). If it's set and isn't already one of
    the curated plan names -- a legacy or one-off value typed back
    when this field was still free text -- it's appended as its own
    choice so opening the edit form doesn't silently blank it out or
    fail validation the moment the page loads."""
    plans = Plan.query.order_by(Plan.name).all()
    plan_names = [p.name for p in plans]
    choices = [("", "-- None --")] + [(name, name) for name in plan_names]
    if current_value and current_value not in plan_names:
        choices.append((current_value, f"{current_value} (legacy)"))
    form.plan_type.choices = choices


@subscribers_bp.route("/")
@role_required("administrator")
def list_subscribers():
    """Displays all subscribers, with optional search (by code, name,
    or email) and status filtering via query string parameters
    (?q=...&status=...)."""
    search_term = request.args.get("q", "").strip()
    status_filter = request.args.get("status", "").strip()

    query = Subscriber.query

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.filter(
            db.or_(
                Subscriber.subscriber_code.ilike(like_pattern),
                Subscriber.full_name.ilike(like_pattern),
                Subscriber.email.ilike(like_pattern),
            )
        )

    if status_filter:
        query = query.filter(Subscriber.status == status_filter)

    subscribers = query.order_by(Subscriber.full_name.asc()).all()

    return render_template(
        "subscribers/list.html",
        subscribers=subscribers,
        search_term=search_term,
        status_filter=status_filter,
    )


def _decimal_from_arg(value):
    """Best-effort str->Decimal for a query-string coordinate, matching
    the DecimalField(places=7) fields it's headed into. Returns None on
    anything missing or unparseable rather than raising -- a bad/absent
    query param should just mean "don't pre-fill this", never a 500."""
    if value in (None, ""):
        return None
    try:
        return Decimal(value)
    except (InvalidOperation, ValueError):
        return None


@subscribers_bp.route("/add", methods=["GET", "POST"])
@role_required("administrator")
def add_subscriber():
    """Shows and processes the Add Subscriber form.

    Also doubles as the landing page for the "completed new_installation
    request has no subscriber yet" hand-off service_requests.edit_request()
    redirects to (see that route's own comment) when it detects a
    request being marked 'completed' with nothing linked to it yet.
    ?nap_id=&latitude=&longitude= pre-fill what's already on file for
    that request (the assigned NAP and the customer's coordinates) so
    the admin isn't re-entering data that was already captured, and
    ?service_request_id=, carried through the form as a plain hidden
    input (it isn't a real Subscriber column, so it's not a SubscriberForm
    field), links the new subscriber back onto that request once this
    form is actually submitted -- closing the loop instead of leaving a
    completed install with no linked, billable account.
    """
    form = SubscriberForm()
    form.subscriber_id_value = None
    _populate_nap_choices(form)
    _populate_plan_choices(form)

    # Re-looked-up (never trusted blindly from the query string/hidden
    # field) and only honored if it's still exactly the case this
    # hand-off is for -- a real new_installation request that still has
    # no subscriber -- the same "re-validate anything client-supplied"
    # rule every other route in this app already follows. A stale,
    # bogus, or already-resolved id is silently ignored rather than
    # blocked, so the form still works as a plain Add Subscriber page.
    service_request_id = request.values.get("service_request_id", type=int)
    linked_service_request = None
    if service_request_id:
        candidate = ServiceRequest.query.get(service_request_id)
        if (
            candidate is not None
            and candidate.request_type == "new_installation"
            and not candidate.subscriber_id
        ):
            linked_service_request = candidate
        else:
            service_request_id = None

    if request.method == "GET":
        prefill_nap_id = request.args.get("nap_id", type=int)
        if prefill_nap_id:
            form.nap_id.data = prefill_nap_id
        prefill_lat = _decimal_from_arg(request.args.get("latitude"))
        if prefill_lat is not None:
            form.latitude.data = prefill_lat
        prefill_lng = _decimal_from_arg(request.args.get("longitude"))
        if prefill_lng is not None:
            form.longitude.data = prefill_lng

    if form.validate_on_submit():
        installed_at = None
        if form.installed_at.data:
            installed_at = datetime.strptime(form.installed_at.data.strip(), "%Y-%m-%d").date()

        subscriber = Subscriber(
            subscriber_code=form.subscriber_code.data.strip(),
            full_name=form.full_name.data.strip(),
            address=(form.address.data or "").strip() or None,
            latitude=form.latitude.data,
            longitude=form.longitude.data,
            contact_number=(form.contact_number.data or "").strip() or None,
            email=(form.email.data or "").strip() or None,
            plan_type=(form.plan_type.data or "").strip() or None,
            nap_id=form.nap_id.data or None,  # 0 sentinel -> NULL
            status=form.status.data,
            installed_at=installed_at,
        )
        db.session.add(subscriber)
        db.session.flush()  # assigns subscriber.id, needed below before commit

        if linked_service_request:
            linked_service_request.subscriber_id = subscriber.id

        db.session.commit()

        if linked_service_request:
            flash(
                f"Subscriber '{subscriber.subscriber_code}' was created and linked back to "
                f"service request #{linked_service_request.id} -- the installation is now fully activated.",
                "success",
            )
        else:
            flash(f"Subscriber '{subscriber.subscriber_code}' was created successfully.", "success")
        return redirect(url_for("subscribers.list_subscribers"))

    return render_template(
        "subscribers/form.html",
        form=form,
        mode="add",
        subscriber=None,
        linked_service_request=linked_service_request,
        service_request_id=service_request_id,
    )


@subscribers_bp.route("/quick-add", methods=["POST"])
@role_required("administrator")
def quick_add_subscriber():
    """Installation Planning integration, Phase 5 (70%) — creates a
    Subscriber row directly from the GeoMap's "Plan Installation"
    flow (app/static/js/nap-install-planner.js), after the admin has
    already seen the Phase 2 nearest-available-NAP suggestion for a
    dropped pin (Phase 4) and clicked "Use this NAP & add subscriber".

    Mirrors naps.quick_add_nap()'s exact shape: called via
    fetch()/AJAX rather than a page navigation, so it takes and
    returns JSON instead of redirecting; CSRF-protected by the same
    global CSRFProtect every other POST route in this app already
    uses (X-CSRFToken header, read from the <meta name="csrf-token">
    tag already on every page). See PLAN_INSTALL_10_PERCENT_NOTES.md
    §5 for why this creates a Subscriber directly rather than a
    ServiceRequest, and that file's §3 for why subscriber_code stays
    a manually-typed, uniqueness-checked field rather than an
    invented generation scheme.

    This is a second *caller* of the existing Subscriber-creation
    validation (MapQuickInstallSubscriberForm mirrors SubscriberForm's
    relevant fields/validators exactly, the same relationship
    MapQuickAddNapForm already has to NapForm), not a second,
    divergent way of writing a subscriber row — the actual
    `Subscriber(...)` construction below matches add_subscriber()'s
    field-by-field shape. add_subscriber() itself is completely
    unmodified and unaffected by this route's existence.
    """
    form = MapQuickInstallSubscriberForm()

    if not form.validate_on_submit():
        return jsonify({"status": "error", "errors": form.errors}), 400

    # Re-validated here rather than trusted from the page that posted
    # this, same reasoning quick_add_nap() and assign_nap() already
    # document for their own client-sourced values: the NAP shown as
    # "available" when the suggestion was fetched could have gone
    # inactive or filled up by the time this form is actually
    # submitted.
    nap = Nap.query.get(form.nap_id.data)
    if nap is None:
        return jsonify({"status": "error", "errors": {"nap_id": ["Selected NAP no longer exists."]}}), 400
    if nap.status != "active" or (nap.available_ports or 0) <= 0:
        return (
            jsonify(
                {
                    "status": "error",
                    "errors": {
                        "nap_id": [
                            "This NAP no longer has available capacity. "
                            "Drop the pin again to get an updated suggestion."
                        ]
                    },
                }
            ),
            409,
        )

    # Field-for-field the same shape as add_subscriber()'s own
    # Subscriber(...) construction above (contact_number/email are
    # simply not collected by this quick form — see
    # MapQuickInstallSubscriberForm's docstring — so they stay NULL,
    # matching every other optional column when left blank elsewhere
    # in this app, rather than a fabricated placeholder value). This
    # route does not adjust nap.used_ports/available_ports, matching
    # add_subscriber()'s own behavior exactly — neither the existing
    # Subscribers -> Add Subscriber route nor Phase 22's assign_nap()
    # touches that bookkeeping when linking a subscriber/request to a
    # NAP, so this route introduces no new, divergent behavior there.
    subscriber = Subscriber(
        subscriber_code=form.subscriber_code.data.strip(),
        full_name=form.full_name.data.strip(),
        address=(form.address.data or "").strip() or None,
        latitude=form.latitude.data,
        longitude=form.longitude.data,
        plan_type=(form.plan_type.data or "").strip() or None,
        nap_id=nap.id,
        status="active",
    )
    db.session.add(subscriber)
    db.session.commit()

    return (
        jsonify(
            {
                "status": "success",
                "message": f"Subscriber '{subscriber.subscriber_code}' was created and linked to {nap.nap_code}.",
                "subscriber": {
                    "id": subscriber.id,
                    "subscriber_code": subscriber.subscriber_code,
                    "full_name": subscriber.full_name,
                    "address": subscriber.address,
                    "latitude": float(subscriber.latitude) if subscriber.latitude is not None else None,
                    "longitude": float(subscriber.longitude) if subscriber.longitude is not None else None,
                    "plan_type": subscriber.plan_type,
                    "status": subscriber.status,
                    "nap_id": nap.id,
                    "nap_code": nap.nap_code,
                },
            }
        ),
        201,
    )


@subscribers_bp.route("/<int:subscriber_id>")
@role_required("administrator")
def view_subscriber(subscriber_id):
    """Read-only detail view: subscriber info, linked NAP, linked login
    account (if any), and a quick summary of related issues/payments/
    service requests (already ordered newest-first by the model
    relationships)."""
    subscriber = Subscriber.query.get_or_404(subscriber_id)
    return render_template("subscribers/view.html", subscriber=subscriber)


@subscribers_bp.route("/<int:subscriber_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_subscriber(subscriber_id):
    """Shows and processes the Edit Subscriber form."""
    subscriber = Subscriber.query.get_or_404(subscriber_id)

    form = SubscriberForm(obj=subscriber)
    form.subscriber_id_value = subscriber.id
    _populate_nap_choices(form)
    _populate_plan_choices(form, current_value=subscriber.plan_type)
    if request.method == "GET":
        form.nap_id.data = subscriber.nap_id or 0
        form.plan_type.data = subscriber.plan_type or ""
        if subscriber.installed_at:
            form.installed_at.data = subscriber.installed_at.strftime("%Y-%m-%d")

    if form.validate_on_submit():
        installed_at = None
        if form.installed_at.data:
            installed_at = datetime.strptime(form.installed_at.data.strip(), "%Y-%m-%d").date()

        subscriber.subscriber_code = form.subscriber_code.data.strip()
        subscriber.full_name = form.full_name.data.strip()
        subscriber.address = (form.address.data or "").strip() or None
        subscriber.latitude = form.latitude.data
        subscriber.longitude = form.longitude.data
        subscriber.contact_number = (form.contact_number.data or "").strip() or None
        subscriber.email = (form.email.data or "").strip() or None
        subscriber.plan_type = (form.plan_type.data or "").strip() or None
        subscriber.nap_id = form.nap_id.data or None
        subscriber.status = form.status.data
        subscriber.installed_at = installed_at

        db.session.commit()
        flash(f"Subscriber '{subscriber.subscriber_code}' was updated successfully.", "success")
        return redirect(url_for("subscribers.list_subscribers"))

    return render_template(
        "subscribers/form.html", form=form, mode="edit", subscriber=subscriber
    )
