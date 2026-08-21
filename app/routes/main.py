"""
Main Blueprint
---------------
Holds general-purpose routes that don't belong to a specific feature
module yet. For this foundation phase, this is just a landing route
and the /database-test diagnostic route.
"""

from flask import Blueprint, jsonify, redirect, url_for, g

from app.extensions import db
from app.auth import role_required
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
    return redirect(url_for("auth.login"))


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
