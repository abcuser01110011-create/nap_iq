"""
Settings Blueprint — Phase 15, opened up to all roles for Display Settings
----------------------------------------------------------------------------
Fills in the "Settings" sidebar placeholder that was deliberately left
disabled ("Coming soon") since PHASE13_NOTES.md, pending scope. Scope
for v1 was agreed with the client before any code was written (see
PHASE15_NOTES.md): app-level config, specifically —

    1. Session Timeout (minutes) — how long an idle login stays
       signed in. Applied live: app/settings_utils.py's
       `apply_dynamic_settings()` before_request hook reads this
       value every request and sets it on
       `current_app.permanent_session_lifetime`, so a change here
       takes effect on the very next request without an app restart.
    2. Default NAP Total Ports — the value app/routes/naps.py's
       `add_nap()` pre-fills the "Total Ports" field with on the
       (GET) Add NAP form. A starting suggestion, not a hard rule —
       an administrator can still type a different value per NAP.

Backed by a single singleton row in `app_settings` (see
app/models.py's `AppSettings.get_current()`), not a generic key/value
store — the set of settings is small and known ahead of time, so this
matches the schema's existing style of typed columns. Both fields above
remain administrator-only.

Dark-mode addition (Phase 24): the page now also has a "Display
Settings" card (Dark Mode toggle) that every signed-in role can see and
use, since it's a personal preference rather than app-level config. It
is intentionally NOT part of `AppSettings`/`SettingsForm` above — it's
saved per user account on `users.theme_preference` (see app/models.py)
via the separate `set_theme()` endpoint below, so it follows a signed-in
user to any browser/device rather than living in that one browser's
localStorage, and each account defaults to 'light' regardless of role.
The sign-in screen (auth/login.html, via base.html) never reads this
column — it always renders in light mode, fixed, no matter what the
account about to sign in has saved.

Plans addition: a "Plans" card, administrator-only, for adding to or
removing from the `plans` table (see app/models.py's `Plan` model) —
the list of suggested subscriber plan names offered elsewhere in the
app (subscribers/form.html and naps/map.html's install planner, both
via a `<datalist>`). Deliberately its own small table + its own two
routes below rather than folded into AppSettings/SettingsForm, since
it's a variable-length list an admin adds/removes rows from over time,
not a fixed set of scalar settings — same reasoning `set_theme()`
above already applies for keeping unrelated concerns on their own
endpoint. Removing a plan here never touches any subscriber that
already has that plan_type value; see `Plan`'s docstring.

Routes:
    GET  /settings/               -> index       (show settings form)
    POST /settings/               -> index       (process app settings form; administrators only)
    POST /settings/theme          -> set_theme   (save the caller's own Dark Mode preference; any role)
    POST /settings/plans          -> add_plan    (add a new plan name; administrators only)
    POST /settings/plans/<id>/delete -> delete_plan (remove a plan; administrators only)
"""

from flask import Blueprint, render_template, redirect, url_for, flash, g, request, jsonify

from app.extensions import db
from app.auth import login_required, role_required
from app.models import AppSettings, Plan, USER_THEME_PREFERENCES
from app.forms import SettingsForm, PlanForm

settings_bp = Blueprint("settings", __name__, url_prefix="/settings")


@settings_bp.route("/", methods=["GET", "POST"])
@login_required
def index():
    """Shows Display Settings (all roles) and the App Settings /
    Plans sections (administrators only)."""
    settings = AppSettings.get_current()
    form = SettingsForm(obj=settings)
    plan_form = PlanForm()
    plans = Plan.query.order_by(Plan.name).all()

    if g.user.role == "administrator" and form.validate_on_submit():
        settings.session_timeout_minutes = form.session_timeout_minutes.data
        settings.default_nap_total_ports = form.default_nap_total_ports.data
        settings.nap_connection_radius_meters = form.nap_connection_radius_meters.data

        # GeoMap default filters — only the *starting* state of each
        # naps/map.html control; the controls themselves stay fully
        # interactive for every role on every visit (see AppSettings'
        # docstring in app/models.py).
        settings.geomap_default_show_naps = form.geomap_default_show_naps.data
        settings.geomap_default_show_issues = form.geomap_default_show_issues.data
        settings.geomap_default_show_subscribers = form.geomap_default_show_subscribers.data

        settings.geomap_default_status_active = form.geomap_default_status_active.data
        settings.geomap_default_status_inactive = form.geomap_default_status_inactive.data
        settings.geomap_default_status_maintenance = form.geomap_default_status_maintenance.data
        settings.geomap_default_status_full = form.geomap_default_status_full.data
        settings.geomap_default_ports_filter = form.geomap_default_ports_filter.data

        settings.geomap_default_issue_status_pending = form.geomap_default_issue_status_pending.data
        settings.geomap_default_issue_status_assigned = form.geomap_default_issue_status_assigned.data
        settings.geomap_default_issue_status_in_progress = form.geomap_default_issue_status_in_progress.data
        settings.geomap_default_issue_status_resolved = form.geomap_default_issue_status_resolved.data
        settings.geomap_default_issue_status_closed = form.geomap_default_issue_status_closed.data

        settings.geomap_default_issue_priority_low = form.geomap_default_issue_priority_low.data
        settings.geomap_default_issue_priority_medium = form.geomap_default_issue_priority_medium.data
        settings.geomap_default_issue_priority_high = form.geomap_default_issue_priority_high.data
        settings.geomap_default_issue_priority_critical = form.geomap_default_issue_priority_critical.data

        settings.updated_by_id = g.user.id
        db.session.commit()
        flash("Settings updated successfully.", "success")
        return redirect(url_for("settings.index"))

    return render_template(
        "settings/index.html", form=form, settings=settings, plan_form=plan_form, plans=plans
    )


@settings_bp.route("/plans", methods=["POST"])
@role_required("administrator")
def add_plan():
    """Adds one new row to the `plans` table. Administrator-only —
    Jinja also only ever renders this form inside the admin-only Plans
    card, but the route itself is the actual enforcement point (same
    belt-and-suspenders pattern the rest of this app already uses)."""
    plan_form = PlanForm()

    if plan_form.validate_on_submit():
        plan = Plan(name=plan_form.name.data.strip())
        db.session.add(plan)
        db.session.commit()
        flash(f'Plan "{plan.name}" added.', "success")
    else:
        for error in plan_form.name.errors:
            flash(error, "danger")

    return redirect(url_for("settings.index"))


@settings_bp.route("/plans/<int:plan_id>/delete", methods=["POST"])
@role_required("administrator")
def delete_plan(plan_id):
    """Removes a plan from the `plans` table. This is a hard delete —
    safe because `Subscriber.plan_type` is a free-text column, not a
    foreign key to this table (see `Plan`'s docstring in
    app/models.py), so no subscriber record references a plan's id;
    removing it here only stops that name from being suggested to new
    ones going forward."""
    plan = Plan.query.get_or_404(plan_id)
    name = plan.name
    db.session.delete(plan)
    db.session.commit()
    flash(f'Plan "{name}" removed.', "success")
    return redirect(url_for("settings.index"))


@settings_bp.route("/theme", methods=["POST"])
@login_required
def set_theme():
    """Saves the signed-in user's own Dark Mode preference (Settings >
    Display Settings). Any role can call this — it's a personal display
    preference tied to the account, not the administrator-only app
    config above. Called by static/js/theme.js, which applies the
    change instantly client-side and posts here in the background to
    persist it; static/js/napmap.js reads the result (via
    `window.NapIQTheme.get()`) to pick a matching light/dark basemap on
    the GeoMap.
    """
    payload = request.get_json(silent=True) or {}
    theme = payload.get("theme")

    if theme not in USER_THEME_PREFERENCES:
        return jsonify({"error": "Invalid theme."}), 400

    g.user.theme_preference = theme
    db.session.commit()
    return jsonify({"theme": g.user.theme_preference})
