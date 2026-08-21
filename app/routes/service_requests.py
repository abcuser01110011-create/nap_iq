"""
Administrator Service Requests Blueprint — Phase 15
--------------------------------------------------------
Fills in the "Service Requests" sidebar placeholder that was
deliberately left disabled ("Coming soon"). This is the full
management module — creating a service request for any subscriber
(or a walk-in applicant with no subscriber record yet, matching
existing seed data), and editing every field including status —
distinct from the customer-facing `customer.my_service_requests`
page added in Phase 14, which is a read-only view scoped to the
signed-in customer's own requests.

Records are never physically deleted — same reasoning as
subscribers.py/naps.py's soft-delete-by-status: a rejected/completed
request stays in the table as a record of what was asked for and how
it was resolved, rather than disappearing.

Phase 16: a one-click Approve/Reject quick action was added
(`approve_request`/`reject_request`, below), same
confirm-then-POST-redirect shape as naps.py's activate/deactivate.
Both only apply to a request currently `pending` — approving or
rejecting a request that's already moved past that first decision
(scheduled/completed/rejected/approved) isn't a meaningful one-click
action, so those transitions still go through the full edit form,
same as every other status change. The full edit form's Status field
is untouched and still allows setting any of the five states
directly (e.g. moving a request straight to `scheduled` or
`completed`), same as before.

Phase 17: every route below that changes an existing request's status
(edit_request, approve_request, reject_request — not add_request,
since a brand-new request has nothing to "change" yet) now also
records a Notification via `_notify_status_change()` /
app/notifications_utils.py — see PHASE17_NOTES.md.

Phase 22 (phase_11.pdf, "nearest available NAP recommendation"):
`recommend_nap()` and `assign_nap()` below are the two new routes this
phase adds — see app/nap_recommendation.py's module docstring for the
full algorithm/query/distance explanation, and PHASE22_NOTES.md for
how this phase's one schema addition (`service_requests.latitude`/
`longitude`, added to `add_request`/`edit_request` above) was arrived
at. Same "advisory page + separate confirm route" shape Phase 21
already established for technician dispatch: `recommend_nap()` is a
read-only GET that never writes to the database; `assign_nap()` is the
only route that actually sets `requested_nap_id`, and only in
response to a real POST with a CSRF token.

Routes:
    GET  /service-requests/                    -> list_requests    (search + type/status filter)
    GET  /service-requests/add                 -> add_request       (show add form)
    POST /service-requests/add                 -> add_request       (process add form)
    GET  /service-requests/<id>/edit           -> edit_request      (show edit form)
    POST /service-requests/<id>/edit           -> edit_request      (process edit form)
    POST /service-requests/<id>/approve        -> approve_request   (quick action, pending -> approved)
    POST /service-requests/<id>/reject         -> reject_request    (quick action, pending -> rejected)
    GET  /service-requests/<id>/recommend-nap  -> recommend_nap     (Phase 22, see above)
    POST /service-requests/<id>/assign-nap     -> assign_nap        (Phase 22, see above)
"""

from flask import Blueprint, render_template, redirect, url_for, request, flash

from app.extensions import db
from app.auth import role_required
from app.models import ServiceRequest, Subscriber, Nap
from app.forms import ServiceRequestForm
from app.notifications_utils import notify
from app.nap_recommendation import recommend_naps

service_requests_bp = Blueprint("service_requests", __name__, url_prefix="/service-requests")


def _populate_choices(form):
    """Fills in the Subscriber and Requested NAP dropdowns from the
    current contents of their tables, same dynamic-choices pattern
    subscribers.py's _populate_nap_choices already uses. Subscriber
    list is not restricted to 'active' here (unlike
    collector._populate_subscriber_choices) — an administrator may
    need to look up a request tied to a subscriber who has since gone
    inactive/disconnected."""
    subscribers = Subscriber.query.order_by(Subscriber.full_name).all()
    form.subscriber_id.choices = [(0, "-- No subscriber record yet --")] + [
        (s.id, f"{s.subscriber_code} — {s.full_name}") for s in subscribers
    ]

    naps = Nap.query.order_by(Nap.name).all()
    form.requested_nap_id.choices = [(0, "-- Not specified --")] + [
        (n.id, f"{n.nap_code} — {n.name}") for n in naps
    ]


def _notify_status_change(service_request):
    """Records a Phase 17 notification for a service request's status
    change — called from every route below that actually changes
    `.status` on an existing request (not `add_request`, since a
    freshly-created request isn't a "change" yet). Not added to the
    session's pending commit until here; the caller's own
    `db.session.commit()` right after saves this in the same
    transaction (see app/notifications_utils.py's `notify()`
    docstring)."""
    label = service_request.subscriber.subscriber_code if service_request.subscriber else f"#{service_request.id}"
    customer_user_id = (
        service_request.subscriber.user_id if service_request.subscriber else None
    )
    notify(
        "service_request",
        f"Service request {label} — {service_request.status.replace('_', ' ')}",
        f"Your {service_request.request_type.replace('_', ' ')} request is now "
        f"'{service_request.status.replace('_', ' ')}'."
        if customer_user_id
        else f"Service request {label} ({service_request.request_type.replace('_', ' ')}) "
        f"is now '{service_request.status.replace('_', ' ')}'.",
        customer_user_id=customer_user_id,
        entity_type="service_request",
        entity_id=service_request.id,
    )


@service_requests_bp.route("/")
@role_required("administrator")
def list_requests():
    """Displays all service requests, with optional search (by
    subscriber name/code or notes) and request-type/status filtering
    via query string parameters (?q=...&type=...&status=...)."""
    search_term = request.args.get("q", "").strip()
    type_filter = request.args.get("type", "").strip()
    status_filter = request.args.get("status", "").strip()

    query = ServiceRequest.query

    if search_term:
        like_pattern = f"%{search_term}%"
        query = query.outerjoin(Subscriber).filter(
            db.or_(
                Subscriber.full_name.ilike(like_pattern),
                Subscriber.subscriber_code.ilike(like_pattern),
                ServiceRequest.notes.ilike(like_pattern),
            )
        )

    if type_filter:
        query = query.filter(ServiceRequest.request_type == type_filter)

    if status_filter:
        query = query.filter(ServiceRequest.status == status_filter)

    requests_ = query.order_by(ServiceRequest.created_at.desc()).all()

    return render_template(
        "service_requests/list.html",
        requests=requests_,
        search_term=search_term,
        type_filter=type_filter,
        status_filter=status_filter,
    )


@service_requests_bp.route("/add", methods=["GET", "POST"])
@role_required("administrator")
def add_request():
    """Shows and processes the Add Service Request form."""
    form = ServiceRequestForm()
    _populate_choices(form)

    if form.validate_on_submit():
        service_request = ServiceRequest(
            request_type=form.request_type.data,
            subscriber_id=form.subscriber_id.data or None,
            requested_nap_id=form.requested_nap_id.data or None,
            status=form.status.data,
            latitude=form.latitude.data,
            longitude=form.longitude.data,
            notes=(form.notes.data or "").strip() or None,
        )
        db.session.add(service_request)
        db.session.commit()
        flash("Service request was created successfully.", "success")
        return redirect(url_for("service_requests.list_requests"))

    return render_template("service_requests/form.html", form=form, mode="add", service_request=None)


@service_requests_bp.route("/<int:request_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_request(request_id):
    """Shows and processes the Edit Service Request form."""
    service_request = ServiceRequest.query.get_or_404(request_id)

    form = ServiceRequestForm(obj=service_request)
    _populate_choices(form)
    if request.method == "GET":
        form.subscriber_id.data = service_request.subscriber_id or 0
        form.requested_nap_id.data = service_request.requested_nap_id or 0

    if form.validate_on_submit():
        status_changed = form.status.data != service_request.status

        service_request.request_type = form.request_type.data
        service_request.subscriber_id = form.subscriber_id.data or None
        service_request.requested_nap_id = form.requested_nap_id.data or None
        service_request.status = form.status.data
        service_request.latitude = form.latitude.data
        service_request.longitude = form.longitude.data
        service_request.notes = (form.notes.data or "").strip() or None

        if status_changed:
            _notify_status_change(service_request)

        db.session.commit()
        flash("Service request was updated successfully.", "success")
        return redirect(url_for("service_requests.list_requests"))

    return render_template(
        "service_requests/form.html", form=form, mode="edit", service_request=service_request
    )


@service_requests_bp.route("/<int:request_id>/approve", methods=["POST"])
@role_required("administrator")
def approve_request(request_id):
    """Quick action: moves a pending request straight to 'approved'
    without opening the full edit form. Only valid from 'pending' —
    a request already past that first decision should go through the
    edit form like any other status change."""
    service_request = ServiceRequest.query.get_or_404(request_id)
    if service_request.status != "pending":
        flash("Only a pending service request can be approved this way.", "warning")
        return redirect(request.referrer or url_for("service_requests.list_requests"))

    service_request.status = "approved"
    _notify_status_change(service_request)
    db.session.commit()
    flash("Service request was approved.", "success")
    return redirect(request.referrer or url_for("service_requests.list_requests"))


@service_requests_bp.route("/<int:request_id>/reject", methods=["POST"])
@role_required("administrator")
def reject_request(request_id):
    """Quick action: moves a pending request straight to 'rejected'
    without opening the full edit form. Only valid from 'pending' —
    same reasoning as approve_request above."""
    service_request = ServiceRequest.query.get_or_404(request_id)
    if service_request.status != "pending":
        flash("Only a pending service request can be rejected this way.", "warning")
        return redirect(request.referrer or url_for("service_requests.list_requests"))

    service_request.status = "rejected"
    _notify_status_change(service_request)
    db.session.commit()
    flash("Service request was rejected.", "success")
    return redirect(request.referrer or url_for("service_requests.list_requests"))


@service_requests_bp.route("/<int:request_id>/recommend-nap")
@role_required("administrator")
def recommend_nap(request_id):
    """Phase 22: shows ranked "nearest available NAP" recommendations
    for one service request, each with a "Use This NAP" button.
    Read-only — see app/nap_recommendation.py's module docstring for
    the full filter/sort/distance explanation.

    Requires the request to already have a customer location set
    (`latitude`/`longitude`, Phase 22's addition to the Add/Edit
    form) — without one there's nothing to measure distance from, so
    this redirects back to the edit form with a flash rather than
    crashing or silently guessing a location.
    """
    service_request = ServiceRequest.query.get_or_404(request_id)

    if service_request.latitude is None or service_request.longitude is None:
        flash(
            "Set a customer location (latitude/longitude) on this "
            "service request before recommending a NAP.",
            "warning",
        )
        return redirect(url_for("service_requests.edit_request", request_id=service_request.id))

    recommendations = recommend_naps(service_request.latitude, service_request.longitude)

    return render_template(
        "service_requests/recommend_nap.html",
        service_request=service_request,
        recommendations=recommendations,
    )


@service_requests_bp.route("/<int:request_id>/assign-nap", methods=["POST"])
@role_required("administrator")
def assign_nap(request_id):
    """Phase 22: the only route that actually sets
    `requested_nap_id` — the "Administrator confirms -> Create
    assignment" step of phase_11.pdf's workflow diagram. Called from
    a plain CSRF-protected HTML form on the recommendation page
    (`service_requests/recommend_nap.html`), one per candidate, same
    shape as Phase 21's dispatch `assign()`/`reassign()` forms.

    Deliberately does not force any status transition — assigning a
    NAP is orthogonal to a request's approval workflow (a request can
    already carry a `requested_nap_id` picked manually via the Edit
    form's dropdown at any status, unchanged since Phase 15/16), so
    this route only ever changes the one field it's named for.
    """
    service_request = ServiceRequest.query.get_or_404(request_id)
    nap_id = request.form.get("nap_id", type=int)
    nap = Nap.query.get_or_404(nap_id) if nap_id else None

    if nap is None:
        flash("No NAP was selected.", "danger")
        return redirect(request.referrer or url_for("service_requests.list_requests"))

    if nap.status != "active" or (nap.available_ports or 0) <= 0:
        # Re-checked here, not just trusted from the page that posted
        # this — the same "never trust a browser-supplied value just
        # because it looks like it came from our own recommendation
        # page" reasoning app/routes/naps.py's quick_add_nap() already
        # documents, applied to a NAP's live status/ports instead of a
        # map-click coordinate. A NAP could have gone inactive or
        # filled up between the recommendation page rendering and this
        # click.
        flash(
            f"NAP '{nap.nap_code}' is no longer active with available ports — "
            "refresh the recommendation list and try again.",
            "warning",
        )
        return redirect(request.referrer or url_for("service_requests.list_requests"))

    service_request.requested_nap_id = nap.id
    db.session.commit()

    flash(f"NAP '{nap.nap_code}' was assigned to this service request.", "success")
    return redirect(url_for("service_requests.edit_request", request_id=service_request.id))
