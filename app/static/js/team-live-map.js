/* Team Details > ticket popup: live map for an in-progress ticket.
 *
 * Shows the technician's last reported position, the destination and the
 * driving route between them (same approach as the subscriber's "Arriving"
 * map on My Issues). The technician's page reports a GPS fix about once a
 * second while the job is in progress, and this map re-reads it every
 * second (a single small query per tick), warning inside the popup when the
 * technician can't be tracked.
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
        var REFRESH_MS = 1000;            // how often the map re-reads the technician's position
        var STALE_S = 30;                 // no new fix for this long => can't be tracked
        var FAIL_LIMIT = 3;               // consecutive failed refreshes before warning about OUR connection
        var ROUTE_MIN_MS = 10 * 1000;     // don't ask the routing service more often than this
        var ROUTE_MIN_MOVE_M = 25;        // ...or for tiny movements
        var ROUTE_RETRY_MS = 15 * 1000;   // retry a failed route lookup this often
        var live = null;                  // the open popup's map state

        function num(v) { var n = parseFloat(v); return (v === '' || v == null || isNaN(n)) ? null : n; }
        function esc(x) { var d = document.createElement('div'); d.textContent = x == null ? '' : String(x); return d.innerHTML; }
        function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
        function fmtClock(d) { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
        function fmtAgo(sec) {
            if (sec < 60) return Math.max(1, Math.round(sec)) + ' sec';
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
            live.destroyed = true;
            try { live.map.remove(); } catch (e) { /* already gone */ }
            live = null;
        }

        // The ticket is no longer in progress (the technician completed it --
        // for a consolidated ticket that is the whole group -- or it was pulled
        // back). Drop the live map, the "last location" line and every warning,
        // update the popup's status and move the row to the Completed tab.
        function finish(status) {
            var l = live;
            if (!l) return;
            var pop = l.pop, root = l.root, ref = l.ref;
            destroy();
            if (pop) {
                var box = pop.querySelector('.td-pop-live');
                var mapEl = pop.querySelector('.td-pop-map');
                var info = pop.querySelector('.td-pop-mapinfo');
                var warn = pop.querySelector('.td-pop-warn');
                if (warn) { warn.hidden = true; warn.innerHTML = ''; warn.classList.remove('is-error'); }
                if (info) info.innerHTML = '';
                if (mapEl) { mapEl.hidden = true; mapEl.innerHTML = ''; mapEl.className = mapEl.className.replace(/\bleaflet-[^\s]+/g, '').trim(); }
                if (box) box.hidden = true;
                var st = pop.querySelector('[data-f=status]');
                if (st) st.textContent = status === 'completed' ? 'Completed' : (status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ') : '\u2014');
            }
            if (status === 'completed') moveRowToCompleted(root, ref);
        }

        function moveRowToCompleted(root, ref) {
            if (!root || !ref) return;
            var prog = root.querySelector('.td-c-prog .td-jobs-list');
            var done = root.querySelector('.td-tabpane[data-tab="completed"]');
            if (!prog || !done) return;
            var row = null;
            prog.querySelectorAll('.td-job').forEach(function (r) { if (r.dataset.ref === ref) row = r; });
            if (!row) return;
            row.dataset.status = 'completed';
            row.dataset.statusLabel = 'Completed';
            row.dataset.techLat = ''; row.dataset.techLng = ''; row.dataset.techAge = ''; row.dataset.techAt = '';
            var top = row.querySelector('.td-job-top');
            if (top && !top.querySelector('.td-st')) {
                var cons = top.querySelector('.td-cons');
                var wrap = document.createElement('span');
                wrap.className = 'td-badges';
                if (cons) wrap.appendChild(cons);
                var badge = document.createElement('span');
                badge.className = 'td-st is-completed';
                badge.textContent = 'Completed';
                wrap.appendChild(badge);
                top.appendChild(wrap);
            }
            prog.removeChild(row);
            if (!prog.querySelector('.td-job')) {
                var empty = document.createElement('div');
                empty.className = 'p-4 text-center text-muted';
                empty.textContent = 'No work in progress right now.';
                prog.appendChild(empty);
            }
            var placeholder = done.querySelector('.p-4');
            if (placeholder) done.removeChild(placeholder);
            done.insertBefore(row, done.firstChild);
            var n = prog.querySelectorAll('.td-job').length;
            var cnt = root.querySelector('.td-c-prog .td-count');
            if (cnt) cnt.textContent = '(' + n + ')';
            var tabCount = root.querySelector('.td-tab[data-tab="completed"] .td-tab-count');
            if (tabCount) tabCount.textContent = String(done.querySelectorAll('.td-job').length);
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
                text = '';
            } else if (live.failCount >= FAIL_LIMIT) {
                level = 'error';
                text = '<b>Couldn\u2019t refresh the live location.</b> This looks like a connection problem on your side or the server; showing the last known position and retrying.';
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
                var age = currentAge();
                if (age != null && age > STALE_S) parts.push('<span>last location ' + (live.at ? fmtClock(new Date(live.at)) : 'unknown') + ' \u00b7 waiting for the technician</span>');
                else parts.push('<span>' + (live.at ? 'last location ' + fmtClock(new Date(live.at)) + ' \u00b7 ' : '') + 'updating every second</span>');
            }
            live.info.innerHTML = parts.join('');
        }

        function drawRoute() {
            var l = live, token = l.routeToken = {};
            l.routeAt = Date.now();
            l.routeFrom = l.tech;
            if (!l.tech || !l.dest) {
                if (l.line) { l.map.removeLayer(l.line); l.line = null; }
                l.routeM = null;
                return;
            }
            // Until the new route arrives, the old (possibly far-behind) road
            // geometry must not stay on screen: fall back to the straight line.
            if (l.routeSolid && l.line) { l.map.removeLayer(l.line); l.line = null; l.routeSolid = false; l.routeM = null; }
            if (!l.line) l.line = L.polyline([l.tech, l.dest], { color: '#0d8bf2', weight: 4, dashArray: '6 8' }).addTo(l.map);
            else l.line.setLatLngs([l.tech, l.dest]);
            fetch(OSRM + l.tech[1] + ',' + l.tech[0] + ';' + l.dest[1] + ',' + l.dest[0] + '?overview=full&geometries=geojson')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (live !== l || l.routeToken !== token) return;
                    if (!data || !data.routes || !data.routes[0]) { l.routeAt = Date.now(); return; }
                    var rt = data.routes[0];
                    if (l.line) l.map.removeLayer(l.line);
                    l.line = L.polyline(rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }), { color: '#0d8bf2', weight: 5, opacity: .85 }).addTo(l.map);
                    l.routeM = rt.distance;
                    l.routeSolid = true;
                    renderInfo();
                })
                .catch(function () { if (live === l) l.routeAt = Date.now(); /* keep the straight-line fallback; the tick retries */ });
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

        function paint(first, moved) {
            if (live.tech) {
                if (live.techMarker) live.techMarker.setLatLng(live.tech);
                else live.techMarker = L.marker(live.tech, { icon: pin('#0d8bf2', 'Technician') }).addTo(live.map);
            } else if (live.techMarker) { live.map.removeLayer(live.techMarker); live.techMarker = null; }

            if (first) { drawRoute(); fit(); }
            else if (moved) {
                // keep the pin on screen, but never fight the admin's own panning/zooming
                if (live.tech && !live.map.getBounds().contains(live.tech)) fit();
                // the straight line follows the pin every tick; the real route is refreshed sparingly
                var far = live.routeFrom && live.tech ? haversine(live.routeFrom[0], live.routeFrom[1], live.tech[0], live.tech[1]) : Infinity;
                if (!live.routeAt || (Date.now() - live.routeAt >= ROUTE_MIN_MS && far >= ROUTE_MIN_MOVE_M)) drawRoute();
                else if (live.line && !live.routeSolid && live.tech && live.dest) live.line.setLatLngs([live.tech, live.dest]);
            }
            renderInfo();
            evaluate();
        }

        // ---- 1-second refresh ----
        function refresh() {
            if (!live || live.busy || live.ended) return;
            var l = live;
            if (navigator.onLine === false) { evaluate(); return; }
            l.busy = true;
            var url = l.liveUrl + (l.liveUrl.indexOf('?') < 0 ? '?' : '&') + 'ref=' + encodeURIComponent(l.ref);
            fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (live !== l) return;
                    l.busy = false;
                    l.failCount = 0;
                    var t = data.tickets && data.tickets[l.ref];
                    if (!t || (t.status && t.status !== 'in_progress')) {   // completed / moved on from in-progress
                        l.ended = true;
                        finish(t && t.status ? t.status : 'completed');
                        return;
                    }
                    var tech = (t.tech_lat != null && t.tech_lng != null) ? [t.tech_lat, t.tech_lng] : null;
                    var moved = (!tech !== !l.tech) || !!(tech && l.tech && (tech[0] !== l.tech[0] || tech[1] !== l.tech[1]));
                    var stampChanged = (t.tech_updated_at || null) !== (l.at || null);
                    l.tech = tech;
                    l.techName = t.tech_name || l.techName;
                    l.ageS = t.tech_age_s;
                    l.at = t.tech_updated_at;
                    l.fetchedAt = Date.now();
                    if (moved || stampChanged) paint(false, moved); else evaluate();
                })
                .catch(function () {
                    if (live !== l) return;
                    l.busy = false;
                    l.failCount = (l.failCount || 0) + 1;   // a single hiccup isn't a warning; FAIL_LIMIT in a row is
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
            // Leaflet measures its container when the map is created: building it
            // inside a hidden popup gave it a 0x0 size, which left the pins and the
            // route out of line with the tiles. Reveal everything first.
            pop.hidden = false;
            box.hidden = false;
            mapEl.hidden = false;
            mapEl.innerHTML = '';

            var d = row.dataset;
            var dest = (num(d.destLat) != null && num(d.destLng) != null) ? [num(d.destLat), num(d.destLng)] : null;
            var tech = (num(d.techLat) != null && num(d.techLng) != null) ? [num(d.techLat), num(d.techLng)] : null;

            var map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
            var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
            live = {
                map: map, info: info, warn: warn, pop: pop, root: root, code: d.code, liveUrl: pop.dataset.liveUrl,
                ref: d.ref, tech: tech, dest: dest, techName: d.techName || '',
                ageS: num(d.techAge), at: d.techAt || null, fetchedAt: Date.now(),
                techMarker: null, line: null, routeM: null,
                failCount: 0, busy: false, tilesFailed: false, ended: false, routeSolid: false
            };
            tiles.on('tileerror', function () { if (live && !live.tilesFailed) { live.tilesFailed = true; evaluate(); } });
            tiles.on('tileload', function () { if (live && live.tilesFailed) { live.tilesFailed = false; evaluate(); } });
            if (dest) L.marker(dest, { icon: pin('#16a34a', 'Destination') }).addTo(map);

            if (!dest && !tech) map.setView([14.28, 121.41], 12);   // nothing to plot yet: show the service area
            map.invalidateSize();
            paint(true, false);
            // the popup fades/slides in: re-measure once it has settled
            setTimeout(function () { if (live && live.map === map) fit(); }, 80);
            setTimeout(function () { if (live && live.map === map) fit(); }, 350);

            live.refreshTimer = setInterval(refresh, REFRESH_MS);
            live.tickTimer = setInterval(function () {
                if (!live) return;
                evaluate();
                renderInfo();
                if (!live.routeSolid && live.tech && live.dest && Date.now() - (live.routeAt || 0) >= ROUTE_RETRY_MS) drawRoute();
            }, 5 * 1000);        // staleness is time-based: re-check every few seconds
        }

        // Opened/closed by the Team Details popup (technicians/_team_detail.html).
        window.tdLiveMapShow = show;
        window.tdLiveMapDestroy = destroy;

        window.addEventListener('online', function () { if (live) { live.failCount = 0; refresh(); } });
        window.addEventListener('offline', function () { evaluate(); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden && live) refresh(); });
        // closing the whole Team Details popup also tears the map down
        document.addEventListener('hidden.bs.modal', function (e) { if (e.target && e.target.id === 'techTeamDetailModal') destroy(); });
    })();
