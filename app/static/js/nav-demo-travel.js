/**
 * Demo travel state machine — Phase 9 (45%, translation project)
 * -----------------------------------------------------------------
 * Translates the prototype's demo-travel simulation (the
 * `startDemoTravel` / `pauseDemoTravel` / `resumeDemoTravel` /
 * `resetDemoTravel` slice of `src/store/NavigationStore.tsx`) into
 * vanilla JS on top of the existing route engine (nav-routing.js,
 * Phase 5/6/7) and the Navigation Card shell (nav-card.js, Phase 4).
 *
 * Scope of this phase (per the phase 9 spec):
 *   - Four explicit states: idle, running, paused, complete.
 *   - Movement is interpolated along the REAL OSRM route geometry
 *     already stored by nav-routing.js (window.NapIQNavRouting) —
 *     never a straight line between origin and destination.
 *   - Progress (0-100%), remaining distance, and remaining ETA all
 *     derive from that real geometry/duration, never fabricated.
 *   - Controls: Start, Pause, Resume, Reset, Replay (after
 *     completion).
 *
 * Explicitly NOT implemented this phase (per the phase spec / the
 * project's later phases):
 *   - No dedicated technician/navigation marker is drawn on the map.
 *     Phase 10 ("Navigation marker / technician position") owns
 *     that. This module only computes and exposes the simulated
 *     position (getPosition()/getState().position) so Phase 10 can
 *     render it without this file needing to change.
 *   - No device GPS (Phase 11/12).
 *   - The technician's real database location/last-known position is
 *     never read or written by this file — demo travel is a
 *     client-side-only preview, matching the phase's own boundary
 *     ("Do not change the database technician's permanent location"
 *     is actually Phase 10's line, but the principle already applies
 *     here: this module never touches technicians.py / the DB).
 *
 * Integration points used (all documented, none guessed):
 *   - window.NapIQNavRouting.getState() (nav-routing.js) — the
 *     source of truth for the current ready route's points,
 *     distanceMeters, and durationSeconds. This module takes a
 *     snapshot of that route when Start/Replay is pressed; it never
 *     duplicates or re-fetches routing data itself.
 *   - window.NapIQNavCard.elements() (nav-card.js) — the stable
 *     `#navCardControls` container this module appends its own
 *     Start/Pause/Resume/Reset/Replay block into, alongside (not
 *     replacing) nav-routing.js's origin form.
 *   - `napiq:navcard-rendered` (nav-card.js) and the route engine's
 *     own re-render of `#navCardControls` on `napiq:destination-
 *     changed` / `napiq:origin-changed` / `napiq:demo-travel-changed`
 *     (nav-routing.js) both wipe and rebuild `#navCardControls`
 *     wholesale, so this module re-appends its block after every one
 *     of those events rather than trying to patch DOM nav-routing.js
 *     owns. A new `napiq:route-status-changed` event (dispatched by
 *     nav-routing.js at the end of its own render(), additive to that
 *     file) covers the remaining case: an async OSRM response arriving
 *     and flipping the route to "ready" without a full nav-card.js
 *     rebuild.
 *   - A new `napiq:demo-travel-changed` event (dispatched by this
 *     file) that nav-routing.js listens for so its Route Details
 *     Panel (`#navCardRouteCompletion`, the Phase 7 "placeholder"
 *     progress bar, and the ready-state "Remaining" metric) can show
 *     this module's real progress instead of the static 0% Phase 7
 *     shipped with. Nothing about nav-routing.js's OSRM request
 *     logic, polyline drawing, or error handling was touched.
 *
 * Cleanup: a demo run is fully reset (stopped, state cleared) if the
 * destination or origin changes mid-run, since the route it was
 * following no longer applies. This is the minimum correctness this
 * phase's own feature needs to avoid showing stale/nonsensical
 * progress for a route that no longer exists — it is not an attempt
 * at the fuller edge-case hardening pass Phase 18 owns.
 */
(function () {
    // ---- Tunable simulation pacing ----
    // The phase spec does not mandate a specific demo speed, only
    // that movement follows the real route geometry and that
    // progress/remaining distance/remaining ETA behave correctly. A
    // demo preview that took the same wall-clock time as the real
    // drive would be unusable for quickly previewing a route, so
    // playback is time-compressed relative to the route's own OSRM
    // duration, clamped to a sensible min/max so very short or very
    // long routes both stay watchable.
    var SPEED_DIVISOR = 40; // real route duration compressed 40x
    var MIN_DEMO_MS = 6000; // never finish faster than 6s
    var MAX_DEMO_MS = 45000; // never take longer than 45s
    var DISPATCH_THROTTLE_MS = 150; // ~6-7 UI refreshes/sec while running

    var DEMO_CONTROLS_ID = "navDemoTravelControls";

    var state = {
        status: "idle", // 'idle' | 'running' | 'paused' | 'complete'
        progressRatio: 0, // 0..1, based on real route distance covered
        position: null, // {lat, lng} current interpolated position, or null
        remainingDistanceMeters: null,
        remainingDurationSeconds: null,
    };

    var snapshotRoute = null; // {points, distanceMeters, durationSeconds} taken at Start/Replay
    var cumulative = null; // cumulative meters at each point of snapshotRoute.points
    var totalDistanceMeters = 0;
    var demoDurationMs = 0;
    var accumulatedMs = 0; // elapsed ms banked across pause/resume cycles
    var runStartTs = null; // performance.now() when the current running segment began
    var rafId = null;
    var lastDispatchTs = 0;

    function now() {
        return window.performance && typeof performance.now === "function" ? performance.now() : Date.now();
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    /** Great-circle distance in meters — used only to build cumulative
     * segment lengths for interpolation, matching the precision the
     * existing origin-picker/route code already relies on elsewhere. */
    function haversineMeters(a, b) {
        var R = 6371000;
        var toRad = function (deg) {
            return (deg * Math.PI) / 180;
        };
        var dLat = toRad(b.lat - a.lat);
        var dLng = toRad(b.lng - a.lng);
        var lat1 = toRad(a.lat);
        var lat2 = toRad(b.lat);
        var sinDLat = Math.sin(dLat / 2);
        var sinDLng = Math.sin(dLng / 2);
        var h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function buildCumulative(points) {
        var out = [0];
        for (var i = 1; i < points.length; i++) {
            out.push(out[i - 1] + haversineMeters(points[i - 1], points[i]));
        }
        return out;
    }

    /**
     * Interpolates a position along the real route geometry at the
     * given distance-in-meters, never a straight line between origin
     * and destination. Walks the cumulative-distance table to find
     * the enclosing road segment, then linearly interpolates within
     * that (short, road-following) segment only.
     */
    function positionAtDistance(targetMeters) {
        var points = snapshotRoute.points;
        if (targetMeters <= 0) return { lat: points[0].lat, lng: points[0].lng };
        var last = points.length - 1;
        if (targetMeters >= cumulative[last]) return { lat: points[last].lat, lng: points[last].lng };

        // cumulative is monotonically non-decreasing; linear scan is
        // fine at typical OSRM polyline sizes (tens to low hundreds
        // of points) and keeps this dependency-free.
        var i = 1;
        while (i < cumulative.length && cumulative[i] < targetMeters) i++;
        var segStart = cumulative[i - 1];
        var segEnd = cumulative[i];
        var segFrac = segEnd > segStart ? (targetMeters - segStart) / (segEnd - segStart) : 0;
        var a = points[i - 1];
        var b = points[i];
        return {
            lat: a.lat + (b.lat - a.lat) * segFrac,
            lng: a.lng + (b.lng - a.lng) * segFrac,
        };
    }

    function dispatchChanged(force) {
        var t = now();
        if (!force && t - lastDispatchTs < DISPATCH_THROTTLE_MS) return;
        lastDispatchTs = t;
        window.dispatchEvent(new CustomEvent("napiq:demo-travel-changed", { detail: getState() }));
    }

    function applyProgress(ratio) {
        state.progressRatio = ratio;
        state.position = positionAtDistance(ratio * totalDistanceMeters);
        state.remainingDistanceMeters = Math.max(0, totalDistanceMeters * (1 - ratio));
        state.remainingDurationSeconds = Math.max(0, snapshotRoute.durationSeconds * (1 - ratio));
    }

    function tick() {
        if (state.status !== "running") return;
        var elapsed = accumulatedMs + (now() - runStartTs);
        var ratio = demoDurationMs > 0 ? clamp(elapsed / demoDurationMs, 0, 1) : 1;

        if (ratio >= 1) {
            applyProgress(1);
            state.status = "complete";
            rafId = null;
            dispatchChanged(true);
            renderControls();
            return;
        }

        applyProgress(ratio);
        dispatchChanged(false);
        rafId = window.requestAnimationFrame(tick);
    }

    function hasReadyRoute() {
        var routing = window.NapIQNavRouting ? window.NapIQNavRouting.getState() : null;
        return !!(routing && routing.status === "ready" && routing.route && Array.isArray(routing.route.points) && routing.route.points.length >= 2);
    }

    function takeRouteSnapshot() {
        var routing = window.NapIQNavRouting.getState();
        snapshotRoute = routing.route;
        cumulative = buildCumulative(snapshotRoute.points);
        totalDistanceMeters = cumulative[cumulative.length - 1];
    }

    function start() {
        if (!window.NapIQNavRouting || !hasReadyRoute()) return false;
        if (state.status === "running") return true;

        takeRouteSnapshot();
        accumulatedMs = 0;
        demoDurationMs = clamp((snapshotRoute.durationSeconds * 1000) / SPEED_DIVISOR, MIN_DEMO_MS, MAX_DEMO_MS);
        state.status = "running";
        applyProgress(0);
        runStartTs = now();
        dispatchChanged(true);
        renderControls();
        rafId = window.requestAnimationFrame(tick);
        return true;
    }

    function pause() {
        if (state.status !== "running") return false;
        accumulatedMs += now() - runStartTs;
        if (rafId != null) {
            window.cancelAnimationFrame(rafId);
            rafId = null;
        }
        state.status = "paused";
        dispatchChanged(true);
        renderControls();
        return true;
    }

    function resume() {
        if (state.status !== "paused") return false;
        runStartTs = now();
        state.status = "running";
        dispatchChanged(true);
        renderControls();
        rafId = window.requestAnimationFrame(tick);
        return true;
    }

    /** Stops any run and returns the simulated position to the
     * route's own origin point (per the phase's acceptance criteria),
     * rather than clearing the position entirely, so a caller (e.g. a
     * future Phase 10 marker) sees the technician sitting back at the
     * start of the route rather than vanishing. */
    function reset() {
        if (rafId != null) {
            window.cancelAnimationFrame(rafId);
            rafId = null;
        }
        accumulatedMs = 0;
        state.status = "idle";
        if (snapshotRoute) {
            applyProgress(0);
        } else {
            state.progressRatio = 0;
            state.position = null;
            state.remainingDistanceMeters = null;
            state.remainingDurationSeconds = null;
        }
        dispatchChanged(true);
        renderControls();
        return true;
    }

    /** Only valid after completion — restarts from the beginning
     * using the CURRENT ready route (re-snapshotted, in case the
     * route changed since the last run completed), matching "Replay
     * after completion" from the phase spec. */
    function replay() {
        if (state.status !== "complete") return false;
        if (!window.NapIQNavRouting || !hasReadyRoute()) return false;
        return start();
    }

    /** Full teardown used when the destination/origin changes and the
     * route this demo run was following no longer applies. */
    function hardReset() {
        if (rafId != null) {
            window.cancelAnimationFrame(rafId);
            rafId = null;
        }
        accumulatedMs = 0;
        snapshotRoute = null;
        cumulative = null;
        totalDistanceMeters = 0;
        demoDurationMs = 0;
        state = { status: "idle", progressRatio: 0, position: null, remainingDistanceMeters: null, remainingDurationSeconds: null };
        dispatchChanged(true);
        renderControls();
    }

    function getState() {
        return {
            status: state.status,
            progressRatio: state.progressRatio,
            progressPercent: Math.round(state.progressRatio * 100),
            position: state.position ? { lat: state.position.lat, lng: state.position.lng } : null,
            remainingDistanceMeters: state.remainingDistanceMeters,
            remainingDurationSeconds: state.remainingDurationSeconds,
            totalDistanceMeters: totalDistanceMeters || null,
            totalDurationSeconds: snapshotRoute ? snapshotRoute.durationSeconds : null,
        };
    }

    function getPosition() {
        return state.position ? { lat: state.position.lat, lng: state.position.lng } : null;
    }

    // ---- Controls UI (appended into nav-card.js's #navCardControls,
    // alongside nav-routing.js's origin form, never replacing it) ----

    var BADGE_META = {
        idle: { label: "Idle", cls: "text-bg-secondary" },
        running: { label: "Running", cls: "text-bg-primary" },
        paused: { label: "Paused", cls: "text-bg-warning" },
        complete: { label: "Complete", cls: "text-bg-success" },
    };

    function controlsHtml() {
        var meta = BADGE_META[state.status] || BADGE_META.idle;
        var isRunning = state.status === "running";
        var isPaused = state.status === "paused";
        var isComplete = state.status === "complete";
        var isIdle = state.status === "idle";

        return (
            '<div class="nav-demo-travel mt-2 pt-2 border-top" id="' + DEMO_CONTROLS_ID + '">' +
            '<div class="d-flex align-items-center justify-content-between mb-2">' +
            '<span class="small text-muted"><i class="bi bi-play-circle me-1"></i>Demo travel</span>' +
            '<span class="badge ' + meta.cls + '" id="navDemoTravelBadge">' + meta.label + "</span>" +
            "</div>" +
            '<div class="d-flex gap-2 flex-wrap">' +
            '<button type="button" class="btn btn-sm btn-primary" id="navDemoStartBtn"' + (isIdle ? "" : " disabled") + ">" +
            '<i class="bi bi-play-fill me-1"></i>Start demo</button>' +
            '<button type="button" class="btn btn-sm btn-outline-secondary" id="navDemoPauseBtn"' + (isRunning ? "" : " disabled") + ">" +
            '<i class="bi bi-pause-fill me-1"></i>Pause</button>' +
            '<button type="button" class="btn btn-sm btn-outline-secondary" id="navDemoResumeBtn"' + (isPaused ? "" : " disabled") + ">" +
            '<i class="bi bi-play-fill me-1"></i>Resume</button>' +
            '<button type="button" class="btn btn-sm btn-outline-secondary" id="navDemoResetBtn"' + (isIdle ? " disabled" : "") + ">" +
            '<i class="bi bi-arrow-counterclockwise me-1"></i>Reset</button>' +
            '<button type="button" class="btn btn-sm btn-outline-success" id="navDemoReplayBtn"' + (isComplete ? "" : " disabled") + ">" +
            '<i class="bi bi-arrow-repeat me-1"></i>Replay</button>' +
            "</div>" +
            "</div>"
        );
    }

    function attachHandlers() {
        var startBtn = document.getElementById("navDemoStartBtn");
        if (startBtn) startBtn.addEventListener("click", start);
        var pauseBtn = document.getElementById("navDemoPauseBtn");
        if (pauseBtn) pauseBtn.addEventListener("click", pause);
        var resumeBtn = document.getElementById("navDemoResumeBtn");
        if (resumeBtn) resumeBtn.addEventListener("click", resume);
        var resetBtn = document.getElementById("navDemoResetBtn");
        if (resetBtn) resetBtn.addEventListener("click", reset);
        var replayBtn = document.getElementById("navDemoReplayBtn");
        if (replayBtn) replayBtn.addEventListener("click", replay);
    }

    /**
     * Re-appends the controls block into #navCardControls. Called
     * after every event that might have wiped that container
     * (nav-card.js rebuilding the whole card, or nav-routing.js
     * rebuilding just #navCardControls) and after every local state
     * change. Idempotent: always removes a stale copy of the block
     * first so re-renders never stack duplicate button rows.
     */
    function renderControls() {
        if (!window.NapIQNavCard) return;
        var els = window.NapIQNavCard.elements();
        if (!els || !els.controls) return; // collapsed pill, or card not on this page

        var existing = document.getElementById(DEMO_CONTROLS_ID);
        if (existing) existing.remove();

        // Only offer demo travel once there's a real, ready road
        // route to demo — matches the phase's own "use the actual
        // route geometry" requirement and this project's "no fake
        // data" rule (no controls that would operate on nothing).
        if (!hasReadyRoute() && state.status === "idle") return;
        // If the route stopped being ready mid-run (destination/origin
        // cleared), hardReset() already put us back to a clean idle
        // state with no snapshot, so the check above naturally hides
        // the block in that case too.
        if (!hasReadyRoute() && !snapshotRoute) return;

        els.controls.insertAdjacentHTML("beforeend", controlsHtml());
        attachHandlers();
    }

    window.addEventListener("napiq:navcard-rendered", renderControls);
    // Phase 9 (45%): nav-routing.js also rebuilds #navCardControls on
    // its own (e.g. once an async OSRM response arrives and the route
    // becomes ready), not only when nav-card.js rebuilds the whole
    // card. Listen for that too so the demo-travel controls appear as
    // soon as a route is actually ready, not only after the next full
    // card re-render.
    window.addEventListener("napiq:route-status-changed", renderControls);
    window.addEventListener("napiq:destination-changed", hardReset);
    window.addEventListener("napiq:origin-changed", hardReset);
    document.addEventListener("DOMContentLoaded", renderControls);

    window.NapIQNavDemoTravel = {
        start: start,
        pause: pause,
        resume: resume,
        reset: reset,
        replay: replay,
        getState: getState,
        getPosition: getPosition,
    };
})();
