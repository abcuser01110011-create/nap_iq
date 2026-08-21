# NAP-IQ — Phase 18 Notes (Login Rate Limiting, Opt-in HTTPS Enforcement)

## Scope

This round closed the two items `SECURITY_CHECKLIST.md` had explicitly
flagged as **not implemented** at the end of Phase 17 ("Known gaps"
#1 and #2). Nothing else from Phases 1–17 was touched — no route
signatures, templates, or auth/RBAC core logic changed beyond the two
additions below.

1. **Rate limiting on `/login`.** Previously unlimited attempts per
   IP/account with no backoff.
2. **HTTPS enforcement (opt-in).** Previously no in-app HTTP→HTTPS
   redirect at all — only the separate `SESSION_COOKIE_SECURE` flag
   controlling the cookie itself.

Both are described in full, with exact file/function references, in
the updated `SECURITY_CHECKLIST.md`. This file only covers what
changed and why.

---

## 1. Login rate limiting

Added Flask-Limiter (`requirements.txt`), a shared `limiter` instance
(`app/extensions.py`, alongside the existing `db`), and initialized it
in the application factory (`limiter.init_app(app)` in
`app/__init__.py`, next to the existing `csrf.init_app(app)`).

`app/routes/auth.py`'s `login()` gets two independent limits, both
scoped to `POST` only so the plain `GET` of the login form is never
throttled:

- **Per remote IP** (Limiter's default `key_func`) —
  `LOGIN_RATE_LIMIT_PER_IP`, defaults to `10 per minute`.
- **Per submitted username** (new `_login_username_key()` helper,
  lower-cased/stripped, with a fallback key when the field is blank) —
  `LOGIN_RATE_LIMIT_PER_USERNAME`, defaults to `5 per minute`. This
  half exists because a per-IP-only limit doesn't stop a botnet
  spreading attempts against one account across many source IPs.

Both limit values are read from `current_app.config` via a lambda
(not frozen at import time), so they're overridable per deployment
through `.env` with no code change.

Exceeding either limit now returns a styled 429 page
(`app/templates/errors/429.html`, matching the existing 403 page's
look) via a new `@app.errorhandler(429)` in `app/__init__.py`, instead
of Flask-Limiter's default bare-text response.

**Storage caveat (documented, not solved this round):** the default
storage (`RATELIMIT_STORAGE_URI`, defaults to `memory://`) only
tracks attempts within a single process. A multi-worker deployment
(e.g. gunicorn with more than one worker) would have each worker
counting separately, weakening the effective limit. Set
`RATELIMIT_STORAGE_URI=redis://...` in `.env` for a real multi-worker
deployment — no code change needed, just the config value.

## 2. HTTPS enforcement (opt-in)

New `app/config.py` settings: `FORCE_HTTPS` (default `False`) and
`TRUST_X_FORWARDED_PROTO` (default `False`). When `FORCE_HTTPS=True`,
a new `before_request` hook in `app/__init__.py`
(`_enforce_https()`) 301-redirects any request whose scheme isn't
`https` to the same URL over `https`. `TRUST_X_FORWARDED_PROTO`
additionally opts into reading the `X-Forwarded-Proto` header instead
of Flask's own `request.scheme` — needed behind a TLS-terminating
reverse proxy (which talks to Flask over plain HTTP internally), and
deliberately off by default since blindly trusting that header with
no such proxy in front would let a client fake "already HTTPS" by
setting it themselves.

Left off by default for the same reason it was left unimplemented
before: a local `http://` dev server has no TLS to redirect to, and
many production deployments already redirect HTTP→HTTPS at a reverse
proxy/load balancer in front of Flask, which would make an in-app
redirect redundant there. This is deliberately independent of
`SESSION_COOKIE_SECURE` (unchanged, Phase 7) — that flag controls
whether the cookie is marked `Secure`; `FORCE_HTTPS` controls whether
a plain-HTTP request gets redirected at all. A deployment where Flask
itself is the first hop needs both set.

---

## Changed files

- `requirements.txt` — added `Flask-Limiter==3.8.0`.
- `app/extensions.py` — new `limiter` (Flask-Limiter instance,
  `default_limits=[]` so nothing is throttled app-wide by default,
  only routes that opt in).
- `app/config.py` — `RATELIMIT_STORAGE_URI`,
  `LOGIN_RATE_LIMIT_PER_IP`, `LOGIN_RATE_LIMIT_PER_USERNAME`,
  `FORCE_HTTPS`, `TRUST_X_FORWARDED_PROTO`.
- `app/__init__.py` — `limiter.init_app(app)`; opt-in
  `_enforce_https()` before_request hook; new
  `@app.errorhandler(429)`.
- `app/routes/auth.py` — `_login_username_key()` helper; two
  `@limiter.limit(...)` decorators on `login()`.
- `app/templates/errors/429.html` — new, styled to match
  `errors/403.html`.
- `SECURITY_CHECKLIST.md` — both items moved from "NOT IMPLEMENTED"
  to "IMPLEMENTED", with file/function references; "Known gaps"
  section rewritten for what's still actually open.
- `TESTING.md` — new Section 2a (login rate limiting) and Section 2b
  (HTTPS enforcement, opt-in).
- `PHASE18_NOTES.md` — this file.

## Not touched

- Everything from Phases 1–17 — auth/RBAC core (`@login_required`,
  `@role_required`, `ROLE_HOME_ENDPOINT`), the `users.status` sweep,
  Notifications, GeoMap/API/NAP scoping, CSRF, session cookie flags,
  session timeout, the `next=` open-redirect guard. No route
  signatures or templates changed beyond the new `errors/429.html`.

---

## Manual verification checklist (run against your real environment)

- [ ] `pip install -r requirements.txt` picks up `Flask-Limiter`
      cleanly (this sandbox has no network access, so this round was
      verified by `python3 -m py_compile` on every touched file — all
      clean — and by reading the Flask-Limiter API against its
      documented usage, not by actually running the app against a
      live install).
- [ ] Run `TESTING.md` Section 2a end-to-end: 6 rapid `POST /login`
      attempts with the same username → 6th returns the styled 429
      page; wait ~1 minute → attempts succeed again; 11 attempts
      across different usernames from one client → 11th also 429; a
      plain `GET /login` is never throttled.
- [ ] If deploying with more than one worker process, set
      `RATELIMIT_STORAGE_URI` to a shared Redis instance and re-verify
      Section 2a — the in-memory default will under-enforce the limit
      across workers otherwise.
- [ ] If deploying with `FORCE_HTTPS=True`: run `TESTING.md` Section
      2b — confirm plain `http://` is 301-redirected to `https://`.
      If behind a TLS-terminating reverse proxy, also set
      `TRUST_X_FORWARDED_PROTO=True` and confirm the redirect loop
      doesn't fire again on the proxy's internal plain-HTTP request to
      Flask (i.e. confirm the proxy actually sets `X-Forwarded-Proto:
      https` on the original request it forwards).
- [ ] Re-read `SECURITY_CHECKLIST.md`'s "Known gaps" section — items
      3–4 there (no account lockout, no automated security testing)
      are still open if you want a Phase 19 to tackle either.

**Not yet run against a live MySQL instance or a live Flask-Limiter
install** in this sandbox (no outbound network / no DB server
available here) — same caveat as every prior phase's notes. Python
syntax (`py_compile`) was checked directly in this sandbox and is
clean for every touched file.

---

## Continuation prompt (paste this to resume)

```
Continue developing my NAP-IQ Flask + MySQL system.
Upload: nap_iq_phase18.zip (includes PHASE7-18_NOTES.md history,
TESTING.md, SECURITY_CHECKLIST.md).
Phases 1-18 are complete and verified by code review — do not rework
the auth/RBAC core, the users.status sweep, the Notifications system,
the GeoMap/API/NAP-management scoping, or the Phase 18 login rate
limiting / opt-in HTTPS enforcement, unless a bug is found.

Known outstanding items, per PHASE18_NOTES.md and
SECURITY_CHECKLIST.md's "Known gaps":
  - Rate limiting's in-memory storage doesn't share state across
    worker processes — needs RATELIMIT_STORAGE_URI pointed at Redis
    for a real multi-worker deployment.
  - No account lockout, only rate limiting (a determined attacker
    staying just under both /login limits can still make slow
    progress).
  - No automated security testing (bandit/pip-audit/CSRF-XSS test
    suite) — everything so far has been manual code review plus
    py_compile, never run against a live MySQL instance or a live
    Flask-Limiter install in this sandbox.

Keep the same patterns already in the codebase (role_required
decorators, status pattern, CSRF-protected POST forms,
PHASE<N>_NOTES.md per phase, dynamic-choices-populated-by-the-route
pattern for dropdowns). Don't touch anything from phases 1-18 unless
a bug is found.
```
