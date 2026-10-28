/*
 * cable-path-geometry.js
 *
 * Shared by the technician's Cable Path recorder
 * (templates/technician/cable_path_map.html) and the admin GeoMap
 * (static/js/napmap.js) so the line looks the same on both sides.
 *
 * Exposes window.CablePathGeometry:
 *
 *   createGpsFilter()      -> { accept(position) -> {lat, lng} | null }
 *       Capture-time cleaning. Phone GPS jumps around by several metres
 *       fix-to-fix; drawing those raw fixes is what produces the
 *       zig-zag/spiky trail. The filter (a) throws away fixes whose
 *       implied walking speed is impossible, and (b) runs an
 *       accuracy-weighted Kalman filter so a noisy fix only nudges the
 *       position a little while a precise one is trusted. What gets
 *       saved is the filtered position, so the stored data itself is
 *       cleaner, not just the drawing.
 *
 *   simplify(latlngs, tolMeters)   Ramer-Douglas-Peucker (drops jitter)
 *   smooth(latlngs, iterations)    Chaikin corner cutting (rounds the
 *                                  remaining corners into natural curves;
 *                                  first and last point are never moved)
 *   toDisplayPath(latlngs, opts)   simplify -> smooth in one call
 *
 * All inputs/outputs are arrays of [lat, lng] pairs (Leaflet style).
 */
(function (global) {
    "use strict";

    var M_PER_DEG_LAT = 111320;

    function metersBetween(aLat, aLng, bLat, bLng) {
        var mPerDegLng = M_PER_DEG_LAT * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
        var dx = (bLng - aLng) * mPerDegLng;
        var dy = (bLat - aLat) * M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ------------------------------------------------------------------
    // Capture-time GPS filter
    // ------------------------------------------------------------------
    function createGpsFilter(options) {
        var opts = options || {};
        // Walking pace of a technician paying out cable. Used both as the
        // Kalman process noise and as the "impossible jump" ceiling.
        var PROCESS_SPEED_MS = opts.processSpeedMs || 1.5;
        var MAX_SPEED_MS = opts.maxSpeedMs || 5;
        var MIN_ACCURACY_M = 1;          // never trust a fix more than 1 m
        var MAX_CONSECUTIVE_REJECTS = 4; // then re-seed instead of freezing

        var lat = null, lng = null;   // filtered estimate
        var variance = -1;            // metres^2; <0 = not initialised
        var lastTs = null;
        var rejects = 0;

        function accept(position) {
            var c = position.coords;
            var acc = typeof c.accuracy === "number" && c.accuracy > 0 ? c.accuracy : 10;
            acc = Math.max(acc, MIN_ACCURACY_M);
            var ts = typeof position.timestamp === "number" ? position.timestamp : Date.now();

            if (variance < 0) {
                lat = c.latitude;
                lng = c.longitude;
                variance = acc * acc;
                lastTs = ts;
                return { lat: lat, lng: lng };
            }

            var dtSec = Math.max((ts - lastTs) / 1000, 0.001);

            // Outlier gate: a jump faster than anyone can walk is a bad
            // fix (multipath near walls/trees), not movement. Allow the
            // fix's own error as slack. If several arrive in a row the
            // filter has probably genuinely lost track, so re-seed.
            var jump = metersBetween(lat, lng, c.latitude, c.longitude);
            if (jump - acc > MAX_SPEED_MS * dtSec + 2) {
                rejects += 1;
                if (rejects <= MAX_CONSECUTIVE_REJECTS) return null;
                variance = acc * acc;
                lat = c.latitude;
                lng = c.longitude;
                lastTs = ts;
                rejects = 0;
                return { lat: lat, lng: lng };
            }
            rejects = 0;

            // Predict: uncertainty grows with time since the last fix.
            variance += dtSec * PROCESS_SPEED_MS * PROCESS_SPEED_MS;

            // Update: blend by relative confidence.
            var gain = variance / (variance + acc * acc);
            lat += gain * (c.latitude - lat);
            lng += gain * (c.longitude - lng);
            variance = (1 - gain) * variance;
            lastTs = ts;
            return { lat: lat, lng: lng };
        }

        return { accept: accept };
    }

    // ------------------------------------------------------------------
    // Display-time geometry
    // ------------------------------------------------------------------
    function simplify(points, toleranceMeters) {
        if (!Array.isArray(points) || points.length < 3) {
            return Array.isArray(points) ? points.slice() : points;
        }

        function perpDist(p, a, b) {
            var mLng = M_PER_DEG_LAT * Math.cos(a[0] * Math.PI / 180);
            var x1 = 0, y1 = 0;
            var x2 = (b[1] - a[1]) * mLng, y2 = (b[0] - a[0]) * M_PER_DEG_LAT;
            var x0 = (p[1] - a[1]) * mLng, y0 = (p[0] - a[0]) * M_PER_DEG_LAT;
            var dx = x2 - x1, dy = y2 - y1;
            var lenSq = dx * dx + dy * dy;
            if (lenSq === 0) return Math.hypot(x0, y0);
            var t = Math.max(0, Math.min(1, (x0 * dx + y0 * dy) / lenSq));
            return Math.hypot(x0 - t * dx, y0 - t * dy);
        }

        function rdp(pts) {
            if (pts.length < 3) return pts;
            var maxD = 0, idx = 0;
            var first = pts[0], last = pts[pts.length - 1];
            for (var i = 1; i < pts.length - 1; i++) {
                var d = perpDist(pts[i], first, last);
                if (d > maxD) { maxD = d; idx = i; }
            }
            if (maxD > toleranceMeters) {
                var left = rdp(pts.slice(0, idx + 1));
                var right = rdp(pts.slice(idx));
                return left.slice(0, -1).concat(right);
            }
            return [first, last];
        }

        return rdp(points);
    }

    // Chaikin corner cutting: each segment A->B is replaced by points at
    // 25% and 75%. Repeating rounds every corner while keeping the curve
    // inside the original polygon, so it can never wander away from where
    // the technician actually walked. First/last points are preserved so
    // the snapped NAP / subscriber ends stay exact.
    function smooth(points, iterations) {
        if (!Array.isArray(points) || points.length < 3) {
            return Array.isArray(points) ? points.slice() : points;
        }
        var out = points;
        var n = iterations == null ? 2 : iterations;
        for (var it = 0; it < n; it++) {
            if (out.length > 1500) break; // safety cap for very long trails
            var next = [out[0]];
            for (var i = 0; i < out.length - 1; i++) {
                var a = out[i], b = out[i + 1];
                next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
                next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
            }
            next.push(out[out.length - 1]);
            out = next;
        }
        return out;
    }

    function toDisplayPath(points, opts) {
        var o = opts || {};
        var tol = o.toleranceMeters == null ? 1.25 : o.toleranceMeters;
        var iters = o.iterations == null ? 3 : o.iterations;
        return smooth(simplify(points, tol), iters);
    }

    global.CablePathGeometry = {
        createGpsFilter: createGpsFilter,
        simplify: simplify,
        smooth: smooth,
        toDisplayPath: toDisplayPath,
        metersBetween: metersBetween,
    };
})(window);
