# NAP-IQ — Security Checklist

Sign-off list for NAP-IQ's authentication and RBAC security controls.
Each item points at where it's actually implemented so it can be
verified by reading the code, not just taken on faith. Items not yet
implemented are marked accordingly rather than omitted — see
"Known gaps" at the end.

## Password hashing

- **Where:** `app/models.py`, `User.set_password()` /
  `User.check_password()`.
- **What:** `werkzeug.security.generate_password_hash(raw_password,
  method="pbkdf2:sha256")` on write; `check_password_hash()` on read.
  PBKDF2-SHA256 with a random per-password salt (Werkzeug's default
  iteration count as of the pinned Flask/Werkzeug version) — never a
  fast unsalted hash (MD5/SHA1) and never a reversible encryption.
- **Verify:** `password_hash` is the only password-related column on
  `users` (`database/schema.sql`); no code path anywhere compares
  `form.password.data` against a stored value directly (grep the repo
  for `== .*password` — the only comparison is via `check_password()`
  in `app/routes/auth.py`'s `login()`).
- **No plaintext exists:** `database/seed.sql`'s demo accounts are
  pre-hashed (`pbkdf2:sha256:...` strings), not plaintext — there was
  never a legacy plaintext column to clean up in this schema.

## Session cookie flags

- **Where:** `app/config.py`, `Config` class.
- **What:**
  - `SESSION_COOKIE_HTTPONLY = True` — always on, not
    environment-configurable, since there's never a legitimate reason
    for client-side JS to read the session cookie.
  - `SESSION_COOKIE_SAMESITE = "Lax"` — always on. Blocks the cookie
    being sent on most cross-site requests (a key CSRF mitigation
    layered under the CSRF-token check below, not a replacement for
    it).
  - `SESSION_COOKIE_SECURE = _get_bool("SESSION_COOKIE_SECURE",
    "False")` — environment-driven, **defaults to False**. This is
    intentional and documented in `config.py`'s own comment: a local
    `http://` dev server cannot set a `Secure` cookie at all, so the
    default has to be `False` for local development to work. **This
    must be set to `True` via the `.env` file (`SESSION_COOKIE_SECURE=True`)
    for any real deployment served over HTTPS** — it is not
    automatic. See "Known gaps" below; this is the one item in this
    section that requires a deployment-time action, not just code
    review.
- **Session contents:** only `session["user_id"]` is ever stored
  (`app/routes/auth.py`'s `login()`) — no role, no password hash, no
  other PII in the cookie itself. The cookie is signed (tamper-evident
  via `SECRET_KEY`) but not encrypted, which is why nothing sensitive
  beyond an opaque integer id is put in it.
- **Session fixation:** `session.clear()` runs immediately before
  `session["user_id"]` is set on every successful login (see
  `login()`) — guarantees no leftover session data from a previous
  account survives into a freshly authenticated one, even on a shared
  browser.

## Session expiration

- **Where:** `app/config.py` (`PERMANENT_SESSION_LIFETIME`,
  environment-seeded default) and `app/settings_utils.py`
  (`apply_dynamic_settings()`).
- **What:** `session.permanent = True` is set on every login
  (`auth.py`), so the session is subject to
  `current_app.permanent_session_lifetime`. That value is not static —
  `apply_dynamic_settings()` runs as a `before_request` hook (see
  `app/__init__.py`'s registration order, ahead of
  `load_logged_in_user`) and re-reads
  `AppSettings.session_timeout_minutes` on every single request, so an
  Administrator changing the timeout on the Settings page
  (`/settings/`) takes effect immediately, without an app restart, and
  without waiting for existing sessions to naturally expire first.
- **Verify:** set a very short timeout via Settings and confirm an
  idle session is rejected on its next request — see
  `TESTING.md` Section 5.

## CSRF protection

- **Where:** `app/__init__.py` (`CSRFProtect().init_app(app)`,
  applied globally) and every `FlaskForm` subclass in
  `app/forms.py`.
- **What:** Flask-WTF's `CSRFProtect` validates a per-session CSRF
  token on every state-changing request app-wide — not opted in per
  route. Every form template renders `{{ form.hidden_tag() }}` (or an
  explicit `{{ csrf_token() }}` hidden field, e.g. the nav bar's
  logout form and each POST-only action button like
  Deactivate/Activate/Approve/Reject/Void) so the token travels with
  the request. `base.html` also exposes the token via a
  `<meta name="csrf-token">` tag for any JavaScript
  `fetch()`/`XMLHttpRequest` call (e.g. `napmap.js`'s quick-add-NAP
  request) to attach as a header.
- **Verify:** every `<form method="post">` in `app/templates/` renders
  a CSRF field — grep for `method="post"` alongside `csrf_token` to
  confirm none were missed as new routes were added phase over phase.

## Open-redirect guard on `next=`

- **Where:** `app/routes/auth.py`, `_is_safe_next_url()`.
- **What:** after a successful login, `next_url` (from
  `request.args.get("next")` or `request.form.get("next")`) is only
  followed if `_is_safe_next_url()` returns True — which requires the
  value to start with a single `/` and explicitly rejects a leading
  `//` (browsers can treat a `//`-prefixed path as protocol-relative
  and follow it off-site). Anything else — a full
  `https://evil.example` URL, a `javascript:` URI, or a bare `//`
  falls through to the normal `redirect(url_for("auth.home"))` instead.
- **Why it matters:** without this check, a crafted
  `/login?next=https://evil.example` link would use NAP-IQ's own,
  trusted login page to send someone to an attacker's site immediately
  after they type in their real password — a classic open-redirect
  phishing setup.
- **Verify:** see `TESTING.md` Section 3's last paragraph for the
  manual test steps.

## SQL injection via the ORM

- **Where:** every query in every `app/routes/*.py` file and
  `app/models.py`.
- **What:** all data access goes through SQLAlchemy's ORM query API
  (`Model.query.filter_by(...)`, `Model.query.filter(...)`) or the
  parameterized Core `db.select(...)` construct (used for the
  aggregate/grouped queries in `app/routes/dashboard.py` and
  `app/routes/reports.py`) — never raw SQL string concatenation or
  Python f-strings/`%`-formatting building a query. Search filters
  (e.g. `naps.list_naps()`'s `?q=`, `issues.list_issues()`'s
  `?q=&status=&priority=`) use `.ilike(f"%{search_term}%")` where
  `search_term` is passed as a **bound parameter** to `ilike()`, not
  spliced into a SQL string — the `%` wildcards are part of the
  parameter value, not the query text.
- **The one raw-SQL call in the app**
  (`app/routes/main.py`'s `database_test()`, `db.session.execute(text("SELECT
  1"))`) takes no user input at all — it's a fixed connectivity
  smoke-test string, not a template.
- **Verify:** grep the repo for `text(` and `.execute(` — every hit
  either takes a fixed literal (the `SELECT 1` above) or a
  SQLAlchemy Core `db.select(...)` object, never an f-string/`.format()`/
  `%`-built SQL string.

## Env-var-based secrets

- **Where:** `app/config.py`, loaded via `python-dotenv`'s
  `load_dotenv()` at module import time.
- **What:** `SECRET_KEY`, all five MySQL connection settings
  (`MYSQL_HOST`/`PORT`/`USER`/`PASSWORD`/`DB`),
  `SESSION_COOKIE_SECURE`, and `SESSION_LIFETIME_MINUTES` are all read
  from `os.environ` with a local `.env` file (not committed) as the
  intended source, never hardcoded as the *actual* value used in a
  real deployment. `SECRET_KEY`'s in-code fallback
  (`"dev-secret-key-change-in-production"`) exists only so the app can
  boot at all without a `.env` file present in this sandbox — it is
  not a production value and its name says so explicitly.
- **Verify:** confirm `.env` (or equivalent secret store) is in
  `.gitignore` / never committed, and that a real deployment's
  `SECRET_KEY` is a long random value distinct from the fallback
  string, not the fallback itself left in place.

## Input validation / sanitization

- **Where:** every form in `app/forms.py` (all `FlaskForm`
  subclasses) plus template-level auto-escaping.
- **What:** every field that reaches the database goes through a
  WTForms validator chain — `DataRequired`, `Length(max=...)` (28
  fields across the form set), `NumberRange`, `Email`, `Optional`,
  and NAP-IQ-specific custom validators for things like coordinate
  ranges. Nothing is written to the database from raw
  `request.form[...]`/`request.args[...]` without going through a
  form's `validate_on_submit()` first, **except** the read-only search
  querystring filters (`?q=`, `?status=`), which are used only inside
  a parameterized `.ilike()`/`.filter()` call (see the SQL-injection
  section above) and never written back to the database or reflected
  unescaped into HTML.
- **Output escaping:** Jinja2's autoescaping is on by default for
  `.html` templates (Flask's default) and was not disabled anywhere
  (`grep -rn "| safe\|Markup(" app/templates/` turns up nothing) — no
  template renders user-supplied text (names, addresses, descriptions,
  etc.) unescaped, which is what would otherwise open a stored-XSS
  path.

## Prevent sensitive-data exposure

- **Where:** `app/routes/api.py`'s three JSON endpoints
  (`naps_json`/`issues_json`/`subscribers_json`) and every Jinja
  template.
- **What:** each JSON response builds an explicit dict of only the
  fields the frontend needs (id, code, name, coordinates, status,
  etc.) — never `model_instance.__dict__` or an ORM-object
  auto-serializer that could accidentally include `password_hash` or
  other internal columns. Grep confirms `password_hash` never appears
  in `app/routes/*.py`'s response-building code or in any
  `app/templates/*.html` file — the only two places it's referenced at
  all are its column definition and the two methods in
  `app/models.py` that hash/compare it.
- **Logging:** the app doesn't log request bodies or form data
  anywhere (no custom request-logging middleware exists), so a
  submitted password is never written to a log file in the first
  place, hashed or not.

## Rate limiting on `/login`

- **Status: IMPLEMENTED (Phase 18).**
- **Where:** `app/extensions.py` (`limiter = Limiter(...)`),
  `app/routes/auth.py` (the two `@limiter.limit(...)` decorators on
  `login()`), `app/__init__.py` (`limiter.init_app(app)`,
  `errorhandler(429)`), `app/config.py`
  (`LOGIN_RATE_LIMIT_PER_IP`/`_PER_USERNAME`, `RATELIMIT_STORAGE_URI`).
- **What:** Flask-Limiter enforces two independent limits on `POST
  /login` only (a plain `GET` of the form doesn't count against
  either budget):
  - Per remote IP address (Limiter's default `key_func`), default
    `10 per minute` — stops one source hammering any/many accounts.
  - Per submitted username (`_login_username_key()`, lower-cased and
    stripped), default `5 per minute` — stops many IPs (e.g. a
    botnet) grinding a single account, which the per-IP limit alone
    would not catch.
  Both are overridable via `.env` (`LOGIN_RATE_LIMIT_PER_IP`,
  `LOGIN_RATE_LIMIT_PER_USERNAME`) without a code change. Exceeding
  either returns a styled 429 page (`app/templates/errors/429.html`)
  rather than Flask-Limiter's default plain-text response.
- **Known limitation:** the default storage backend
  (`RATELIMIT_STORAGE_URI`, defaults to Flask-Limiter's in-memory
  store) only tracks attempts within a single process. Under a
  multi-worker deployment (e.g. gunicorn with more than one worker),
  each worker keeps its own counters, so the *effective* limit is
  roughly `configured limit × worker count` rather than a single
  shared budget. Point `RATELIMIT_STORAGE_URI` at a shared backend
  such as Redis (e.g. `redis://localhost:6379/0`) for a real
  multi-worker deployment — see `app/config.py`'s comment.
- **Verify:** submit 11+ rapid `POST /login` attempts from the same
  client with the same username and confirm the 11th returns 429; see
  `TESTING.md` Section 2a.

## HTTPS enforcement (production)

- **Status: IMPLEMENTED, opt-in (Phase 18).**
- **Where:** `app/config.py` (`FORCE_HTTPS`,
  `TRUST_X_FORWARDED_PROTO`), `app/__init__.py`'s `_enforce_https()`.
- **What:** off by default (`FORCE_HTTPS=False`) for the same reason
  it was left unimplemented before — a local `http://` dev server has
  no TLS to redirect to, and many production deployments already
  redirect HTTP→HTTPS at a reverse proxy/load balancer in front of
  Flask, which would make an in-app redirect redundant. Set
  `FORCE_HTTPS=True` in `.env` for a deployment where Flask itself is
  the first hop that sees plain HTTP traffic; every request is then
  301-redirected to the same URL over HTTPS if it isn't already.
  Behind a TLS-terminating reverse proxy, also set
  `TRUST_X_FORWARDED_PROTO=True` so the check reads the proxy's
  `X-Forwarded-Proto` header instead of Flask's own (always-HTTP,
  since the proxy talks to Flask in plaintext) view of the
  connection — **only** turn this on when a proxy that is actually
  known to set this header honestly sits in front, since trusting it
  with no such proxy would let a client fake "already HTTPS" by
  setting the header itself.
- **This remains independent of `SESSION_COOKIE_SECURE`** (above) —
  that flag controls whether the cookie is marked `Secure`; this
  controls whether a plain-HTTP request is redirected at all. Both
  need to be set for a real HTTPS deployment where Flask sees plain
  HTTP directly.
- **Verify:** with `FORCE_HTTPS=True`, request `http://<host>/login`
  and confirm a 301 to `https://<host>/login`; see `TESTING.md`
  Section 2b.

---

## Known gaps (not implemented as of Phase 18)

These are genuine gaps, not just undocumented — listed here instead
of silently assumed to be "someone else's problem":

1. **`SESSION_COOKIE_SECURE`, `SECRET_KEY`, `FORCE_HTTPS`, and
   `RATELIMIT_STORAGE_URI` still need a real, production `.env` file
   at deploy time** — the codebase supports all of these correctly,
   but nothing in the code *forces* them to be set; a deployment that
   forgets will silently run with dev-safe (but production-unsafe)
   defaults. Worth a deployment-checklist item outside this repo, or
   a startup-time check that refuses to boot with `DEBUG=True` and
   the fallback `SECRET_KEY` simultaneously.
2. **Rate limiting's in-memory storage doesn't share state across
   worker processes** (see above) — fine for a single-worker
   deployment, needs Redis (or similar) for a real multi-worker one.
3. **No automated security testing.** Everything in this document was
   verified by manual code review, not an automated scan (e.g.
   `bandit`, `safety`/`pip-audit` for dependency CVEs, or a CSRF/XSS
   test suite). See `TESTING.md`'s own note on the lack of an
   automated test suite generally.
4. **No account lockout, only rate limiting.** A determined attacker
   who stays just under both `/login` rate limits can still make slow
   brute-force progress indefinitely — the limits raise the cost of an
   attack but don't cap total attempts the way an account lockout
   (with an admin-driven unlock) would. Not implemented here since it
   introduces its own denial-of-service risk (an attacker locking out
   a legitimate user by repeatedly failing their username) that would
   need its own design discussion before building.
