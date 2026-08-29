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

Phase 27 (KYC review queue): `list_requests()` below now defaults to
showing only `pending` requests on a fresh visit (no query string at
all) — see that function's own docstring for exactly what counts as
"fresh" vs. an administrator's explicit "All Requests" choice. The
KYC document itself (`ServiceRequest.id_document_filename`) is
uploaded by the customer mobile API (app/routes/api_v1/customer.py)
and simply displayed here, read-only, on the edit form once set.

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
from app.email_utils import send_status_email

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


def _build_walkin_note(form):
    """Builds the note every request created through the Add Service
    Request form gets saved with. This form represents a walk-in
    application taken at the office, so the note is fixed as such
    automatically instead of relying on staff to type it every time —
    same idea as how the mobile app would tag its own submissions.

    The applicant's basic details (full name, address, contact number)
    are no longer folded into this text — they're saved as their own
    columns on the request (see the caller) and shown under "Customer
    Information" on the document view instead. This function now only
    produces the short, professional description that goes in the
    Notes section itself.
    """
    if form.request_type.data == "new_installation":
        return (
            "Walk-in application submitted in person at the PG Networks "
            "office. Applicant details are on file under Customer "
            "Information."
        )
    return (
        "Walk-in request processed at the PG Networks office on behalf "
        "of the subscriber on file."
    )


def _sync_subscriber_nap(service_request):
    """Keeps `Subscriber.nap_id` (what the GeoMap actually reads —
    both the subscriber↔NAP connector line and, via `nap.subscribers`,
    the NAP detail panel's slot-capacity count) in step with whatever
    NAP this service request has on file.

    Every write path below (`add_request`, `edit_request`,
    `approve_request`, `assign_nap`) sets `requested_nap_id` on the
    *ServiceRequest*, but historically none of them touched the
    linked *Subscriber* row at all. That's invisible for the
    Administrator "Add Subscriber"/"Plan Installation" flows, which
    stamp `Subscriber.nap_id` directly at creation time — but a
    self-registered mobile account (app/routes/api_v1/auth.py's
    `register()`) is created with `nap_id=None` by design, on the
    understanding that "assigning a NAP" happens later through this
    exact service-request review flow. Since nothing here ever wrote
    that assignment back onto the Subscriber, a mobile-registered
    account's marker never gained a connector line to its NAP no
    matter how the admin approved/assigned its request — not a
    display bug, but a missing write.

    Only runs forward (clearing `requested_nap_id` back out, e.g. via
    the edit form, deliberately leaves the subscriber's existing
    connection alone rather than un-linking a line that may already
    represent a completed installation), and only when there's an
    actual linked Subscriber to update — a walk-in request with no
    subscriber record yet has nothing to sync.
    """
    if not service_request.requested_nap_id or not service_request.subscriber_id:
        return
    subscriber = Subscriber.query.get(service_request.subscriber_id)
    if subscriber is not None and subscriber.nap_id != service_request.requested_nap_id:
        subscriber.nap_id = service_request.requested_nap_id


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

    # Applicant email notification (Gmail SMTP) — separate from the
    # in-app Notification row above, for the statuses an applicant
    # actually cares about hearing via email even if they don't have
    # the app open: approved, scheduled, and rejected. Silently does
    # nothing if the subscriber has no email on file, or if sending
    # fails (see app/email_utils.py's send_status_email()) — the
    # in-app notification above always still gets recorded either way.
    subscriber_email = service_request.subscriber.email if service_request.subscriber else None
    if subscriber_email and service_request.status in ("approved", "scheduled", "rejected"):
        status_copy = {
            "approved": (
                "Your application has been approved!",
                "Good news — your service request has been approved. "
                "We'll follow up shortly to schedule your installation.",
            ),
            "scheduled": (
                "Your installation has been scheduled",
                "Your service request has moved to 'scheduled'. "
                "A technician will be assigned and dispatched soon.",
            ),
            "rejected": (
                "Update on your service application",
                "Unfortunately, your service request could not be approved "
                "at this time. Please contact support if you have questions.",
            ),
        }[service_request.status]
        send_status_email(
            subscriber_email,
            subject=f"PG Networks — {status_copy[0]}",
            heading=status_copy[0],
            body_text=status_copy[1],
        )


@service_requests_bp.route("/")
@role_required("administrator")
def list_requests():
    """Displays all service requests, with optional search (by
    subscriber name/code or notes) and request-type/status filtering
    via query string parameters (?q=...&type=...&status=...).

    Phase 27 (KYC review queue): a fresh visit to this page — no query
    string at all — defaults `status_filter` to 'pending' instead of
    "All Statuses", so a new self-registration doesn't get lost among
    already-settled disconnection/relocation/upgrade rows. This is
    distinct from an administrator explicitly choosing "All Statuses"
    from the dropdown (?status= with an empty value), which still
    shows every request regardless of status exactly as before — see
    service_requests/list.html's "Pending Applications" / "All
    Requests" quick links, which submit that explicit empty value
    rather than omitting the parameter.
    """
    search_term = request.args.get("q", "").strip()
    type_filter = request.args.get("type", "").strip()
    raw_status_filter = request.args.get("status")
    # Only an explicit ?status= (even empty, from the "All Requests"
    # link) counts as the administrator having chosen a value —
    # omitting the parameter entirely (a fresh visit to this page) is
    # what triggers the pending-queue default below.
    default_pending_view = raw_status_filter is None
    status_filter = (raw_status_filter if raw_status_filter is not None else "pending").strip()

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

    # Phase 29 (list-view NAP suggestion): a request with a customer
    # location on file but no `requested_nap_id` yet (typically a
    # mobile self-registration/coverage-check, per Phase 22/27) gets
    # the same nearest-suitable-NAP lookup `recommend_nap()` already
    # runs, computed here so the "Requested NAP" column can show it as
    # a suggestion without the administrator opening the dedicated
    # recommendation page first. Purely a read — see
    # app/nap_recommendation.py's "THIS MODULE NEVER WRITES TO THE
    # DATABASE" section; `requested_nap_id` itself is only ever set by
    # `assign_nap()`. Attached as a plain instance attribute (not a
    # mapped column), so it's available to the template but never
    # persisted.
    for r in requests_:
        r.suggested_nap = None
        if not r.requested_nap_id and r.latitude is not None and r.longitude is not None:
            top = recommend_naps(r.latitude, r.longitude, limit=1)
            r.suggested_nap = top[0] if top else None

    return render_template(
        "service_requests/list.html",
        requests=requests_,
        search_term=search_term,
        type_filter=type_filter,
        status_filter=status_filter,
        default_pending_view=default_pending_view,
    )


@service_requests_bp.route("/add", methods=["GET", "POST"])
@role_required("administrator")
def add_request():
    """Shows and processes the Add Service Request form. This form is
    the walk-in application flow (see _build_walkin_note() above) —
    every request created here is tagged with a fixed, professional
    "walk-in" note automatically, and New Installation additionally
    collects the applicant's full name/address/contact number (saved
    on the request itself — see ServiceRequest.full_name/address/
    contact_number) since there's no Subscriber record for them yet."""
    form = ServiceRequestForm()
    _populate_choices(form)

    if request.method == "GET":
        requested_type = request.args.get("type")
        valid_types = {choice[0] for choice in form.request_type.choices}
        if requested_type in valid_types:
            form.request_type.data = requested_type

    if form.validate_on_submit():
        service_request = ServiceRequest(
            request_type=form.request_type.data,
            subscriber_id=form.subscriber_id.data or None,
            requested_nap_id=form.requested_nap_id.data or None,
            status=form.status.data,
            latitude=form.latitude.data,
            longitude=form.longitude.data,
            full_name=(form.full_name.data or "").strip() or None,
            address=(form.address.data or "").strip() or None,
            contact_number=(form.contact_number.data or "").strip() or None,
            notes=_build_walkin_note(form),
        )
        db.session.add(service_request)
        _sync_subscriber_nap(service_request)
        db.session.commit()
        flash("Service request was created successfully.", "success")
        return redirect(url_for("service_requests.list_requests"))

    return render_template("service_requests/form.html", form=form, mode="add", service_request=None)


@service_requests_bp.route("/<int:request_id>/edit", methods=["GET", "POST"])
@role_required("administrator")
def edit_request(request_id):
    """Shows and processes the Edit Service Request form."""
    service_request = ServiceRequest.query.get_or_404(request_id)

    # Same on-the-fly nearest-NAP suggestion list_requests() computes
    # (see that route's comment) — attached here too so the read-only
    # detail view shows the same "Suggested: NAP-XXXX" a reviewer
    # would have already seen on the list, rather than just "Not yet
    # assigned" when this page is opened directly. Never persisted —
    # see app/nap_recommendation.py's "THIS MODULE NEVER WRITES TO THE
    # DATABASE" section.
    service_request.suggested_nap = None
    if (
        not service_request.requested_nap_id
        and service_request.latitude is not None
        and service_request.longitude is not None
    ):
        top = recommend_naps(service_request.latitude, service_request.longitude, limit=1)
        service_request.suggested_nap = top[0] if top else None

    form = ServiceRequestForm(obj=service_request)
    _populate_choices(form)
    if request.method == "GET":
        form.subscriber_id.data = service_request.subscriber_id or 0
        form.requested_nap_id.data = service_request.requested_nap_id or 0

    if form.validate_on_submit():
        old_status = service_request.status

        service_request.request_type = form.request_type.data
        service_request.subscriber_id = form.subscriber_id.data or None
        service_request.requested_nap_id = form.requested_nap_id.data or None
        service_request.status = form.status.data
        service_request.latitude = form.latitude.data
        service_request.longitude = form.longitude.data
        service_request.notes = (form.notes.data or "").strip() or None

        # Phase 28: same auto-advance rule as assign_nap() below — a
        # request that's 'approved' and has a NAP attached is ready
        # for dispatch, regardless of whether the NAP was attached
        # here (via this form's dropdown) or through the dedicated
        # "Recommend NAP" -> assign_nap() flow. Without this, a NAP
        # picked from this dropdown never reaches app/routes/
        # dispatch.py's DISPATCHABLE_REQUEST_STATUSES and the request
        # silently never shows up on the dispatch board.
        if service_request.status == "approved" and service_request.requested_nap_id:
            service_request.status = "scheduled"

        status_changed = service_request.status != old_status
        if status_changed:
            _notify_status_change(service_request)

        _sync_subscriber_nap(service_request)
        db.session.commit()

        # Hand-off fix: a new_installation request can be marked
        # 'completed' with no Subscriber ever attached to it -- nothing
        # else in this app creates one automatically, so the "customer"
        # silently never becomes a real, billable account unless
        # whoever's on shift remembers the separate Add Subscriber step.
        # Catching the transition right here, the one place status
        # actually changes, sends the admin straight into Add
        # Subscriber with what's already on file (the assigned NAP and
        # the customer's coordinates, if set) pre-filled, and
        # subscribers.add_subscriber() links the new row back onto this
        # request once it's saved -- see that route's own comment.
        needs_subscriber_handoff = (
            status_changed
            and service_request.status == "completed"
            and service_request.request_type == "new_installation"
            and not service_request.subscriber_id
        )
        if needs_subscriber_handoff:
            flash(
                "Service request was updated successfully. This installation has no "
                "linked subscriber account yet -- create one now to finish activating it.",
                "warning",
            )
            return redirect(
                url_for(
                    "subscribers.add_subscriber",
                    service_request_id=service_request.id,
                    nap_id=service_request.requested_nap_id or None,
                    latitude=service_request.latitude,
                    longitude=service_request.longitude,
                )
            )

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
    edit form like any other status change.

    Auto-NAP-assign on approve: if the request doesn't already have a
    requested_nap_id and has a customer location on file, this now
    looks up the same nearest-suitable-NAP list list_requests()/
    edit_request() already compute for display (recommend_naps() —
    see app/nap_recommendation.py; it only ever returns active NAPs
    with free ports, so whatever it picks is always a safe candidate)
    and assigns the top match immediately, rather than making the
    administrator open "Recommend NAP" as a separate manual step.
    Same auto-advance rule assign_nap()/edit_request() already use
    then applies: 'approved' + a requested_nap_id -> 'scheduled', so
    an approval with a location on file goes straight to the Dispatch
    Board in one click. A request with no location (nothing to
    recommend from) still just lands on 'approved', same as before —
    an administrator can assign a NAP for it manually via the edit
    form or "Recommend NAP" whenever a location becomes available.
    """
    service_request = ServiceRequest.query.get_or_404(request_id)
    if service_request.status != "pending":
        flash("Only a pending service request can be approved this way.", "warning")
        return redirect(request.referrer or url_for("service_requests.list_requests"))

    service_request.status = "approved"

    assigned_nap = None
    if (
        not service_request.requested_nap_id
        and service_request.latitude is not None
        and service_request.longitude is not None
    ):
        top = recommend_naps(service_request.latitude, service_request.longitude, limit=1)
        if top:
            # recommend_naps() returns a list of plain dicts, not Nap
            # ORM objects (see its own "RETURN SHAPE" docstring) — the
            # actual Nap row lives under the "nap" key.
            assigned_nap = top[0]["nap"]
            service_request.requested_nap_id = assigned_nap.id

    # Same auto-advance rule assign_nap()/edit_request() use elsewhere:
    # 'approved' + a NAP attached is ready for dispatch.
    if service_request.status == "approved" and service_request.requested_nap_id:
        service_request.status = "scheduled"

    _notify_status_change(service_request)
    _sync_subscriber_nap(service_request)
    db.session.commit()

    if assigned_nap is not None:
        flash(
            f"Service request was approved and NAP '{assigned_nap.nap_code}' "
            "was assigned automatically.",
            "success",
        )
    else:
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

    Phase 28 update: does move status 'approved' -> 'scheduled' when a
    NAP is assigned — that transition is what makes the request show
    up on the dispatch board (see app/routes/dispatch.py). The Edit
    form's manual NAP dropdown (Phase 15/16) still does NOT do this —
    only this dedicated route does, since it's the one confirming an
    admin has deliberately picked a NAP for dispatch, not just editing
    a field.
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

    # Phase 28: assigning a NAP to an already-approved request is what
    # actually makes it dispatchable — see app/routes/dispatch.py's
    # DISPATCHABLE_REQUEST_STATUSES. Only auto-advance from 'approved';
    # a still-'pending' request picking up a NAP early (e.g. via the
    # Edit form) shouldn't silently skip the approval step, and a
    # request that's already 'scheduled' or beyond just keeps its NAP
    # updated without moving status backward/forward again.
    if service_request.status == "approved":
        service_request.status = "scheduled"

    _sync_subscriber_nap(service_request)
    db.session.commit()

    flash(f"NAP '{nap.nap_code}' was assigned to this service request.", "success")
    return redirect(url_for("service_requests.edit_request", request_id=service_request.id))