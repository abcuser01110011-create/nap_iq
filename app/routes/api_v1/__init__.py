"""
Mobile API (Phase 25)
-----------------------
JSON, JWT-authenticated endpoints for the two native mobile apps
(Technician, Customer) — see the NAP-IQ mobile apps plan. Kept
entirely separate from app/routes/api.py, which is the existing
read-only, session-cookie-gated JSON feed for the internal GeoMap.

Each sub-module here owns one blueprint:
    auth.py        -> api_v1_auth_bp        (/api/v1/auth/...)
    technician.py  -> api_v1_technician_bp  (/api/v1/technician/...) [later task]
    customer.py    -> api_v1_customer_bp    (/api/v1/customer/...)   [later task]

All are registered on the app in app/__init__.py, same as every other
blueprint in the project.
"""

from app.routes.api_v1.auth import api_v1_auth_bp
from app.routes.api_v1.technician import api_v1_technician_bp
from app.routes.api_v1.customer import api_v1_customer_bp

__all__ = ["api_v1_auth_bp", "api_v1_technician_bp", "api_v1_customer_bp"]
