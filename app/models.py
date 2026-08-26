"""
NAP-IQ Database Models
------------------------
SQLAlchemy ORM models mirroring the schema defined in database/schema.sql.
These models are what the rest of the Flask application will use to
query and manipulate data in later development phases. The raw SQL file
remains the source of truth for actually creating the tables in MySQL.

Table overview:
    users              -> system accounts (administrator, technician, payment collector)
    naps               -> Network Access Points (GIS-mapped distribution nodes)
    subscribers        -> ISP customers connected to a NAP
    technicians        -> technician profiles used for dispatch
    technical_issues   -> subscriber-reported technical complaints
    service_requests   -> requests for new installation / relocation / upgrade
    payments           -> subscriber payment records
    assignments        -> links a technical issue to the technician dispatched to it
    app_settings        -> singleton row of admin-configurable app-level config (Phase 15)
    plans               -> admin-managed list of subscription plan names (Settings > Plans)
"""

from datetime import datetime

from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy.orm import validates

from app.extensions import db

# ---------------------------------------------------------------------
# Phase 7 — Authentication & RBAC
# ---------------------------------------------------------------------
# 'user' (Customer) was added in Phase 7 for subscriber-facing logins.
# 'payment_collector' predates Phase 7 and is kept for backward
# compatibility with existing seeded/production data — it is not one
# of the three roles this phase's login system builds interfaces for
# (Administrator / Technician / User), so any account still carrying
# that role should be migrated to one of the three, or the RBAC rules
# in app/auth.py extended for it, in a future phase.
USER_ROLES = ("administrator", "technician", "payment_collector", "user")

# ---------------------------------------------------------------------
# Phase 17 — users.status (replaces users.is_active)
# ---------------------------------------------------------------------
# phase_7.pdf's USER DATA list names a `Status` column explicitly; the
# original Phase 7 build used a boolean `is_active` instead, which
# worked identically (inactive = can't log in) but didn't literally
# match the spec's field name/type. This phase renames it to a real
# status enum, confirmed rather than silently kept — see
# PHASE17_NOTES.md for the full list of call sites this rename
# touched (app/auth.py's load_logged_in_user, routes/auth.py's login,
# routes/users.py's list/deactivate/activate, users/list.html).
# 'suspended' is included per the spec's own example
# (active/inactive/suspended) but isn't wired into any UI action yet
# in this round — deactivate_user()/activate_user() still only ever
# toggle between 'active' and 'inactive', same two states the old
# boolean supported; 'suspended' is available for a future phase to
# use without another schema change.
USER_STATUSES = ("active", "inactive", "suspended")

# Dark Mode, Phase 24: a personal display preference, stored per account
# (not per browser/localStorage) so it follows the signed-in user to any
# device — and is independent of role, since any role can choose either
# value. Every account defaults to 'light'. The sign-in screen
# (auth/login.html, via base.html) intentionally never reads this column;
# it always renders in light mode regardless of what the account it's
# about to authenticate has saved.
USER_THEME_PREFERENCES = ("light", "dark")


class User(db.Model):
    """System accounts. Every technician and payment collector also has
    a corresponding user account used to log in to NAP-IQ."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    full_name = db.Column(db.String(100), nullable=False)
    role = db.Column(
        db.Enum(*USER_ROLES, name="user_role"),
        nullable=False,
    )
    email = db.Column(db.String(100), unique=True, nullable=True)
    phone_number = db.Column(db.String(20), nullable=True)
    # Phase 17: replaces the original boolean `is_active` — see the
    # USER_STATUSES comment above. An account can log in only when
    # this is 'active' (checked in app/auth.py and routes/auth.py);
    # 'inactive' and 'suspended' both behave like the old `False`.
    status = db.Column(
        db.Enum(*USER_STATUSES, name="user_status"),
        nullable=False,
        default="active",
    )
    # Phase 24: Settings > Display Settings' Dark Mode toggle. Set by
    # app/routes/settings.py's `set_theme()`. Defaults to 'light' for
    # every role.
    theme_preference = db.Column(
        db.Enum(*USER_THEME_PREFERENCES, name="user_theme_preference"),
        nullable=False,
        default="light",
        server_default="light",
    )
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # A user account may optionally correspond to one technician profile.
    technician_profile = db.relationship(
        "Technician", back_populates="user", uselist=False
    )

    # Phase 10: a user account (role='user') may optionally correspond to
    # one subscriber (service/billing) record. See Subscriber.user_id.
    subscriber_profile = db.relationship(
        "Subscriber", back_populates="user", uselist=False
    )

    # ---- Password handling (Phase 7) ----
    # Passwords are NEVER stored or compared in plaintext. Werkzeug's
    # generate_password_hash uses PBKDF2-SHA256 with a random salt and
    # a high iteration count by default, which is what gets stored in
    # password_hash. check_password_hash re-derives the hash from the
    # candidate password and the stored salt/params and compares them
    # using a constant-time comparison internally.

    def set_password(self, raw_password: str) -> None:
        """Hashes `raw_password` and stores it. Never assign to
        `password_hash` directly anywhere else in the app."""
        self.password_hash = generate_password_hash(raw_password, method="pbkdf2:sha256")

    def check_password(self, raw_password: str) -> bool:
        """Returns True if `raw_password` matches the stored hash."""
        if not raw_password or not self.password_hash:
            return False
        return check_password_hash(self.password_hash, raw_password)

    def __repr__(self):
        return f"<User {self.username} ({self.role}, {self.status})>"


class Nap(db.Model):
    """Network Access Point: a physical distribution node plotted on the
    GeoMap that subscriber lines connect to."""

    __tablename__ = "naps"

    id = db.Column(db.Integer, primary_key=True)
    nap_code = db.Column(db.String(20), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    address = db.Column(db.String(255), nullable=True)
    latitude = db.Column(db.Numeric(10, 7), nullable=False)
    longitude = db.Column(db.Numeric(10, 7), nullable=False)
    total_ports = db.Column(db.Integer, nullable=False, default=8)
    used_ports = db.Column(db.Integer, nullable=False, default=0)
    # available_ports is maintained by the application layer for now
    # (kept as a real, updatable column rather than a generated column
    # so it stays portable across MySQL versions).
    available_ports = db.Column(db.Integer, nullable=False, default=8)
    status = db.Column(
        db.Enum("active", "inactive", "full", "maintenance", name="nap_status"),
        nullable=False,
        default="active",
    )
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    subscribers = db.relationship("Subscriber", back_populates="nap")
    technical_issues = db.relationship("TechnicalIssue", back_populates="nap")

    def __repr__(self):
        return f"<Nap {self.nap_code}>"


class Subscriber(db.Model):
    """An ISP customer connected to (or applying to connect to) a NAP."""

    __tablename__ = "subscribers"

    id = db.Column(db.Integer, primary_key=True)
    subscriber_code = db.Column(db.String(20), unique=True, nullable=False)
    full_name = db.Column(db.String(100), nullable=False)
    address = db.Column(db.String(255), nullable=True)
    latitude = db.Column(db.Numeric(10, 7), nullable=True)
    longitude = db.Column(db.Numeric(10, 7), nullable=True)
    contact_number = db.Column(db.String(20), nullable=True)
    email = db.Column(db.String(100), nullable=True)
    plan_type = db.Column(db.String(50), nullable=True)
    nap_id = db.Column(db.Integer, db.ForeignKey("naps.id"), nullable=True)
    # Phase 10: optional link to this subscriber's own login account.
    # Nullable + unique — a subscriber can exist with no portal login
    # (staff-created service record, not yet linked), and a user
    # account can link to at most one subscriber.
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=True)
    status = db.Column(
        db.Enum("active", "inactive", "disconnected", "pending_review", name="subscriber_status"),
        nullable=False,
        default="active",
    )
    installed_at = db.Column(db.Date, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    nap = db.relationship("Nap", back_populates="subscribers")
    user = db.relationship("User", back_populates="subscriber_profile")
    technical_issues = db.relationship(
        "TechnicalIssue", back_populates="subscriber",
        order_by="TechnicalIssue.created_at.desc()",
    )
    service_requests = db.relationship(
        "ServiceRequest", back_populates="subscriber",
        order_by="ServiceRequest.created_at.desc()",
    )
    payments = db.relationship(
        "Payment", back_populates="subscriber",
        order_by="Payment.payment_date.desc()",
    )

    def __repr__(self):
        return f"<Subscriber {self.subscriber_code}>"


class Technician(db.Model):
    """Technician profile used by the (future) dispatch module. Linked
    one-to-one with a `users` account with role='technician'."""

    __tablename__ = "technicians"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=True)
    full_name = db.Column(db.String(100), nullable=False)
    contact_number = db.Column(db.String(20), nullable=True)
    current_latitude = db.Column(db.Numeric(10, 7), nullable=True)
    current_longitude = db.Column(db.Numeric(10, 7), nullable=True)
    status = db.Column(
        db.Enum("available", "busy", "offline", name="technician_status"),
        nullable=False,
        default="available",
    )
    resolved_issues_count = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    user = db.relationship("User", back_populates="technician_profile")
    assignments = db.relationship("Assignment", back_populates="technician")

    def __repr__(self):
        return f"<Technician {self.full_name}>"


class TechnicalIssue(db.Model):
    """A subscriber-reported technical complaint (e.g., no connection,
    slow speed, intermittent drops)."""

    __tablename__ = "technical_issues"

    id = db.Column(db.Integer, primary_key=True)
    issue_code = db.Column(db.String(20), unique=True, nullable=True)
    issue_type = db.Column(db.String(50), nullable=False)
    description = db.Column(db.Text, nullable=True)
    priority = db.Column(
        db.Enum("low", "medium", "high", "critical", name="issue_priority"),
        nullable=False,
        default="medium",
    )
    status = db.Column(
        db.Enum(
            "pending", "assigned", "in_progress", "resolved", "closed",
            name="issue_status",
        ),
        nullable=False,
        default="pending",
    )
    address = db.Column(db.String(255), nullable=True)
    latitude = db.Column(db.Numeric(10, 7), nullable=True)
    longitude = db.Column(db.Numeric(10, 7), nullable=True)
    subscriber_id = db.Column(db.Integer, db.ForeignKey("subscribers.id"), nullable=False)
    nap_id = db.Column(db.Integer, db.ForeignKey("naps.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    subscriber = db.relationship("Subscriber", back_populates="technical_issues")
    nap = db.relationship("Nap", back_populates="technical_issues")
    assignments = db.relationship("Assignment", back_populates="technical_issue")

    def __repr__(self):
        return f"<TechnicalIssue {self.id} ({self.status})>"


class ServiceRequest(db.Model):
    """A request for a new installation, disconnection, relocation, or
    plan upgrade. Kept separate from technical_issues since it follows
    a different (sales/provisioning) workflow rather than a repair one."""

    __tablename__ = "service_requests"

    id = db.Column(db.Integer, primary_key=True)
    request_type = db.Column(
        db.Enum(
            "new_installation", "disconnection", "relocation", "upgrade",
            name="service_request_type",
        ),
        nullable=False,
    )
    subscriber_id = db.Column(db.Integer, db.ForeignKey("subscribers.id"), nullable=True)
    requested_nap_id = db.Column(db.Integer, db.ForeignKey("naps.id"), nullable=True)
    status = db.Column(
        db.Enum(
            "pending", "approved", "scheduled", "completed", "rejected",
            name="service_request_status",
        ),
        nullable=False,
        default="pending",
    )
    # Phase 22: customer/proposed-installation coordinates — see the
    # matching comment on this table in database/schema.sql. Nullable;
    # a request with no location set here simply can't be run through
    # app/nap_recommendation.py yet.
    latitude = db.Column(db.Numeric(10, 7), nullable=True)
    longitude = db.Column(db.Numeric(10, 7), nullable=True)
    notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    subscriber = db.relationship("Subscriber", back_populates="service_requests")
    requested_nap = db.relationship("Nap")

    def __repr__(self):
        return f"<ServiceRequest {self.id} ({self.request_type})>"


class Payment(db.Model):
    """A payment made by a subscriber, optionally recorded by a
    payment-collector user."""

    __tablename__ = "payments"

    id = db.Column(db.Integer, primary_key=True)
    subscriber_id = db.Column(db.Integer, db.ForeignKey("subscribers.id"), nullable=False)
    collector_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    amount = db.Column(db.Numeric(10, 2), nullable=False)
    payment_method = db.Column(
        db.Enum("cash", "gcash", "bank_transfer", "other", name="payment_method"),
        nullable=False,
        default="cash",
    )
    payment_date = db.Column(db.Date, nullable=False)
    reference_number = db.Column(db.String(50), nullable=True)
    status = db.Column(
        db.Enum("pending", "confirmed", "overdue", "voided", name="payment_status"),
        nullable=False,
        default="confirmed",
    )
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    subscriber = db.relationship("Subscriber", back_populates="payments")
    collector = db.relationship("User")

    def __repr__(self):
        return f"<Payment {self.id} {self.amount}>"


class Assignment(db.Model):
    """Links a technician to the job they're dispatched to: either a
    technical_issue (a repair — the only source this table supported
    through Phase 25) or, as of Phase 28, a service_request (an
    install). Kept as its own table (rather than a column on either
    source table) so that reassignment history can be preserved.

    Exactly one of technical_issue_id / service_request_id is set on
    any given row — enforced in the app layer (see
    `_check_exactly_one_source` below) rather than a DB CHECK
    constraint. Every existing repair-dispatch code path keeps working
    exactly as it did before this phase — it simply never sets
    service_request_id, so technical_issue_id continues to be the
    only column populated for those rows.
    """

    __tablename__ = "assignments"

    id = db.Column(db.Integer, primary_key=True)
    technical_issue_id = db.Column(
        db.Integer, db.ForeignKey("technical_issues.id"), nullable=True
    )
    # Phase 28: set instead of technical_issue_id when this assignment
    # dispatches a technician to perform a new_installation (or, in
    # principle, any other service_request) rather than repair an
    # existing technical_issue.
    service_request_id = db.Column(
        db.Integer, db.ForeignKey("service_requests.id"), nullable=True
    )
    technician_id = db.Column(db.Integer, db.ForeignKey("technicians.id"), nullable=False)
    assigned_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    status = db.Column(
        db.Enum(
            "assigned", "accepted", "in_progress", "completed", "cancelled",
            name="assignment_status",
        ),
        nullable=False,
        default="assigned",
    )
    dispatch_score = db.Column(db.Numeric(5, 2), nullable=True)
    # Phase 20: see database/schema.sql's comment on this column —
    # the technician's own free-text notes on what was found/done,
    # kept per-assignment so reassignment history stays intact.
    resolution_notes = db.Column(db.Text, nullable=True)
    # Filename (not full path/URL) of the technician's required
    # completion photo — see database/schema.sql's comment on this
    # column and api_v1/technician.py's upload_assignment_photo().
    photo_filename = db.Column(db.String(255), nullable=True)
    # Phase 28: an install's required customer sign-off, stored the
    # same way (full Cloudinary secure_url — see
    # api_v1/technician.py's upload_assignment_signature()). Only ever
    # set for a service_request-linked (installation) assignment; a
    # repair assignment has no signature step and this stays NULL.
    signature_filename = db.Column(db.String(255), nullable=True)
    completed_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    technical_issue = db.relationship("TechnicalIssue", back_populates="assignments")
    # Phase 28. No back_populates on ServiceRequest — nothing needs
    # the reverse "all assignments for this request" collection yet.
    service_request = db.relationship("ServiceRequest")
    technician = db.relationship("Technician", back_populates="assignments")

    @validates("technical_issue_id", "service_request_id")
    def _check_exactly_one_source(self, key, value):
        """App-layer equivalent of a DB CHECK constraint (see this
        class's docstring): exactly one of technical_issue_id /
        service_request_id may be non-None."""
        other_key = "service_request_id" if key == "technical_issue_id" else "technical_issue_id"
        other_value = getattr(self, other_key, None)
        if value is not None and other_value is not None:
            raise ValueError(
                "An Assignment must link to exactly one of technical_issue_id or "
                "service_request_id, not both."
            )
        return value

    def __repr__(self):
        source = (
            f"issue={self.technical_issue_id}"
            if self.technical_issue_id is not None
            else f"request={self.service_request_id}"
        )
        return f"<Assignment {source} tech={self.technician_id}>"


class AppSettings(db.Model):
    """Singleton row (always id=1) of admin-configurable, app-level
    config — Phase 15. Deliberately a small table of typed columns
    rather than a generic key/value store, since the set of settings
    is small and known ahead of time; matches this schema's existing
    style (compare Nap/Subscriber's typed columns) rather than
    introducing a new pattern.

    `session_timeout_minutes` is applied live, once per request, by
    app/settings_utils.py's `apply_dynamic_settings()` — a small,
    separate before_request hook (see app/__init__.py) that only ever
    adjusts `current_app.permanent_session_lifetime`. It deliberately
    does NOT touch app/auth.py or app/routes/auth.py at all, so the
    verified Phase 7 login/session/RBAC core stays untouched.

    `default_nap_total_ports` is consumed by app/routes/naps.py's
    `add_nap()` to pre-fill the Total Ports field on the (GET) Add NAP
    form — it's a starting suggestion, not a hard rule, so an
    administrator can still type a different value for a specific NAP.

    GeoMap default filters (`geomap_default_*`, added alongside the
    above): what the GeoMap's Layers/Filters dropdowns are set to the
    moment the page loads, administrator-configurable from Settings >
    App Settings so every role sees the same starting view. This only
    ever changes the *starting* checkbox/select state that
    app/templates/naps/map.html renders — it does not remove or lock
    any control. Every checkbox and the ports <select> stay exactly as
    interactive as before; anyone (any role) can still tick/untick or
    change them per-visit, same as always, and that in-session choice
    is never written back here. One column per control (rather than a
    single JSON blob) to match this table's existing typed-column
    style. Column defaults below intentionally reproduce the
    hard-coded `checked`/`selected` attributes naps/map.html shipped
    with before this setting existed, so an administrator who never
    visits Settings sees no behavior change.
    """

    __tablename__ = "app_settings"

    id = db.Column(db.Integer, primary_key=True, default=1)
    session_timeout_minutes = db.Column(db.Integer, nullable=False, default=60)
    default_nap_total_ports = db.Column(db.Integer, nullable=False, default=8)

    # Max Connection Radius (meters): the farthest a subscriber's pin
    # is allowed to be from a NAP for that NAP to still count as a
    # "suitable" candidate. Enforced in exactly one place —
    # app/nap_recommendation.py's recommend_naps() — since every
    # NAP-suggestion/auto-assign entry point in the app already
    # funnels through that one function (mobile self-registration's
    # coverage check, the GeoMap's "Plan Installation" nearest-NAP
    # lookup, and the Service Requests "Recommend NAP" page /
    # approve_request's auto-assign all call it — see that module's
    # docstring). A NAP beyond this radius is treated exactly like a
    # full/inactive NAP: filtered out of the candidate pool before
    # distance-sorting, never just sorted to the bottom, so it can
    # never be auto-suggested or auto-assigned no matter how empty the
    # rest of the map is.
    #
    # 0 means "no limit" — the feature is opt-in; an admin who never
    # visits this setting sees no behavior change (same
    # zero-is-off-by-default pattern this app already uses, e.g.
    # NEAR_CAPACITY_THRESHOLD_PCT-style admin-tunable constants).
    # Deliberately advisory-only for a NAP an administrator picks
    # *manually* (the Service Request Add/Edit form's plain NAP
    # dropdown) — same "suggest, don't remove control" philosophy the
    # GeoMap default-filters settings above already use; this caps
    # what gets *recommended*, not what an administrator can
    # deliberately override by hand.
    nap_connection_radius_meters = db.Column(db.Integer, nullable=False, default=0)


    # GeoMap default filters — Layers dropdown.
    geomap_default_show_naps = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_show_issues = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_show_subscribers = db.Column(db.Boolean, nullable=False, default=False)

    # GeoMap default filters — NAP Status + Port Availability.
    geomap_default_status_active = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_status_inactive = db.Column(db.Boolean, nullable=False, default=False)
    geomap_default_status_maintenance = db.Column(db.Boolean, nullable=False, default=False)
    geomap_default_status_full = db.Column(db.Boolean, nullable=False, default=False)
    geomap_default_ports_filter = db.Column(
        db.Enum("all", "available", "full", name="geomap_default_ports_filter"),
        nullable=False,
        default="all",
    )

    # GeoMap default filters — Issue Status.
    geomap_default_issue_status_pending = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_issue_status_assigned = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_issue_status_in_progress = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_issue_status_resolved = db.Column(db.Boolean, nullable=False, default=False)
    geomap_default_issue_status_closed = db.Column(db.Boolean, nullable=False, default=False)

    # GeoMap default filters — Issue Priority.
    geomap_default_issue_priority_low = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_issue_priority_medium = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_issue_priority_high = db.Column(db.Boolean, nullable=False, default=True)
    geomap_default_issue_priority_critical = db.Column(db.Boolean, nullable=False, default=True)

    updated_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    updated_by = db.relationship("User")

    @classmethod
    def get_current(cls):
        """Returns the one settings row, creating it with defaults
        first if it doesn't exist yet (e.g. an existing database that
        hasn't run migration_phase15.sql, which already seeds it) —
        so every caller can rely on this always returning a row rather
        than needing its own None-check."""
        settings = cls.query.get(1)
        if settings is None:
            settings = cls(id=1)
            db.session.add(settings)
            db.session.commit()
        return settings

    def __repr__(self):
        return f"<AppSettings session_timeout={self.session_timeout_minutes}m>"


class Plan(db.Model):
    """Admin-managed list of subscription plan names (Settings > App
    Settings > Plans), e.g. "Fiber 50Mbps". Previously `Subscriber.
    plan_type` (and the installation-planning quick-add form's own
    plan_type field) was pure free text with no fixed list at all —
    deliberately so, per PLAN_INSTALL_10_PERCENT_NOTES.md §4, since at
    the time there was no admin UI to curate one. This table is that
    UI's backing store now that one exists.

    `Subscriber.plan_type` stays a plain string column, NOT a foreign
    key to this table -- it's still validated at the app layer, not
    the database layer -- but both places that let an admin set it
    (subscribers/form.html's SubscriberForm.plan_type and naps/map.
    html's install planner) now render it as a real dropdown of this
    table's names rather than a free-text `<input list=...>` datalist
    of suggestions. A subscriber's existing plan_type that predates
    this list (a legacy or one-off value) is still preserved -- the
    edit form appends it as its own "(legacy)" choice rather than
    silently dropping it -- so removing a plan here never touches
    existing subscriber records that already used it; it only stops
    that name being offered to new ones.

    Kept as a genuinely small, single-column lookup table (name only,
    hard-deletable) rather than reusing AppSettings' singleton-row/
    typed-column pattern, since this is a variable-length *list* an
    administrator adds to and removes from over time, not a fixed set
    of scalar settings known ahead of time.
    """

    __tablename__ = "plans"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False, unique=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<Plan {self.name}>"


# ---------------------------------------------------------------------
# Phase 17 — Notifications
# ---------------------------------------------------------------------
# phase_7.pdf lists "Notifications" as one of the Customer role's
# pages; it never got built in any prior phase (both the Customer's
# and the Administrator's sidebar entries were disabled "Coming soon"
# placeholders — see PHASE7_NOTES.md onward). This phase builds it.
#
# In scope for what generates a notification (client decision, see
# PHASE17_NOTES.md): service request status changes, payment
# due/overdue, and technical issue status changes. Out of scope:
# anything else (e.g. NAP status, new-user-account events).
#
# Who sees which (client decision): a Customer only ever sees their
# own notifications; an Administrator sees every notification,
# system-wide. This is modeled with two columns instead of a generic
# per-user-role join table:
#   - `audience` says which *kind* of view a row belongs to
#     ('customer' or 'administrator').
#   - `user_id` is only ever set on a 'customer' row (the specific
#     subscriber's linked login) — always NULL on an 'administrator'
#     row, since that audience is system-wide rather than tied to one
#     account.
# A single event (e.g. a service request moving to 'approved') can
# produce up to two rows: one 'customer' row for the affected
# subscriber's login (if they have one) and one 'administrator' row
# so the event is visible system-wide — created together by
# app/notifications_utils.py's `notify()` helper, called from the
# route where the underlying status actually changes.
#
# Read/unread is tracked per row (client decision: needed for v1).
# This is a deliberate v1 simplification: `is_read` lives directly on
# the row rather than in a separate per-viewer join table, so if two
# different Administrator accounts both read the system-wide feed,
# marking a row read is shared between them (there is normally only
# one or a small handful of Administrator accounts in this app — see
# users.py's "last active Administrator" guard — so this was judged an
# acceptable v1 tradeoff rather than a new junction table; a
# per-viewer read table is a reasonable future-phase upgrade if that
# stops being true). A Customer row's `is_read` is only ever touched
# by that one subscriber's own login anyway, so there's no sharing
# concern on that side.
NOTIFICATION_AUDIENCES = ("customer", "administrator")
NOTIFICATION_CATEGORIES = ("service_request", "payment", "issue")


class Notification(db.Model):
    """A single notification entry — see the module-level comment
    above for the audience/read-state model."""

    __tablename__ = "notifications"

    id = db.Column(db.Integer, primary_key=True)
    audience = db.Column(
        db.Enum(*NOTIFICATION_AUDIENCES, name="notification_audience"), nullable=False
    )
    # Only set (and only meaningful) on a 'customer'-audience row —
    # the subscriber's own linked `users` account. Always NULL on an
    # 'administrator'-audience row.
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    category = db.Column(
        db.Enum(*NOTIFICATION_CATEGORIES, name="notification_category"), nullable=False
    )
    title = db.Column(db.String(150), nullable=False)
    message = db.Column(db.Text, nullable=False)
    # Optional pointer back to the record this notification is about
    # (e.g. entity_type='service_request', entity_id=42), used to link
    # the notification to that record's page. Both nullable since not
    # every notification needs to link anywhere.
    entity_type = db.Column(db.String(30), nullable=True)
    entity_id = db.Column(db.Integer, nullable=True)
    is_read = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    user = db.relationship("User")

    def __repr__(self):
        return f"<Notification {self.id} ({self.audience}/{self.category})>"


class RevokedToken(db.Model):
    """A JWT (access or refresh) that has been explicitly logged out,
    identified by its `jti` (JWT ID) claim.

    Mobile API auth (app/routes/api_v1/auth.py) uses short-lived JWTs
    instead of the signed session cookie the HTML app uses (see
    app/auth.py) — a JWT is self-contained and normally stays valid
    until it expires, with no server-side session to clear on logout.
    Recording revoked jti values here (checked by the JWTManager's
    token-in-blocklist callback in app/extensions.py) is what lets
    POST /api/v1/auth/logout actually invalidate a token immediately,
    the same way session.clear() does for the cookie-based flow.

    Rows older than the longest-lived token type (the refresh token,
    see JWT_REFRESH_TOKEN_EXPIRES in app/config.py) are safe to purge
    periodically — an expired token would be rejected by expiry alone
    even if its jti were never recorded here.
    """

    __tablename__ = "revoked_tokens"

    id = db.Column(db.Integer, primary_key=True)
    jti = db.Column(db.String(36), unique=True, nullable=False, index=True)
    revoked_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<RevokedToken {self.jti}>"


class EmailVerification(db.Model):
    """A one-time verification code sent to an email address, backing
    the mobile app's "verify your email before submitting the
    application" step (see app/email_utils.py and
    app/routes/api_v1/auth.py's send-verification-code / verify-email-
    code / register endpoints).

    Deliberately NOT tied to a `users` row by foreign key — the whole
    point is to verify an address BEFORE any account exists yet. Rows
    are looked up by `email` + `purpose` instead.

    `purpose` keeps this table reusable beyond registration (e.g. a
    future "change my email" flow could use purpose='email_change')
    without needing a second, near-identical table.
    """

    __tablename__ = "email_verifications"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(100), nullable=False, index=True)
    purpose = db.Column(db.String(30), nullable=False, default="registration")
    code = db.Column(db.String(6), nullable=False)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    is_verified = db.Column(db.Boolean, nullable=False, default=False)
    expires_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<EmailVerification {self.email} ({self.purpose})>"
