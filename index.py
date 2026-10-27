"""
Vercel entrypoint.

Vercel's Python runtime looks for a top-level `app` variable in one of
app.py / index.py / server.py / main.py / wsgi.py. This project's real entry
point is run.py, and a root-level app.py would clash with the `app/` package,
so this tiny file just re-exports the Flask app from run.py.

Local development is unchanged:  python run.py
"""

from run import app  # noqa: F401  (Vercel imports `app` from this module)
