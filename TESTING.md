# NAP-IQ — Testing Procedure

Manual test procedure for authentication, session, and role-based
access control (RBAC) behavior. Written against the seeded demo
accounts in `database/seed.sql` (see table below); run these against
a real MySQL instance with `schema.sql` + `seed.sql` loaded — no
automated test suite exists yet (see `PHASE17_NOTES.md`'s Known
Follow-ups).

Where a step says "confirm 403", the expected result is NAP-IQ's own
`app/templates/errors/403.html` page (an "Access Denied" card with a
link back to the signed-in account's own home page), not a generic
Flask/Werkzeug error page and not a silent redirect.

## Demo accounts

| Username    | Password       | Role              | Status |
|-------------|----------------|-------------------|--------|
| admin1      | Admin@12345    | administrator     | active |
| tech1       | Tech@12345     | technician        | active |
| tech2       | Tech@12345     | technician        | active |
| collector1  | Collect@12345  | payment_collector | active |
| customer1   | User@12345     | user (customer)   | active |

`payment_collector` has its own landing page (`/collector/`, Phase
10) but was never one of the three roles phase_7.pdf scoped a
dedicated interface for — it's included below only where relevant
(login itself, and as a fourth role to bounce off the other three
roles' pages).

---

## 1. Login — valid and invalid credentials

For **each** of the five demo accounts above:

1. Go to `/login`.
2. Submit the correct username and password.
   - **Expect:** a `"Welcome back, <full name>."` flash, then a
     redirect to that role's home page (`ROLE_HOME_ENDPOINT` in
     `app/auth.py`: `dashboard.index` / `technician.index` /
     `collector.index` / `customer.index`).
3. Log out (`POST /logout` via the nav bar's Log Out button), then go
   back to `/login` and submit:
   - the correct username with a **wrong** password,
   - a **username that doesn't exist** at all.
   - **Expect:** both cases show the exact same flash message,
     `"Invalid username or password."` — this is intentional (see
     `app/routes/auth.py`'s `login()` docstring): the message
     shouldn't let someone tell which of the two is true, since a
     different message per case would let the login form be used to
     enumerate valid usernames.
4. While already logged in (any role), navigate to `/login` directly.
   - **Expect:** immediately redirected to `/home` (your own role's
     landing page) — the login form itself is never re-shown to an
     already-authenticated session.

## 2. Deactivated / suspended account login

1. As `admin1`, go to **Manage Users**, open `customer1`, and click
   **Deactivate**.
   - **Expect:** a confirmation flash, and `customer1`'s status badge
     changes to "Inactive".
2. Log out of `admin1`. Attempt to log in as `customer1` with its
   correct password.
   - **Expect:** login is rejected with the flash `"This account has
     been deactivated. Please contact an administrator."` — no
     session is created.
3. **If `customer1` was already logged in in another browser/tab**
   when it was deactivated: refresh any page in that other session.
   - **Expect:** the very next request treats that session as logged
     out (`app/auth.py`'s `load_logged_in_user()` re-checks
     `user.status == "active"` on every request, not just at login),
     and the session cookie is cleared — a stale cookie from before
     the deactivation can't keep the account usable.
4. As `admin1`, reactivate `customer1` (**Activate** button) and
   confirm it can log in again normally.
5. Repeat step 2 for a `'suspended'` status if you manually set one
   via SQL (`UPDATE users SET status = 'suspended' WHERE username =
   'customer1';`) — the same rejection should occur, since the check
   is `status != 'active'`, not specifically `'inactive'`.

## 2a. Login rate limiting (Phase 18)

Uses the default limits (`10 per minute` per IP, `5 per minute` per
submitted username — see `SECURITY_CHECKLIST.md`'s "Rate limiting on
`/login`" section); adjust the counts below if you've changed
`LOGIN_RATE_LIMIT_PER_IP`/`_PER_USERNAME` in `.env`.

1. From one browser/client, submit `POST /login` with the **same**
   username (e.g. `customer1`, any password — wrong is fine, it still
   counts as an attempt) six times in quick succession.
   - **Expect:** the first five attempts each return the normal login
     page (with the "Invalid username or password." flash, or a
     successful login if you used the real password on one of them).
     The sixth returns NAP-IQ's styled 429 page
     (`app/templates/errors/429.html`, "Too Many Attempts") instead of
     the login form.
2. Wait roughly a minute for the window to reset, then confirm login
   attempts succeed again.
3. Repeat step 1 using **eleven different usernames** (real or not)
   from the same client in quick succession, to trigger the per-IP
   limit instead of the per-username one — the eleventh should also
   return 429.
4. Confirm a plain `GET /login` (just loading the page, no form
   submit) is never blocked, no matter how many times you refresh —
   both limits are scoped to `POST` only.

## 2b. HTTPS enforcement (Phase 18, opt-in)

Only applicable if you've set `FORCE_HTTPS=True` in `.env` — skipped
by default, since a local `http://` dev server has no TLS to redirect
to.

1. With `FORCE_HTTPS=True` and the app running with TLS available (or
   `TRUST_X_FORWARDED_PROTO=True` behind a proxy that sets
   `X-Forwarded-Proto`), request `http://<host>/login` directly.
   - **Expect:** a 301 redirect to `https://<host>/login`.
2. With `FORCE_HTTPS=False` (the default), confirm plain `http://`
   requests are served normally with no redirect — this step exists
   to catch the flag accidentally being left on in a local dev
   `.env`.

## 3. Role-based direct-URL access (expect 403)

For each row, log in as the role in the **Signed in as** column and
request the URL in the **Target URL** column directly (paste it into
the address bar — don't navigate via a link the UI wouldn't show
that role anyway, since the point is testing the server-side guard,
not the UI hiding a link).

| Signed in as | Target URL | Expect |
|---|---|---|
| technician | `/users/` (Manage Users) | 403 |
| technician | `/settings/` | 403 |
| technician | `/reports/` | 403 |
| technician | `/naps/add` | 403 |
| technician | `/naps/<id>/edit` for any NAP id | 403 |
| technician | `/dispatch/` | 403 |
| technician | `/subscribers/` | 403 |
| technician | `/technicians/` | 403 |
| technician | `/naps/<id>` for a NAP **not** tied to one of their assignments | 403 (Phase 17) |
| technician | `/issues/<id>` for an issue **never** assigned to them | 403 (Phase 14) |
| user (customer) | `/dashboard/` | 403 |
| user (customer) | `/technician/` | 403 |
| user (customer) | `/naps/` | 403 |
| user (customer) | `/users/` | 403 |
| user (customer) | `/issues/` (staff issue list) | 403 |
| user (customer) | `/collector/` | 403 |
| payment_collector | `/dashboard/` | 403 |
| payment_collector | `/technician/` | 403 |
| payment_collector | `/portal/` (customer portal) | 403 |
| administrator | *(all of the above)* | 200 — an Administrator is never blocked from any staff route |

Also confirm the **unauthenticated** case: while logged out, request
any protected URL (e.g. `/dashboard/`) directly.
- **Expect:** redirected to `/login?next=/dashboard/` (not a 403 —
  `login_required`/`role_required` both send an anonymous visitor to
  the login page rather than a 403, since they haven't been denied a
  permission yet, they just haven't proven who they are). After
  logging in, confirm you land back on `/dashboard/` (the `next=`
  value), not the generic role home page. Then confirm a
  **malicious** `next` value is rejected: log out, go to
  `/login?next=https://example.com`, log in, and confirm you land on
  your own role's home page, **not** an external redirect — `next` is
  only honored when it's a same-site relative path (see
  `SECURITY_CHECKLIST.md`'s open-redirect section).

## 4. Technician / Customer scoped-access spot checks

These aren't full 403 tests (the routes are reachable by design) but
confirm the *content* returned is correctly narrowed — a bug here
would leak another subscriber's data rather than reject the request
outright.

1. As `tech1`, open **My Assignments** (`/technician/`) and note which
   issues are listed. Open **NAP Management** (`/naps/`) and confirm
   only NAPs tied to one of those listed issues appear (Phase 17) —
   compare against `admin1`'s full NAP list to confirm it's a subset,
   not the same list.
2. As `tech1`, open the GeoMap (`/naps/map`). Confirm **every** NAP
   still plots (this is the documented, intentional exception —
   `/api/naps` stays unscoped for the shared situational view) while
   the issue/subscriber marker layers only show `tech1`'s own
   assigned work.
3. As `customer1`, open **My Service Requests**, **My Issues**, and
   **Payments** under the customer portal and confirm every row shown
   belongs to `customer1`'s own linked subscriber record — cross-check
   against `admin1`'s full admin-side lists for the same records to
   confirm nothing extra or missing.

## 5. Session timeout (Phase 15 Settings)

1. As `admin1`, go to **Settings** (`/settings/`) and set **Session
   Timeout (minutes)** to `5` (the form enforces a 5–1440 minute
   range), then save.
2. Log out, log back in as any account, and let the session sit idle
   (no requests) for **longer** than 5 minutes.
3. Make any request (e.g. reload the dashboard).
   - **Expect:** treated as logged out — redirected to `/login`, since
     the signed cookie's timestamp is now older than
     `PERMANENT_SESSION_LIFETIME`, which `app/settings_utils.py`'s
     `apply_dynamic_settings()` set from the Settings value on every
     request.
4. Repeat with the timeout set back to a normal value (e.g. `60`) and
   confirm a session idle for under a minute is **not** logged out.
5. Set **Default NAP Total Ports** to a new value (e.g. `24`) while
   here too, then as `admin1` open **NAP Management -> Add NAP** and
   confirm the **Total Ports** field is pre-filled with `24` on the
   initial GET (not on a failed-validation re-render, which should
   keep whatever was actually submitted).

## 6. Notifications page (Administrator and Customer only)

Technician and Payment Collector accounts have no Notifications page
in this round — confirm `/notifications/` 403s for `tech1` and
`collector1` as part of Section 3's table above, then:

1. As `admin1`, change a service request's status (**Service
   Requests -> Edit -> change Status -> Save**) so it actually
   transitions (e.g. `pending` -> `approved`). Then open
   **Notifications** as `admin1`.
   - **Expect:** a new, unread `service_request`-category row appears
     at the top, dated just now.
2. Open **Notifications** as the customer whose service request that
   was (their linked `user` account, if any).
   - **Expect:** that customer sees their own matching
     `service_request` row — and it is a **different row** than the
     admin's (Administrator sees an `audience='administrator'` row;
     the customer sees their own `audience='customer'` row) — not the
     same notification shared between both.
3. Repeat for a payment transitioning into `'overdue'` (**Payments ->
   Add/Edit**, or **Record Payment** on the collector's own page with
   Status set to `overdue`) and for a technical issue's status
   changing (**Dispatch -> Assign/Reassign/Cancel**, or **Technician
   -> Start/Complete** on an assignment) — confirm exactly two rows
   land each time (one customer, one administrator), per
   `PHASE17_NOTES.md`'s notification-triggers verification.
4. Confirm a subscriber with **no linked user account** produces only
   the administrator-audience row and no orphaned customer row (there
   is nobody to link a `user_id` to) — pick a subscriber from
   **Subscribers** with **Linked Login: Not linked** shown on their
   detail
   page, trigger one of the three event types against them, and
   confirm Notifications as `admin1` shows exactly one new row, not
   two.
5. Click **Mark as read** on a single row, then **Mark all as read**.
   - **Expect:** the unread-count badge in the sidebar/topbar
     (`dashboard_base.html`) decrements accordingly and reaches 0
     after "Mark all as read".
6. As `customer1`, attempt `POST /notifications/<id>/read` for a
   notification id that belongs to a **different** customer (find one
   via `admin1`'s administrator-audience list, or by trying a nearby
   id). Expect a 403, not a redirect or silent no-op — confirms
   `notifications.py`'s `_assert_own()` ownership check, not just the
   list view's filtering.
