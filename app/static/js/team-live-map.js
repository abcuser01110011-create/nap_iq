/* Team Details > ticket popup: live map for an in-progress ticket.
 *
 * Shows the technician's last reported position, the destination and the
 * driving route between them (same approach as the subscriber's "Arriving"
 * map on My Issues). The technician app reports a GPS fix every 5 minutes,
 * so the map re-reads it on that cadence, and warns inside the popup when
 * the technician can't be tracked.
 *
 * Loaded on demand by technicians/_team_detail.html (after Leaflet), which
 * then calls window.tdLiveMapShow(row) / window.tdLiveMapDestroy().
 */
    // Team details > ticket popup: for an in-progress ticket, show a live map
    // with the technician's last reported position, the destination and the
    // driving route between them (same approach as the subscriber's
    // "Arriving" map on the My Issues page). The technician app reports a
    // GPS fix every 5 minutes, so the map re-reads it on that cadence, and
    // warns inside the popup when the technician can't be tracked.
    (function () {
        if (typeof L === 'undefined') return;   // Leaflet must be loaded first (the popup does that)
        window.tdLiveMapReady = true;

        var OSRM = 'https://router.project-osrm.org/route/v1/driving/';
        var REFRESH_MS = 5 * 60 * 1000;   // same cadence the technician app reports at
        var STALE_S = 12 * 60;            // two missed reports + a little slack
        var live = null;                  // the open popup's map state

        function num(v) { var n = parseFloat(v); return (v === '' || v == null || isNaN(n)) ? null : n; }
        function esc(x) { var d = document.createElement('div'); d.textContent = x == null ? '' : String(x); return d.innerHTML; }
        function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
        function fmtClock(d) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
        function fmtAgo(sec) {
            if (sec < 60) return 'less than a minute';
            var min = Math.round(sec / 60);
            if (min < 60) return min + ' min';
            var h = Math.floor(min / 60), r = min % 60;
            return h + ' h' + (r ? ' ' + r + ' min' : '');
        }
        function haversine(a, b, c, d) {
            var R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLng = (d - b) * r;
            var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
            return 2 * R * Math.asin(Math.sqrt(h));
        }
        function pin(color, label) {
            return L.divIcon({
                className: 'td-pin',
                html: '<span class="td-pin__dot" style="background:' + color + '"></span><span class="td-pin__tag" style="background:' + color + '">' + label + '</span>',
                iconSize: [0, 0]
            });
        }

        function destroy() {
            if (!live) return;
            clearInterval(live.refreshTimer);
            clearInterval(live.tickTimer);
            live.map.remove();
            live = null;
        }

        // ---- warnings (always inside the popup, under the map) ----
        function setWarn(box, level, text) {
            if (!text) { box.hidden = true; box.innerHTML = ''; box.classList.remove('is-error'); return; }
            box.classList.toggle('is-error', level === 'error');
            box.innerHTML = '<i class="bi bi-' + (level === 'error' ? 'wifi-off' : 'exclamation-triangle-fill') + '"></i><span>' + text + '</span>';
            box.hidden = false;
        }

        function currentAge() {
            if (live.ageS == null) return null;
            return live.ageS + (Date.now() - live.fetchedAt) / 1000;
        }

        function evaluate() {
            if (!live) return;
            var age = currentAge(), text = '', level = 'warn';
            if (navigator.onLine === false) {
                level = 'error';
                text = '<b>You\u2019re offline.</b> The live location can\u2019t be refreshed until your connection is back.';
            } else if (live.ended) {
                text = 'This ticket is no longer in progress, so live tracking has stopped.';
            } else if (live.refreshFailed) {
                level = 'error';
                text = '<b>Couldn\u2019t refresh the live location.</b> This looks like a connection problem; showing the last known position. Retrying in a few minutes.';
            } else if (!live.tech) {
                text = '<b>The technician can\u2019t be tracked yet.</b> No location has been reported. They may be offline, out of signal, or haven\u2019t opened the job in the technician app.';
            } else if (age != null && age > STALE_S) {
                var seen = live.at ? ' (last seen ' + fmtClock(new Date(live.at)) + ')' : '';
                text = '<b>No location update for ' + fmtAgo(age) + seen + '.</b> The technician may have lost their internet connection or GPS signal. The pin shows their last known position.';
            } else if (live.tilesFailed) {
                text = 'The map background couldn\u2019t load. Check your connection; the pins and route are still accurate.';
            }
            setWarn(live.warn, level, text);
        }

        function renderInfo() {
            var parts = ['<span>Technician: <b>' + (live.techName ? esc(live.techName) : 'Not available') + '</b></span>'];
            if (live.tech && live.dest) {
                var m = live.routeM != null ? live.routeM : haversine(live.tech[0], live.tech[1], live.dest[0], live.dest[1]);
                parts.push('<span>' + (live.routeM != null ? 'Route distance' : 'Distance') + ': <b>' + fmtDist(m) + '</b>' + (live.routeM != null ? '' : ' (straight-line)') + '</span>');
            }
            if (!live.dest) parts.push('<span>No destination location on file.</span>');
            if (live.tech) {
                var when = live.at ? 'last location ' + fmtClock(new Date(live.at)) + ' \u00b7 ' : '';
                parts.push('<span>' + when + 'refreshes every 5 minutes</span>');
            }
            live.info.innerHTML = parts.join('');
        }

        function drawRoute() {
            var l = live, token = l.routeToken = {};
            if (l.line) { l.map.removeLayer(l.line); l.line = null; }
            l.routeM = null;
            if (!l.tech || !l.dest) return;
            l.line = L.polyline([l.tech, l.dest], { color: '#0d8bf2', weight: 4, dashArray: '6 8' }).addTo(l.map);
            fetch(OSRM + l.tech[1] + ',' + l.tech[0] + ';' + l.dest[1] + ',' + l.dest[0] + '?overview=full&geometries=geojson')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (live !== l || l.routeToken !== token || !data || !data.routes || !data.routes[0]) return;
                    var rt = data.routes[0];
                    if (l.line) l.map.removeLayer(l.line);
                    l.line = L.polyline(rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }), { color: '#0d8bf2', weight: 5, opacity: .85 }).addTo(l.map);
                    l.routeM = rt.distance;
                    renderInfo();
                })
                .catch(function () { /* keep the straight-line fallback */ });
        }

        function fit() {
            if (!live) return;
            var pts = [];
            if (live.tech) pts.push(live.tech);
            if (live.dest) pts.push(live.dest);
            live.map.invalidateSize();
            if (pts.length > 1) live.map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 17 });
            else if (pts.length === 1) live.map.setView(pts[0], 16);
        }

        function paint(moved) {
            if (live.techMarker) { live.map.removeLayer(live.techMarker); live.techMarker = null; }
            if (live.tech) live.techMarker = L.marker(live.tech, { icon: pin('#0d8bf2', 'Technician') }).addTo(live.map);
            if (moved) { drawRoute(); fit(); }
            renderInfo();
            evaluate();
        }

        // ---- 5-minute refresh ----
        function refresh() {
            if (!live) return;
            var l = live;
            if (navigator.onLine === false) { l.refreshFailed = false; evaluate(); return; }
            fetch(l.liveUrl, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (live !== l) return;
                    l.refreshFailed = false;
                    var t = data.tickets && data.tickets[l.code];
                    if (!t) {                       // moved on from in-progress
                        l.ended = true;
                        clearInterval(l.refreshTimer);
                        evaluate();
                        return;
                    }
                    var tech = (t.tech_lat != null && t.tech_lng != null) ? [t.tech_lat, t.tech_lng] : null;
                    var moved = (!tech !== !l.tech) || (tech && l.tech && (tech[0] !== l.tech[0] || tech[1] !== l.tech[1]));
                    l.tech = tech;
                    l.techName = t.tech_name || l.techName;
                    l.ageS = t.tech_age_s;
                    l.at = t.tech_updated_at;
                    l.fetchedAt = Date.now();
                    paint(moved);
                })
                .catch(function () {
                    if (live !== l) return;
                    l.refreshFailed = true;         // our own connection / the server is unreachable
                    evaluate();
                });
        }

        function show(row) {
            var root = row.closest('.team-detail');
            var pop = root && root.querySelector('.td-pop');
            if (!pop) return;
            var box = pop.querySelector('.td-pop-live');
            var mapEl = pop.querySelector('.td-pop-map');
            var info = pop.querySelector('.td-pop-mapinfo');
            var warn = pop.querySelector('.td-pop-warn');
            destroy();
            if (!box || !mapEl || row.dataset.status !== 'in_progress') return;

            var d = row.dataset;
            var dest = (num(d.destLat) != null && num(d.destLng) != null) ? [num(d.destLat), num(d.destLng)] : null;
            var tech = (num(d.techLat) != null && num(d.techLng) != null) ? [num(d.techLat), num(d.techLng)] : null;

            mapEl.hidden = false;
            var map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
            var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
            live = {
                map: map, info: info, warn: warn, code: d.code, liveUrl: pop.dataset.liveUrl,
                tech: tech, dest: dest, techName: d.techName || '',
                ageS: num(d.techAge), at: d.techAt || null, fetchedAt: Date.now(),
                techMarker: null, line: null, routeM: null,
                refreshFailed: false, tilesFailed: false, ended: false
            };
            tiles.on('tileerror', function () { if (live && !live.tilesFailed) { live.tilesFailed = true; evaluate(); } });
            tiles.on('tileload', function () { if (live && live.tilesFailed) { live.tilesFailed = false; evaluate(); } });
            if (dest) L.marker(dest, { icon: pin('#16a34a', 'Destination') }).addTo(map);

            if (!dest && !tech) map.setView([14.28, 121.41], 12);   // nothing to plot yet: show the service area
            paint(true);
            setTimeout(fit, 80);   // popup was just revealed: re-measure once it has its final size

            live.refreshTimer = setInterval(refresh, REFRESH_MS);
            live.tickTimer = setInterval(evaluate, 60 * 1000);       // staleness is time-based: re-check each minute
        }

        // Opened/closed by the Team Details popup (technicians/_team_detail.html).
        window.tdLiveMapShow = show;
        window.tdLiveMapDestroy = destroy;

        window.addEventListener('online', function () { if (live) { live.refreshFailed = false; refresh(); } });
        window.addEventListener('offline', function () { evaluate(); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden && live) refresh(); });
        // closing the whole Team Details popup also tears the map down
        document.addEventListener('hidden.bs.modal', function (e) { if (e.target && e.target.id === 'techTeamDetailModal') destroy(); });
    })();
