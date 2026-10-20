// Installation application tracker: clickable steps with a details panel
// (live map on "Arriving", like the reported-issue tracker), refreshed
// every 15s; the page reloads itself when the stage changes.
(function () {
    "use strict";
    var box = document.getElementById("appProgress");
    if (!box) return;

    var REFRESH_MS = 15000;
    var ROUTE_REFRESH_MS = 5 * 60 * 1000;
    var OSRM = "https://router.project-osrm.org/route/v1/driving/";
    var ARRIVING = 2;   // step index that shows the live map

    var url = box.getAttribute("data-url");
    var details = document.querySelector(".app-prog-details .ip-details-body");
    var state = window.APP_PROGRESS_INITIAL || null;
    var selected = null;           // { step, stage }
    var route = null, routeAt = 0, routeKey = "";
    var map = null, mapEl = null;

    function esc(text) {
        var d = document.createElement("div");
        d.textContent = text == null ? "" : String(text);
        return d.innerHTML;
    }
    function row(label, value) {
        return '<div class="ip-d-row"><span class="ip-d-label">' + label + '</span><span class="ip-d-value">' + value + "</span></div>";
    }
    function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m"; }
    function fmtTime(d) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    function haversine(a, b, c, d) {
        var R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLng = (d - b) * r;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function defaultStep(s) {
        if (s.done >= 4) return 3;
        return s.current >= 0 ? s.current : 0;
    }
    function currentStep(s) {
        if (selected && selected.stage === s.stage) return selected.step;
        selected = null;
        return defaultStep(s);
    }

    /* ---------- map ---------- */
    function destroyMap() { if (map) { map.remove(); map = null; mapEl = null; } }
    function dot(color, label) {
        return L.divIcon({
            className: "ip-pin",
            html: '<span class="ip-pin__dot" style="background:' + color + '"></span><span class="ip-pin__tag">' + label + "</span>",
            iconSize: [0, 0]
        });
    }
    function drawMap(s, el) {
        if (typeof L === "undefined" || s.dest_lat == null || s.dest_lng == null) return false;
        if (map && mapEl !== el) destroyMap();
        var fresh = !map;
        if (!map) {
            map = L.map(el, { zoomControl: true, scrollWheelZoom: false });
            mapEl = el;
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
        }
        map.eachLayer(function (l) { if (!(l instanceof L.TileLayer)) map.removeLayer(l); });
        var pts = [];
        var dest = L.marker([s.dest_lat, s.dest_lng], { icon: dot("#16a34a", "You") }).addTo(map);
        pts.push(dest.getLatLng());
        if (s.tech_lat != null && s.tech_lng != null) {
            var tech = L.marker([s.tech_lat, s.tech_lng], { icon: dot("#0d8bf2", "Technician") }).addTo(map);
            pts.push(tech.getLatLng());
            if (route && route.line) L.polyline(route.line, { color: "#0d8bf2", weight: 5, opacity: .85 }).addTo(map);
            else L.polyline([[s.tech_lat, s.tech_lng], [s.dest_lat, s.dest_lng]], { color: "#0d8bf2", weight: 4, dashArray: "6 8" }).addTo(map);
        }
        function fit() {
            map.invalidateSize();
            if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
            else map.setView(pts[0], 16);
        }
        if (fresh) setTimeout(fit, 60); else fit();
        return true;
    }

    function updateRoute(s) {
        if (s.stage !== "arriving" || s.tech_lat == null || s.tech_lng == null || s.dest_lat == null || s.dest_lng == null) {
            route = null; return;
        }
        var key = s.tech_lat + "," + s.tech_lng;
        var now = Date.now();
        if (route && routeKey === key) return;
        if (route && now - routeAt < ROUTE_REFRESH_MS) return;
        routeAt = now; routeKey = key;
        route = { m: haversine(s.tech_lat, s.tech_lng, s.dest_lat, s.dest_lng), approx: true, line: null };
        var stamp = routeAt;
        fetch(OSRM + s.tech_lng + "," + s.tech_lat + ";" + s.dest_lng + "," + s.dest_lat + "?overview=full&geometries=geojson")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (stamp !== routeAt || !data || !data.routes || !data.routes[0]) return;
                var rt = data.routes[0];
                route = { m: rt.distance, approx: false, line: rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }) };
                renderDetails();
            })
            .catch(function () {});
    }

    /* ---------- details panel ---------- */
    function renderDetails() {
        var s = state;
        if (!s || !details) return;
        var step = currentStep(s);
        var steps = box.querySelectorAll(".ip-step");
        for (var i = 0; i < steps.length; i++) steps[i].classList.toggle("selected", i === step);
        if (step !== ARRIVING) destroyMap();
        // "Technician is on the way" note: only while the Arriving step is shown.
        var note = document.getElementById("appProgNote");
        if (note) note.hidden = !(s.stage === "arriving" && step === ARRIVING);

        if (step === 0) {
            var body = '<div class="ip-d-title">Pending</div>';
            if (s.submitted) body += row("Submitted", esc(s.submitted));
            if (s.stage === "rejected") body += '<div class="ip-d-note">Your application was not approved.</div>';
            else if (s.stage === "pending") body += '<div class="ip-d-note">Your application is being reviewed by our admin.</div>';
            else body += '<div class="ip-d-note">Your application was approved by our admin.</div>';
            details.innerHTML = body;
        } else if (step === 1) {
            if (s.technician) {
                details.innerHTML = '<div class="ip-d-title">Technician Assigned</div>' +
                    row("Name", esc(s.technician)) +
                    row("Contact", s.technician_phone ? '<a href="tel:' + esc(s.technician_phone) + '">' + esc(s.technician_phone) + "</a>" : "None");
            } else if (s.done >= 4) {
                details.innerHTML = '<div class="ip-d-title">Technician Assigned</div><div class="ip-d-note">A technician completed your installation.</div>';
            } else {
                details.innerHTML = '<div class="ip-d-title">Technician Assigned</div><div class="ip-d-note">Waiting for a technician to be assigned.</div>';
            }
        } else if (step === ARRIVING) {
            if (s.current === ARRIVING) {
                var wrap = details.querySelector(".ip-arriving");
                if (!wrap) {
                    details.innerHTML = '<div class="ip-arriving"><div class="ip-d-title">Arriving</div>' +
                        '<div class="ip-map" role="img" aria-label="Map showing the technician and your address"></div>' +
                        '<div class="ip-arr-info"></div></div>';
                    wrap = details.querySelector(".ip-arriving");
                }
                var info = row("Technician", s.technician ? esc(s.technician) : "None");
                info += row("Route distance", route ? fmtDist(route.m) + (route.approx ? " (straight-line)" : "") : "Not available");
                if (s.tech_lat == null) info += '<div class="ip-d-note">Technician location not available yet.</div>';
                info += '<div class="ip-d-note">Updates automatically &middot; last updated ' + fmtTime(new Date()) + "</div>";
                wrap.querySelector(".ip-arr-info").innerHTML = info;
                var mapNode = wrap.querySelector(".ip-map");
                if (!drawMap(s, mapNode)) mapNode.style.display = "none";
            } else if (s.done >= 4) {
                details.innerHTML = '<div class="ip-d-title">Arriving</div><div class="ip-d-note">The technician has arrived and finished the installation.</div>';
            } else {
                details.innerHTML = '<div class="ip-d-title">Arriving</div><div class="ip-d-note">The technician is not on the way yet. You\u2019ll see the live map here once they are.</div>';
            }
        } else {
            details.innerHTML = '<div class="ip-d-title">Completed</div><div class="ip-d-note">' +
                (s.done >= 4 ? "Your connection is installed and ready. Welcome to PG Networks!" : "Not completed yet.") + "</div>";
        }
    }

    function pick(el) {
        if (!state) return;
        selected = { step: parseInt(el.getAttribute("data-step"), 10), stage: state.stage };
        renderDetails();
    }
    box.addEventListener("click", function (e) {
        var el = e.target.closest && e.target.closest(".ip-step");
        if (el) pick(el);
    });
    box.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var el = e.target.closest && e.target.closest(".ip-step");
        if (el) { e.preventDefault(); pick(el); }
    });

    /* ---------- refresh ---------- */
    function refresh() {
        if (document.hidden || !url) return;
        fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d) return;
                if (!d.progress || (state && d.progress.stage !== state.stage)) { window.location.reload(); return; }
                state = d.progress;
                updateRoute(state);
                renderDetails();
            })
            .catch(function () {});
    }

    if (state) { updateRoute(state); renderDetails(); }
    if (!state || (state.stage !== "completed" && state.stage !== "rejected")) {
        setInterval(refresh, REFRESH_MS);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
        window.addEventListener("focus", refresh);
    }
})();
