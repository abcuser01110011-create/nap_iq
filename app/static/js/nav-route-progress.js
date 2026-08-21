/**
 * Route progress engine — Phase 12 (60%), TASK 1 ONLY
 * -----------------------------------------------------------------
 * Per the phase 12 spec ("Live GPS route progress"), this phase
 * needs to: take a real GPS fix, find where it sits along the
 * active OSRM route (not straight-line distance), and derive
 * percentage / remaining distance / remaining ETA from that,
 * without letting GPS noise make progress jump backward and
 * forward.
 *
 * This file is task 1 of that phase only: the nearest-point-on-
 * route projection + progress math itself, as a small,
 * dependency-free, pure-calculation module that can be unit-tested
 * and reasoned about in isolation. It intentionally does NOT yet:
 *   - listen for GPS fixes (nav-gps-origin.js's watchPosition
 *     handler is untouched by this task);
 *   - update window.NapIQNavTechnicianMarker or any map layer;
 *   - update nav-routing.js's Route Details Panel;
 *   - apply any noise/monotonicity guarding against progress
 *     jumping backward on a noisy fix (that is explicitly a
 *     separate, later Phase 12 task -- this module's job is only to
 *     compute an honest instantaneous projection; deciding whether
 *     to *trust* a given noisy projection enough to update visible
 *     state is deferred).
 * Those are separate Phase 12 tasks, done in later sessions per the
 * project's own "one task, then stop" workflow.
 *
 * Input contract (matches nav-routing.js's existing route shape --
 * see nav-routing.js's `state.route`, unchanged by this file):
 *   route = { points: [{lat, lng}, ...], distanceMeters, durationSeconds }
 *
 * Output contract of computeProgress(route, gpsPoint):
 *   {
 *     progressRatio,            // 0..1, clamped
 *     progressPercent,          // Math.round(progressRatio * 100)
 *     distanceAlongRouteMeters, // meters from route start to the projection
 *     remainingDistanceMeters,  // route.distanceMeters - distanceAlongRouteMeters
 *     remainingDurationSeconds,// route.durationSeconds * (1 - progressRatio)
 *                                //  -- a proportional estimate from the
 *                                //  OSRM total, same honesty standard
 *                                //  nav-routing.js's own "remaining"
 *                                //  values already use elsewhere; never
 *                                //  fabricated from a made-up speed.
 *     nearestPoint,             // {lat, lng} the projected point ON the route
 *     offRouteDistanceMeters,   // perpendicular distance from gpsPoint to
 *                                //  nearestPoint -- how far off the road
 *                                //  geometry this fix is, for later tasks
 *                                //  (e.g. deciding whether a fix is usable)
 *     segmentIndex               // index i such that the projection falls
 *                                //  on the segment points[i-1]->points[i]
 *   }
 *   Returns null if the route has fewer than 2 points (nothing to
 *   project onto).
 *
 * Algorithm: for every road segment in the route polyline, project
 * the GPS point onto that segment using a local equirectangular
 * approximation (accurate at the sub-kilometer segment lengths
 * OSRM polylines actually have -- the same scale assumption
 * nav-demo-travel.js's own haversine-based interpolation already
 * relies on), clamp the projection to the segment's endpoints, and
 * keep the segment whose projection is closest to the raw GPS
 * point. This is a linear scan over the route's points, matching
 * nav-demo-travel.js's own documented choice to do the same for
 * typical OSRM polyline sizes (tens to low hundreds of points)
 * rather than adding a spatial-index dependency this project
 * doesn't otherwise need.
 */
(function () {
    var EARTH_RADIUS_M = 6371000;

    function toRad(deg) {
        return (deg * Math.PI) / 180;
    }

    /** Standard haversine great-circle distance in meters. Same
     * formula nav-demo-travel.js and nav-gps-origin.js already use
     * elsewhere in this project -- not reintroducing a different
     * approximation for the same job. */
    function haversineMeters(a, b) {
        var dLat = toRad(b.lat - a.lat);
        var dLng = toRad(b.lng - a.lng);
        var lat1 = toRad(a.lat);
        var lat2 = toRad(b.lat);
        var sinDLat = Math.sin(dLat / 2);
        var sinDLng = Math.sin(dLng / 2);
        var h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /**
     * Converts lat/lng degrees to local flat meters relative to an
     * origin, using an equirectangular approximation. Valid for the
     * short segment lengths (tens to low hundreds of meters) an
     * OSRM road polyline actually has between consecutive points --
     * not intended for, or used across, long distances.
     */
    function toLocalMeters(point, origin) {
        var latRad = toRad(origin.lat);
        var x = toRad(point.lng - origin.lng) * Math.cos(latRad) * EARTH_RADIUS_M;
        var y = toRad(point.lat - origin.lat) * EARTH_RADIUS_M;
        return { x: x, y: y };
    }

    function fromLocalMeters(local, origin) {
        var latRad = toRad(origin.lat);
        var lng = origin.lng + (local.x / (EARTH_RADIUS_M * Math.cos(latRad))) * (180 / Math.PI);
        var lat = origin.lat + (local.y / EARTH_RADIUS_M) * (180 / Math.PI);
        return { lat: lat, lng: lng };
    }

    function buildCumulative(points) {
        var out = [0];
        for (var i = 1; i < points.length; i++) {
            out.push(out[i - 1] + haversineMeters(points[i - 1], points[i]));
        }
        return out;
    }

    /**
     * Projects gpsPoint onto the single segment a->b, clamped to the
     * segment's endpoints. Returns { point, fraction, distanceMeters }
     * where distanceMeters is the perpendicular (or endpoint) distance
     * from gpsPoint to the returned point.
     */
    function projectOntoSegment(gpsPoint, a, b) {
        var origin = a;
        var pA = { x: 0, y: 0 };
        var pB = toLocalMeters(b, origin);
        var pG = toLocalMeters(gpsPoint, origin);

        var segX = pB.x - pA.x;
        var segY = pB.y - pA.y;
        var segLenSq = segX * segX + segY * segY;

        var fraction;
        if (segLenSq === 0) {
            // Degenerate zero-length segment (duplicate consecutive
            // points, which OSRM output can occasionally contain) --
            // treat the whole segment as its start point.
            fraction = 0;
        } else {
            fraction = ((pG.x - pA.x) * segX + (pG.y - pA.y) * segY) / segLenSq;
            fraction = Math.max(0, Math.min(1, fraction));
        }

        var projLocal = { x: pA.x + segX * fraction, y: pA.y + segY * fraction };
        var projPoint = fromLocalMeters(projLocal, origin);
        var distanceMeters = haversineMeters(gpsPoint, projPoint);

        return { point: projPoint, fraction: fraction, distanceMeters: distanceMeters };
    }

    /**
     * Finds the nearest point on the whole route polyline to
     * gpsPoint, and how far along the route (in meters from the
     * route start) that nearest point is.
     *
     * Returns null if route has fewer than 2 points.
     */
    function nearestPointOnRoute(points, cumulative, gpsPoint) {
        if (!points || points.length < 2) return null;

        var best = null;
        for (var i = 1; i < points.length; i++) {
            var result = projectOntoSegment(gpsPoint, points[i - 1], points[i]);
            if (!best || result.distanceMeters < best.distanceMeters) {
                var segStart = cumulative[i - 1];
                var segEnd = cumulative[i];
                var distanceAlongRoute = segStart + (segEnd - segStart) * result.fraction;
                best = {
                    point: result.point,
                    distanceMeters: result.distanceMeters,
                    distanceAlongRouteMeters: distanceAlongRoute,
                    segmentIndex: i,
                };
            }
        }
        return best;
    }

    /**
     * Computes route progress for a single GPS fix against a single
     * route snapshot. Pure function: no reads of any other module's
     * state, no DOM, no globals besides Math. See file header for
     * the full input/output contract.
     */
    function computeProgress(route, gpsPoint) {
        if (!route || !route.points || route.points.length < 2) return null;
        if (!gpsPoint || typeof gpsPoint.lat !== "number" || typeof gpsPoint.lng !== "number") return null;

        var points = route.points;
        var cumulative = buildCumulative(points);
        var totalDistanceMeters = cumulative[cumulative.length - 1];

        var nearest = nearestPointOnRoute(points, cumulative, gpsPoint);
        if (!nearest) return null;

        var progressRatio = totalDistanceMeters > 0 ? nearest.distanceAlongRouteMeters / totalDistanceMeters : 0;
        progressRatio = Math.max(0, Math.min(1, progressRatio));

        var routeDistanceMeters = typeof route.distanceMeters === "number" ? route.distanceMeters : totalDistanceMeters;
        var routeDurationSeconds = typeof route.durationSeconds === "number" ? route.durationSeconds : null;

        var remainingDistanceMeters = Math.max(0, routeDistanceMeters * (1 - progressRatio));
        var remainingDurationSeconds = routeDurationSeconds != null ? Math.max(0, routeDurationSeconds * (1 - progressRatio)) : null;

        return {
            progressRatio: progressRatio,
            progressPercent: Math.round(progressRatio * 100),
            distanceAlongRouteMeters: nearest.distanceAlongRouteMeters,
            remainingDistanceMeters: remainingDistanceMeters,
            remainingDurationSeconds: remainingDurationSeconds,
            nearestPoint: nearest.point,
            offRouteDistanceMeters: nearest.distanceMeters,
            segmentIndex: nearest.segmentIndex,
        };
    }

    window.NapIQNavRouteProgress = {
        computeProgress: computeProgress,
        // Exposed for the later Phase 12 tasks (and for tests) that
        // will need the same primitives without recomputing them:
        haversineMeters: haversineMeters,
        buildCumulative: buildCumulative,
    };
})();
