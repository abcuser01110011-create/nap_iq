/**
 * Live GPS → technician marker bridge — Phase 12 (60%), TASK 3 OF N
 * -----------------------------------------------------------------
 * Tasks 1-2 (nav-route-progress.js, nav-gps-route-progress.js, same
 * phase) built the calculation engine and wired real GPS fixes into
 * it, producing live progress state
 * (`window.NapIQNavGpsRouteProgress.getState()`). Nothing rendered
 * it anywhere yet.
 *
 * This task is only the bridge: translate that live-progress state
 * into the shape `nav-technician-marker.js` (Phase 10) already
 * accepts via its `render()` function, and call it — reusing that
 * existing marker/pane/icon/popup machinery entirely rather than
 * building a second marker layer, exactly as Phase 10's own header
 * comment predicted this phase would do.
 *
 * Shape translation (GPS-progress state -> technician-marker state):
 *   { active, progressRatio, progressPercent, distanceAlongRouteMeters,
 *     remainingDistanceMeters, remainingDurationSeconds, nearestPoint,
 *     offRouteDistanceMeters, lastFixTimestamp }
 *   becomes
 *   { status, position, progressPercent, remainingDistanceMeters,
 *     remainingDurationSeconds, source: "live-gps" }
 * where:
 *   - `position` is `nearestPoint` (the fix snapped onto the actual
 *     route geometry, not the raw fix) — the marker always sits ON
 *     the road, matching the phase's own "use the actual route
 *     geometry" requirement, same as demo travel already does.
 *   - `status` is "complete" once `progressPercent >= 100`,
 *     otherwise "running" (there is no live-GPS equivalent of demo
 *     travel's "paused" — GPS tracking is simply on or off — so only
 *     these two of the marker's four known statuses are ever used
 *     here; "idle" is never sent because an idle/inactive GPS state
 *     means "no position to show", handled by clearing instead, see
 *     below).
 *
 * --- Phase 18 (90%) addendum: marker handoff on GPS-inactive ---
 * Tasks 1-3 above left one documented gap: when live GPS was the
 * source actively driving the marker and then goes inactive (tracking
 * stopped, permission revoked, route no longer ready), the marker was
 * simply cleared -- even if a demo travel run was still sitting there
 * mid-run, paused, complete, or reset-to-origin with a perfectly valid
 * position of its own to show. `handleInactive()` now checks
 * `window.NapIQNavDemoTravel.getState()` before clearing: if demo
 * travel still has a real `position` (running/paused/complete, or
 * idle-at-origin after `reset()` -- see nav-demo-travel.js's own
 * `reset()` vs `hardReset()` distinction), control is handed back to
 * it via the same `render()` entry point Task 3 already uses, with
 * `source: "demo"` so the ribbon/popup correctly read "Demo travel"
 * again rather than staying on a stale "GPS" label. Only when demo
 * travel has no position at all (never started, or hard-reset because
 * the destination/origin changed) does the marker actually clear, same
 * as before. This never runs the other direction -- a live GPS fix
 * still always wins over demo travel the instant one arrives (Task 3's
 * original, unchanged `handleActive()` policy) -- it only changes what
 * happens when GPS *stops* owning the marker.
 *
 * Explicitly NOT this task (deferred, see nav-technician-marker.js's
 * own "Multiple sources, one marker" note added this task for the
 * full explanation):
 *   - No noise/monotonicity guarding — same as Task 2, an active
 *     state is rendered exactly as computed, however jumpy.
 *   - No dispatch/assignment technician identity — the marker is not
 *     labeled with a real technician's name here either, same as
 *     Task 3's demo-travel counterpart already documents (that's
 *     Phase 13/14).
 */
(function () {
    function translate(gpsState) {
        var status = gpsState.progressPercent >= 100 ? "complete" : "running";
        return {
            status: status,
            position: gpsState.nearestPoint,
            progressPercent: gpsState.progressPercent,
            remainingDistanceMeters: gpsState.remainingDistanceMeters,
            remainingDurationSeconds: gpsState.remainingDurationSeconds,
            source: "live-gps",
        };
    }

    function handleActive(gpsState) {
        if (!window.NapIQNavTechnicianMarker) return;
        window.NapIQNavTechnicianMarker.render(translate(gpsState));
    }

    function handleInactive() {
        if (!window.NapIQNavTechnicianMarker) return;
        // Only act if THIS source currently owns the marker. If demo
        // travel (Phase 9) already owns it, GPS going inactive is a
        // no-op here -- nothing to hand back, nothing to clear.
        if (window.NapIQNavTechnicianMarker.getSource() !== "live-gps") return;

        // Phase 18 (90%): hand control back to demo travel if it has
        // a real position to show, instead of unconditionally
        // clearing the marker just because the source that had been
        // overriding it went inactive. See file header addendum.
        var demoState = window.NapIQNavDemoTravel ? window.NapIQNavDemoTravel.getState() : null;
        if (demoState && demoState.position) {
            window.NapIQNavTechnicianMarker.render({
                status: demoState.status,
                position: demoState.position,
                progressPercent: demoState.progressPercent,
                remainingDistanceMeters: demoState.remainingDistanceMeters,
                remainingDurationSeconds: demoState.remainingDurationSeconds,
                source: "demo",
            });
            return;
        }
        window.NapIQNavTechnicianMarker.clear();
    }

    function handleProgressChanged(evt) {
        var gpsState = (evt && evt.detail) || (window.NapIQNavGpsRouteProgress ? window.NapIQNavGpsRouteProgress.getState() : null);
        if (!gpsState) return;
        if (gpsState.active && gpsState.nearestPoint) {
            handleActive(gpsState);
        } else {
            handleInactive();
        }
    }

    function syncFromCurrentState() {
        if (!window.NapIQNavGpsRouteProgress) return;
        handleProgressChanged({ detail: window.NapIQNavGpsRouteProgress.getState() });
    }

    window.addEventListener("napiq:gps-route-progress-changed", handleProgressChanged);
    // Same "re-sync on load in case state already exists" convention
    // nav-technician-marker.js itself uses for demo travel.
    window.addEventListener("napiq:map-ready", syncFromCurrentState);
    document.addEventListener("DOMContentLoaded", syncFromCurrentState);

    window.NapIQNavGpsTechnicianMarker = {
        // Exposed for symmetry with every other nav-*.js module and
        // for tests; this bridge has no state of its own beyond what
        // it reads from NapIQNavGpsRouteProgress on demand.
        syncFromCurrentState: syncFromCurrentState,
    };
})();
