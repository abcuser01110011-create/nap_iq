/**
 * Route-line engine — Phase 5 (25%) + Phase 6 (30%) + Phase 7 (35%)
 * + Phase 9 (45%, translation project)
 * -----------------------------------------------------------------
 * Translates the prototype's `NavigationStore.loadRoute()`
 * (src/store/NavigationStore.tsx) — the routing slice only — into
 * vanilla JS on top of the existing Phase 4 Navigation Card shell
 * (nav-card.js) and the Phase 5 origin store (nav-origin.js).
 *
 * What this does, matching the phase spec:
 *   - Requests a real driving route from OSRM (the same public
 *     `router.project-osrm.org` driving service the prototype calls
 *     directly from the browser — see loadRoute() in
 *     NavigationStore.tsx) given a real origin lat/lng and the
 *     existing destination lat/lng from `window.NapIQNavigation`.
 *   - Stores route points (real road geometry, not a straight line),
 *     distance in meters, and duration in seconds.
 *   - Implements four distinct, honestly-labeled states: loading,
 *     ready, invalid/no-route, and network failure — plus a retry
 *     action for the two error states.
 *   - Protects against stale responses: if the destination or origin
 *     changes while a request is in flight, a monotonically
 *     increasing request id (mirrors the prototype's
 *     `routeRequestRef`) makes the in-flight response a no-op when it
 *     lands.
 *   - (Phase 6, 30%) Draws the route as a dedicated Leaflet layer —
 *     translated from GeoMap.tsx's `RouteController` + its
 *     "navigation-route" / "navigation-endpoints" `<Pane>`s and
 *     `<Polyline>`/`<CircleMarker>` JSX — see "Map route-layer
 *     integration" below for the one thing this phase still could not
 *     fully wire up without a file it wasn't given.
 *   - (Phase 7, 35%) Expands the Navigation Card's route-status block
 *     into a full "Route Details Panel", translated from the
 *     prototype's `RouteDetails.tsx`:
 *       - total route distance + estimated duration (straight from the
 *         OSRM response, same as Phase 5/6 already showed);
 *       - a human-readable arrival ETA (a clock time, e.g. "Arrives
 *         around 3:45 PM"), computed as now + durationSeconds;
 *       - "remaining" distance/duration — shown honestly equal to the
 *         totals (since no progress is tracked yet, 0% of the route
 *         has been traveled, so 100% of it remains — this is the
 *         mathematically correct value given the current state, not a
 *         guess);
 *       - an explicit route-status badge (Idle / Loading / Ready /
 *         Error) shown at the top of the panel in every state;
 *       - a route-completion percentage placeholder — always 0%,
 *         labeled as a placeholder — because this phase does NOT
 *         implement live GPS progress (see prototype's
 *         `navigation.progress` / demo-travel simulation, explicitly
 *         out of scope) and must not show fabricated movement;
 *       - the current origin and destination coordinates, always
 *         visible in the panel so it's clear what the displayed route
 *         is between.
 *     Loading / ready / error / idle states are all handled explicitly
 *     with distinct, clearly-labeled markup (translated from
 *     `RoutingNotice`, the ready-state metric grid, `RouteError`, and
 *     the destination-without-origin notice in RouteDetails.tsx).
 *   - (Phase 9, 45%) The Phase 7 "route completion percentage
 *     placeholder" and the "Remaining" metric are no longer
 *     permanently frozen at 0%/the totals. This file now reads
 *     window.NapIQNavDemoTravel.getState() (nav-demo-travel.js, a new
 *     module this phase adds) and, only while a demo travel run is
 *     actually active, shows its real progress percentage, remaining
 *     distance, and remaining duration -- computed by that module
 *     from the same real OSRM route geometry stored here. With no
 *     demo run started, both stay exactly as Phase 7 left them (0%,
 *     totals). This file's own OSRM request/error/retry logic, and
 *     the Phase 6 route-line drawing, are unchanged.
 *   - (Phase 12, 60%, TASK 4 OF N) The same "Route completion" block
 *     and "Remaining" metric now also read live GPS progress
 *     (window.NapIQNavGpsRouteProgress.getState(), Phase 12 Task 2)
 *     when it's active, using the same precedence Task 3 already
 *     established for the technician marker: a real, live GPS fix
 *     outranks a simulated demo-travel run. If GPS progress is not
 *     active, this panel falls straight back to Task-free-standing
 *     Phase 9 demo-travel behavior (or the Phase 7 static 0%/totals
 *     placeholder if neither is active) -- byte-for-byte the same as
 *     before this task for anyone not using live GPS. See
 *     getActiveProgressSource() below. This file listens for the new
 *     napiq:gps-route-progress-changed event (Task 2) to re-render
 *     when a GPS fix updates progress, the same way it already
 *     listens for napiq:demo-travel-changed.
 *
 * Explicitly NOT implemented this phase (per the phase spec):
 *   - GPS movement (demo travel simulation itself is now implemented,
 *     but only in the separate nav-demo-travel.js module -- see the
 *     Phase 9 note above; this file never runs the animation loop).
 *   - Origin selection beyond manual lat/lng entry (see nav-origin.js
 *     for why).
 *   - Live route-completion tracking (Phase 7 shows only the honest,
 *     static 0% placeholder described above — no fake progress).
 *
 * Integration points used (all documented, none of them guessed):
 *   - window.NapIQNavigation (nav-destination.js, Phase 23) — destination.
 *   - window.NapIQNavOrigin (nav-origin.js, Phase 5) — origin.
 *   - window.NapIQNavCard.elements() (nav-card.js, Phase 4) — the
 *     stable #navCardRouteStatus / #navCardControls containers this
 *     phase renders into, instead of rewriting nav-card.js.
 *   - The `napiq:navcard-rendered` event, a one-line, additive
 *     addition to nav-card.js's existing render() (see that file's
 *     diff) that fires after every re-render (destination change,
 *     collapse/expand) so this module can safely re-apply its own
 *     content into the freshly-rebuilt containers without nav-card.js
 *     needing to know anything about routing.
 *
 * Map route-layer integration (remaining limitation, unchanged since
 * Phase 5 — still blocked on the same missing file):
 *   Drawing anything on the existing #napMap requires the actual
 *   Leaflet map instance that napmap.js creates. napmap.js has not
 *   been part of ANY delta package supplied to this translation
 *   project so far (Phase 4: nav-card.js, map.html, napmap.css.
 *   Phase 5: nav-origin.js, nav-routing.js, nav-card.js, napmap.css,
 *   map.html. Phase 6: nav-routing.js only), so it still could not be
 *   inspected or safely edited this phase either. Per this project's
 *   own rules — inspect the real target file before changing it,
 *   never risk creating a second map — this module continues to only
 *   *look for* the map instance at the documented convention
 *   `window.NapIQMap` and builds/tears down its entire route layer on
 *   it *if present*, touching nothing else napmap.js owns (NAP/issue/
 *   subscriber marker layers, filters, click handlers are never
 *   referenced here). Distance, ETA, loading, ready, error, and retry
 *   all keep working fully in the Navigation Card regardless of
 *   whether `window.NapIQMap` exists. Everything else Phase 6 asks
 *   for — dedicated route layer/panes, casing+line styling, endpoint
 *   markers, fit-bounds, replace-not-stack on re-route, clean removal
 *   on reset — is fully implemented below and will start rendering on
 *   the map automatically, no further change on this side, the moment
 *   napmap.js adds one line after it creates the map:
 *   `window.NapIQMap = map;` (substituting the real local variable
 *   name). See TRANSLATION_PHASE6_30PCT_NOTES.md for the full
 *   breakdown.
 */
(function () {
    var OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving/";

    var state = {
        status: "idle", // 'idle' | 'loading' | 'ready' | 'error'
        errorKind: null, // null | 'no_route' | 'network'
        errorMessage: null,
        route: null, // { points: [{lat,lng}, ...], distanceMeters, durationSeconds }
    };

    var requestSeq = 0;
    var routeLayer = null;

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    function formatDistance(meters) {
        if (meters < 1000) return Math.max(0, Math.round(meters)) + " m";
        return (meters / 1000).toFixed(meters >= 10000 ? 0 : 1) + " km";
    }

    function formatDuration(seconds) {
        var minutes = Math.max(0, Math.ceil(seconds / 60));
        if (minutes < 60) return minutes + " min";
        var hours = Math.floor(minutes / 60);
        return hours + "h " + (minutes % 60) + "m";
    }

    /**
     * Phase 7 (35%) — human-readable arrival ETA (a clock time), e.g.
     * "3:45 PM". Computed from the real OSRM durationSeconds added to
     * the current time; never shown unless a real route is ready.
     */
    function formatEta(durationSeconds) {
        try {
            var arrival = new Date(Date.now() + Math.max(0, durationSeconds) * 1000);
            return arrival.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        } catch (e) {
            return "\u2014"; // em dash fallback, never throw for a display-only value
        }
    }

    /** Phase 7 (35%) — "lat, lng" for the panel's origin/destination rows. */
    function formatCoords(pos) {
        if (!pos || typeof pos.lat !== "number" || typeof pos.lng !== "number") return "\u2014";
        return pos.lat.toFixed(6) + ", " + pos.lng.toFixed(6);
    }

    function parsePoints(coordinates) {
        if (!Array.isArray(coordinates)) return [];
        var points = [];
        for (var i = 0; i < coordinates.length; i++) {
            var item = coordinates[i];
            if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "number" && typeof item[1] === "number") {
                // GeoJSON is [lng, lat]; store as {lat, lng} to match the
                // rest of this app's convention (see destination.position).
                points.push({ lat: item[1], lng: item[0] });
            }
        }
        return points;
    }

    function getDestination() {
        return window.NapIQNavigation ? window.NapIQNavigation.getDestination() : null;
    }

    function getOrigin() {
        return window.NapIQNavOrigin ? window.NapIQNavOrigin.getOrigin() : null;
    }

    // ---- Dedicated route layer (Phase 6, 30%) ----
    //
    // Translated from GeoMap.tsx: a `navigation-route` pane (dark
    // casing line + bright line on top, zIndex 460) and a
    // `navigation-endpoints` pane (origin/destination circle markers,
    // zIndex 470), plus `RouteController`'s fitBounds-on-route-ready
    // behavior. Both panes sit above Leaflet's default overlayPane
    // (400) but below its default markerPane (600) — the pane that
    // this app's existing NAP/issue/subscriber `L.marker` layers use
    // — so the route line can never visually cover a marker no matter
    // what order layers were added in. The whole thing lives in one
    // `L.layerGroup` that is fully torn down and rebuilt on every
    // route change, so re-routing replaces the line instead of
    // stacking a new one on top, and clearing navigation removes it
    // completely.

    var ROUTE_PANE_NAME = "napiqRoutePane";
    var ROUTE_ENDPOINTS_PANE_NAME = "napiqRouteEndpointsPane";
    var panesReady = false;

    function ensureRoutePanes() {
        if (panesReady || !window.NapIQMap) return;
        if (!window.NapIQMap.getPane(ROUTE_PANE_NAME)) {
            window.NapIQMap.createPane(ROUTE_PANE_NAME).style.zIndex = 460;
        }
        if (!window.NapIQMap.getPane(ROUTE_ENDPOINTS_PANE_NAME)) {
            window.NapIQMap.createPane(ROUTE_ENDPOINTS_PANE_NAME).style.zIndex = 470;
        }
        panesReady = true;
    }

    function drawPolyline(points) {
        clearPolyline();
        if (!window.NapIQMap || !window.L || points.length < 2) return; // integration point not available this build
        ensureRoutePanes();

        var latlngs = points.map(function (p) {
            return [p.lat, p.lng];
        });

        routeLayer = window.L.layerGroup();

        // Dark casing under a bright line (same two-layer treatment as
        // the prototype's route Polylines) so the route reads clearly
        // over tiles, NAP/issue markers, and any other overlay.
        window.L.polyline(latlngs, {
            pane: ROUTE_PANE_NAME,
            color: "#0b2540",
            weight: 9,
            opacity: 0.55,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
            className: "napiq-route-polyline-casing",
        }).addTo(routeLayer);

        window.L.polyline(latlngs, {
            pane: ROUTE_PANE_NAME,
            color: "#0d6efd", // Bootstrap primary, matching the rest of the NAP-IQ UI
            weight: 4.5,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
            className: "napiq-route-polyline",
        }).addTo(routeLayer);

        // Endpoint markers — origin (sky-blue ring) and destination
        // (solid blue), positioned on the route's own snapped-to-road
        // start/end points, same convention as the prototype's
        // routePositions[0] / destination CircleMarkers.
        window.L.circleMarker(latlngs[0], {
            pane: ROUTE_ENDPOINTS_PANE_NAME,
            radius: 7,
            color: "#e0f2fe",
            fillColor: "#0ea5e9",
            fillOpacity: 1,
            weight: 2.5,
            interactive: false,
        }).addTo(routeLayer);

        window.L.circleMarker(latlngs[latlngs.length - 1], {
            pane: ROUTE_ENDPOINTS_PANE_NAME,
            radius: 8,
            color: "#f8fafc",
            fillColor: "#1d4ed8",
            fillOpacity: 1,
            weight: 3,
            interactive: false,
        }).addTo(routeLayer);

        routeLayer.addTo(window.NapIQMap);
        fitRouteBounds(latlngs);
    }

    function fitRouteBounds(latlngs) {
        if (!window.NapIQMap || !window.L || latlngs.length < 2) return;
        try {
            window.NapIQMap.fitBounds(window.L.latLngBounds(latlngs), {
                padding: [72, 72],
                maxZoom: 16,
                animate: true,
                duration: 0.8,
            });
        } catch (e) {
            // Defensive only: never let a bounds/animation edge case
            // (e.g. a map not fully initialized yet) break routing.
        }
    }

    function clearPolyline() {
        if (routeLayer && window.NapIQMap) {
            window.NapIQMap.removeLayer(routeLayer);
        }
        routeLayer = null;
    }

    // ---- Core routing request ----

    function requestRoute(origin, destination) {
        var seq = ++requestSeq;
        state = { status: "loading", errorKind: null, errorMessage: null, route: null };
        render();

        var url =
            OSRM_BASE_URL +
            origin.position.lng + "," + origin.position.lat + ";" +
            destination.position.lng + "," + destination.position.lat +
            "?overview=full&geometries=geojson";

        fetch(url)
            .then(function (response) {
                if (!response.ok) {
                    throw { kind: "network", message: "Road route service is unavailable (HTTP " + response.status + "). Check your connection and retry." };
                }
                return response.json();
            })
            .then(function (payload) {
                if (seq !== requestSeq) return; // a newer request superseded this one
                var candidate = payload && payload.routes && payload.routes[0];
                var points = parsePoints(candidate && candidate.geometry && candidate.geometry.coordinates);
                var hasValidRoute =
                    payload && payload.code === "Ok" && candidate && points.length >= 2 &&
                    typeof candidate.distance === "number" && typeof candidate.duration === "number";

                if (!hasValidRoute) {
                    throw { kind: "no_route", message: "No drivable road route was returned for this destination." };
                }

                state = {
                    status: "ready",
                    errorKind: null,
                    errorMessage: null,
                    route: {
                        points: points,
                        distanceMeters: candidate.distance,
                        durationSeconds: candidate.duration,
                    },
                };
                drawPolyline(points);
                render();
            })
            .catch(function (err) {
                if (seq !== requestSeq) return; // stale request, ignore
                var kind = (err && err.kind) || "network";
                var message =
                    (err && err.message) ||
                    "Road route could not load. Check your connection and retry.";
                state = { status: "error", errorKind: kind, errorMessage: message, route: null };
                clearPolyline();
                render();
            });
    }

    function retry() {
        var destination = getDestination();
        var origin = getOrigin();
        if (destination && origin) requestRoute(origin, destination);
    }

    /**
     * Called whenever the destination or origin changes. Mirrors the
     * prototype's behavior (setManualOrigin / startNavigation both
     * call loadRoute immediately once both an origin and a
     * destination exist).
     */
    function maybeAutoRequest() {
        var destination = getDestination();
        var origin = getOrigin();

        if (!destination) {
            requestSeq += 1; // invalidate any in-flight request
            state = { status: "idle", errorKind: null, errorMessage: null, route: null };
            clearPolyline();
            render();
            return;
        }
        if (!origin) {
            requestSeq += 1;
            state = { status: "idle", errorKind: null, errorMessage: null, route: null };
            clearPolyline();
            render();
            return;
        }
        requestRoute(origin, destination);
    }

    // ---- Rendering into nav-card.js's documented hook points ----

    /**
     * Phase 7 (35%) — Route Details Panel building blocks, translated
     * from RouteDetails.tsx. All of these are pure string-builders
     * with no side effects, so they're safe to call from every state
     * branch below.
     */

    var STATUS_BADGE_META = {
        idle: { label: "Idle", cls: "text-bg-secondary" },
        loading: { label: "Loading", cls: "text-bg-primary" },
        ready: { label: "Ready", cls: "text-bg-success" },
        error: { label: "Error", cls: "text-bg-danger" },
    };

    function routeStatusBadgeHtml() {
        var meta = STATUS_BADGE_META[state.status] || STATUS_BADGE_META.idle;
        var label = meta.label;
        if (state.status === "error") {
            label = state.errorKind === "no_route" ? "No route found" : "Request failed";
        }
        return '<span class="badge ' + meta.cls + '" id="navCardRouteStatusBadge">' + escapeHtml(label) + "</span>";
    }

    function originRowHtml(origin) {
        return (
            '<div class="small text-truncate">' +
            '<i class="bi bi-record-circle me-1 text-primary"></i>' +
            '<span class="text-muted">Origin:</span> ' +
            (origin
                ? '<span class="font-monospace">' + escapeHtml(formatCoords(origin.position)) + "</span>"
                : '<span class="fst-italic text-muted">not set</span>') +
            "</div>"
        );
    }

    function destinationRowHtml(destination) {
        var label = destination.label ? escapeHtml(destination.label) + " &mdash; " : "";
        return (
            '<div class="small text-truncate">' +
            '<i class="bi bi-geo-alt-fill me-1 text-primary"></i>' +
            '<span class="text-muted">Destination:</span> ' +
            label +
            '<span class="font-monospace">' + escapeHtml(formatCoords(destination.position)) + "</span>" +
            "</div>"
        );
    }

    function routeEndpointsHtml(destination, origin) {
        return (
            '<div class="nav-route-endpoints mb-2 d-flex flex-column gap-1">' +
            originRowHtml(origin) +
            destinationRowHtml(destination) +
            "</div>"
        );
    }

    function routeDetailsHeaderHtml(destination, origin) {
        return (
            '<div class="d-flex align-items-center justify-content-between mb-2">' +
            '<span class="small text-muted">Route status</span>' +
            routeStatusBadgeHtml() +
            "</div>" +
            routeEndpointsHtml(destination, origin)
        );
    }

    /**
     * Phase 7 (35%) — route-completion percentage placeholder. Always
     * a static 0%: this phase explicitly does not implement live GPS
     * progress (no demo-travel simulation, no device tracking), so
     * showing anything other than a plainly-labeled 0% placeholder
     * would be fabricating progress the app has no way to know.
     */
    /**
     * Phase 9 (45%) update: this is no longer a hard-coded 0%. When
     * window.NapIQNavDemoTravel (nav-demo-travel.js) reports an
     * active run (running/paused/complete), the percentage, progress
     * bar, and caption reflect its real progress along the actual
     * OSRM route geometry. With no demo run started yet (idle, or
     * nav-demo-travel.js not loaded), it stays the honest Phase 7
     * placeholder — still no live GPS progress exists, so nothing is
     * fabricated either way.
     */
    /**
     * Phase 12 (60%, TASK 4 OF N) — picks which progress source, if
     * any, the Route Details Panel should reflect right now. A real,
     * live GPS fix outranks a simulated demo-travel run — the same
     * precedence Task 3 (nav-gps-technician-marker.js) already
     * established for the technician marker, kept consistent here so
     * the panel and the marker never disagree about which source is
     * "driving" at a given moment. Returns null when neither source
     * is active (the Phase 7 static placeholder case).
     *
     * Shape returned (a small normalized subset of either source's
     * own state, not a new source of truth): { kind: "gps"|"demo",
     * status, progressPercent, remainingDistanceMeters,
     * remainingDurationSeconds }.
     */
    function getActiveProgressSource() {
        var gps = window.NapIQNavGpsRouteProgress ? window.NapIQNavGpsRouteProgress.getState() : null;
        if (gps && gps.active) {
            return {
                kind: "gps",
                status: gps.progressPercent >= 100 ? "complete" : "running",
                progressPercent: gps.progressPercent,
                remainingDistanceMeters: gps.remainingDistanceMeters,
                remainingDurationSeconds: gps.remainingDurationSeconds,
            };
        }
        var demo = window.NapIQNavDemoTravel ? window.NapIQNavDemoTravel.getState() : null;
        if (demo && demo.status !== "idle") {
            return {
                kind: "demo",
                status: demo.status,
                progressPercent: demo.progressPercent,
                remainingDistanceMeters: demo.remainingDistanceMeters,
                remainingDurationSeconds: demo.remainingDurationSeconds,
            };
        }
        return null;
    }

    function completionPlaceholderHtml() {
        var source = getActiveProgressSource();
        var active = !!source;
        var percent = active ? source.progressPercent : 0;
        var caption;
        var captionItalic = true;

        if (!active) {
            var demoLoaded = !!window.NapIQNavDemoTravel;
            caption = demoLoaded
                ? "Placeholder only \u2014 start demo travel below, or enable device GPS, to preview progress along this route."
                : "Placeholder only \u2014 live GPS progress tracking isn\u2019t implemented yet.";
        } else if (source.status === "complete") {
            caption = source.kind === "gps"
                ? "Live GPS progress complete \u2014 destination reached."
                : "Demo travel complete \u2014 destination reached.";
            captionItalic = false;
        } else {
            var distanceLabel = typeof source.remainingDistanceMeters === "number" ? formatDistance(source.remainingDistanceMeters) : "\u2014";
            var etaLabel = typeof source.remainingDurationSeconds === "number" ? formatDuration(source.remainingDurationSeconds) : "\u2014";
            var prefix;
            if (source.kind === "gps") {
                prefix = "Live GPS progress \u2014 ";
            } else {
                prefix = source.status === "paused" ? "Demo travel paused \u2014 " : "Demo travel in progress \u2014 ";
            }
            caption = prefix + distanceLabel + " remaining, about " + etaLabel + " left.";
            captionItalic = false;
        }

        return (
            '<div class="mt-2" id="navCardRouteCompletion">' +
            '<div class="d-flex justify-content-between small text-muted mb-1">' +
            "<span>Route completion</span><span>" + percent + "%</span>" +
            "</div>" +
            '<div class="progress" style="height: 6px;" role="progressbar" ' +
            'aria-valuenow="' + percent + '" aria-valuemin="0" aria-valuemax="100" ' +
            'aria-label="Route completion' + (active ? "" : " placeholder \u2014 live GPS progress tracking is not yet implemented") + '">' +
            '<div class="progress-bar' + (active && source.status === "complete" ? " bg-success" : "") + '" style="width: ' + percent + '%"></div>' +
            "</div>" +
            '<div class="text-muted small mt-1' + (captionItalic ? " fst-italic" : "") + '">' + escapeHtml(caption) + "</div>" +
            "</div>"
        );
    }

    function readyMetricsHtml(route) {
        // Phase 9 (45%) / Phase 12 Task 4 (60%) update: "Remaining"
        // reflects whichever progress source is currently active --
        // live GPS (window.NapIQNavGpsRouteProgress) if present,
        // otherwise a real, in-progress demo travel run
        // (window.NapIQNavDemoTravel), otherwise it stays honestly
        // equal to the totals \u2014 0% traveled, so 100% remains \u2014
        // exactly as Phase 7 shipped it, never a guess.
        var source = getActiveProgressSource();
        var remainingDurationSeconds = source && typeof source.remainingDurationSeconds === "number" ? source.remainingDurationSeconds : route.durationSeconds;

        return (
            '<div class="row g-2 text-center">' +
            '<div class="col-6"><div class="small text-muted">Route distance</div>' +
            '<div class="fw-semibold">' + escapeHtml(formatDistance(route.distanceMeters)) + "</div></div>" +
            '<div class="col-6"><div class="small text-muted">Estimated duration</div>' +
            '<div class="fw-semibold">' + escapeHtml(formatDuration(route.durationSeconds)) + "</div></div>" +
            '<div class="col-6"><div class="small text-muted">Arrival ETA</div>' +
            '<div class="fw-semibold">' + escapeHtml(formatEta(route.durationSeconds)) + "</div></div>" +
            '<div class="col-6"><div class="small text-muted">Remaining</div>' +
            '<div class="fw-semibold">' + escapeHtml(formatDuration(remainingDurationSeconds)) + "</div></div>" +
            "</div>"
        );
    }

    function routeStatusInnerHtml(destination, origin) {
        var header = routeDetailsHeaderHtml(destination, origin);

        if (state.status === "loading") {
            return (
                header +
                '<div class="d-flex align-items-center gap-2 text-primary small">' +
                '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>' +
                "<span>Requesting a driving route from OSRM&hellip;</span></div>"
            );
        }
        if (state.status === "ready" && state.route) {
            var mapNote = window.NapIQMap
                ? "Real road route via OSRM, drawn on the map."
                : "Real road route via OSRM (map line unavailable in this build &mdash; see Phase 6 notes).";
            return (
                header +
                readyMetricsHtml(state.route) +
                completionPlaceholderHtml() +
                '<div class="text-muted small mt-2"><i class="bi bi-signpost-split me-1"></i>' + mapNote + "</div>"
            );
        }
        if (state.status === "error") {
            var icon = state.errorKind === "no_route" ? "bi-signpost-2" : "bi-wifi-off";
            var label = state.errorKind === "no_route" ? "No road route found" : "Route request failed";
            return (
                header +
                '<div class="text-danger small">' +
                '<div class="d-flex align-items-start gap-2">' +
                '<i class="bi ' + icon + ' mt-1 flex-shrink-0"></i>' +
                "<span><strong>" + escapeHtml(label) + ":</strong> " + escapeHtml(state.errorMessage) + "</span>" +
                "</div>" +
                '<button type="button" class="btn btn-sm btn-outline-danger mt-2" id="navCardRetryBtn">' +
                '<i class="bi bi-arrow-clockwise me-1"></i>Retry route</button>' +
                "</div>"
            );
        }
        // idle
        if (!origin) {
            return (
                header +
                '<div class="text-muted small"><i class="bi bi-signpost-split me-1"></i>' +
                "Set a starting point below to calculate a real driving route." + "</div>"
            );
        }
        return (
            header +
            '<div class="text-muted small"><i class="bi bi-signpost-split me-1"></i>' +
            "Route information will appear here." + "</div>"
        );
    }

    function originFormHtml(origin) {
        var hasOrigin = !!origin;
        return (
            '<div class="nav-card-origin-form">' +
            '<label class="form-label small text-muted mb-1">Starting point (latitude, longitude)</label>' +
            '<div class="input-group input-group-sm mb-1">' +
            '<input type="number" step="any" class="form-control" id="navCardOriginLat" placeholder="Latitude" value="' +
            (hasOrigin ? escapeHtml(origin.position.lat) : "") + '">' +
            '<input type="number" step="any" class="form-control" id="navCardOriginLng" placeholder="Longitude" value="' +
            (hasOrigin ? escapeHtml(origin.position.lng) : "") + '">' +
            "</div>" +
            '<div class="d-flex gap-2">' +
            '<button type="button" class="btn btn-sm btn-primary flex-grow-1" id="navCardSetOriginBtn">' +
            '<i class="bi bi-geo-alt me-1"></i>' + (hasOrigin ? "Update origin" : "Set origin") + "</button>" +
            (hasOrigin
                ? '<button type="button" class="btn btn-sm btn-outline-secondary" id="navCardClearOriginBtn" title="Clear origin"><i class="bi bi-x-lg"></i></button>'
                : "") +
            "</div>" +
            (hasOrigin
                ? '<div class="text-muted small mt-1 font-monospace">' + origin.position.lat.toFixed(6) + ", " + origin.position.lng.toFixed(6) + "</div>"
                : "") +
            '<div class="small text-danger mt-1" id="navCardOriginError"></div>' +
            "</div>"
        );
    }

    function render() {
        if (!window.NapIQNavCard) return;
        var els = window.NapIQNavCard.elements();
        if (!els || !els.root) return;

        var destination = getDestination();
        var origin = getOrigin();

        // Collapsed pill has neither container — nothing to do until
        // the card is expanded again (napiq:navcard-rendered fires
        // again at that point and we re-apply).
        if (!els.routeStatus || !els.controls) return;

        if (destination) {
            els.routeStatus.innerHTML = routeStatusInnerHtml(destination, origin);
        }
        // else: leave nav-card.js's own idle placeholder ("No
        // navigation destination selected...") exactly as it is.

        els.controls.innerHTML = originFormHtml(origin);
        attachControlHandlers();

        // Phase 9 (45%): tell nav-demo-travel.js this container was
        // just rebuilt (e.g. after an async OSRM response arrives and
        // the route becomes ready) so it can (re-)append its Start/
        // Pause/Resume/Reset/Replay controls. render() above already
        // fully replaced #navCardControls's innerHTML with just the
        // origin form, so without this, nav-demo-travel.js would have
        // no way to know it needs to re-attach after a route-status
        // change that didn't come from a full nav-card.js rebuild.
        window.dispatchEvent(new CustomEvent("napiq:route-status-changed", { detail: state }));
    }

    function attachControlHandlers() {
        var setBtn = document.getElementById("navCardSetOriginBtn");
        if (setBtn) {
            setBtn.addEventListener("click", function () {
                var latInput = document.getElementById("navCardOriginLat");
                var lngInput = document.getElementById("navCardOriginLng");
                var errorEl = document.getElementById("navCardOriginError");
                var ok = window.NapIQNavOrigin.setOrigin(latInput.value, lngInput.value);
                if (!ok && errorEl) {
                    errorEl.textContent = "Enter a valid latitude (-90 to 90) and longitude (-180 to 180).";
                } else if (errorEl) {
                    errorEl.textContent = "";
                }
            });
        }
        var clearBtn = document.getElementById("navCardClearOriginBtn");
        if (clearBtn) {
            clearBtn.addEventListener("click", function () {
                window.NapIQNavOrigin.clearOrigin();
            });
        }
        var retryBtn = document.getElementById("navCardRetryBtn");
        if (retryBtn) {
            retryBtn.addEventListener("click", retry);
        }
    }

    window.addEventListener("napiq:destination-changed", maybeAutoRequest);
    window.addEventListener("napiq:origin-changed", maybeAutoRequest);
    // Re-apply our content whenever nav-card.js rebuilds the card DOM
    // (destination change, collapse/expand) without re-requesting a route.
    window.addEventListener("napiq:navcard-rendered", render);
    // Phase 9 (45%): re-render the Route Details Panel (completion %,
    // "Remaining" metric) whenever nav-demo-travel.js's state changes,
    // without re-requesting a route. This does not touch routing
    // logic, only what the panel displays.
    window.addEventListener("napiq:demo-travel-changed", render);
    // Phase 12 (60%, TASK 4 OF N): re-render the Route Details Panel
    // when a live GPS fix updates progress (nav-gps-route-progress.js,
    // Task 2), the same way demo-travel-changed already triggers a
    // re-render above. Does not touch routing/OSRM logic at all.
    window.addEventListener("napiq:gps-route-progress-changed", render);
    document.addEventListener("DOMContentLoaded", maybeAutoRequest);

    window.NapIQNavRouting = {
        getState: function () {
            return state;
        },
        retry: retry,
        refresh: render,
    };
})();
