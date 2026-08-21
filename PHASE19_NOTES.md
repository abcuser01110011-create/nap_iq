# NAP-IQ — Phase 19 Notes (Automated Test Suite)

## Scope

The user asked, in effect: "is running TESTING.md by hand in a real
browser really the only way to close this out?" It isn't — most of
`TESTING.md`'s scenarios are ordinary HTTP request/response checks
(status codes, redirect targets, response body content, session
cookie contents), which Flask's built-in test client can exercise
directly against the real app code with no browser and no MySQL
server. This phase adds that as `tests/`, a pytest suite.

No app code changed this round — this is entirely new test
infrastructure. See `tests/README.md` for what's covered, how to run
it, and its one honest limitation (real elapsed-time session expiry
can't be simulated by a test client — see below).

## Why SQLite instead of MySQL for the tests

Every model in `app/models.py` uses SQLAlchemy's cross-dialect column
types with no raw MySQL-specific SQL anywhere in the auth/RBAC code
path (confirmed in `SECURITY_CHECKLIST.md`'s SQL-injection section
back in Phase 17). That means the ORM logic this suite exercises
behaves identically against SQLite. This is a deliberate trade:
SQLite makes the suite fast and dependency-free (no server to start),
at the cost of not catching a true MySQL-specific issue (collation,
storage-engine quirks). `TESTING.md` still recommends one real run
against actual MySQL before a production deploy — this suite makes
that one remaining run much shorter, since everything else will
already be caught.

## What's covered

Seven test files, mapped directly to `TESTING.md`'s existing section
numbers (`test_login.py` → §1, `test_account_status.py` → §2,
`test_rate_limiting.py` → §2a, `test_https_enforcement.py` → §2b,
`test_rbac_matrix.py` → §3, `test_scoped_access.py` → §4,
`test_session_timeout.py` → §5). Full list of what each file asserts
is in `tests/README.md`'s table — not repeated here to avoid the two
docs drifting apart.

**Not automated:** §6 (Notifications) — it depends on seeding
payments/dispatch/service-request workflows this suite doesn't touch,
which would roughly double its size for one section. Left as a
manual step, or a candidate for Phase 20 if wanted.

## The one thing an automated suite genuinely can't prove here

NAP-IQ's session timeout (`SESSION_LIFETIME_MINUTES` /
`AppSettings.session_timeout_minutes`, Phase 15) is enforced the
standard Flask way: a signed cookie with a `Max-Age` the client is
expected to honor, not a server-side "last active" timestamp NAP-IQ
re-checks on every request. Flask's test client doesn't simulate real
wall-clock time passing, so "an idle session is rejected after N
minutes" can only be proven with a real client actually waiting N
minutes — `TESTING.md` §5's manual step. `test_session_timeout.py`
instead proves the *mechanism feeding that behavior* — that changing
the timeout setting updates `current_app.permanent_session_lifetime`
live, including for an already-logged-in session — which is the part
of Phase 15's work that was actually new/risky code; the literal
countdown-and-reject is Flask/browser plumbing this app doesn't
reimplement, so there's nothing suite-specific left to get wrong
there.

## Honesty note — this has not been run

The suite was written by directly reading this codebase's actual
route decorators (`grep`'d and read, not recalled from memory), model
columns, and blueprint URL prefixes, and every file passes
`python3 -m py_compile`. It has **not been executed.** This sandbox
has no network access — confirmed by attempting both `pip install
flask-limiter` and `apt-get install mariadb-server`, both of which
failed on DNS/fetch errors — so `Flask-SQLAlchemy`, `Flask-WTF`,
`Flask-Limiter`, and `email-validator` (all already pinned in
`requirements.txt`) could not be installed here to actually run
`pytest` and confirm every assertion passes as written.

**Please run `pytest -v` yourself as the first step** — most likely
candidates for a small fixup if something fails: an exact flash-
message byte-string not matching Jinja's rendered HTML exactly (e.g.
HTML-escaping of an apostrophe), or a redirect target's exact
formatting. The underlying RBAC/auth logic being tested is unlikely
to be the source of a failure, since it's unchanged from the
already-shipped Phase 7–18 code — but this line shouldn't be taken on
faith either; report back anything that fails and it can be fixed
directly against the real failure output.

---

## Changed files

- `tests/conftest.py` — new: `TestConfig`, `app`/`client` fixtures,
  `DEMO_ACCOUNTS`, `login()` helper.
- `tests/test_login.py`, `tests/test_account_status.py`,
  `tests/test_rate_limiting.py`, `tests/test_https_enforcement.py`,
  `tests/test_rbac_matrix.py`, `tests/test_scoped_access.py`,
  `tests/test_session_timeout.py` — new.
- `tests/README.md` — new: coverage table + the honesty note above.
- `pytest.ini` — new: points pytest at `tests/`.
- `requirements.txt` — added `pytest==8.3.3` under a new dev/test-only
  comment block.
- `PHASE19_NOTES.md` — this file.

## Not touched

Every app file from Phases 1–18 — this phase is test infrastructure
only, no application code changed.

---

## Manual verification checklist (run against your real environment)

- [ ] `pip install -r requirements.txt` then `pytest -v` — confirm all
      tests pass; fix and report back anything that doesn't (see
      "Honesty note" above for the likely failure shapes).
- [ ] Once the automated suite is green, run `TESTING.md` §6
      (Notifications) manually — the one section this suite doesn't
      cover.
- [ ] Run `TESTING.md` §5's manual real-time step once (set a short
      timeout, wait it out, confirm the next request is rejected) —
      the one behavior this suite structurally can't simulate.
- [ ] For full confidence before a production deploy: run this same
      suite (or at minimum `TESTING.md` end-to-end by hand once) against
      a real MySQL instance instead of SQLite, per the "Why SQLite"
      note above.

---

## Continuation prompt (paste this to resume)

```
Continue developing my NAP-IQ Flask + MySQL system.
Upload: nap_iq_phase19.zip (includes PHASE7-19_NOTES.md history,
TESTING.md, SECURITY_CHECKLIST.md, tests/).
Phases 1-19 are complete. Phases 1-18 are verified by code review;
Phase 19 (tests/, an automated pytest suite covering TESTING.md
Sections 1-5, 2a-2b) has been written and py_compile-checked but
NOT executed — no network/MySQL was available in the sandbox that
built it. Do not rework the auth/RBAC core, the users.status sweep,
Notifications, GeoMap/API/NAP scoping, or Phase 18's rate
limiting/HTTPS enforcement, unless a bug is found.

First step: run `pytest -v` and report the actual results. If
anything fails, fix it against the real failure output rather than
guessing.

Known outstanding items:
  - tests/ has never been executed (see PHASE19_NOTES.md's honesty
    note) — this is the first thing to resolve.
  - TESTING.md Section 6 (Notifications) has no automated coverage.
  - TESTING.md Section 5's real-time session-expiry step can't be
    automated (see PHASE19_NOTES.md) and still needs one manual run.
  - Rate limiting's in-memory storage doesn't share state across
    worker processes — needs RATELIMIT_STORAGE_URI pointed at Redis
    for a real multi-worker deployment.
  - No account lockout, only rate limiting.

Keep the same patterns already in the codebase (role_required
decorators, status pattern, CSRF-protected POST forms,
PHASE<N>_NOTES.md per phase). Don't touch anything from phases 1-19
unless a bug is found.
```
