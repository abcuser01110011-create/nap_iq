"""
NAP-IQ Entry Point
--------------------
Run this file to start the Flask development server:

    python run.py

For later phases (Flask-Migrate, CLI commands, etc.) this is also the
natural place to register custom `flask` CLI commands via `app.cli`.
"""

from app import create_app

app = create_app()

if __name__ == "__main__":
    app.run(debug=app.config["DEBUG"])
