// Real-time connection-quality monitor.
//
// Used by auth-transition.js to size (and, while the overlay is
// showing, live-adjust) the sign-in/sign-out loading animation to the
// user's actual internet speed, instead of a single fixed duration.
//
// Two data sources, in priority order:
//
//   1. The Network Information API (navigator.connection). Where it
//      exists (Chromium/Android browsers) it's free and already
//      real-time -- it fires a `change` event whenever the OS reports
//      a different downlink/effectiveType, so no polling needed.
//
//   2. An active probe, for browsers without that API (Safari,
//      Firefox). Re-fetches a tiny already-loaded image with a
//      cache-busting query string and `cache: "no-store"`, times how
//      long the download actually takes, and derives an approximate
//      Mbps from that. Re-run periodically so the reading stays
//      current for long-lived pages.
//
// Either source lands in the same `state` shape and fires the same
// `napiq:network-quality-change` event / subscriber callback, so
// callers don't need to know which one is active.
(function () {
    "use strict";

    // Mirrors NETWORK_QUALITY_DURATION_MS in the mobile app's
    // networkQuality.ts -- same tiers, same reasoning: a fast
    // connection gets a quick transition, a slow/offline one gets
    // more showtime so the progress bar doesn't finish and then sit
    // there waiting on a still-pending request.
    var QUALITY_DURATION_MS = {
        fast: 1800,
        moderate: 2800,
        slow: 4200,
        offline: 4200,
    };

    var PROBE_INTERVAL_MS = 15000;
    var PROBE_TIMEOUT_MS = 1500;

    var state = {
        quality: "moderate", // fast | moderate | slow | offline
        downlinkMbps: null,
        effectiveType: null,
        rtt: null,
        source: "default", // "network-information-api" | "active-probe" | "offline-event" | "default"
        updatedAt: Date.now(),
    };

    var listeners = [];

    function notify() {
        state.updatedAt = Date.now();
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](state);
            } catch (err) {
                /* a bad listener shouldn't break the monitor */
            }
        }
        if (typeof window.CustomEvent === "function") {
            window.dispatchEvent(new CustomEvent("napiq:network-quality-change", { detail: state }));
        }
    }

    function classifyFromConnection(conn) {
        if (typeof conn.downlink === "number") {
            if (conn.downlink >= 5) return "fast";
            if (conn.downlink >= 1.5) return "moderate";
            return "slow";
        }
        switch (conn.effectiveType) {
            case "4g":
                return "fast";
            case "3g":
                return "moderate";
            case "2g":
            case "slow-2g":
                return "slow";
            default:
                return "moderate";
        }
    }

    function classifyFromMbps(mbps) {
        if (mbps >= 5) return "fast";
        if (mbps >= 1.5) return "moderate";
        return "slow";
    }

    // --- Source 1: Network Information API -----------------------------

    function tryNetworkInformationAPI() {
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) return false;

        function update() {
            if (navigator.onLine === false) {
                state.quality = "offline";
                state.source = "offline-event";
            } else {
                state.downlinkMbps = typeof conn.downlink === "number" ? conn.downlink : null;
                state.effectiveType = conn.effectiveType || null;
                state.rtt = typeof conn.rtt === "number" ? conn.rtt : null;
                state.quality = classifyFromConnection(conn);
                state.source = "network-information-api";
            }
            notify();
        }

        conn.addEventListener("change", update);
        update();
        return true;
    }

    // --- Source 2: active probe (fallback) ------------------------------

    function probeUrl() {
        if (window.NAPIQ_NETWORK_PROBE_URL) return window.NAPIQ_NETWORK_PROBE_URL;
        if (window.NAPIQ_LOADER_ICON_URL) return window.NAPIQ_LOADER_ICON_URL;
        var img = document.querySelector('img[src*="pg-networks-logo"]');
        if (img) return img.getAttribute("src");
        return "/static/img/pg-networks-logo-mono.png";
    }

    /** One-off measurement. Resolves `null` (meaning "inconclusive,
     * keep whatever we already had") if the probe times out, so a
     * slow probe attempt never itself gets mistaken for a fast one. */
    function measureNow(timeoutMs) {
        timeoutMs = timeoutMs || PROBE_TIMEOUT_MS;

        if (navigator.onLine === false) {
            return Promise.resolve({ quality: "offline", source: "offline-event" });
        }

        var base = probeUrl();
        var sep = base.indexOf("?") === -1 ? "?" : "&";
        var url = base + sep + "napiq_probe=" + Date.now();
        var start = window.performance && performance.now ? performance.now() : Date.now();

        return new Promise(function (resolve) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                resolve(null);
            }, timeoutMs);

            fetch(url, { cache: "no-store" })
                .then(function (res) {
                    return res.blob();
                })
                .then(function (blob) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    var end = window.performance && performance.now ? performance.now() : Date.now();
                    var seconds = Math.max((end - start) / 1000, 0.001);
                    var bytes = blob.size || 2000;
                    var mbps = (bytes * 8) / seconds / 1e6;
                    resolve({
                        quality: classifyFromMbps(mbps),
                        downlinkMbps: Math.round(mbps * 100) / 100,
                        source: "active-probe",
                    });
                })
                .catch(function () {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({ quality: "offline", source: "active-probe" });
                });
        });
    }

    function applyMeasurement(result) {
        if (!result) return; // inconclusive -- leave state as-is
        state.quality = result.quality;
        if (typeof result.downlinkMbps === "number") state.downlinkMbps = result.downlinkMbps;
        state.source = result.source;
        notify();
    }

    function startActiveProbing() {
        measureNow().then(applyMeasurement);
        setInterval(function () {
            measureNow().then(applyMeasurement);
        }, PROBE_INTERVAL_MS);
    }

    // --- Wire up ---------------------------------------------------------

    var usingNetworkInformationAPI = tryNetworkInformationAPI();
    if (!usingNetworkInformationAPI) {
        startActiveProbing();
    }

    window.addEventListener("offline", function () {
        state.quality = "offline";
        state.source = "offline-event";
        notify();
    });
    window.addEventListener("online", function () {
        if (usingNetworkInformationAPI) return; // its own `change` handler covers this
        measureNow().then(applyMeasurement);
    });

    window.NAPIQNetworkSpeed = {
        QUALITY_DURATION_MS: QUALITY_DURATION_MS,
        getState: function () {
            return {
                quality: state.quality,
                downlinkMbps: state.downlinkMbps,
                effectiveType: state.effectiveType,
                rtt: state.rtt,
                source: state.source,
                updatedAt: state.updatedAt,
            };
        },
        getDurationMs: function () {
            return QUALITY_DURATION_MS[state.quality] || QUALITY_DURATION_MS.moderate;
        },
        measureNow: measureNow,
        /** Registers `fn(state)` for every future update and calls it
         * once immediately with the current state. Returns an
         * unsubscribe function. */
        subscribe: function (fn) {
            listeners.push(fn);
            fn(this.getState());
            return function unsubscribe() {
                var idx = listeners.indexOf(fn);
                if (idx !== -1) listeners.splice(idx, 1);
            };
        },
    };
})();
