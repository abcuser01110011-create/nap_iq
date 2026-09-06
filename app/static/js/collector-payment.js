/*
 * Collector "Record a Payment" form (app/templates/collector/index.html)
 * ------------------------------------------------------------------
 * Two pieces:
 *
 *  1. Subscriber search -- replaces the old plain <select> with the
 *     same live-search pattern tickets.js's Subscriber autocomplete
 *     already uses (type to filter, click a result to pick it), fed
 *     by /collector/subscribers.json (coverage-scoped, same set the
 *     hidden <select>'s server-side choices are built from -- see
 *     app/routes/collector.py's subscribers_json()/
 *     _populate_subscriber_choices()). Picking a result sets the real
 *     (now hidden) #subscriber_id <select> so form submission and
 *     validation are unchanged, and fills in the read-only Plan /
 *     Address / Est. Due Date panel underneath.
 *
 *  2. Reference number -- auto-generated (RCPT-<code>-<timestamp>) the
 *     moment a subscriber is picked, and once with a generic stamp on
 *     page load so the field is never blank. Still a plain, editable
 *     text input -- a collector can overwrite it, and the refresh
 *     button next to it generates a new one on demand.
 */
(function () {
    "use strict";

    var searchInput = document.getElementById("collectorSubscriberInput");
    var resultsBox = document.getElementById("collectorSubscriberResults");
    var hiddenSelect = document.getElementById("subscriber_id");
    var helpText = document.getElementById("collectorSubscriberHelp");
    var infoBox = document.getElementById("collectorSubscriberInfo");
    var infoPlan = document.getElementById("collectorSubInfoPlan");
    var infoAddress = document.getElementById("collectorSubInfoAddress");
    var infoDueDate = document.getElementById("collectorSubInfoDueDate");
    var refInput = document.getElementById("collectorReferenceNumberInput");
    var refRegenerateBtn = document.getElementById("collectorRefRegenerateBtn");

    if (!searchInput || !hiddenSelect) return;

    var allSubscribers = [];
    var loaded = false;
    var selectedSubscriber = null;

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function loadSubscribers() {
        if (loaded) return Promise.resolve();
        return fetch("/collector/subscribers.json")
            .then(function (res) { return res.json(); })
            .then(function (data) {
                allSubscribers = data || [];
                loaded = true;
            })
            .catch(function () {
                allSubscribers = [];
            });
    }

    function formatDueDate(iso) {
        if (!iso) return "—";
        var d = new Date(iso + "T00:00:00");
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }

    function renderResults(matches) {
        if (!matches.length) {
            resultsBox.classList.add("d-none");
            resultsBox.innerHTML = "";
            return;
        }
        resultsBox.innerHTML = matches
            .slice(0, 8)
            .map(function (s) {
                return (
                    '<button type="button" class="list-group-item list-group-item-action" data-sub-id="' + s.id + '">' +
                        '<span class="fw-semibold">' + escapeHtml(s.subscriber_code) + "</span> — " +
                        escapeHtml(s.full_name) +
                        (s.address ? '<div class="small text-muted">' + escapeHtml(s.address) + "</div>" : "") +
                    "</button>"
                );
            })
            .join("");
        resultsBox.classList.remove("d-none");
    }

    function setHelp(message, tone) {
        if (!helpText) return;
        helpText.textContent = message;
        helpText.className = "form-text " + (tone || "text-muted");
    }

    function pad(n) {
        return String(n).padStart(2, "0");
    }

    // RCPT-<subscriber code, letters/digits only>-<YYYYMMDDHHMMSS>, or
    // just RCPT-<timestamp> before a subscriber has been picked --
    // unique enough for a collector's own day-to-day use without
    // needing a server round trip or a dedicated sequence column.
    function generateReferenceNumber(subscriber) {
        var now = new Date();
        var stamp =
            now.getFullYear().toString() +
            pad(now.getMonth() + 1) +
            pad(now.getDate()) +
            pad(now.getHours()) +
            pad(now.getMinutes()) +
            pad(now.getSeconds());
        var codePart = subscriber ? String(subscriber.subscriber_code).replace(/[^A-Za-z0-9]/g, "") : "GEN";
        return "RCPT-" + codePart + "-" + stamp;
    }

    function clearSelection() {
        selectedSubscriber = null;
        hiddenSelect.value = "0";
        if (infoBox) infoBox.classList.add("d-none");
    }

    function selectSubscriber(sub) {
        selectedSubscriber = sub;
        hiddenSelect.value = sub.id;
        searchInput.value = sub.subscriber_code + " — " + sub.full_name;
        renderResults([]);
        setHelp("Matched " + sub.full_name + ".", "text-success");

        if (infoBox) {
            infoBox.classList.remove("d-none");
            infoPlan.textContent = sub.plan_type || "—";
            infoAddress.textContent = sub.address || "—";
            infoDueDate.textContent = formatDueDate(sub.due_date);
        }

        if (refInput) refInput.value = generateReferenceNumber(sub);
    }

    searchInput.addEventListener("input", function () {
        clearSelection();
        var term = searchInput.value.trim().toLowerCase();

        if (!term) {
            setHelp("", "text-muted");
            renderResults([]);
            return;
        }

        loadSubscribers().then(function () {
            var matches = allSubscribers.filter(function (s) {
                return (
                    s.full_name.toLowerCase().indexOf(term) !== -1 ||
                    (s.subscriber_code || "").toLowerCase().indexOf(term) !== -1 ||
                    (s.address || "").toLowerCase().indexOf(term) !== -1
                );
            });
            renderResults(matches);
            if (!matches.length) {
                setHelp('No matching subscriber in your coverage area for "' + searchInput.value.trim() + '".', "text-danger");
            } else {
                setHelp("", "text-muted");
            }
        });
    });

    resultsBox.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-sub-id]");
        if (!btn) return;
        var sub = allSubscribers.find(function (s) { return String(s.id) === btn.getAttribute("data-sub-id"); });
        if (sub) selectSubscriber(sub);
    });

    // Close the results dropdown on outside click, same as tickets.js's
    // subscriber/NAP autocompletes.
    document.addEventListener("click", function (e) {
        if (e.target !== searchInput && !resultsBox.contains(e.target)) {
            renderResults([]);
        }
    });

    if (refRegenerateBtn) {
        refRegenerateBtn.addEventListener("click", function () {
            refInput.value = generateReferenceNumber(selectedSubscriber);
        });
    }

    // Never leave the field blank, even before a subscriber is picked.
    if (refInput && !refInput.value.trim()) {
        refInput.value = generateReferenceNumber(null);
    }
})();
