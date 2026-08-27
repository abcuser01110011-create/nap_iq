"""
NAP-IQ Flask Application Factory
---------------------------------
This module creates and configures the Flask application instance using
the "application factory" pattern. This pattern is used (instead of a
single global `app` object) so the project stays testable and modular
as more blueprints, extensions, and configurations are added in later
development phases.
"""

from flask import Flask, render_template, g, request, redirect, jsonify

from flask_wtf import CSRFProtect

from app.config import Config
from app.extensions import db, limiter, jwt

csrf = CSRFProtect()


def create_app(config_class: type = Config) -> Flask:
    """Create and configure an instance of the Flask application.

    Args:
        config_class: Configuration class to load settings from.
                       Defaults to the base Config class.

    Returns:
        A fully configured Flask application instance.
    """
    app = Flask(__name__)
    app.config.from_object(config_class)

    # ---- Initialize extensions ----
    db.init_app(app)
    csrf.init_app(app)  # protects all POST forms (add/edit/deactivate/activate)
    limiter.init_app(app)  # Phase 18: brute-force protection, applied to POST /login
    jwt.init_app(app)  # Phase 25: token auth for the api_v1 mobile-app endpoints only

    # ---- Mobile API token auth callbacks (Phase 25) ----
    # Registered here (rather than in app/extensions.py) because both
    # need the `app.models` import, which app/extensions.py
    # deliberately avoids to prevent a circular import with
    # app/models.py importing `db` from this same extensions module.
    from app.models import RevokedToken, User

    @jwt.user_lookup_loader
    def _load_jwt_user(_jwt_header, jwt_data):
        """Turns a verified token's identity into `current_user` for
        every @jwt_role_required view (app/jwt_auth.py) — the JWT
        equivalent of load_logged_in_user() populating `flask.g.user`
        below for the session-cookie side."""
        return User.query.get(int(jwt_data["sub"]))

    @jwt.token_in_blocklist_loader
    def _check_if_token_revoked(_jwt_header, jwt_data):
        """Backs POST /api/v1/auth/logout — see RevokedToken's
        docstring in app/models.py for why a normally-stateless JWT
        needs this at all."""
        jti = jwt_data["jti"]
        return db.session.query(RevokedToken.id).filter_by(jti=jti).first() is not None

    @jwt.expired_token_loader
    def _expired_token_response(_jwt_header, _jwt_data):
        return jsonify(error="Token has expired. Please log in again."), 401

    @jwt.invalid_token_loader
    def _invalid_token_response(_reason):
        return jsonify(error="Invalid token."), 401

    @jwt.unauthorized_loader
    def _missing_token_response(_reason):
        return jsonify(error="Authorization token is required."), 401

    @jwt.revoked_token_loader
    def _revoked_token_response(_jwt_header, _jwt_data):
        return jsonify(error="Token has been revoked. Please log in again."), 401

    # ---- HTTPS enforcement (Phase 18) ----
    # Off unless FORCE_HTTPS=True is set in .env — see app/config.py's
    # comment on why the default has to be False (local dev has no
    # TLS; many deployments already redirect at the reverse-proxy
    # layer in front of Flask). When it IS enabled, this runs before
    # every request and 301-redirects any plain-HTTP request to the
    # same URL over HTTPS.
    if app.config["FORCE_HTTPS"]:

        @app.before_request
        def _enforce_https():
            # `request.is_secure` reflects the connection Flask itself
            # sees. Behind a TLS-terminating reverse proxy, that
            # connection is plain HTTP even though the original client
            # request was HTTPS — TRUST_X_FORWARDED_PROTO opts into
            # reading the proxy-set header instead, and must only be
            # turned on when a proxy that actually sets this header
            # honestly sits in front (see config.py's comment).
            if app.config["TRUST_X_FORWARDED_PROTO"]:
                scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
            else:
                scheme = request.scheme

            if scheme != "https":
                https_url = request.url.replace("http://", "https://", 1)
                return redirect(https_url, code=301)

    # ---- Authentication (Phase 7) ----
    # Runs before every request so `g.user` (None if nobody's logged
    # in, otherwise the current User row) is always available — to
    # every view function and every template, not just ones behind
    # @login_required / @role_required.
    from app.auth import load_logged_in_user
    from app.settings_utils import apply_dynamic_settings

    # Phase 15: applies the admin-configurable session timeout before
    # load_logged_in_user runs, so a session started later in this
    # same request already uses the up-to-date lifetime. Kept as its
    # own hook in its own module rather than added into
    # load_logged_in_user itself — see settings_utils.py's docstring
    # for why the Phase 7 auth core was left untouched.
    app.before_request(apply_dynamic_settings)
    app.before_request(load_logged_in_user)

    @app.context_processor
    def inject_current_user():
        """Makes `current_user` available in every Jinja template
        without each view having to pass it explicitly."""
        return {"current_user": g.get("user")}

    @app.context_processor
    def inject_role_home_endpoint():
        """Makes the signed-in user's own "home" endpoint available as
        `role_home_endpoint` in every template — used by
        dashboard_base.html so its "Dashboard" sidebar link always
        points at the current role's own landing page (Administrator ->
        dashboard.index, Technician -> technician.index, Customer ->
        customer.index, Payment Collector -> collector.index) instead of
        being hard-coded to the Administrator one, since that same
        layout is shared by all four dashboards. Falls back to
        `dashboard.index` for a logged-out visitor so the template can
        still call `url_for()` without erroring."""
        from app.auth import ROLE_HOME_ENDPOINT

        user = g.get("user")
        endpoint = ROLE_HOME_ENDPOINT.get(user.role, "dashboard.index") if user else "dashboard.index"
        return {"role_home_endpoint": endpoint}

    @app.context_processor
    def inject_unread_notifications_count():
        """Makes `unread_notifications_count` available in every Jinja
        template (Phase 17) — used by dashboard_base.html's sidebar
        link and topbar bell to show a badge. Returns 0 for a
        logged-out visitor or a role with no Notifications page
        (Technician, Payment Collector) — see
        app/notifications_utils.py's `unread_count_for`."""
        from app.notifications_utils import unread_count_for

        return {"unread_notifications_count": unread_count_for(g.get("user"))}

    @app.context_processor
    def inject_recent_notifications():
        """Makes `recent_notifications` available in every Jinja
        template — the last handful of the signed-in account's own
        notifications, used by dashboard_base.html's topbar bell
        popover (a Facebook-style "peek" list) so it doesn't need its
        own page load/route to populate. Returns [] for a logged-out
        visitor or a role with no Notifications page, same as
        `unread_notifications_count` above. Kept small (6) since this
        is a quick glance, not the full history — that's what the
        popover's "View all notifications" link goes to."""
        from app.notifications_utils import recent_for

        return {"recent_notifications": recent_for(g.get("user"), limit=6)}

    @app.context_processor
    def inject_sidebar_badges():
        """Makes `sidebar_badges` available in every Jinja template —
        a dict of small "needs action" counts shown as a pill next to
        a sidebar link (e.g. Subscribers, Dispatch Board), one key per
        badge-worthy nav item. See app/sidebar_badges.py's module
        docstring for what each count means and why it's computed
        differently for an Administrator/Technician (live status
        counts) than a Customer (unread notification counts).
        Returns {} for a logged-out visitor or a role with nothing
        badge-worthy (Payment Collector)."""
        from app.sidebar_badges import sidebar_badge_counts

        return {"sidebar_badges": sidebar_badge_counts(g.get("user"))}

    # ---- Register blueprints ----
    from app.routes.main import main_bp
    from app.routes.naps import naps_bp
    from app.routes.api import api_bp
    from app.routes.issues import issues_bp
    from app.routes.dashboard import dashboard_bp
    from app.routes.auth import auth_bp
    from app.routes.technician import technician_bp
    from app.routes.customer import customer_bp
    from app.routes.users import users_bp
    from app.routes.dispatch import dispatch_bp
    from app.routes.collector import collector_bp
    from app.routes.profile import profile_bp
    from app.routes.subscribers import subscribers_bp
    from app.routes.technicians import technicians_bp
    from app.routes.reports import reports_bp
    from app.routes.settings import settings_bp
    from app.routes.service_requests import service_requests_bp
    from app.routes.payments import payments_bp
    from app.routes.notifications import notifications_bp
    from app.routes.api_v1 import api_v1_auth_bp, api_v1_technician_bp, api_v1_customer_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(naps_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(issues_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(technician_bp)
    app.register_blueprint(customer_bp)
    app.register_blueprint(users_bp)
    app.register_blueprint(dispatch_bp)
    app.register_blueprint(collector_bp)
    app.register_blueprint(profile_bp)
    app.register_blueprint(subscribers_bp)
    app.register_blueprint(technicians_bp)
    app.register_blueprint(reports_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(service_requests_bp)
    app.register_blueprint(payments_bp)
    app.register_blueprint(notifications_bp)
    app.register_blueprint(api_v1_auth_bp)
    app.register_blueprint(api_v1_technician_bp)
    app.register_blueprint(api_v1_customer_bp)

    # CSRFProtect (registered above) defends the session-cookie HTML
    # app's forms against cross-site POSTs — a browser automatically
    # attaches a cookie to any request, so a form needs its own proof
    # the submission actually came from this app's own page. The
    # api_v1 blueprints authenticate with a bearer token in the
    # Authorization header instead: nothing about a cross-site request
    # can make a browser attach that header on its own, so there's no
    # CSRF exposure here to defend against, and Flask-WTF has no way to
    # know that — it would otherwise 400 every JSON POST to these
    # blueprints for lacking a CSRF token that a mobile app has no
    # reason to send. See app/jwt_auth.py's docstring for the auth
    # model these blueprints actually use.
    csrf.exempt(api_v1_auth_bp)
    csrf.exempt(api_v1_technician_bp)
    csrf.exempt(api_v1_customer_bp)

    # ---- Error handlers (Phase 7) ----
    @app.errorhandler(403)
    def forbidden(_error):
        """Shown when a logged-in user's role doesn't allow a route
        they reached directly by URL (role_required's 403 path)."""
        return render_template("errors/403.html"), 403

    @app.errorhandler(429)
    def rate_limited(_error):
        """Phase 18: shown when either /login rate limit (per-IP or
        per-submitted-username, see app/routes/auth.py) is exceeded.
        Flask-Limiter's default response is a bare text/plain "429 Too
        Many Requests" body; this swaps it for a styled page consistent
        with the rest of the app's error handling."""
        return render_template("errors/429.html"), 429

    return app
