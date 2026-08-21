/**
 * Live GPS route progress (state wiring) — Phase 12 (60%), TASK 2 OF N
 * + TASK 5 OF N (noise/monotonicity guarding)
 * -----------------------------------------------------------------
 * Task 1 (nav-route-progress.js, same phase) built a pure, isolated
 * calculation engine: given a route and a GPS point, compute where
 * on the route that point projects to. It had no listeners and
 * updated no state anywhere.
 *
 * Task 2 (this file, originally) wired that engine up to real, live
 * input: every GPS fix nav-gps-origin.js's watchPosition() receives
 * (via the `napiq:gps-fix-received` event that file dispatches on
 * every accepted fix — see nav-gps-origin.js's onPosition()), fed
 * against whatever route nav-routing.js currently has ready
 * (`window.NapIQNavRouting.getState()`, unchanged, read-only). The
 * result is kept as this module's own live progress state and
 * broadcast via a new `napiq:gps-route-progress-changed` event so a
 * later task can render it.
 *
 * Task 5 (this session) adds the guarding Task 2 explicitly deferred:
 * a raw fix that projects to a point far *behind* where the last
 * *accepted* fix was, or implausibly far *ahead* of it for the time
 * that elapsed, is rejected rather than accepted into visible state.
 * See "Noise/monotonicity guard (Task 5)" below for the full
 * rationale and thresholds.
 *
 * Task 6 (this session) adds the one item Task 5 explicitly left
 * open: using `offRouteDistanceMeters` (Task 1's perpendicular
 * distance from the raw fix to the nearest point on the route
 * geometry, already computed and already stored, but until now never
 * acted on) to reject a fix that is too far from the mapped road to
 * trust its *along-route* projection at all — e.g. a bad multipath
 * fix, a fix from inside a building/parking structure, or a fix on a
 * genuinely different road than the one being navigated. This is a
 * distinct signal from Task 5's guard: a fix can be perfectly
 * monotonic and plausible in its along-route movement while still
 * being physically nowhere near the road, and Task 5's checks alone
 * would have no way to catch that. See "Off-route distance guard
 * (Task 6)" below.
 *
 * Explicitly NOT this task (deferred to a later Phase 12 task, same
 * as documented in PHASE12_TASK1_NOTES.md / TASK2 / TASK4 notes):
 *   - No smoothing/averaging of off-route fixes — a fix that fails
 *     this guard is rejected outright (visible state keeps showing
 *     the last accepted reading), the same reject/keep policy Task 5
 *     already established; this task does not introduce any new way
 *     of blending or estimating a position.
 *
 * What Task 2's wiring already respected, as basic correctness for
 * the wiring itself (unchanged by Task 5):
 *   - Live progress is only ever computed against a route that is
 *     currently `status === "ready"` in nav-routing.js. A fix
 *     arriving while there's no ready route (no destination/origin
 *     yet, still loading, or errored) is a no-op for this module —
 *     it does not fabricate progress against a route that doesn't
 *     exist.
 *   - Live progress state resets to idle/null when: GPS tracking
 *     stops or errors (`napiq:gps-tracking-stopped`), or the active
 *     route changes/clears (`napiq:destination-changed`,
 *     `napiq:origin-changed`, `napiq:route-status-changed` moving
 *     away from "ready"). Task 5 also resets the new guard's
 *     "last accepted fix" memory at the same points, so a guard
 *     comparison never spans two different routes.
 *
 * Noise/monotonicity guard (Task 5):
 *   Task 1's computeProgress() is, by design, an honest *instantaneous*
 *   projection — it makes no attempt to decide whether a given fix is
 *   trustworthy (see nav-route-progress.js's own header, which
 *   explicitly defers that). Feeding every raw GPS fix straight into
 *   visible state means an ordinary GPS glitch (a momentary bad fix,
 *   a multipath reflection off a building, a stale/duplicate fix
 *   replayed by the browser) can make the progress bar and technician
 *   marker jump backward or teleport far ahead for one frame, then
 *   snap back — exactly what the phase spec prohibits.
 *
 *   This task adds a small accept/reject gate in front of state
 *   updates, comparing each new raw projection to the *last accepted*
 *   one (not the last *received* one — a rejected fix does not become
 *   the new baseline, so a run of bad fixes doesn't let the baseline
 *   itself drift):
 *     - The very first fix against a (newly) ready route is always
 *       accepted — there is nothing yet to compare it to.
 *     - A fix that projects *behind* the last accepted fix by more
 *       than BACKWARD_TOLERANCE_METERS is rejected. Some backward
 *       slack is intentionally allowed (ordinary GPS jitter can
 *       legitimately project a few meters earlier on the route from
 *       one fix to the next even while genuinely moving forward), but
 *       a real backward *jump* is refused.
 *     - A fix that projects more than MAX_SINGLE_FIX_JUMP_METERS
 *       ahead of the last accepted fix is rejected outright,
 *       regardless of elapsed time (a hard ceiling against
 *       teleport-style glitches).
 *     - Otherwise, if enough time has passed to make a speed estimate
 *       meaningful, a fix implying a forward speed faster than
 *       MAX_PLAUSIBLE_SPEED_MPS is rejected (guards against a smaller
 *       but still-implausible jump that the hard distance ceiling
 *       alone wouldn't catch for a short time gap).
 *     - A rejected fix leaves all visible progress numbers exactly as
 *       they were — the last *accepted* reading keeps being shown
 *       until a fix passes the gate, rather than being overwritten by
 *       a value this module doesn't trust. This is a reject/keep
 *       policy, not smoothing/averaging: every number the panel and
 *       marker ever show remains a real, unmodified projection from
 *       some actual GPS fix, never a blended or invented value.
 *   The guard's own bookkeeping (whether the last fix was accepted,
 *   why not if rejected, and how many fixes have been rejected in a
 *   row) is exposed via getState().guard so a later task (or manual
 *   testing) can see the gate working, without that bookkeeping
 *   itself affecting the progress numbers shown.
 *
 * Off-route distance guard (Task 6):
 *   Applied first, before the Task 5 along-route checks, and applied
 *   to *every* fix -- including the very first one against a route
 *   (Task 5's along-route checks skip the first fix, since there is
 *   nothing yet to compare it to; but "is this fix even near the
 *   road" needs no prior fix to evaluate, so there is no reason to
 *   let a wildly off-road first fix become the trusted baseline).
 *   If Task 1's `offRouteDistanceMeters` for a raw fix exceeds
 *   MAX_OFF_ROUTE_DISTANCE_METERS, the fix is rejected with reason
 *   `too_far_off_route` and never reaches the Task 5 checks or
 *   visible state -- same reject/keep policy as every other rejection
 *   reason. The threshold is deliberately generous (wider than a
 *   typical road plus realistic consumer GPS error) so it only
 *   catches fixes that are genuinely nowhere near the mapped route,
 *   not ordinary lane-width or urban-canyon drift.
 *
 * Integration points used (all pre-existing except where noted new):
 *   - `napiq:gps-fix-received` (dispatched by nav-gps-origin.js,
 *     Task 2) — the input.
 *   - `napiq:gps-tracking-stopped` (dispatched by nav-gps-origin.js,
 *     Task 2) — one of the reset triggers.
 *   - `window.NapIQNavRouteProgress.computeProgress()` (Task 1,
 *     unchanged by this task) — the actual math; this task adds no
 *     new math to that engine, only a gate in front of its output.
 *   - `window.NapIQNavRouting.getState()` (pre-existing, unchanged)
 *     — the active route snapshot to project against.
 *   - `napiq:destination-changed`, `napiq:origin-changed`,
 *     `napiq:route-status-changed` (all pre-existing, unchanged) —
 *     reset triggers.
 */
(function () {
    // ---- Task 5: noise/monotonicity guard thresholds ----
    //
    // Deliberately generous, not tuned to reject anything but genuine
    // glitches: a real, moving vehicle should never be rejected by
    // these; a GPS jump/teleport/duplicate should almost always be.
    var BACKWARD_TOLERANCE_METERS = 25; // ordinary GPS jitter allowance
    var MAX_SINGLE_FIX_JUMP_METERS = 400; // hard ceiling regardless of elapsed time
    var MAX_PLAUSIBLE_SPEED_MPS = 45; // ~162 km/h, generous upper bound for a road vehicle
    var MIN_ELAPSED_SECONDS_FOR_SPEED_CHECK = 1; // below this, elapsed time is too noisy to divide by

    // ---- Task 6: off-route distance guard threshold ----
    //
    // Perpendicular distance (meters) from a raw fix to the nearest
    // point on the route geometry. Wider than a typical road plus
    // realistic consumer GPS error, so it only rejects fixes that are
    // genuinely nowhere near the mapped route (multipath glitches,
    // indoor fixes, a different road entirely) -- not ordinary
    // lane-width drift or urban-canyon jitter.
    var MAX_OFF_ROUTE_DISTANCE_METERS = 60;

    var state = {
        active: false, // true only once we have a real progress reading against a ready route
        progressRatio: null,
        progressPercent: null,
        distanceAlongRouteMeters: null,
        remainingDistanceMeters: null,
        remainingDurationSeconds: null,
        nearestPoint: null,
        offRouteDistanceMeters: null,
        lastFixTimestamp: null,
    };

    // Task 5: the last *accepted* fix's along-route distance/timestamp
    // -- the guard's comparison baseline. Deliberately separate from
    // `state` above: a rejected fix must never become the new
    // baseline, or a run of bad fixes could let the baseline itself
    // drift into nonsense.
    var lastAccepted = null; // { distanceAlongRouteMeters, timestamp } | null

    // Task 5: guard bookkeeping, exposed read-only via getState().guard
    // for visibility/testing. Never influences what progress numbers
    // are shown -- only describes what the guard just did.
    var guard = {
        lastFixAccepted: null, // null until a fix has actually been evaluated
        lastRejectionReason: null, // null | 'too_far_off_route' | 'backward_jump' | 'forward_jump_too_large' | 'implausible_speed' | 'non_monotonic_timestamp'
        rejectedFixCount: 0,
        acceptedFixCount: 0,
    };

    function resetState() {
        state = {
            active: false,
            progressRatio: null,
            progressPercent: null,
            distanceAlongRouteMeters: null,
            remainingDistanceMeters: null,
            remainingDurationSeconds: null,
            nearestPoint: null,
            offRouteDistanceMeters: null,
            lastFixTimestamp: null,
        };
        lastAccepted = null;
        guard = {
            lastFixAccepted: null,
            lastRejectionReason: null,
            rejectedFixCount: 0,
            acceptedFixCount: 0,
        };
    }

    function dispatchChanged() {
        window.dispatchEvent(new CustomEvent("napiq:gps-route-progress-changed", { detail: getState() }));
    }

    function hasReadyRoute() {
        return !!(
            window.NapIQNavRouting &&
            typeof window.NapIQNavRouting.getState === "function" &&
            window.NapIQNavRouting.getState().status === "ready" &&
            window.NapIQNavRouting.getState().route
        );
    }

    /**
     * Task 5/6 — decides whether `result` (a fresh, raw
     * computeProgress() output) should be accepted against
     * `lastAccepted`. Returns { accept: boolean, reason: string|null }.
     * Pure decision function: does not itself mutate any module state.
     */
    function evaluateGuard(result, fixTimestamp) {
        // Task 6: off-route distance check runs first and applies to
        // every fix, including the very first one against a route --
        // there is nothing to compare a wildly off-road fix to, but it
        // still should not become the trusted baseline.
        if (
            typeof result.offRouteDistanceMeters === "number" &&
            result.offRouteDistanceMeters > MAX_OFF_ROUTE_DISTANCE_METERS
        ) {
            return { accept: false, reason: "too_far_off_route" };
        }

        if (!lastAccepted) {
            // Nothing to compare the very first reading against for
            // this route -- always accept it as the new baseline.
            return { accept: true, reason: null };
        }

        var deltaMeters = result.distanceAlongRouteMeters - lastAccepted.distanceAlongRouteMeters;
        var elapsedSeconds = (fixTimestamp - lastAccepted.timestamp) / 1000;

        if (elapsedSeconds < 0) {
            // A fix timestamped earlier than the last accepted one --
            // e.g. a delayed/out-of-order delivery. Never let it move
            // the baseline backward in time.
            return { accept: false, reason: "non_monotonic_timestamp" };
        }
        if (deltaMeters < 0 && Math.abs(deltaMeters) > BACKWARD_TOLERANCE_METERS) {
            return { accept: false, reason: "backward_jump" };
        }
        if (deltaMeters > MAX_SINGLE_FIX_JUMP_METERS) {
            return { accept: false, reason: "forward_jump_too_large" };
        }
        if (deltaMeters > 0 && elapsedSeconds >= MIN_ELAPSED_SECONDS_FOR_SPEED_CHECK) {
            var impliedSpeedMps = deltaMeters / elapsedSeconds;
            if (impliedSpeedMps > MAX_PLAUSIBLE_SPEED_MPS) {
                return { accept: false, reason: "implausible_speed" };
            }
        }
        return { accept: true, reason: null };
    }

    function onFixReceived(evt) {
        var fix = evt && evt.detail;
        if (!fix || typeof fix.lat !== "number" || typeof fix.lng !== "number") return;
        if (!hasReadyRoute() || !window.NapIQNavRouteProgress) {
            // No ready route to project against right now -- this is
            // not an error, just nothing for this task to do with
            // this particular fix. If progress was previously active
            // (route existed a moment ago and just stopped being
            // ready), fall through to a reset rather than leaving
            // stale numbers displayed by a future consumer.
            if (state.active) {
                resetState();
                dispatchChanged();
            }
            return;
        }

        var route = window.NapIQNavRouting.getState().route;
        var result = window.NapIQNavRouteProgress.computeProgress(route, { lat: fix.lat, lng: fix.lng });
        if (!result) return;

        var fixTimestamp = fix.timestamp || Date.now();
        var verdict = evaluateGuard(result, fixTimestamp);

        if (!verdict.accept) {
            // Task 5: reject/keep, not smoothing -- every visible
            // number stays exactly what it was from the last accepted
            // fix. Only the guard bookkeeping changes, so a later
            // task/manual test can see the rejection happened.
            guard.lastFixAccepted = false;
            guard.lastRejectionReason = verdict.reason;
            guard.rejectedFixCount += 1;
            dispatchChanged();
            return;
        }

        lastAccepted = { distanceAlongRouteMeters: result.distanceAlongRouteMeters, timestamp: fixTimestamp };
        guard.lastFixAccepted = true;
        guard.lastRejectionReason = null;
        guard.acceptedFixCount += 1;

        state = {
            active: true,
            progressRatio: result.progressRatio,
            progressPercent: result.progressPercent,
            distanceAlongRouteMeters: result.distanceAlongRouteMeters,
            remainingDistanceMeters: result.remainingDistanceMeters,
            remainingDurationSeconds: result.remainingDurationSeconds,
            nearestPoint: result.nearestPoint,
            offRouteDistanceMeters: result.offRouteDistanceMeters,
            lastFixTimestamp: fixTimestamp,
        };
        dispatchChanged();
    }

    function onTrackingStopped() {
        if (!state.active) return;
        resetState();
        dispatchChanged();
    }

    function onRouteContextChanged() {
        // Covers the destination/origin changing outright, and the
        // route moving away from "ready" (loading again, errored, or
        // cleared) -- in every case, any live progress this module
        // was tracking (and the guard's baseline) was against a route
        // that no longer applies.
        if (!hasReadyRoute() && state.active) {
            resetState();
            dispatchChanged();
        }
    }

    function getState() {
        return {
            active: state.active,
            progressRatio: state.progressRatio,
            progressPercent: state.progressPercent,
            distanceAlongRouteMeters: state.distanceAlongRouteMeters,
            remainingDistanceMeters: state.remainingDistanceMeters,
            remainingDurationSeconds: state.remainingDurationSeconds,
            nearestPoint: state.nearestPoint ? { lat: state.nearestPoint.lat, lng: state.nearestPoint.lng } : null,
            offRouteDistanceMeters: state.offRouteDistanceMeters,
            lastFixTimestamp: state.lastFixTimestamp,
            // Task 5: read-only guard bookkeeping -- describes what the
            // guard just did, never influences the fields above.
            guard: {
                lastFixAccepted: guard.lastFixAccepted,
                lastRejectionReason: guard.lastRejectionReason,
                rejectedFixCount: guard.rejectedFixCount,
                acceptedFixCount: guard.acceptedFixCount,
            },
        };
    }

    window.addEventListener("napiq:gps-fix-received", onFixReceived);
    window.addEventListener("napiq:gps-tracking-stopped", onTrackingStopped);
    window.addEventListener("napiq:destination-changed", onRouteContextChanged);
    window.addEventListener("napiq:origin-changed", onRouteContextChanged);
    window.addEventListener("napiq:route-status-changed", onRouteContextChanged);

    window.NapIQNavGpsRouteProgress = {
        getState: getState,
    };
})();
