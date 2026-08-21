# NAP-IQ — Automated Test Suite (Phase 19)

Turns most of `TESTING.md` from "click through a browser" into "run
one command." Uses Flask's built-in test client (in-process, no
browser, no real network socket) against the real app code, with an
in-memory SQLite database standing in for MySQL.

## Running it

```bash
pip install -r requirements.txt
pip install pytest
pytest -v
```

No `.env` file, no MySQL server, and no browser needed for this to
run — it's fully self-contained.

## What's covered

| File | Automates |
|---|---|
| `test_login.py` | TESTING.md §1 — valid/invalid login, generic error message, already-logged-in redirect, logout |
| `test_account_status.py` | TESTING.md §2 — deactivated/suspended login, mid-session deactivation, reactivation |
| `test_rate_limiting.py` | TESTING.md §2a — per-IP and per-username `/login` rate limits, 429 page, GET never throttled |
| `test_https_enforcement.py` | TESTING.md §2b — `FORCE_HTTPS` redirect behavior, off-by-default |
| `test_rbac_matrix.py` | TESTING.md §3 — role×route 403 matrix, unauthenticated `next=` redirect, open-redirect + protocol-relative rejection |
| `test_scoped_access.py` | TESTING.md §4 — Technician NAP-list/view scoping (Phase 17), admin sees everything, GeoMap deliberately unrestricted |
| `test_session_timeout.py` | TESTING.md §5 — dynamic timeout applies live to an already-logged-in session; **does not** simulate real elapsed time (see below) |

Not automated: TESTING.md §6 (Notifications) — it depends on
payments/dispatch/service-request workflows this suite doesn't seed,
and would roughly double the suite's size for one section. Worth a
Phase 20 if you want it.

## The one thing this suite cannot prove

NAP-IQ enforces session expiration the standard Flask way: a signed
cookie whose `Max-Age` the client is expected to honor, not a
server-side "last active" timestamp NAP-IQ re-checks itself. Flask's
test client doesn't simulate real time passing, so "an idle session
gets rejected after N minutes" can only be proven by actually waiting
N minutes with a real client (TESTING.md §5's manual steps) — this
suite instead proves the *mechanism* feeding that behavior (the
timeout value updates live on `current_app.permanent_session_lifetime`
for an already-logged-in session), which is the part that's actually
new/risky code. The literal countdown is Flask/browser plumbing this
app doesn't reimplement.

## Honesty note

This suite was written against the actual route decorators, model
columns, and blueprint URL prefixes in this exact codebase (grepped
and read directly, not guessed from memory), and every file passes
`python3 -m py_compile`. It has **not been executed** — the sandbox
this was built in has no network access, so `Flask-SQLAlchemy`,
`Flask-WTF`, `Flask-Limiter`, and `email-validator` (all in
`requirements.txt` already) couldn't be installed to actually run
`pytest` and confirm every assertion passes. Please run `pytest -v`
yourself as the first thing you do with this — some assertion values
(exact flash-message byte strings, exact redirect targets) are more
likely than the RBAC logic itself to need a small tweak once actually
executed. Report back anything that fails and it can be fixed
directly.
