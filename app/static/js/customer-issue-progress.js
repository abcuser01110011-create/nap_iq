/* My Issues page: progress tracker per issue (Technician Assigned ->
   Arriving -> Completed) that refreshes by itself, same approach as the
   GeoMap's live refresh (interval + when the tab/window regains focus). */
(function () {
    "use strict";

    var REFRESH_MS = 15000;
    var STEPS = ["Technician Assigned", "Arriving", "Completed"];
    var BADGE_CLASSES = {
        pending: "text-bg-secondary",
        assigned: "text-bg-info",
        accepted: "text-bg-info",
        in_progress: "text-bg-primary",
        resolved: "text-bg-success",
        closed: "text-bg-dark",
    };
    var BADGE_ALL = ["text-bg-secondary", "text-bg-info", "text-bg-primary", "text-bg-success", "text-bg-dark"];

    function esc(text) {
        var d = document.createElement("div");
        d.textContent = text == null ? "" : String(text);
        return d.innerHTML;
    }

    function stepHtml(index, issue) {
        var cls = index < issue.done ? "done" : (index === issue.current ? "current" : "");
        var dot = index < issue.done ? '<i class="bi bi-check-lg"></i>' : String(index + 1);
        var pulse = cls === "current" ? " pulse" : "";
        var sub = "";
        if (index === 0 && issue.technician && issue.done < 3 && issue.status !== "pending") {
            sub = '<span class="ip-sub">' + esc(issue.technician) + "</span>";
        }
        if (index === 1 && issue.current === 1) sub = '<span class="ip-sub">Technician is on the way</span>';
        return '<div class="ip-step ' + cls + '"><div class="ip-dot' + pulse + '">' + dot + "</div>" +
            '<div class="ip-label">' + STEPS[index] + "</div>" + sub + "</div>";
    }

    function render(issue) {
        var box = document.querySelector('.issue-progress[data-issue-id="' + issue.id + '"]');
        if (box) {
            var html = "";
            for (var i = 0; i < STEPS.length; i++) html += stepHtml(i, issue);
            if (issue.status === "pending") {
                html += "";
            }
            box.innerHTML = html;
            var row = box.closest("td") || box.parentElement;
            var note = row.querySelector(".ip-note");
            if (issue.status === "pending") {
                if (!note) {
                    note = document.createElement("div");
                    note.className = "ip-note";
                    row.appendChild(note);
                }
                note.textContent = "Waiting for a technician to be assigned.";
            } else if (note) {
                note.remove();
            }
        }
        var badge = document.querySelector('tr.issue-row[data-issue-id="' + issue.id + '"] .issue-status-badge') ||
            document.querySelector('.ip-home-item[data-issue-id="' + issue.id + '"] .issue-status-badge');
        if (badge) {
            BADGE_ALL.forEach(function (c) { badge.classList.remove(c); });
            badge.classList.add(BADGE_CLASSES[issue.status] || "text-bg-secondary");
            badge.textContent = issue.status_label;
        }
    }


    /* ---------- Home-screen details dropdown (per issue) ---------- */
    var LOC_REFRESH_MS = 5 * 60 * 1000;   // technician location + route refresh
    var OSRM = "https://router.project-osrm.org/route/v1/driving/";
    var loc = {};                          // issue id -> { at, tech, route }

    function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m"; }
    function fmtTime(d) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    function haversine(a, b, c, d) {
        var R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLng = (d - b) * r;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function ensureDetails(issue) {
        var item = document.querySelector('.ip-home-item[data-issue-id="' + issue.id + '"]');
        if (!item) return null;
        var d = item.querySelector(".ip-details");
        if (d) return d;
        d = document.createElement("div");
        d.className = "ip-details";
        d.innerHTML =
            '<button type="button" class="ip-details-toggle" aria-expanded="false">' +
            '<span>Progress details</span><i class="bi bi-chevron-down"></i></button>' +
            '<div class="ip-details-body" hidden></div>';
        item.appendChild(d);
        d.querySelector(".ip-details-toggle").addEventListener("click", function () {
            var body = d.querySelector(".ip-details-body");
            var open = body.hasAttribute("hidden");
            if (open) body.removeAttribute("hidden"); else body.setAttribute("hidden", "");
            this.setAttribute("aria-expanded", open ? "true" : "false");
            d.classList.toggle("open", open);
        });
        return d;
    }

    function updateLocation(issue) {
        var st = loc[issue.id] || (loc[issue.id] = { at: 0, tech: null, route: null, busy: false });
        var now = Date.now();
        if (issue.current !== 1) { return; }
        if (st.at && now - st.at < LOC_REFRESH_MS) { return; }
        st.at = now;
        st.tech = (issue.tech_lat != null && issue.tech_lng != null) ? [issue.tech_lat, issue.tech_lng] : null;
        st.route = null;
        if (st.tech && issue.dest_lat != null && issue.dest_lng != null) {
            var straight = haversine(st.tech[0], st.tech[1], issue.dest_lat, issue.dest_lng);
            st.route = { m: straight, approx: true };
            var url = OSRM + st.tech[1] + "," + st.tech[0] + ";" + issue.dest_lng + "," + issue.dest_lat + "?overview=false";
            fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
                if (data && data.routes && data.routes[0]) {
                    st.route = { m: data.routes[0].distance, approx: false };
                    renderDetails(issue);
                }
            }).catch(function () {});
        }
    }

    function row(label, value) {
        return '<div class="ip-d-row"><span class="ip-d-label">' + label + '</span><span class="ip-d-value">' + value + "</span></div>";
    }

    function renderDetails(issue) {
        var d = ensureDetails(issue);
        if (!d) return;
        var st = loc[issue.id] || {};
        var html = '<div class="ip-d-section"><div class="ip-d-title">Technician Assigned</div>' +
            row("Name", issue.technician ? esc(issue.technician) : "None") +
            row("Contact", issue.technician_phone ? '<a href="tel:' + esc(issue.technician_phone) + '">' + esc(issue.technician_phone) + "</a>" : "None") +
            "</div>";
        html += '<div class="ip-d-section"><div class="ip-d-title">Arriving</div>';
        if (issue.current === 1) {
            if (st.tech) {
                html += row("Technician location",
                    '<a href="https://www.openstreetmap.org/?mlat=' + st.tech[0] + "&mlon=" + st.tech[1] + '#map=16/' + st.tech[0] + "/" + st.tech[1] +
                    '" target="_blank" rel="noopener">' + st.tech[0].toFixed(5) + ", " + st.tech[1].toFixed(5) + "</a>");
            } else {
                html += row("Technician location", "Not available yet");
            }
            html += row("Route distance", st.route ? fmtDist(st.route.m) + (st.route.approx ? " (straight-line)" : "") : "Not available");
            if (st.at) html += '<div class="ip-d-note">Updates every 5 minutes &middot; last updated ' + fmtTime(new Date(st.at)) + "</div>";
        } else if (issue.done >= 3) {
            html += '<div class="ip-d-note">Technician has arrived.</div>';
        } else {
            html += '<div class="ip-d-note">Shown once the technician is on the way.</div>';
        }
        html += "</div>";
        html += '<div class="ip-d-section"><div class="ip-d-title">Completed</div>' +
            '<div class="ip-d-note">' + (issue.done >= 3 ? "Your issue has been resolved." : "Pending completion of the work.") + "</div></div>";
        d.querySelector(".ip-details-body").innerHTML = html;
    }

    function renderHomeDetails(issue) { updateLocation(issue); renderDetails(issue); }

    function apply(issues) { (issues || []).forEach(function (i) { render(i); renderHomeDetails(i); }); }

    function refresh() {
        fetch(window.ISSUE_PROGRESS_URL, { credentials: "same-origin", headers: { Accept: "application/json" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) { if (data) apply(data.issues); })
            .catch(function () { /* keep the last known state; try again next tick */ });
    }

    apply(window.ISSUE_PROGRESS_INITIAL);
    setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
    window.addEventListener("focus", refresh);
})();
