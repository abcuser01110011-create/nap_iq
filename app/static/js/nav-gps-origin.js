/**
 * Real device GPS origin — Phase 11 (55%)
 * -----------------------------------------------------------------
 * Translates the prototype's browser-geolocation origin concept
 * (`NavigationOriginMode` including a device/GPS mode, and the
 * device-location state described in the Phase 2 data contract) onto
 * this project's existing Phase 8 origin architecture
 * (`nav-origin.js` + `nav-origin-picker.js`).
 *
 * This is a sibling of `nav-origin-picker.js`, not a rewrite of it:
 * same "tiny, dependency-free module + render into a container inside
 * nav-origin.js's panel" pattern, same mutual-exclusion contract with
 * the map-click picker and napmap.js's Add NAP / Report Issue
 * placement modes, same "never call OSRM itself, just push a point
 * into window.NapIQNavOrigin and let nav-routing.js's existing
 * `napiq:origin-changed` listener request the road route" boundary.
 *
 * Per the phase spec, this module implements:
 *   - Requesting device location via `navigator.geolocation.watchPosition()`
 *     (not a single `getCurrentPosition()` call — the phase spec is
 *     explicit that watchPosition is the API to use).
 *   - Permission handling (the browser's native permission prompt is
 *     triggered by the first `watchPosition()` call; this module only
 *     reacts to the outcome, it never fakes or bypasses the prompt).
 *   - An explicit tracking state machine: unsupported / idle /
 *     requesting / tracking / error, always rendered honestly (see
 *     "Do not claim GPS is active when it is not" below).
 *   - A GPS error state that distinguishes *why* it failed: permission
 *     denied, position unavailable, timeout, or the browser not
 *     supporting geolocation at all — each `GeolocationPositionError`
 *     code (1/2/3) and the "no navigator.geolocation" case get their
 *     own message, never a single generic "GPS failed".
 *   - Stop tracking (`clearWatch`), which stops receiving updates but
 *     — like `nav-origin-picker.js`'s confirmed marker — deliberately
 *     leaves the last known device-GPS point as a perfectly usable
 *     static origin rather than yanking it out of the store. The
 *     existing "Clear" button in nav-origin.js's confirmed-state panel
 *     (unchanged, untouched by this file) is still the way to remove
 *     the origin entirely.
 *   - "Current-device origin": every accepted GPS fix is pushed into
 *     `window.NapIQNavOrigin.setOriginPoint()` with
 *     `source: "device-gps"` (a small, additive, backward-compatible
 *     change to that function — see nav-origin.js's own comment at
 *     the call site), which nav-routing.js's existing
 *     `napiq:origin-changed` listener (added back in Phase 5, never
 *     touched here) already turns into a real OSRM road-route request
 *     with zero changes to nav-routing.js.
 *
 * Explicitly NOT implemented this phase (per the phase spec and per
 * PHASE10_50_PERCENT_NOTES.md's own forward-looking note):
 *   - Live route-progress tracking from GPS movement (nearest-point-
 *     on-route math, percentage, remaining distance/ETA) — that is
 *     Phase 12's "Live GPS route progress", not this phase's "can a
 *     device fix become the route origin". This module only ever
 *     calls `NapIQNavOrigin.setOriginPoint()`; it does not touch
 *     `NapIQNavRouting`, `NapIQNavDemoTravel`, or
 *     `NapIQNavTechnicianMarker` at all.
 *   - Any GPS noise-smoothing beyond a minimum-movement threshold
 *     before re-broadcasting a fix (see "Reducing OSRM/backend chatter
 *     from GPS jitter" below) — genuine route-progress noise handling
 *     ("do not allow noisy GPS readings to make progress jump wildly
 *     backward and forward") is explicitly Phase 12's job, since
 *     there is no route-progress concept for GPS to feed yet.
 *   - Any backend/API call of any kind. This file makes zero
 *     `fetch()` requests — device location is browser-local state
 *     only, per "Do not permanently save every GPS update to MySQL"
 *     (see that section below).
 *
 * --- Do not claim GPS is active when it is not ---
 * The rendered status only ever says "tracking" while
 * `watchId !== null` and at least one real, successful position fix
 * has been received. Requesting-but-not-yet-fixed is its own
 * "Requesting your location…" state, not folded into "tracking". A
 * denied/unavailable/timeout/unsupported state is always shown as an
 * explicit error, never silently reverted to "idle" (which would read
 * as "GPS was never tried"), until the user acts again (Retry or
 * Stop).
 *
 * --- Distinguishing Manual origin from Device GPS ---
 * `nav-origin.js`'s confirmed-origin badge now reads the origin's
 * `source` field: "manual-latlng" / "manual-map" still show the
 * existing green "Origin" badge; "device-gps" shows a distinct blue
 * "Device GPS" badge with a satellite icon (see nav-origin.js's
 * `renderPanel()`). This module additionally shows its own live
 * "GPS tracking active" indicator (with a pulsing dot, matching the
 * project's existing pending-marker pulse convention) directly under
 * the picker controls whenever `watchId !== null`, so the *current*
 * live/static distinction — not just "was this origin ever GPS-
 * derived" — is always visible, even after the page has been open a
 * while and the origin badge alone wouldn't say whether tracking is
 * still actually running right now.
 *
 * --- Do not permanently save every GPS update to MySQL ---
 * This module never calls `fetch()`, `XMLHttpRequest`, or any backend
 * route. Every GPS fix lives only in this module's own in-memory
 * `lastFix` variable and, once pushed to the origin store, in
 * `nav-origin.js`'s in-memory `selectedOrigin` — both are lost on
 * page reload, exactly like every other origin source in this
 * project (manual lat/lng, manual map-pick). No continuous location
 * history is written anywhere, and `navigator.geolocation.clearWatch`
 * is always called when tracking stops or the page unloads, so the
 * browser itself stops polling the device too.
 *
 * --- Reducing OSRM/backend chatter from GPS jitter ---
 * A device sitting still can still emit GPS fixes that wobble by a
 * few meters. Re-broadcasting every single one of those as a new
 * origin would fire a new OSRM request (`nav-routing.js`'s existing
 * `maybeAutoRequest`) for a route that hasn't meaningfully changed.
 * This module only pushes a fix into the origin store if it is the
 * first fix of this tracking session, or at least
 * `MIN_MOVE_METERS` (15m) from the last fix that was pushed — a
 * simple, honest distance check (haversine), not a fabricated
 * smoothing/interpolation algorithm. The *displayed* "last GPS fix"
 * accuracy/timestamp in this module's own status line still updates
 * on every fix received, so the UI never looks frozen while waiting
 * for the threshold — only the origin-store push (and therefore the
 * OSRM re-request) is throttled.
 */
(function () {
    var STATE_UNSUPPORTED = "unsupported";
    var STATE_IDLE = "idle";
    var STATE_REQUESTING = "requesting";
    var STATE_TRACKING = "tracking";
    var STATE_ERROR = "error";

    var MIN_MOVE_METERS = 15;

    var state = STATE_IDLE;
    var watchId = null;
    var lastFix = null; // { lat, lng, accuracy, timestamp }
    var lastPushedLatLng = null; // {lat, lng} of the last fix actually sent to the origin store
    var errorMessage = null;

    function supported() {
        return !!(window.navigator && "geolocation" in window.navigator && window.navigator.geolocation);
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    // Haversine distance in meters -- same standard formula used for
    // "did the device actually move", nothing fabricated.
    function distanceMeters(a, b) {
        var R = 6371000;
        var toRad = function (deg) { return (deg * Math.PI) / 180; };
        var dLat = toRad(b.lat - a.lat);
        var dLng = toRad(b.lng - a.lng);
        var lat1 = toRad(a.lat);
        var lat2 = toRad(b.lat);
        var h =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function formatCoords(lat, lng) {
        return lat.toFixed(6) + ", " + lng.toFixed(6);
    }

    function formatAccuracy(accuracy) {
        if (accuracy == null || !isFinite(accuracy)) return null;
        return "±" + Math.round(accuracy) + "m accuracy";
    }

    function errorReasonMessage(err) {
        // GeolocationPositionError codes: 1 = PERMISSION_DENIED,
        // 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT. Each gets its own
        // honest message rather than one generic "GPS failed" string.
        if (err && err.code === 1) {
            return "Location permission was denied. Allow location access for this site in your browser settings, then try again.";
        }
        if (err && err.code === 2) {
            return "Your device's location is currently unavailable. Check that location services are turned on.";
        }
        if (err && err.code === 3) {
            return "Timed out waiting for a location fix. Try again, ideally with a clearer view of the sky.";
        }
        return "Could not get your location. Please try again.";
    }

    // ---- Actions ----

    function startTracking() {
        // Phase 18 (90%): defensive guard against a duplicate
        // `watchPosition()` registration (e.g. a caller invoking this
        // twice in quick succession before a re-render disables the
        // button). Idempotent — already tracking/requesting is simply
        // a no-op, never a second concurrent watch.
        if (watchId !== null) return;
        if (!supported()) {
            state = STATE_UNSUPPORTED;
            errorMessage = "This browser does not support device location (Geolocation API unavailable).";
            render();
            return;
        }
        // Only one map-interaction / origin-acquisition flow at a time.
        if (window.NapIQNavOriginPicker && typeof window.NapIQNavOriginPicker.cancelPicking === "function") {
            window.NapIQNavOriginPicker.cancelPicking();
        }
        if (window.NapIQMapModes && typeof window.NapIQMapModes.exitPlacementModes === "function") {
            window.NapIQMapModes.exitPlacementModes();
        }

        state = STATE_REQUESTING;
        errorMessage = null;
        render();

        watchId = window.navigator.geolocation.watchPosition(onPosition, onError, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 20000,
        });
    }

    function stopTracking() {
        if (watchId !== null && window.navigator && window.navigator.geolocation) {
            window.navigator.geolocation.clearWatch(watchId);
        }
        watchId = null;
        // Deliberately keep lastFix / the already-pushed origin as-is
        // (see file header) -- stopping tracking is not the same as
        // clearing the origin. Only the live "requesting"/"tracking"
        // state resets.
        state = STATE_IDLE;
        errorMessage = null;
        render();
        // Phase 12 (60%), task 2: a separate, additive event from
        // napiq:origin-changed -- tracking can stop without the
        // origin itself changing (the origin deliberately stays put,
        // see above), but a live-progress consumer still needs to
        // know the fix stream has ended so it can stop showing
        // "live" progress derived from a watch that's no longer
        // running.
        window.dispatchEvent(new CustomEvent("napiq:gps-tracking-stopped"));
    }

    function retry() {
        errorMessage = null;
        startTracking();
    }

    function onPosition(position) {
        var coords = position.coords || {};
        var fix = {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy,
            timestamp: position.timestamp || Date.now(),
        };
        lastFix = fix;
        state = STATE_TRACKING;
        errorMessage = null;

        // Phase 12 (60%), task 2: broadcast EVERY accepted fix, not
        // just the ones that clear MIN_MOVE_METERS and get pushed as
        // a new origin below. Route-progress consumers need a much
        // higher-frequency signal than the origin/OSRM-re-request
        // throttle below is willing to provide -- that throttle
        // exists to avoid spamming OSRM with re-route requests, which
        // has nothing to do with how often on-route progress should
        // recompute. This is purely additive: a new event, no change
        // to any existing behavior in this function.
        window.dispatchEvent(new CustomEvent("napiq:gps-fix-received", { detail: fix }));

        var shouldPush =
            !lastPushedLatLng || distanceMeters(lastPushedLatLng, fix) >= MIN_MOVE_METERS;

        if (shouldPush && window.NapIQNavOrigin) {
            var accSuffix = formatAccuracy(fix.accuracy);
            var origin = {
                id: "device-gps-" + Date.now(),
                label: "My current location",
                subtitle: "Live GPS" + (accSuffix ? " · " + accSuffix : ""),
                position: { lat: fix.lat, lng: fix.lng },
                source: "device-gps",
            };
            // Set this BEFORE calling setOriginPoint(): that call
            // dispatches napiq:origin-changed synchronously (via
            // nav-origin.js's broadcast()), which this same module's
            // own napiq:origin-changed listener below receives
            // immediately -- before setOriginPoint() even returns. If
            // lastPushedLatLng were only updated after the call
            // returned, that listener would see a stale value on
            // every fix, wrongly conclude "something else changed the
            // origin", and call stopTracking() on our own update.
            var previousPushed = lastPushedLatLng;
            lastPushedLatLng = { lat: fix.lat, lng: fix.lng };
            var ok = window.NapIQNavOrigin.setOriginPoint(origin);
            if (!ok) lastPushedLatLng = previousPushed;
        }
        render();
    }

    function onError(err) {
        state = STATE_ERROR;
        errorMessage = errorReasonMessage(err);
        // A failed/denied fix must not silently keep a stale watch
        // running in the background implying tracking is still live.
        if (watchId !== null && window.navigator && window.navigator.geolocation) {
            window.navigator.geolocation.clearWatch(watchId);
        }
        watchId = null;
        render();
        // Phase 12 (60%), task 2: an error also ends the fix stream
        // (see onPosition()'s dispatch above for the counterpart) --
        // same reasoning as stopTracking()'s dispatch.
        window.dispatchEvent(new CustomEvent("napiq:gps-tracking-stopped"));
    }

    // ---- Rendering into nav-origin.js's #navOriginGpsControls ----

    function statusLine() {
        if (state === STATE_TRACKING && lastFix) {
            var accSuffix = formatAccuracy(lastFix.accuracy);
            return (
                '<div class="nav-gps-live-indicator d-flex align-items-center gap-2 text-primary small mb-1">' +
                '<span class="nav-gps-live-dot" aria-hidden="true"></span>' +
                "<span>Live GPS tracking active" + (accSuffix ? " (" + escapeHtml(accSuffix) + ")" : "") + "</span>" +
                "</div>"
            );
        }
        if (state === STATE_REQUESTING) {
            return (
                '<div class="d-flex align-items-center gap-2 text-muted small mb-1">' +
                '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>' +
                "<span>Requesting your device location&hellip;</span>" +
                "</div>"
            );
        }
        if (state === STATE_ERROR && errorMessage) {
            return '<div class="text-danger small mb-1"><i class="bi bi-exclamation-triangle-fill me-1"></i>' + escapeHtml(errorMessage) + "</div>";
        }
        if (state === STATE_UNSUPPORTED && errorMessage) {
            return '<div class="text-muted small fst-italic mb-1">' + escapeHtml(errorMessage) + "</div>";
        }
        return "";
    }

    function buttonHtml() {
        if (state === STATE_UNSUPPORTED) return "";
        if (state === STATE_TRACKING) {
            return (
                '<button type="button" class="btn btn-sm btn-outline-primary w-100" id="navGpsStopBtn">' +
                '<i class="bi bi-broadcast-pin me-1"></i>Stop GPS tracking</button>'
            );
        }
        if (state === STATE_REQUESTING) {
            return (
                '<button type="button" class="btn btn-sm btn-outline-secondary w-100" id="navGpsStopBtn" disabled>' +
                '<i class="bi bi-broadcast-pin me-1"></i>Requesting&hellip;</button>'
            );
        }
        if (state === STATE_ERROR) {
            return (
                '<button type="button" class="btn btn-sm btn-outline-primary w-100" id="navGpsRetryBtn">' +
                '<i class="bi bi-arrow-clockwise me-1"></i>Retry</button>'
            );
        }
        return (
            '<button type="button" class="btn btn-sm btn-outline-primary w-100" id="navGpsStartBtn">' +
            '<i class="bi bi-geo-alt-fill me-1"></i>Use my device location</button>'
        );
    }

    function render() {
        var host = document.getElementById("navOriginGpsControls");
        if (!host) return;
        host.innerHTML =
            '<div aria-live="polite" aria-atomic="true">' + statusLine() + "</div>" +
            '<div class="mb-2">' + buttonHtml() + "</div>";
        attachHandlers();
    }

    function attachHandlers() {
        var startBtn = document.getElementById("navGpsStartBtn");
        if (startBtn) startBtn.addEventListener("click", startTracking);
        var stopBtn = document.getElementById("navGpsStopBtn");
        if (stopBtn) stopBtn.addEventListener("click", stopTracking);
        var retryBtn = document.getElementById("navGpsRetryBtn");
        if (retryBtn) retryBtn.addEventListener("click", retry);
    }

    // ---- Coordination with the rest of the origin system ----

    // If the origin changed to something this module did NOT itself
    // just push (a manual lat/lng entry, a manual map pick, or the
    // origin being cleared entirely), a live GPS watch would now be
    // silently updating a store nobody asked it to keep updating.
    // Stop tracking so the UI never claims "Live GPS tracking active"
    // while the current origin is actually a manual one.
    window.addEventListener("napiq:origin-changed", function (evt) {
        var origin = evt.detail;
        var thisModuleSetIt =
            origin && origin.source === "device-gps" && lastPushedLatLng &&
            origin.position.lat === lastPushedLatLng.lat && origin.position.lng === lastPushedLatLng.lng;
        if (!thisModuleSetIt && watchId !== null) {
            stopTracking();
        }
    });

    // nav-origin.js rebuilds #navOriginGpsControls's markup from
    // scratch on every renderPanel() call (both the empty and
    // confirmed states include it) -- this is our cue to render our
    // own controls into the fresh DOM, same convention
    // nav-origin-picker.js already uses for its own container.
    window.addEventListener("napiq:navorigin-panel-rendered", function () {
        render();
    });
    document.addEventListener("DOMContentLoaded", render);

    // Stop polling the device if the user navigates away -- belt and
    // suspenders alongside stopTracking()'s own clearWatch(), since
    // this project's origin state is in-memory only and doesn't
    // survive a reload anyway.
    window.addEventListener("beforeunload", function () {
        if (watchId !== null && window.navigator && window.navigator.geolocation) {
            window.navigator.geolocation.clearWatch(watchId);
        }
    });

    window.NapIQNavGpsOrigin = {
        startTracking: startTracking,
        stopTracking: stopTracking,
        retry: retry,
        getState: function () {
            return {
                state: state,
                lastFix: lastFix,
                errorMessage: errorMessage,
                tracking: watchId !== null,
            };
        },
    };
})();
