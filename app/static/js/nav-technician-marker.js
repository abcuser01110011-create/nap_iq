/**
 * Navigation marker / technician position — Phase 10 (50%, translation project)
 * -------------------------------------------------------------------------
 * Translates the prototype's moving "technician position" marker
 * (the `GeoMap.tsx` layer that renders `navigationPosition` /
 * `demoTravel.position`) onto the existing, real Leaflet map
 * (`window.NapIQMap`, exposed by napmap.js).
 *
 * Scope of this phase (per the phase 10 spec):
 *   - A dedicated marker, separate from the existing NAP/issue/
 *     subscriber marker layers, that represents the CURRENT
 *     navigation position.
 *   - It moves along the route during demo travel (Phase 9).
 *   - It updates independently of NAP/issue/subscriber markers —
 *     this file never touches markerLayer / issueMarkerLayer /
 *     subscriberMarkerLayer or any of napmap.js's internal state.
 *   - It disappears/resets appropriately (see "Lifecycle" below).
 *   - It NEVER writes to the technician's permanent database
 *     location (`technicians.current_latitude/current_longitude`,
 *     see app/models.py + app/navigation_contract.py). This file
 *     makes no fetch()/API calls at all — it is a pure, read-only
 *     rendering of Phase 9's already-computed, client-side-only
 *     simulated position.
 *   - It is visually and textually distinguished from a
 *     technician's last-known DB position (a concept this project
 *     already has — `technician_origin()` in navigation_contract.py
 *     — but that is not yet surfaced as its own map marker anywhere
 *     in the app; see "Distinguishing demo vs. DB position" below).
 *
 * --- Phase 12 (60%), TASK 3 addendum ---
 * This originally-Phase-10 file now also renders live GPS route
 * progress (nav-gps-route-progress.js, Phase 12 tasks 1-2), via a
 * new sibling file `nav-gps-technician-marker.js` that translates
 * that module's state into this file's existing render() shape,
 * exactly as this file's own Phase 10 comments predicted it would.
 * The only changes made to THIS file for that: `upsertMarker()` /
 * `markerHtml()` / `popupHtml()` now read an optional `source` field
 * ("demo" | "live-gps", defaulting to "demo" for Phase 9's
 * unchanged event shape) and show a distinct ribbon label/color and
 * popup title/blurb per source -- the same light-touch "badge
 * color/label only" distinction Phase 11 already used for Manual vs.
 * Device GPS origins, not a whole new icon shape. A new `getSource()`
 * getter was added to the public API below so a consumer can check
 * which source currently owns the marker before deciding whether to
 * touch it (see "Multiple sources, one marker" below).
 *
 * Multiple sources, one marker:
 * Demo travel and live GPS both render into this same single marker
 * slot. Policy: a live GPS fix always takes over the marker (real
 * device data takes priority over a simulated preview) the instant
 * one arrives, via `nav-gps-technician-marker.js`'s unchanged
 * `handleActive()`. Phase 18 (90%) closed the one gap that policy
 * left open: when GPS later goes inactive, `nav-gps-technician-
 * marker.js`'s `handleInactive()` now checks whether demo travel
 * still has a real position (mid-run, paused, complete, or reset-to-
 * origin) and, if so, hands the marker back to it (re-rendering with
 * `source: "demo"`) instead of unconditionally clearing it. It still
 * only acts when `getSource()` currently says "live-gps" (so stopping
 * GPS while demo travel already owns the marker remains a no-op), and
 * it still never interrupts a live GPS fix that's actively arriving.
 * See nav-gps-technician-marker.js's own file-header addendum for the
 * full rationale.
 *
 * Explicitly NOT implemented this phase (per the phase spec / this
 * project's later phases):
 *   - No dispatch/assignment integration (Phase 13/14) — the marker
 *     is not yet labeled with a real assigned technician's name;
 *     that context does not exist in the navigation store until
 *     later phases wire it in.
 *
 * Integration points used (all documented, none guessed):
 *   - `window.NapIQMap` (napmap.js) — the one real Leaflet map
 *     instance. This file listens for the `napiq:map-ready` event
 *     napmap.js fires (Phase 8 convention, reused verbatim) so load
 *     order relative to napmap.js never matters.
 *   - `napiq:demo-travel-changed` (nav-demo-travel.js, Phase 9) — the
 *     event this file listens to for `{status, position,
 *     progressPercent, remainingDistanceMeters,
 *     remainingDurationSeconds}`. Phase 9 already computes this
 *     purely from real OSRM route geometry (never a straight line);
 *     this file only renders it.
 *   - `window.NapIQNavDemoTravel.getState()` (nav-demo-travel.js) —
 *     read once on load / on `napiq:map-ready`, in case demo travel
 *     is already mid-run when this file finishes loading (e.g. a
 *     future page that keeps navigation state across a soft
 *     reload), so the marker never has to wait for the next event to
 *     appear.
 *
 * Lifecycle (mirrors Phase 9's own state machine, unchanged by this
 * file):
 *   - `idle` with `position === null` (Phase 9's `hardReset()`, fired
 *     when destination/origin changes) -> marker is removed from the
 *     map entirely.
 *   - `idle` with a `position` set (Phase 9's `reset()`, which puts
 *     the simulated position back at the route's own origin rather
 *     than clearing it) -> marker is shown sitting at the route
 *     origin. This matches this phase's own acceptance criterion
 *     "Reset returns marker to origin".
 *   - `running` / `paused` -> marker follows the live interpolated
 *     position, with status-appropriate styling (see below).
 *   - `complete` -> marker sits at the destination.
 *
 * Distinguishing demo vs. DB position:
 *   Nothing in this app currently draws technicians.current_latitude
 *   / current_longitude as its own map marker anywhere (confirmed by
 *   inspection: `grep -rn "current_latitude" app/` only turns up the
 *   model column, the dispatch recommendation scorer, and the
 *   read-only `technician_origin()` JSON helper — never a Leaflet
 *   layer). So there is no existing "last-known DB position" marker
 *   this phase could collide with. To keep that boundary explicit
 *   for later phases anyway: this marker's icon carries a small
 *   "DEMO" ribbon, its tooltip/popup text always says "Demo travel"
 *   (never "Technician's current location"), and this file contains
 *   no database/API access of any kind — it is fed exclusively by
 *   Phase 9's client-side simulation.
 */
(function () {
    var PANE_NAME = "napiqTechnicianPane";
    var PANE_ZINDEX = 475; // above the Phase 6 route line (460) and its
    // endpoint circle markers (470), but still below Leaflet's default
    // markerPane (600) — the pane napmap.js's NAP/issue/subscriber
    // `L.marker` layers use — so this marker can never visually cover
    // an existing marker, matching Phase 6's own pane convention.

    var STATUS_META = {
        idle: { color: "#6c757d", ring: "#495057", label: "Idle", pulse: false },
        running: { color: "#0d6efd", ring: "#084298", label: "Running", pulse: true },
        paused: { color: "#ffc107", ring: "#997404", label: "Paused", pulse: false },
        complete: { color: "#198754", ring: "#0f5132", label: "Complete", pulse: false },
    };

    // Phase 12 (60%), task 3: this marker now has two possible
    // sources feeding it -- Phase 9's demo travel (unchanged) and
    // Phase 12's live GPS route progress (new). Both share this one
    // marker slot (see "Multiple sources, one marker" below), but
    // must never be visually confused for one another: the ribbon
    // label/color and popup copy differ per source while the core
    // circle+arrow shape stays the same, the same light-touch
    // distinction convention Phase 11 already used for the Manual
    // vs. Device GPS origin badge (color/label only, not a whole new
    // icon).
    var SOURCE_META = {
        demo: { ribbonLabel: "DEMO", ribbonFill: "#212529", icon: "bi-truck", title: "Demo travel", blurb: "Simulated preview position — not a technician's saved location." },
        "live-gps": { ribbonLabel: "GPS", ribbonFill: "#0d6efd", icon: "bi-geo-alt-fill", title: "Live GPS position", blurb: "Your real device location while navigating — not a saved technician location." },
    };

    var marker = null; // the single L.marker this module owns
    var paneReady = false;
    var lastPosition = null; // {lat, lng} used only to compute heading
    var lastStatus = null;
    var lastSource = null; // 'demo' | 'live-gps' | null (no marker shown)

    function map() {
        return window.NapIQMap || null;
    }

    function ensurePane() {
        var m = map();
        if (paneReady || !m) return;
        if (!m.getPane(PANE_NAME)) {
            m.createPane(PANE_NAME).style.zIndex = PANE_ZINDEX;
        }
        paneReady = true;
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    /** Bearing in degrees (0 = north, clockwise) from `a` to `b`, used
     * only to rotate the marker's arrow so it visibly points along the
     * road it's following — never used for distance/progress math,
     * which Phase 9 already owns and this file only reads. */
    function bearingDegrees(a, b) {
        var toRad = function (deg) {
            return (deg * Math.PI) / 180;
        };
        var toDeg = function (rad) {
            return (rad * 180) / Math.PI;
        };
        var lat1 = toRad(a.lat);
        var lat2 = toRad(b.lat);
        var dLng = toRad(b.lng - a.lng);
        var y = Math.sin(dLng) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
        var deg = toDeg(Math.atan2(y, x));
        return (deg + 360) % 360;
    }

    /**
     * Distinct marker icon — must not read as a NAP marker (blue
     * rounded rectangle), an issue marker (colored triangle), a
     * subscriber marker (person glyph), or an origin-picker pin
     * (emerald teardrop). This one is a circular badge with a
     * directional arrow (heading = travel direction) and a small
     * source ribbon underneath ("DEMO" or "GPS", see SOURCE_META),
     * so it's shape- and label-distinct from every other marker on
     * the map, and the ribbon itself keeps the two position sources
     * this file can now render from distinct from each other too.
     */
    function markerHtml(status, headingDeg, source) {
        var meta = STATUS_META[status] || STATUS_META.idle;
        var srcMeta = SOURCE_META[source] || SOURCE_META.demo;
        var rotate = typeof headingDeg === "number" ? headingDeg : 0;
        return (
            '<div class="nav-tech-marker-wrap' + (meta.pulse ? " nav-tech-marker-pulse" : "") + '">' +
            '<svg width="40" height="52" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg" ' +
            'style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));">' +
            '<circle cx="20" cy="20" r="16" fill="' + meta.color + '" stroke="' + meta.ring + '" stroke-width="2.5"/>' +
            '<g transform="rotate(' + rotate + ' 20 20)">' +
            '<path d="M20 10L26 24L20 20.5L14 24Z" fill="#ffffff"/>' +
            "</g>" +
            '<rect x="4" y="40" width="32" height="11" rx="5.5" fill="' + srcMeta.ribbonFill + '"/>' +
            '<text x="20" y="48" text-anchor="middle" font-size="7.5" font-weight="700" ' +
            'font-family="sans-serif" fill="#ffffff" letter-spacing="0.5">' + srcMeta.ribbonLabel + "</text>" +
            "</svg></div>"
        );
    }

    function icon(status, headingDeg, source) {
        return window.L.divIcon({
            className: "nav-tech-div-icon",
            html: markerHtml(status, headingDeg, source),
            iconSize: [40, 52],
            iconAnchor: [20, 26],
            popupAnchor: [0, -24],
        });
    }

    function formatMeters(m) {
        if (m == null) return "—";
        return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
    }

    function formatDuration(sec) {
        if (sec == null) return "—";
        var totalMin = Math.round(sec / 60);
        if (totalMin < 1) return "<1 min";
        if (totalMin < 60) return totalMin + " min";
        var h = Math.floor(totalMin / 60);
        var m = totalMin % 60;
        return h + "h " + m + "m";
    }

    function popupHtml(demoState) {
        var meta = STATUS_META[demoState.status] || STATUS_META.idle;
        var source = demoState.source || "demo";
        var srcMeta = SOURCE_META[source] || SOURCE_META.demo;
        return (
            '<div class="nav-tech-popup">' +
            '<div class="fw-semibold mb-1"><i class="bi ' + srcMeta.icon + ' me-1"></i>' + escapeHtml(srcMeta.title) + "</div>" +
            '<div class="small text-muted mb-1">' + escapeHtml(srcMeta.blurb) + "</div>" +
            '<div class="small"><span class="badge" style="background:' + meta.color + '">' +
            escapeHtml(meta.label) + "</span> &middot; " + demoState.progressPercent + "% complete</div>" +
            '<div class="small text-muted mt-1">Remaining: ' +
            escapeHtml(formatMeters(demoState.remainingDistanceMeters)) +
            " &middot; " +
            escapeHtml(formatDuration(demoState.remainingDurationSeconds)) +
            "</div>" +
            "</div>"
        );
    }

    function removeMarker() {
        var m = map();
        if (marker && m) m.removeLayer(marker);
        marker = null;
        lastPosition = null;
        lastStatus = null;
        lastSource = null;
    }

    function upsertMarker(demoState) {
        var m = map();
        var position = demoState.position;
        var source = demoState.source || "demo";

        if (!position || !m || !window.L) {
            removeMarker();
            return;
        }

        ensurePane();

        var heading = lastPosition ? bearingDegrees(lastPosition, position) : 0;
        // A zero-length or effectively-unchanged move (e.g. two events
        // at the same idle/complete position) would produce a
        // meaningless bearing; keep the previous heading in that case
        // rather than snapping the arrow to 0/north.
        if (lastPosition && lastPosition.lat === position.lat && lastPosition.lng === position.lng && marker) {
            heading = marker.__napiqHeading || 0;
        }

        if (!marker) {
            marker = window.L.marker([position.lat, position.lng], {
                pane: PANE_NAME,
                icon: icon(demoState.status, heading, source),
                interactive: true,
                keyboard: false,
                zIndexOffset: 1000,
            }).addTo(m);
            // Bound once; updated in place below via setPopupContent()
            // so re-binding never closes an already-open popup.
            marker.bindPopup(popupHtml(demoState));
        } else {
            marker.setLatLng([position.lat, position.lng]);
            if (demoState.status !== lastStatus || source !== lastSource || heading !== marker.__napiqHeading) {
                marker.setIcon(icon(demoState.status, heading, source));
            }
            marker.setPopupContent(popupHtml(demoState));
        }

        marker.__napiqHeading = heading;
        lastPosition = { lat: position.lat, lng: position.lng };
        lastStatus = demoState.status;
        lastSource = source;
    }

    function handleDemoTravelChanged(evt) {
        var demoState = (evt && evt.detail) || (window.NapIQNavDemoTravel ? window.NapIQNavDemoTravel.getState() : null);
        if (!demoState) return;
        upsertMarker(demoState);
    }

    function syncFromCurrentState() {
        if (!window.NapIQNavDemoTravel) return;
        upsertMarker(window.NapIQNavDemoTravel.getState());
    }

    window.addEventListener("napiq:demo-travel-changed", handleDemoTravelChanged);
    // In case demo travel is already running/paused/complete by the
    // time this file's own map reference becomes available (e.g. a
    // future page keeps navigation state across a soft reload before
    // this phase gets a real persistence layer, or simple load-order
    // variance), re-sync from the real current state rather than
    // waiting for the next transition event.
    window.addEventListener("napiq:map-ready", syncFromCurrentState);
    document.addEventListener("DOMContentLoaded", syncFromCurrentState);

    window.NapIQNavTechnicianMarker = {
        // Exposed read-only-by-convention (matching every other
        // nav-*.js module in this project) so a future phase — most
        // plausibly Phase 12's live GPS progress — can drive this
        // exact same marker from a different position source without
        // this file changing, by dispatching a compatible
        // `{status, position, progressPercent, remainingDistanceMeters,
        // remainingDurationSeconds}` shape through this function
        // instead of only through the demo-travel event.
        render: upsertMarker,
        clear: removeMarker,
        getMarker: function () {
            return marker;
        },
        // Phase 12 (60%), task 3: lets a second source (live GPS)
        // check who currently owns the marker before deciding whether
        // it's safe to clear it -- see "Multiple sources, one marker"
        // above.
        getSource: function () {
            return lastSource;
        },
    };
})();
