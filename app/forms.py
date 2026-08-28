"""
NAP-IQ Forms
--------------
Flask-WTF forms for the application. Keeping form definitions separate
from routes/models makes validation rules easy to find, reuse (the same
NapForm powers both the Add and Edit pages), and unit-test later.
"""

from flask_wtf import FlaskForm
from wtforms import (
    StringField,
    PasswordField,
    DecimalField,
    IntegerField,
    SelectField,
    TextAreaField,
    BooleanField,
)
from wtforms.validators import (
    DataRequired,
    Email,
    EqualTo,
    Length,
    NumberRange,
    Optional,
    ValidationError,
)

from app.models import Nap, Subscriber, Technician, User, Plan, USER_ROLES


class LoginForm(FlaskForm):
    """Login form used by the single, role-aware NAP-IQ sign-in page.

    Deliberately minimal: only presence/length is validated here.
    Whether the username exists and whether the password is correct
    are checked server-side against the hashed password in MySQL (see
    routes/auth.py) — never here, and never in a way that reveals
    which of the two was wrong.
    """

    username = StringField(
        "Username",
        validators=[
            DataRequired(message="Username is required."),
            Length(max=50, message="Username must be at most 50 characters."),
        ],
    )
    password = PasswordField(
        "Password",
        validators=[DataRequired(message="Password is required.")],
    )


def _nap_code_is_taken(code, exclude_id=None):
    """Shared uniqueness check used by both NapForm and
    MapQuickAddNapForm so the rule only lives in one place."""
    query = Nap.query.filter(Nap.nap_code == code.strip())
    if exclude_id is not None:
        query = query.filter(Nap.id != exclude_id)
    return query.first() is not None


class NapForm(FlaskForm):
    """Form used for both creating and editing a NAP.

    For edits, the route sets `form.nap_id = <existing id>` right after
    instantiating the form so the uniqueness check on nap_code can
    exclude the record being edited. For adds, `nap_id` stays None.
    """

    nap_id = None  # set manually by the route; not a real form field

    nap_code = StringField(
        "NAP Code",
        validators=[
            DataRequired(message="NAP code is required."),
            Length(max=20, message="NAP code must be at most 20 characters."),
        ],
    )
    name = StringField(
        "Name",
        validators=[
            DataRequired(message="Name is required."),
            Length(max=100, message="Name must be at most 100 characters."),
        ],
    )
    address = TextAreaField(
        "Address",
        validators=[Optional(), Length(max=255, message="Address must be at most 255 characters.")],
    )
    latitude = DecimalField(
        "Latitude",
        places=7,
        validators=[
            DataRequired(message="Latitude is required."),
            NumberRange(min=-90, max=90, message="Latitude must be between -90 and 90."),
        ],
    )
    longitude = DecimalField(
        "Longitude",
        places=7,
        validators=[
            DataRequired(message="Longitude is required."),
            NumberRange(min=-180, max=180, message="Longitude must be between -180 and 180."),
        ],
    )
    total_ports = IntegerField(
        "Total Ports",
        validators=[
            DataRequired(message="Total ports is required."),
            NumberRange(min=1, message="Total ports must be greater than 0."),
        ],
    )
    used_ports = IntegerField(
        "Used Ports",
        validators=[
            DataRequired(message="Used ports is required."),
            NumberRange(min=0, message="Used ports cannot be negative."),
        ],
    )
    status = SelectField(
        "Status",
        choices=[
            ("active", "Active"),
            ("inactive", "Inactive"),
            ("full", "Full"),
            ("maintenance", "Maintenance"),
        ],
        default="active",
        validators=[DataRequired()],
    )

    # ---- Custom, cross-field / database-aware validators ----

    def validate_nap_code(self, field):
        """Ensures nap_code is unique, excluding the record being edited."""
        if _nap_code_is_taken(field.data, exclude_id=self.nap_id):
            raise ValidationError("This NAP code is already in use. Choose a different one.")

    def validate_used_ports(self, field):
        """Ensures used_ports never exceeds total_ports."""
        if self.total_ports.data is not None and field.data is not None:
            if field.data > self.total_ports.data:
                raise ValidationError("Used ports cannot exceed total ports.")


class MapQuickAddNapForm(FlaskForm):
    """Lightweight version of NapForm used by the 'Add NAP from GeoMap'
    workflow. A NAP created this way always starts with zero used
    ports (nothing has been connected to it yet), so there is no
    used_ports field here at all — the route always sets it to 0 and
    available_ports = total_ports. Latitude/longitude arrive from the
    map click, but every value is still fully re-validated here: the
    server never trusts coordinates or numbers sent by the browser.
    """

    nap_code = StringField(
        "NAP Code",
        validators=[
            DataRequired(message="NAP code is required."),
            Length(max=20, message="NAP code must be at most 20 characters."),
        ],
    )
    name = StringField(
        "Name",
        validators=[
            DataRequired(message="Name is required."),
            Length(max=100, message="Name must be at most 100 characters."),
        ],
    )
    address = TextAreaField(
        "Address",
        validators=[Optional(), Length(max=255, message="Address must be at most 255 characters.")],
    )
    latitude = DecimalField(
        "Latitude",
        places=7,
        validators=[
            DataRequired(message="Latitude is required."),
            NumberRange(min=-90, max=90, message="Latitude must be between -90 and 90."),
        ],
    )
    longitude = DecimalField(
        "Longitude",
        places=7,
        validators=[
            DataRequired(message="Longitude is required."),
            NumberRange(min=-180, max=180, message="Longitude must be between -180 and 180."),
        ],
    )
    total_ports = IntegerField(
        "Total Ports",
        validators=[
            DataRequired(message="Total ports is required."),
            NumberRange(min=1, message="Total ports must be greater than 0."),
        ],
    )
    status = SelectField(
        "Status",
        choices=[
            ("active", "Active"),
            ("inactive", "Inactive"),
            ("full", "Full"),
            ("maintenance", "Maintenance"),
        ],
        default="active",
        validators=[DataRequired()],
    )

    def validate_nap_code(self, field):
        """Ensures nap_code is unique. Every NAP created through this
        form is new, so there is no existing record to exclude."""
        if _nap_code_is_taken(field.data):
            raise ValidationError("This NAP code is already in use. Choose a different one.")


ISSUE_TYPE_CHOICES = [
    ("No Internet", "No Internet"),
    ("Slow Internet", "Slow Internet"),
    ("Fiber/Cable Problem", "Fiber/Cable Problem"),
    ("NAP Problem", "NAP Problem"),
    ("Connection Problem", "Connection Problem"),
    ("Other", "Other"),
]


class IssueReportForm(FlaskForm):
    """Form used by the 'Report an Issue' GeoMap workflow.

    Subscriber and NAP are SelectFields whose `choices` are populated
    dynamically by the route (from the current contents of the
    `subscribers` / `naps` tables) right after the form is
    instantiated, since WTForms needs `choices` set before validation
    can check the submitted value against them. `0` is used as the
    "not selected" sentinel for both.

    Issue ID, Status, and Created Date are intentionally NOT fields
    here: issue_code is generated by the route after the row is
    inserted (so it can embed the real primary key), status always
    starts as 'pending' for a newly reported issue, and created_at is
    a database default — none of these should be editable by whoever
    is filing the report.
    """

    issue_type = SelectField(
        "Issue Type",
        choices=ISSUE_TYPE_CHOICES,
        validators=[DataRequired(message="Issue type is required.")],
    )
    subscriber_id = SelectField(
        "Subscriber",
        coerce=int,
        # DataRequired correctly rejects this field's "0 / not selected"
        # sentinel value on its own, since `not 0` is True in Python —
        # no extra custom validator needed here.
        validators=[DataRequired(message="Please select the affected subscriber.")],
    )
    nap_id = SelectField(
        "NAP (if applicable)",
        coerce=int,
        validators=[Optional()],
    )
    address = StringField(
        "Address",
        validators=[Optional(), Length(max=255, message="Address must be at most 255 characters.")],
    )
    latitude = DecimalField(
        "Latitude",
        places=7,
        validators=[
            DataRequired(message="Latitude is required."),
            NumberRange(min=-90, max=90, message="Latitude must be between -90 and 90."),
        ],
    )
    longitude = DecimalField(
        "Longitude",
        places=7,
        validators=[
            DataRequired(message="Longitude is required."),
            NumberRange(min=-180, max=180, message="Longitude must be between -180 and 180."),
        ],
    )
    priority = SelectField(
        "Priority",
        choices=[("low", "Low"), ("medium", "Medium"), ("high", "High"), ("critical", "Critical")],
        default="medium",
        validators=[DataRequired()],
    )
    description = TextAreaField(
        "Description",
        validators=[
            DataRequired(message="Please describe the issue."),
            Length(max=2000, message="Description is too long."),
        ],
    )


# ---------------------------------------------------------------------
# Phase 8 — Administrator "Manage Users" forms
# ---------------------------------------------------------------------

ROLE_CHOICES = [(role, role.replace("_", " ").title()) for role in USER_ROLES]


class UserForm(FlaskForm):
    """Shared account-detail fields for both the Add User and Edit User
    pages. Password is handled separately (set on create by
    `AddUserForm` below; changed afterwards only via the dedicated
    'Reset Password' action) so that editing someone's name/role/email
    can never accidentally blank out or resubmit a hashed password.

    For edits, the route sets `form.user_id = <existing id>` right
    after instantiating the form so the uniqueness checks on username
    and email can exclude the record being edited. For adds, `user_id`
    stays None.
    """

    user_id = None  # set manually by the route; not a real form field

    username = StringField(
        "Username",
        validators=[
            DataRequired(message="Username is required."),
            Length(min=3, max=50, message="Username must be between 3 and 50 characters."),
        ],
    )
    full_name = StringField(
        "Full Name",
        validators=[
            DataRequired(message="Full name is required."),
            Length(max=100, message="Full name must be at most 100 characters."),
        ],
    )
    email = StringField(
        "Email",
        validators=[
            Optional(),
            Length(max=100, message="Email must be at most 100 characters."),
            Email(message="Enter a valid email address."),
        ],
    )
    phone_number = StringField(
        "Phone Number",
        validators=[Optional(), Length(max=20, message="Phone number must be at most 20 characters.")],
    )
    role = SelectField(
        "Role",
        choices=ROLE_CHOICES,
        validators=[DataRequired(message="Role is required.")],
    )

    # ---- Phase 10: optional Subscriber link (Customer accounts only) ----
    # Only meaningful when role == 'user'; the route populates `choices`
    # dynamically (unlinked subscribers, plus whichever one this account
    # is already linked to, if editing) and ignores this field entirely
    # for any other role. 0 is the "not linked" sentinel, same pattern
    # as IssueReportForm.nap_id.
    subscriber_id = SelectField(
        "Linked Subscriber (Customer accounts only)",
        coerce=int,
        validators=[Optional()],
    )

    def validate_username(self, field):
        """Ensures username is unique, excluding the record being edited."""
        query = User.query.filter(User.username == field.data.strip())
        if self.user_id is not None:
            query = query.filter(User.id != self.user_id)
        if query.first() is not None:
            raise ValidationError("This username is already taken. Choose a different one.")

    def validate_email(self, field):
        """Ensures email is unique (when provided), excluding the record
        being edited. `users.email` is a nullable-but-unique column, so
        multiple accounts with no email at all is fine."""
        if not field.data:
            return
        query = User.query.filter(User.email == field.data.strip())
        if self.user_id is not None:
            query = query.filter(User.id != self.user_id)
        if query.first() is not None:
            raise ValidationError("This email address is already in use by another account.")

    def validate_subscriber_id(self, field):
        """Ensures the chosen subscriber (if any) isn't already linked to
        a *different* user account. Only enforced when role == 'user' —
        for any other role the field is ignored by the route, so a
        stray non-zero value can't accidentally steal a link."""
        if self.role.data != "user" or not field.data:
            return
        subscriber = Subscriber.query.get(field.data)
        if subscriber is None:
            raise ValidationError("Selected subscriber no longer exists.")
        if subscriber.user_id is not None and subscriber.user_id != self.user_id:
            raise ValidationError(
                "That subscriber is already linked to a different account."
            )


class AddUserForm(UserForm):
    """Adds the initial-password fields used only when creating a brand
    new account. Editing an existing account never touches the
    password — that's the separate 'Reset Password' action below."""

    password = PasswordField(
        "Password",
        validators=[
            DataRequired(message="Password is required."),
            Length(min=8, message="Password must be at least 8 characters."),
        ],
    )
    confirm_password = PasswordField(
        "Confirm Password",
        validators=[
            DataRequired(message="Please confirm the password."),
            EqualTo("password", message="Passwords do not match."),
        ],
    )


class ResetPasswordForm(FlaskForm):
    """Used by an administrator to set a new password for an existing
    account (e.g. after a forgotten-password request made offline).
    Deliberately has no 'current password' field — this is an
    administrator override, not a self-service password change."""

    password = PasswordField(
        "New Password",
        validators=[
            DataRequired(message="Password is required."),
            Length(min=8, message="Password must be at least 8 characters."),
        ],
    )
    confirm_password = PasswordField(
        "Confirm New Password",
        validators=[
            DataRequired(message="Please confirm the password."),
            EqualTo("password", message="Passwords do not match."),
        ],
    )

# ---------------------------------------------------------------------
# Phase 10 — Admin Dispatch UI forms
# ---------------------------------------------------------------------


class AssignTechnicianForm(FlaskForm):
    """Used for both the 'Assign' and 'Reassign' dispatch actions on a
    technical issue. `technician_id.choices` is populated dynamically
    by the route (from the current contents of the `technicians`
    table, same pattern as IssueReportForm.subscriber_id/nap_id) since
    it must always reflect who's actually in the roster right now. `0`
    is the "not selected" sentinel.
    """

    technician_id = SelectField(
        "Technician",
        coerce=int,
        validators=[DataRequired(message="Please select a technician to dispatch.")],
    )
    note = StringField(
        "Dispatch Note (optional)",
        validators=[Optional(), Length(max=255, message="Note must be at most 255 characters.")],
    )
    # Phase 21: optional hidden field, only ever populated when this
    # form is submitted from the recommendation page
    # (app/templates/dispatch/recommend.html) — carries that
    # candidate's computed `total_score` (see app/recommendation.py)
    # through to `Assignment.dispatch_score` in
    # app/routes/dispatch.py's assign()/reassign(). Left blank by the
    # dispatch board's own manual dropdown (dispatch/index.html,
    # issues/view.html), which never sets it, so a manually-picked
    # assignment's dispatch_score stays NULL exactly as it always has
    # — this field only ever ADDS information, it never changes what
    # those two existing routes did before this phase for the manual
    # path.
    recommendation_score = DecimalField(
        "Recommendation Score",
        validators=[Optional(), NumberRange(min=0, max=100, message="Invalid score.")],
    )


# ---------------------------------------------------------------------
# Phase 20 — Technician resolution notes (phase_8.pdf item #8)
# ---------------------------------------------------------------------


class ResolutionNotesForm(FlaskForm):
    """Used by a technician to record (or update) resolution notes on
    their own assignment — what was found, what was done, parts used,
    follow-up needed, etc. Reused both for the standalone 'Save Notes'
    action (assignment still accepted/in_progress) and for 'Mark
    Complete' (which requires notes, since that's the point in the
    workflow phase_8.pdf calls out: 'Save resolution notes' happens as
    part of the technician's update to the issue).
    """

    resolution_notes = TextAreaField(
        "Resolution Notes",
        validators=[
            DataRequired(message="Please describe what was found/done before saving."),
            Length(max=4000, message="Resolution notes must be at most 4000 characters."),
        ],
    )


# ---------------------------------------------------------------------
# Phase 10 — Payment Collector landing page form
# ---------------------------------------------------------------------


class RecordPaymentForm(FlaskForm):
    """Used by a payment_collector to log a payment they collected in
    person. `subscriber_id.choices` is populated dynamically by the
    route from active subscribers, same pattern as IssueReportForm.
    `collector_id` is never a form field — the route always sets it to
    the signed-in collector's own user id, never something submitted
    by the browser.

    Also reused as-is by payments.py's Administrator add/edit routes
    (see that module's docstring). `status.choices` intentionally does
    NOT include 'voided' here — collector.py (Phase 10) is explicitly
    scoped to recording payments, not voiding them, so a collector
    should never see that option. payments.py's Administrator routes
    append it dynamically onto the instantiated form instead of it
    being a base class choice, keeping collector.py's exposure
    unchanged.
    """

    subscriber_id = SelectField(
        "Subscriber",
        coerce=int,
        validators=[DataRequired(message="Please select the paying subscriber.")],
    )
    amount = DecimalField(
        "Amount",
        places=2,
        validators=[
            DataRequired(message="Amount is required."),
            NumberRange(min=0.01, message="Amount must be greater than 0."),
        ],
    )
    payment_method = SelectField(
        "Payment Method",
        choices=[
            ("cash", "Cash"),
            ("gcash", "GCash"),
            ("bank_transfer", "Bank Transfer"),
            ("other", "Other"),
        ],
        default="cash",
        validators=[DataRequired()],
    )
    payment_date = StringField(
        "Payment Date (YYYY-MM-DD)",
        validators=[DataRequired(message="Payment date is required.")],
    )
    reference_number = StringField(
        "Reference Number",
        validators=[Optional(), Length(max=50, message="Reference number must be at most 50 characters.")],
    )
    status = SelectField(
        "Status",
        choices=[("confirmed", "Confirmed"), ("pending", "Pending"), ("overdue", "Overdue")],
        default="confirmed",
        validators=[DataRequired()],
    )

    def validate_payment_date(self, field):
        """Kept as a plain StringField (rather than WTForms' DateField,
        which is stricter about input format) but still fully
        validated server-side: must parse as a real YYYY-MM-DD date."""
        from datetime import datetime as _datetime

        try:
            _datetime.strptime(field.data.strip(), "%Y-%m-%d")
        except (ValueError, AttributeError):
            raise ValidationError("Enter a valid date in YYYY-MM-DD format.")


# ---------------------------------------------------------------------
# Phase 12 — Profile (self-service, all roles)
# ---------------------------------------------------------------------


class ProfileForm(FlaskForm):
    """Lets any signed-in account edit its own contact details.
    Deliberately excludes username and role — self-service editing of
    either would let an account escalate/rename itself, so both stay
    Administrator-only via Manage Users (Phase 8). Mirrors UserForm's
    uniqueness-check pattern for email, but has no username field to
    check at all.

    The route sets `form.user_id = g.user.id` right after
    instantiating so `validate_email` can exclude the signed-in
    account's own row from the uniqueness check.
    """

    user_id = None  # set manually by the route; not a real form field

    full_name = StringField(
        "Full Name",
        validators=[
            DataRequired(message="Full name is required."),
            Length(max=100, message="Full name must be at most 100 characters."),
        ],
    )
    email = StringField(
        "Email",
        validators=[
            Optional(),
            Length(max=100, message="Email must be at most 100 characters."),
            Email(message="Enter a valid email address."),
        ],
    )
    phone_number = StringField(
        "Phone Number",
        validators=[Optional(), Length(max=20, message="Phone number must be at most 20 characters.")],
    )

    def validate_email(self, field):
        """Same uniqueness rule as UserForm.validate_email, scoped to
        the signed-in account's own id."""
        if not field.data:
            return
        query = User.query.filter(User.email == field.data.strip())
        if self.user_id is not None:
            query = query.filter(User.id != self.user_id)
        if query.first() is not None:
            raise ValidationError("This email address is already in use by another account.")


class ChangePasswordForm(FlaskForm):
    """Self-service password change — unlike ResetPasswordForm (an
    administrator override for someone else's account), this requires
    the account's own current password so a hijacked/left-open
    session can't be used to silently lock the real owner out."""

    current_password = PasswordField(
        "Current Password",
        validators=[DataRequired(message="Enter your current password.")],
    )
    password = PasswordField(
        "New Password",
        validators=[
            DataRequired(message="Password is required."),
            Length(min=8, message="Password must be at least 8 characters."),
        ],
    )
    confirm_password = PasswordField(
        "Confirm New Password",
        validators=[
            DataRequired(message="Please confirm the password."),
            EqualTo("password", message="Passwords do not match."),
        ],
    )


# ---------------------------------------------------------------------
# Phase 12 — Administrator "Subscribers" management forms
# ---------------------------------------------------------------------


class SubscriberForm(FlaskForm):
    """Form used for both creating and editing a subscriber (an ISP
    customer's service/billing record). Deliberately has no `user_id`
    field — linking a subscriber to a login account stays owned by the
    Manage Users "Linked Subscriber" dropdown (Phase 10) so there is
    only ever one place that reconciles that relationship, matching
    UserForm.subscriber_id's own docstring rationale.

    For edits, the route sets `form.subscriber_id_value = <existing
    id>` right after instantiating the form so the uniqueness check on
    subscriber_code can exclude the record being edited. For adds, it
    stays None.
    """

    subscriber_id_value = None  # set manually by the route; not a real form field

    subscriber_code = StringField(
        "Subscriber Code",
        validators=[
            DataRequired(message="Subscriber code is required."),
            Length(max=20, message="Subscriber code must be at most 20 characters."),
        ],
    )
    full_name = StringField(
        "Full Name",
        validators=[
            DataRequired(message="Full name is required."),
            Length(max=100, message="Full name must be at most 100 characters."),
        ],
    )
    address = TextAreaField(
        "Address",
        validators=[Optional(), Length(max=255, message="Address must be at most 255 characters.")],
    )
    latitude = DecimalField(
        "Latitude",
        places=7,
        validators=[
            Optional(),
            NumberRange(min=-90, max=90, message="Latitude must be between -90 and 90."),
        ],
    )
    longitude = DecimalField(
        "Longitude",
        places=7,
        validators=[
            Optional(),
            NumberRange(min=-180, max=180, message="Longitude must be between -180 and 180."),
        ],
    )
    contact_number = StringField(
        "Contact Number",
        validators=[Optional(), Length(max=20, message="Contact number must be at most 20 characters.")],
    )
    email = StringField(
        "Email",
        validators=[
            Optional(),
            Length(max=100, message="Email must be at most 100 characters."),
            Email(message="Enter a valid email address."),
        ],
    )
    # `choices` populated dynamically by the route from the current
    # `plans` table (Settings > App Settings > Plans), same
    # dynamic-choices pattern as nap_id right below. This used to be a
    # free-text `StringField` with an `<input list=...>` datalist of
    # suggestions (any value could be typed); it's now a real dropdown,
    # so only a curated plan name, the blank "-- None --" choice, or --
    # when editing a subscriber whose existing plan_type isn't in the
    # curated list -- that legacy value (appended by the route so
    # editing never silently discards it) can be submitted.
    # validate_choice=False: this is a UI convenience, not a data
    # constraint -- the dropdown lists the curated Settings > App
    # Settings > Plans names, but (matching this column's pre-dropdown
    # "any value accepted" behavior, and Plan's own docstring) a value
    # outside that list must still be accepted server-side, not just
    # when it's the current subscriber's own pre-existing legacy value
    # (which _populate_plan_choices() already adds as a choice) but
    # also for e.g. a race where the list changed between page load
    # and submit.
    plan_type = SelectField(
        "Plan Type",
        validators=[Optional()],
        validate_choice=False,
    )
    # `choices` populated dynamically by the route from the current
    # `naps` table, same pattern as IssueReportForm.nap_id. 0 = "not
    # connected to any NAP yet".
    nap_id = SelectField(
        "Connected NAP",
        coerce=int,
        validators=[Optional()],
    )
    status = SelectField(
        "Status",
        choices=[
            ("active", "Active"),
            ("inactive", "Inactive"),
            ("disconnected", "Disconnected"),
            # Phase 26: this enum value has existed on the Subscriber
            # model / database since self-registration was added — it
            # was missing here, so this dropdown had no matching
            # <option> for a pending applicant's real status and
            # silently fell back to rendering "Active" (the first
            # choice) instead. Saving the form in that state would
            # then write "active" straight over the subscriber's true
            # pending_review status. See PHASE28_BUGFIX_NOTES (NAP
            # dispatch investigation) for how this was found.
            ("pending_review", "Pending Review"),
        ],
        default="active",
        validators=[DataRequired()],
    )
    installed_at = StringField(
        "Installed Date (YYYY-MM-DD, optional)",
        validators=[Optional(), Length(max=10)],
    )

    def validate_subscriber_code(self, field):
        query = Subscriber.query.filter(Subscriber.subscriber_code == field.data.strip())
        if self.subscriber_id_value is not None:
            query = query.filter(Subscriber.id != self.subscriber_id_value)
        if query.first() is not None:
            raise ValidationError("This subscriber code is already in use. Choose a different one.")

    def validate_installed_at(self, field):
        if not field.data:
            return
        from datetime import datetime as _datetime

        try:
            _datetime.strptime(field.data.strip(), "%Y-%m-%d")
        except ValueError:
            raise ValidationError("Enter a valid date in YYYY-MM-DD format.")


# ---------------------------------------------------------------------
# Installation Planning integration, Phase 5 (70%) — "Plan Installation"
# quick subscriber-creation form
# ---------------------------------------------------------------------


class MapQuickInstallSubscriberForm(FlaskForm):
    """Lightweight version of SubscriberForm used by the GeoMap's "Plan
    Installation" workflow (nap-install-planner.js's form step), the
    same relationship MapQuickAddNapForm already has to NapForm for
    the "Add NAP from GeoMap" workflow.

    Only the three fields the Installation Planning plan's Phase 5
    section actually asks for (subscriber name; barangay/address;
    plan type) plus the two values the flow itself supplies rather
    than the admin typing them (the dropped pin's latitude/longitude,
    and the suggested NAP's id) are collected here — no contact_number
    or email field, since the plan does not list them and the
    prototype's own form step does not collect them either (it fills
    a placeholder contact number for its in-memory-only demo data;
    this form intentionally leaves that column NULL instead of
    inventing a fake value — see PLAN_INSTALL_10_PERCENT_NOTES.md /
    the global "do not fake data" instruction).

    subscriber_code stays a required, manually-typed field with the
    exact same uniqueness validation as SubscriberForm.subscriber_code
    — the target application has no subscriber-code generation scheme
    to reuse (see PLAN_INSTALL_10_PERCENT_NOTES.md §3), so the only
    way to honor "do not invent a second code-generation scheme" is to
    keep using the one real scheme that already exists: an admin types
    a code, the server enforces it is unique.

    address reuses the target's existing free-text column (no
    BARANGAYS-style fixed list was introduced — see
    PLAN_INSTALL_10_PERCENT_NOTES.md §4). plan_type is still validated
    here as free text (this endpoint is called via fetch()/FormData
    from nap-install-planner.js, not rendered through this form's own
    field, so there's no WTForms <select> to keep in sync) — but the
    JS side now renders its own plan-type field as a real <select>
    (mirroring SubscriberForm.plan_type, which changed from a
    free-text `<input list=...>` datalist to a dropdown), built from
    the same #installPlannerPlanTypes options naps/map.html already
    renders server-side (app/routes/naps.py's geomap()), so in
    practice only one of those curated/existing values ever reaches
    this endpoint.

    latitude/longitude/nap_id arrive from the client (the dropped pin
    and the Phase 2 suggestion already shown on screen) but are fully
    re-validated here regardless — the route additionally re-checks
    the NAP still exists and still has capacity server-side before
    creating anything, the same "never trust a browser-supplied value
    just because it looks like it came from our own page" discipline
    quick_add_nap() and assign_nap() already apply to their own
    client-sourced values.
    """

    subscriber_code = StringField(
        "Subscriber Code",
        validators=[
            DataRequired(message="Subscriber code is required."),
            Length(max=20, message="Subscriber code must be at most 20 characters."),
        ],
    )
    full_name = StringField(
        "Subscriber Name",
        validators=[
            DataRequired(message="Subscriber name is required."),
            Length(max=100, message="Full name must be at most 100 characters."),
        ],
    )
    address = TextAreaField(
        "Barangay / Address",
        validators=[Optional(), Length(max=255, message="Address must be at most 255 characters.")],
    )
    plan_type = StringField(
        "Plan Type",
        validators=[Optional(), Length(max=50, message="Plan type must be at most 50 characters.")],
    )
    latitude = DecimalField(
        "Latitude",
        places=7,
        validators=[
            DataRequired(message="Latitude is required."),
            NumberRange(min=-90, max=90, message="Latitude must be between -90 and 90."),
        ],
    )
    longitude = DecimalField(
        "Longitude",
        places=7,
        validators=[
            DataRequired(message="Longitude is required."),
            NumberRange(min=-180, max=180, message="Longitude must be between -180 and 180."),
        ],
    )
    nap_id = IntegerField(
        "NAP",
        validators=[DataRequired(message="A suggested NAP is required.")],
    )

    def validate_subscriber_code(self, field):
        """Same uniqueness check as SubscriberForm.validate_subscriber_code
        — every subscriber created through this quick form is new, so
        there is no existing record id to exclude."""
        if Subscriber.query.filter(Subscriber.subscriber_code == field.data.strip()).first() is not None:
            raise ValidationError("This subscriber code is already in use. Choose a different one.")


# ---------------------------------------------------------------------
# Phase 12 — Administrator "Technicians" roster forms
# ---------------------------------------------------------------------


class TechnicianForm(FlaskForm):
    """Form used for both creating and editing a technician profile
    (the dispatch-facing record in the `technicians` table). Kept
    separate from the technician's `users` login account — creating a
    technician profile here does not also create a login (same
    boundary PHASE8_NOTES.md drew the other way: creating a
    technician-role account there doesn't create a profile here
    either). Linking the two remains a manual pairing via the
    `user_id` dropdown below, populated with technician-role accounts
    that don't already have a linked profile.
    """

    technician_id_value = None  # set manually by the route; not a real form field

    full_name = StringField(
        "Full Name",
        validators=[
            DataRequired(message="Full name is required."),
            Length(max=100, message="Full name must be at most 100 characters."),
        ],
    )
    contact_number = StringField(
        "Contact Number",
        validators=[Optional(), Length(max=20, message="Contact number must be at most 20 characters.")],
    )
    status = SelectField(
        "Status",
        choices=[
            ("available", "Available"),
            ("busy", "Busy"),
            ("offline", "Offline"),
        ],
        default="available",
        validators=[DataRequired()],
    )
    # `choices` populated dynamically by the route: technician-role
    # `users` accounts with no linked profile yet, plus whichever
    # account this profile is already linked to (if editing). 0 = "not
    # linked to a login account".
    user_id = SelectField(
        "Linked Login Account",
        coerce=int,
        validators=[Optional()],
    )

    def validate_user_id(self, field):
        """Defense against a stale page / tampered POST offering an
        account that's since been linked to a *different* technician
        profile, mirroring UserForm.validate_subscriber_id."""
        if not field.data:
            return
        existing = Technician.query.filter(Technician.user_id == field.data)
        if self.technician_id_value is not None:
            existing = existing.filter(Technician.id != self.technician_id_value)
        if existing.first() is not None:
            raise ValidationError("That login account is already linked to a different technician profile.")


# ---------------------------------------------------------------------
# Phase 12 — Customer self-service "Report an Issue"
# ---------------------------------------------------------------------


class CustomerIssueReportForm(FlaskForm):
    """Self-service version of IssueReportForm for a signed-in
    customer reporting a problem on their *own* subscriber account.

    Unlike the staff-facing IssueReportForm, there is no
    `subscriber_id` field here at all — the route always attributes a
    new issue to `g.user`'s own linked subscriber, never a value
    submitted by the browser, so one customer can never file an issue
    against another subscriber's account. Latitude/longitude are also
    dropped: a customer reporting from the portal isn't clicking a
    map, so the route falls back to the subscriber's own stored
    address/coordinates instead of asking them to supply GPS numbers.
    """

    issue_type = SelectField(
        "Issue Type",
        choices=ISSUE_TYPE_CHOICES,
        validators=[DataRequired(message="Issue type is required.")],
    )
    priority = SelectField(
        "Priority",
        choices=[("low", "Low"), ("medium", "Medium"), ("high", "High"), ("critical", "Critical")],
        default="medium",
        validators=[DataRequired()],
    )
    description = TextAreaField(
        "Description",
        validators=[
            DataRequired(message="Please describe the issue."),
            Length(max=2000, message="Description is too long."),
        ],
    )


# ---------------------------------------------------------------------
# Phase 15 — Administrator "Settings" form
# ---------------------------------------------------------------------


class SettingsForm(FlaskForm):
    """Form for the singleton `app_settings` row. Originally covered
    just the two settings the client asked for in Phase 15
    (`session_timeout_minutes`, `default_nap_total_ports`); the
    GeoMap default filter fields below extend the same form/row
    rather than starting a second one, since they're the same kind of
    thing — a single piece of admin-configurable, app-level config.
    Not meant to be exhaustive; more settings can be added as their
    own fields here plus columns on AppSettings later.

    The GeoMap fields set the *default* (initial) state of the
    GeoMap's Layers/Filters dropdown controls, mirroring their ids in
    naps/map.html 1:1 (BooleanField per checkbox, one SelectField for
    the Port Availability dropdown). They never disable or remove
    those controls — every signed-in user can still change them
    per-visit on the map itself; only where each one *starts* is
    admin-configurable here.
    """

    session_timeout_minutes = IntegerField(
        "Session Timeout (minutes)",
        validators=[
            DataRequired(message="Session timeout is required."),
            NumberRange(min=5, max=1440, message="Enter a value between 5 and 1440 minutes (24 hours)."),
        ],
    )
    default_nap_total_ports = IntegerField(
        "Default NAP Total Ports",
        validators=[
            DataRequired(message="Default NAP total ports is required."),
            NumberRange(min=1, max=1000, message="Enter a value between 1 and 1000."),
        ],
    )
    nap_connection_radius_meters = IntegerField(
        "Max Connection Radius (meters)",
        validators=[
            DataRequired(message="Max connection radius is required."),
            NumberRange(min=0, max=100000, message="Enter a value between 0 and 100,000 meters."),
        ],
    )

    # NOTE: the GeoMap's Layers/Filters starting state used to be
    # admin-configurable here ("Default GeoMap Filters"). That section
    # has been removed — each control on naps/map.html now remembers
    # its own last-used state per browser (via localStorage; see
    # static/js/napmap.js), so there's nothing left to configure here.


# ---------------------------------------------------------------------
# Plans (Settings > App Settings > Plans) — add/remove plan names
# ---------------------------------------------------------------------


class PlanForm(FlaskForm):
    """Adds a single new row to the `plans` table (Settings page).
    Removal doesn't need a form — it's a plain POST-with-id button,
    same pattern as e.g. naps' activate/deactivate actions."""

    name = StringField(
        "Plan Name",
        validators=[
            DataRequired(message="Plan name is required."),
            Length(max=50, message="Plan name must be at most 50 characters."),
        ],
    )

    def validate_name(self, field):
        """Case-insensitive uniqueness check, since "Fiber 50Mbps" and
        "fiber 50mbps" being both allowed would just be a confusing
        near-duplicate in the datalist suggestions this list feeds."""
        existing = [p for p in Plan.query.all() if p.name.strip().lower() == field.data.strip().lower()]
        if existing:
            raise ValidationError("This plan already exists.")


# ---------------------------------------------------------------------
# Phase 15 — Administrator "Service Requests" management form
# ---------------------------------------------------------------------


class ServiceRequestForm(FlaskForm):
    """Form used for both creating and editing a service request.
    `subscriber_id.choices` and `requested_nap_id.choices` are
    populated dynamically by the route from the current contents of
    the `subscribers`/`naps` tables, same dynamic-choices pattern
    IssueReportForm/SubscriberForm already use. Both are optional (0 =
    "not set") since the underlying columns are nullable — a request
    can arrive from a walk-in applicant with no subscriber record yet,
    matching the existing seed data.
    """

    request_type = SelectField(
        "Request Type",
        choices=[
            ("new_installation", "New Installation"),
            ("relocation", "Relocation"),
            ("upgrade", "Upgrade"),
            ("disconnection", "Disconnection"),
        ],
        validators=[DataRequired(message="Request type is required.")],
    )
    subscriber_id = SelectField(
        "Subscriber",
        coerce=int,
        validators=[Optional()],
    )
    requested_nap_id = SelectField(
        "Requested NAP",
        coerce=int,
        validators=[Optional()],
    )
    status = SelectField(
        "Status",
        choices=[
            ("pending", "Pending"),
            ("approved", "Approved"),
            ("scheduled", "Scheduled"),
            ("completed", "Completed"),
            ("rejected", "Rejected"),
        ],
        default="pending",
        validators=[DataRequired()],
    )
    # Phase 22 (phase_11.pdf): optional customer/proposed-installation
    # coordinates. Both-or-neither isn't enforced at the field level
    # (same relaxed approach NapForm... actually NapForm requires both;
    # here both are Optional since, unlike a NAP, a service request is
    # frequently created with no location at all — see app/forms.py's
    # ServiceRequestForm docstring) — app/nap_recommendation.py simply
    # can't be run for a request missing either one, same as any other
    # incomplete-data case elsewhere in this app.
    latitude = DecimalField(
        "Customer Latitude",
        places=7,
        validators=[
            Optional(),
            NumberRange(min=-90, max=90, message="Latitude must be between -90 and 90."),
        ],
    )
    longitude = DecimalField(
        "Customer Longitude",
        places=7,
        validators=[
            Optional(),
            NumberRange(min=-180, max=180, message="Longitude must be between -180 and 180."),
        ],
    )
    notes = TextAreaField(
        "Notes",
        validators=[Optional(), Length(max=2000, message="Notes are too long.")],
    )
    # Walk-in applicant details — only shown/required on the Add form
    # when Request Type is "New Installation" (see form.html's JS
    # toggle). A walk-in new-installation applicant has no Subscriber
    # record yet, so these are collected here and saved onto the
    # request's own full_name/address/contact_number columns (see
    # ServiceRequest in app/models.py) rather than folded into the
    # free-text Notes field, which now just holds the auto-generated
    # "Walk-in application" description (see app/routes/
    # service_requests.py's _build_walkin_note()).
    full_name = StringField(
        "Full Name",
        validators=[Optional(), Length(max=150, message="Full name is too long.")],
    )
    address = StringField(
        "Address",
        validators=[Optional(), Length(max=255, message="Address is too long.")],
    )
    contact_number = StringField(
        "Contact Number",
        validators=[Optional(), Length(max=20, message="Contact number is too long.")],
    )

    def validate(self, extra_validators=None):
        """Beyond the per-field validators above: New Installation
        walk-ins must include the applicant's basic details, since
        that's the only place this information is captured (see the
        three fields above)."""
        if not super().validate(extra_validators=extra_validators):
            return False
        if self.request_type.data == "new_installation":
            ok = True
            if not (self.full_name.data or "").strip():
                self.full_name.errors.append("Full name is required for a new installation request.")
                ok = False
            if not (self.address.data or "").strip():
                self.address.errors.append("Address is required for a new installation request.")
                ok = False
            if not (self.contact_number.data or "").strip():
                self.contact_number.errors.append("Contact number is required for a new installation request.")
                ok = False
            if not ok:
                return False
        return True
