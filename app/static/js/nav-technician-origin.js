/**
 * Technician's own last-known DB position as a navigation origin —
 * Phase 14 (70%, technician dispatch integration)
 * -----------------------------------------------------------------
 * The plan for this phase asks that, once a technician is assigned
 * to a job, they be able to navigate to it with "the technician's
 * current/manual/device position" available as the route's origin.
 * Manual (Phase 8) and device GPS (Phase 11) origins already exist —
 * this file adds the third: the technician's own `technicians
 * .current_latitude` / `current_longitude` row already exposed
 * read-only by `GET /api/technicians/<id>/location` (built, but
 * unused by any UI, back in the Phase 23 10% data contract — see
 * that endpoint's own docstring in app/routes/api.py).
 *
 * This is a sibling of `nav-gps-origin.js` and `nav-origin-picker.js`,
 * not a rewrite of either: same "tiny, dependency-free module +
 * render into a container inside nav-origin.js's panel" pattern, same
 * "never call OSRM itself, just push a point into
 * window.NapIQNavOrigin and let nav-routing.js's existing
 * napiq:origin-changed listener request the road route" boundary.
 *
 * Unlike nav-gps-origin.js, this is a one-shot lookup, not a live
 * watch — a technician's DB position is only ever as fresh as
 * whatever last wrote `current_latitude`/`current_longitude` (nothing
 * in this project keeps that column live yet; see
 * PHASE23_5_PERCENT_NOTES.md §8), so there is no "tracking" state to
 * maintain, and no `fetch()` result is ever written back to the
 * database — this module only ever reads.
 *
 * Visibility: the button/status this module renders only appears at
 * all when `#napMap`'s `data-own-technician-id` attribute (set
 * server-side by naps.geomap(), see that route's own docstring) is
 * non-empty — i.e. only for a signed-in Technician with a linked
 * profile. An Administrator (who has no Technician profile) sees
 * nothing from this module, exactly like the API endpoint it calls
 * would 403 an id that isn't their own.
 *
 * Public surface: none. This module only writes into
 * `#navOriginTechnicianControls` (owned by nav-origin.js) and reads
 * from `window.NapIQNavOrigin`.
 */
(function () {
    var STATE_IDLE = "idle";
    var STATE_LOADING = "loading";
    var STATE_ERROR = "error";

    var state = STATE_IDLE;
    var errorMessage = null;

    // Phase 18 (90%): a one-shot fetch can resolve after the origin
    // has already moved on to something else (a newer lookup, a
    // manual pick, a GPS fix) — without a guard, a slow/delayed
    // response could silently clobber whatever the user set in the
    // meantime. `requestToken` is bumped on every new lookup and
    // whenever the origin store reports a change this module didn't
    // itself just make; a response is only applied if its token is
    // still current. See `useMyLastKnownLocation()` and the
    // `napiq:origin-changed` listener at the bottom of this file.
    var requestToken = 0;

    function getOwnTechnicianId() {
        var mapEl = document.getElementById("napMap");
        if (!mapEl) return null;
        var raw = mapEl.getAttribute("data-own-technician-id");
        if (!raw) return null;
        var id = parseInt(raw, 10);
        return isFinite(id) && id > 0 ? id : null;
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    function useMyLastKnownLocation() {
        var technicianId = getOwnTechnicianId();
        if (technicianId == null) return;

        // Phase 18 (90%): an explicit action here should win over a
        // passive background GPS watch, the same rule
        // nav-origin-picker.js's startPicking() now also follows —
        // symmetric, not new behavior.
        if (window.NapIQNavGpsOrigin && typeof window.NapIQNavGpsOrigin.getState === "function") {
            var gpsState = window.NapIQNavGpsOrigin.getState();
            if (gpsState && gpsState.tracking && typeof window.NapIQNavGpsOrigin.stopTracking === "function") {
                window.NapIQNavGpsOrigin.stopTracking();
            }
        }

        var myToken = ++requestToken;
        state = STATE_LOADING;
        errorMessage = null;
        render();

        fetch("/api/technicians/" + technicianId + "/location")
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("request-failed");
                }
                return response.json();
            })
            .then(function (data) {
                if (myToken !== requestToken) return; // superseded — see file header
                if (!data || !data.origin) {
                    state = STATE_ERROR;
                    errorMessage =
                        "No last known location is on file for your technician profile yet.";
                    render();
                    return;
                }
                var origin = {
                    id: data.origin.id,
                    label: data.origin.label || "My last known location",
                    subtitle: data.origin.subtitle || "Last known technician location",
                    position: data.origin.position,
                    source: "technician-db",
                };
                state = STATE_IDLE;
                errorMessage = null;
                // renderPanel() (via setOriginPoint -> broadcast()) will
                // rebuild #navOriginTechnicianControls from scratch and
                // this module's own render() runs again on that cue —
                // no separate render() call needed on the success path.
                window.NapIQNavOrigin.setOriginPoint(origin);
            })
            .catch(function () {
                if (myToken !== requestToken) return; // superseded — see file header
                state = STATE_ERROR;
                errorMessage = "Couldn't load your last known location. Try again.";
                render();
            });
    }

    function render() {
        var host = document.getElementById("navOriginTechnicianControls");
        if (!host) return;

        var technicianId = getOwnTechnicianId();
        if (technicianId == null) {
            // Not a technician (or no linked profile) — nothing to
            // offer here. Leave the container empty rather than
            // showing a control that would just 403.
            host.innerHTML = "";
            return;
        }

        var statusHtml = "";
        if (state === STATE_LOADING) {
            statusHtml =
                '<div class="d-flex align-items-center gap-2 text-muted small mb-1">' +
                '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>' +
                "<span>Looking up your last known location&hellip;</span>" +
                "</div>";
        } else if (state === STATE_ERROR && errorMessage) {
            statusHtml =
                '<div class="text-danger small mb-1"><i class="bi bi-exclamation-triangle-fill me-1"></i>' +
                escapeHtml(errorMessage) +
                "</div>";
        }

        var disabled = state === STATE_LOADING ? " disabled" : "";
        var buttonHtml =
            '<button type="button" class="btn btn-sm btn-outline-secondary w-100" id="navTechnicianOriginBtn"' +
            disabled +
            ">" +
            '<i class="bi bi-person-badge me-1"></i>Use my last known location</button>';

        host.innerHTML = '<div aria-live="polite" aria-atomic="true">' + statusHtml + "</div>" +
            '<div class="mb-2">' + buttonHtml + "</div>";

        var btn = document.getElementById("navTechnicianOriginBtn");
        if (btn) btn.addEventListener("click", useMyLastKnownLocation);
    }

    // nav-origin.js rebuilds #navOriginTechnicianControls's markup
    // from scratch on every renderPanel() call (both the empty and
    // confirmed states include it) — this is our cue to render our
    // own control into the fresh DOM, same convention
    // nav-gps-origin.js and nav-origin-picker.js already use for
    // their own containers.
    window.addEventListener("napiq:navorigin-panel-rendered", function () {
        render();
    });
    // Phase 18 (90%): if the origin changed to something this module
    // did NOT itself just set (a manual pick, typed coordinates, or a
    // GPS fix), invalidate any in-flight lookup so a slow response
    // arriving later can't silently overwrite the origin the user has
    // since moved on to. A change TO "technician-db" is this module's
    // own successful result landing — never invalidates itself.
    window.addEventListener("napiq:origin-changed", function (evt) {
        var origin = evt.detail;
        if (!origin || origin.source !== "technician-db") {
            requestToken++;
        }
    });
    document.addEventListener("DOMContentLoaded", render);

    // Exposed for symmetry with nav-gps-origin.js / debugging only —
    // nothing else in the app calls into this.
    window.NapIQNavTechnicianOrigin = {
        useMyLastKnownLocation: useMyLastKnownLocation,
        getState: function () {
            return { state: state, errorMessage: errorMessage };
        },
    };
})();
