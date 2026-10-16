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
            var row = box.closest("td");
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
        var badge = document.querySelector('tr.issue-row[data-issue-id="' + issue.id + '"] .issue-status-badge');
        if (badge) {
            BADGE_ALL.forEach(function (c) { badge.classList.remove(c); });
            badge.classList.add(BADGE_CLASSES[issue.status] || "text-bg-secondary");
            badge.textContent = issue.status_label;
        }
    }

    function apply(issues) { (issues || []).forEach(render); }

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
