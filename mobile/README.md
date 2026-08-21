# nap-iq-mobile

**Single installable app** (`apps/app`, `com.napiq.app`) with
role-based routing for **technician** and **customer** accounts —
one login screen, one install, one download. `AuthContext` derives
the role from the backend's `user.role` on login (`technician` →
technician UI, `user` → customer UI) and `RootNavigator` renders the
matching tab/stack navigator; nothing is asked up front, and there's
no separate app to pick between.

This was originally built as two standalone Expo apps (Task 5:
Customer, Task 6: Technician, on a shared Task 4 `api-client`) and
has since been merged into one. Nothing about the backend contract,
screens, or feature set changed — only how they're packaged and
routed. Backend (tasks 1–3: JWT auth, `api_v1`
technician/customer blueprints) was already in place in the uploaded
project — this monorepo talks to it as-is.

```
nap-iq-mobile/
├── package.json              # yarn workspaces root
├── packages/
│   └── api-client/           # @nap-iq/api-client — shared TS client
│       └── src/
│           ├── types.ts          # mirrors api_v1's exact JSON shapes
│           ├── tokenStorage.ts   # injectable TokenStorage interface
│           ├── client.ts         # ApiClient: fetch + refresh-on-401
│           └── index.ts
├── apps/
│   └── app/                  # "NAP-IQ" — com.napiq.app (single install)
│       ├── App.tsx
│       ├── app.json
│       └── src/
│           ├── auth/            # AuthContext derives role from login
│           ├── navigation/      # RootNavigator branches on role
│           ├── theme/           # customer.ts, technician.ts, shared.ts
│           ├── screens/
│           │   ├── LoginScreen.tsx   # one screen, both roles
│           │   ├── customer/         # Home/Issues/Requests/Payments/Profile
│           │   └── technician/       # Jobs/History/JobDetail/Profile
│           ├── offline/         # technician-only SQLite queue + sync
│           ├── notifications/   # technician-only push registration
│           └── components/      # JobLocationMap (technician)
```

## Why one app instead of two

The two apps were near-identical in shape (same `AuthProvider` /
`useAuth()` pattern, same `RootNavigator` → tabs → screens structure,
same `secureTokenStorage`), differing only in which screens and
theme they mounted and in the extra offline/notifications/maps
subsystems the technician side needed. Merging kept every screen and
subsystem file as-is (moved, not rewritten) and consolidated the
parts that actually needed to be shared:

- **One `AuthContext`** — the two apps' copies each hard-rejected the
  "wrong" role after a successful login (a customer account was
  technically accepted by `/api/v1/auth/login` too, so each app
  logged it back out again). That check doesn't make sense in a
  single app — instead, `toAppRole()` maps the backend's role to
  which UI to render, and login only fails for a role neither half of
  the app knows about.
- **One `secureTokenStorage`** — the old `technician_` / `customer_`
  key prefixes existed only to keep two separate installs' tokens
  apart; one install, one signed-in account at a time, no prefix
  needed.
- **One `LoginScreen`** — same fields, no "which app is this" framing.
- **Two theme files, not one** — `theme/customer.ts` (light) and
  `theme/technician.ts` (dark) are both kept, unchanged, and each
  role's screens still import their own. There's also a small
  `theme/shared.ts` for the login screen and cold-start spinner,
  which render before a role is known.
- **Technician-only subsystems stayed gated, not deleted** — the
  offline SQLite queue, push notification registration, and the maps
  component are only mounted/called on the technician branch of
  `RootNavigator`; `registerPushToken`/`unregisterPushToken` now take
  the caller's role and no-op for customer accounts instead of
  silently hitting a technician-only backend endpoint.

## What's implemented

- **`@nap-iq/api-client`** — one `ApiClient` class, typed against the
  *actual* backend responses (read from
  `app/routes/api_v1/{auth,technician,customer}.py`, not just the plan
  doc — a couple of endpoint shapes drifted during implementation:
  customer profile is `GET /me`, not `/profile`, and there's no
  `POST /service-requests` or technician `/naps` / `/route` yet).
  - `client.auth.login/logout`
  - `client.technician.listAssignments/assignmentHistory/acceptAssignment/startAssignment/saveNotes/completeAssignment`
  - `client.customer.me/listIssues/reportIssue/listServiceRequests/listPayments`
  - Automatic silent refresh: any authenticated request that gets a
    401 tries `/api/v1/auth/refresh` once, then replays the original
    request. Concurrent 401s are de-duped into a single refresh call.
    If the refresh token itself is rejected, `onAuthExpired` fires and
    stored tokens are cleared — that's the one signal both apps use to
    bounce back to the login screen.
  - `TokenStorage` is an interface, not baked into the client — each
    app supplies its own `expo-secure-store`-backed implementation
    (Keychain/Keystore, never `AsyncStorage`, since these are auth
    tokens).

- **Both apps** — `AuthProvider` + `useAuth()`, a `LoginScreen`. Cold-start
  session restore, logout (revokes both tokens server-side, matching
  `api_v1/auth.py`'s `logout()` docstring — "once per token"), and a
  role guard (a technician account can't get past the Customer app's
  login screen and vice versa, and it doesn't just take the backend's
  word — a customer account is *technically* accepted by
  `/api/v1/auth/login` too, so each app also checks `user.role` itself
  after login and immediately logs back out if it's wrong).

- **Customer app (Task 5)** — full tab navigation
  (`@react-navigation/bottom-tabs`), five screens, all wired to the
  real `api_v1/customer/*` endpoints:
  - **Home** — subscriber summary (code, plan, status, linked NAP),
    open-issue and pending-request counts, last payment.
  - **Issues** — full list + a "Report issue" FAB that opens a modal
    form. The form's issue-type chips are hand-kept in sync with
    `app/forms.py`'s `ISSUE_TYPE_CHOICES` (the exact set the backend
    validates against in `api_v1/customer.py`), and surfaces the
    backend's per-field `errors` object inline rather than one generic
    error message.
  - **Requests** — service request list. Read-only: there's no
    `POST /api/v1/customer/service-requests` in the backend yet (only
    `GET`), so the empty state says so instead of implying a "new
    request" button is coming.
  - **Payments** — read-only payment history.
  - **Profile** — account + subscriber details, logout.

  Technician app still has its Task-4 proof screen only (see below).

- **Technician app (Task 6, online flow)** — full tab navigation:
  - **Jobs** — open assignments list → tap through to job detail.
  - **History** — completed/cancelled assignments, same detail screen
    (read-only there — see below).
  - **Profile** — account info + logout. Technician-specific fields
    (status, resolved-job count, contact number) aren't shown because
    there's no `GET /api/v1/technician/me` on the backend yet — only
    the assignments endpoints exist in `api_v1/technician.py`. Worth
    adding one mirroring `customer.py`'s `me()` before building this
    out further.
  - **Job detail** — the whole point of this app. Renders the
    subscriber/issue/NAP info the backend's `_serialize_assignment`
    already includes (so no second round-trip per job), an "Open in
    Maps" link when coordinates are available, and buttons that
    exactly track the backend's status machine
    (`assigned → accepted → in_progress → completed`, from
    `technician.py`'s docstring): Accept only shows on `assigned`,
    Start only on `accepted`, notes are editable on `accepted`/
    `in_progress` and read-only once closed, Complete only shows on
    `in_progress` and is guarded by a confirmation alert plus the same
    "notes required" rule the backend enforces
    (`complete_assignment()`'s 400 if neither a fresh nor
    previously-saved note exists).
  - There's no `GET /api/v1/technician/assignments/<id>` (single-job
    fetch) on the backend — only the two list endpoints — so job
    detail is opened by passing the already-fetched `Assignment`
    object through route params rather than re-fetching by id; each
    action call's response (`{assignment: ...}`) becomes the new
    local state, and the list screens refetch on focus (`goBack()`
    from job detail) to pick up the change.

- **Technician app — offline layer (Task 6, offline half)**, in
  `apps/technician/src/offline/`:
  - **`db.ts`** — a local SQLite mirror (`expo-sqlite`'s sync API,
    SDK 51+) with two tables: `assignments` (a cached snapshot per
    list — `open` for the Jobs tab, `history` for the History tab) and
    `pending_actions` (the write queue).
  - **`assignmentsRepo.ts` / `pendingActionsRepo.ts`** — thin
    synchronous read/write helpers over those tables.
  - **`optimistic.ts`** — applies a queued action to a cached
    assignment locally (mirrors the same `assigned → accepted →
    in_progress → completed` machine as the backend) so the UI
    reflects Accept/Start/Notes/Complete immediately, online or not.
  - **`OfflineContext.tsx`** — the app's data layer: on mount, loads
    whatever's cached on disk before any network call (so a cold
    start works offline); `refresh()` re-fetches both lists when
    online and re-caches them; every write (`acceptJob`, `startJob`,
    `saveNotes`, `completeJob`) applies the optimistic update, appends
    a row to `pending_actions`, and kicks a sync attempt if online.
    `syncNow()` drains the queue oldest-first: a real rejection from
    the server (bad status transition, job reassigned, a validation
    error — anything that isn't connectivity) drops that one action
    and surfaces it via `conflicts[assignmentId]` instead of retrying
    it forever; a network failure stops the whole run so it retries as
    a unit. Triggered by `@react-native-community/netinfo`'s
    reconnect event and a 30s interval while the app's open.
  - **`SyncBanner.tsx`** — "offline, N changes queued" / "syncing N
    changes" banner on the Jobs and History tabs; Job Detail shows its
    own queued/conflict banners since that's where a tech would act on
    one.
  - **Conflict handling** matches the plan: the server stays the
    source of truth. A queued action isn't silently applied if it no
    longer makes sense server-side — it's dropped from the queue and
    the error is shown on that job's detail screen until dismissed or
    superseded by a later successful sync.
  - **Not included**: map tiles aren't cached — `JobDetailScreen`'s
    "Open in Maps" link still just hands off to the OS maps app, which
    needs connectivity of its own. That's the offline map-tile pass,
    scoped separately in the plan for exactly this reason.

- **Push notifications (Task 7, tech-app half)**, in
  `apps/technician/src/notifications/`:
  - **`registerPushToken.ts`** — requests notification permission,
    resolves an Expo push token (skipped on simulators — `Device.isDevice`
    guards that), and registers it with the backend. Called
    best-effort after login and on cold-start session restore in
    `AuthContext`; a failure here (permission denied, no EAS project
    id configured, a network blip) never blocks sign-in. `logout()`
    unregisters the token the same way, mirroring `ApiClient.auth.logout`'s
    "always end up logged out locally" posture.
  - **`NotificationRouter.tsx`** — mounted inside `OfflineProvider`
    (so it always has a live `refresh`): a push landing while the app's
    open refreshes the Jobs/History cache; tapping one navigates to
    the Jobs tab via a module-level `navigationRef` (`navigation/navigationRef.ts`)
    so it works regardless of which screen was open, including from a
    killed-app cold start.
  - **`App.tsx`** opts back into foreground alerts (Expo's default
    handler suppresses them) so a new-assignment push is visible even
    with the app already open.
  - **Backend contract assumption**: `client.technician.registerDeviceToken`
    / `unregisterDeviceToken` call `POST`/`DELETE /api/v1/technician/device-token`.
    The plan's §2.3 table confirms a new `DeviceToken` model but
    doesn't pin the route shape — verify this against the actual
    `api_v1/technician.py` route before relying on it, the same way
    the rest of this client was checked against backend source rather
    than the plan doc alone.
  - **Not included**: this is the tech-app half only — the plan's
    §3.2 calls out push for the technician app specifically ("new
    assignment / status change → Expo push → device"); §3.3 doesn't
    scope push for the customer app, so it wasn't added there.
  - **Not included**: an EAS project id — `app.json`'s
    `extra.eas.projectId` is a placeholder (`REPLACE_WITH_YOUR_EAS_PROJECT_ID`);
    Expo push tokens won't resolve until that's set to a real project,
    same as `apiBaseUrl` below.

- **Job-location map (offline map tiles, plan §3.2)**, in
  `apps/technician/src/components/JobLocationMap.tsx`: the plan
  explicitly frames this as either full tile caching (Mapbox's offline
  SDK or a tile-caching library) or a graceful "map unavailable
  offline, showing last-known list" fallback, and flags the former as
  real added complexity worth scoping separately. This build takes the
  fallback path: `JobDetailScreen`'s Subscriber card renders a live
  `react-native-maps` preview (tap-through to the OS Maps app, same
  `openMaps()` deep link as before) when online, and a plain-text
  "map preview needs a connection" notice pointing back at the address
  already shown in the same card when offline — no tiles are cached
  locally. Swapping in real offline tile caching later is a drop-in
  change scoped to this one component.
  - **Not included**: an Android Google Maps API key.
    `react-native-maps` on Android needs one
    (`expo.android.config.googleMaps.apiKey` in `app.json`) for a
    production build; it works without one in Expo Go / dev builds
    against Google's default quota, but that's not appropriate to
    ship. iOS uses Apple Maps by default and needs no key.

## Not in this task

Everything in the plan's build order (§4) is now implemented:
backend-independent mobile work (tasks 4–7) is done end to end —
shared api-client, both apps' full builds, the technician offline
queue, push notifications for the tech app, and the job-location map
with its offline fallback.

What's left is out of this repo's scope by the plan's own framing
rather than unfinished:
- Full offline map **tile caching** (vs. the graceful fallback taken
  here) — the plan itself calls this out as worth scoping separately.
- **Customer-app push notifications** — never scoped in the plan
  (§3.3 doesn't mention push; only §3.2, the tech app, does).
- Anything backend (tasks 1–3) — assumed already in place per the
  original upload, except the device-token route shape noted above,
  which is a plan-documented gap (`DeviceToken` model exists per
  §2.3, exact route wasn't specified) rather than something this
  client can resolve on its own.

## Running it

```bash
cd nap-iq-mobile
yarn install

# point the app at your backend — edit apiBaseUrl in
# apps/app/app.json (expo.extra.apiBaseUrl), or override at runtime
# with EXPO_PUBLIC_API_BASE_URL if you prefer env vars

yarn app          # expo start
yarn android      # expo start --android
yarn ios          # expo start --ios
```

Log in with either a `technician`-role account or a `user`-role
account (the role name your `User` model uses for customers) — same
credential check as the web login, per `api_v1/auth.py`'s `login()`.
Whichever it is, the app routes to the matching UI automatically;
there's nothing to pick beforehand.

Before a production build, also replace the two placeholders in
`apps/app/app.json`:
- `expo.extra.eas.projectId` — needed for technician push
  notifications to resolve an Expo push token.
- `expo.android.config.googleMaps.apiKey` — needed for the
  technician job-detail map preview on Android (iOS uses Apple Maps
  by default and needs no key). Works without one in Expo Go / dev
  builds against Google's default quota, but that's not appropriate
  to ship.

Note: `api_v1_auth_bp` / `api_v1_technician_bp` / `api_v1_customer_bp`
are CSRF-exempt server-side already (`app/__init__.py`) since they
authenticate with a bearer token, not a session cookie — nothing to
configure on the client side for that.
