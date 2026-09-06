/*
 * Collector "Record a Payment" form (app/templates/collector/index.html)
 * ------------------------------------------------------------------
 * Three pieces, all reacting to the same two inputs -- which
 * subscriber is picked, and what Payment Date is entered:
 *
 *  1. Subscriber search -- same live-search pattern tickets.js's
 *     Subscriber autocomplete already uses (type to filter, click a
 *     result to pick it), fed by /collector/subscribers.json
 *     (coverage-scoped, same set the hidden #subscriber_id <select>'s
 *     server-side choices are built from -- see
 *     app/routes/collector.py's subscribers_json()/
 *     _populate_subscriber_choices()). Picking a result sets that
 *     hidden <select> so form submission/validation are unchanged,
 *     and fills in the read-only Plan / Monthly Fee / Current Balance /
 *     Due Date panel underneath (Monthly Fee/Current Balance come from
 *     app/routes/collector.py's _plan_monthly_fee()/_current_balance()).
 *
 *  2. Reference number -- auto-generated (RCPT-<code>-<timestamp>)
 *     the moment a subscriber is picked, shown as plain read-only
 *     text further down the form (not an editable input) with a
 *     refresh button next to it to generate a new one on demand. The
 *     actual value submitted with the payment still travels in a
 *     hidden #collectorReferenceNumberInput -- only how it's
 *     presented changed, not what gets saved.
 *
 *  3. Status -- no longer a manual dropdown. Automatically computed
 *     by comparing the entered Payment Date against the selected
 *     subscriber's Est. Due Date (see app/routes/collector.py's
 *     _estimate_next_due_date()):
 *       - Payment Date before the due date  -> "Paid"     (confirmed)
 *       - Payment Date exactly on the due date -> "Due"   (pending)
 *       - Payment Date after the due date   -> "Overdue"  (overdue)
 *     Shown as a read-only badge; the real value still travels in the
 *     hidden #collectorStatusSelect using the same 'confirmed' /
 *     'pending' / 'overdue' values the backend has always expected
 *     (app/forms.py's RecordPaymentForm), so nothing server-side
 *     needed to change -- only the collector no longer picks it by
 *     hand.
 */
(function () {
    "use strict";

    var searchInput = document.getElementById("collectorSubscriberInput");
    var resultsBox = document.getElementById("collectorSubscriberResults");
    var hiddenSubscriberSelect = document.getElementById("subscriber_id");
    var helpText = document.getElementById("collectorSubscriberHelp");
    var infoBox = document.getElementById("collectorSubscriberInfo");
    var infoPlan = document.getElementById("collectorSubInfoPlan");
    var infoFee = document.getElementById("collectorSubInfoFee");
    var infoBalance = document.getElementById("collectorSubInfoBalance");
    var infoDueDate = document.getElementById("collectorSubInfoDueDate");
    var infoReference = document.getElementById("collectorSubInfoReference");
    var refHiddenInput = document.getElementById("collectorReferenceNumberInput");
    var refRegenerateBtn = document.getElementById("collectorRefRegenerateBtn");
    var paymentDateInput = document.getElementById("collectorPaymentDateInput");
    var statusBadge = document.getElementById("collectorStatusBadge");
    var statusHelp = document.getElementById("collectorStatusHelp");
    var hiddenStatusSelect = document.getElementById("collectorStatusSelect");

    if (!searchInput || !hiddenSubscriberSelect) return;

    var STATUS_LABELS = { confirmed: "Paid", pending: "Due", overdue: "Overdue" };
    var STATUS_BADGE_CLASSES = {
        confirmed: "badge fs-6 text-bg-success",
        pending: "badge fs-6 text-bg-warning",
        overdue: "badge fs-6 text-bg-danger",
    };

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

    // Monthly Fee / Current Balance come from the server as plain
    // decimal strings (or null when the subscriber's plan hasn't been
    // priced yet in Settings > Plans -- see collector.py's
    // _plan_monthly_fee()) -- "—" covers that case rather than showing
    // ₱0.00, which would misleadingly read as "nothing owed".
    function formatCurrency(value) {
        if (value === null || value === undefined || value === "") return "—";
        var num = parseFloat(value);
        if (isNaN(num)) return "—";
        return "₱" + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

    // RCPT-<subscriber code, letters/digits only>-<YYYYMMDDHHMMSS> --
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

    function setReferenceNumber(value) {
        if (refHiddenInput) refHiddenInput.value = value;
        if (infoReference) infoReference.textContent = value;
    }

    // Compares the entered Payment Date to the selected subscriber's
    // Est. Due Date. Returns one of 'confirmed' / 'pending' / 'overdue',
    // or null when there isn't enough information yet (no subscriber
    // picked, no payment date entered, or the subscriber has no due
    // date on file at all -- see _estimate_next_due_date()'s own
    // "returns None" case).
    function computeStatus(subscriber, paymentDateStr) {
        if (!subscriber || !subscriber.due_date || !paymentDateStr) return null;
        var due = new Date(subscriber.due_date + "T00:00:00");
        var paid = new Date(paymentDateStr + "T00:00:00");
        if (isNaN(due.getTime()) || isNaN(paid.getTime())) return null;
        if (paid.getTime() === due.getTime()) return "pending"; // Due
        if (paid.getTime() < due.getTime()) return "confirmed"; // Paid
        return "overdue"; // Overdue
    }

    function refreshStatus() {
        if (!statusBadge || !hiddenStatusSelect) return;
        var paymentDateStr = paymentDateInput ? paymentDateInput.value : "";
        var computed = computeStatus(selectedSubscriber, paymentDateStr);

        if (!computed) {
            statusBadge.className = "badge fs-6 text-bg-secondary";
            statusBadge.textContent = !selectedSubscriber
                ? "Select a subscriber"
                : (!paymentDateStr ? "Enter a payment date" : "No due date on file — defaults to Paid");
            // Nothing conclusive yet -- fall back to the form's own
            // default ('confirmed'/Paid) rather than leaving the
            // hidden field on a stale value from a previous pick.
            hiddenStatusSelect.value = "confirmed";
            if (statusHelp) statusHelp.textContent = "";
            return;
        }

        hiddenStatusSelect.value = computed;
        statusBadge.className = STATUS_BADGE_CLASSES[computed];
        statusBadge.textContent = STATUS_LABELS[computed];
        if (statusHelp) {
            statusHelp.textContent =
                "Based on the payment date vs. this subscriber's estimated due date (" +
                formatDueDate(selectedSubscriber.due_date) + ").";
        }
    }

    function clearSelection() {
        selectedSubscriber = null;
        hiddenSubscriberSelect.value = "0";
        if (infoBox) infoBox.classList.add("d-none");
        refreshStatus();
    }

    function selectSubscriber(sub) {
        selectedSubscriber = sub;
        hiddenSubscriberSelect.value = sub.id;
        searchInput.value = sub.subscriber_code + " — " + sub.full_name;
        renderResults([]);
        setHelp("Matched " + sub.full_name + ".", "text-success");

        if (infoBox) {
            infoBox.classList.remove("d-none");
            infoPlan.textContent = sub.plan_type || "—";
            infoFee.textContent = formatCurrency(sub.monthly_fee);
            infoBalance.textContent = formatCurrency(sub.current_balance);
            infoDueDate.textContent = formatDueDate(sub.due_date);
        }

        setReferenceNumber(generateReferenceNumber(sub));
        refreshStatus();
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
            setReferenceNumber(generateReferenceNumber(selectedSubscriber));
        });
    }

    if (paymentDateInput) {
        paymentDateInput.addEventListener("change", refreshStatus);
    }

    // Never leave the (hidden) reference number blank, even before a
    // subscriber is picked.
    setReferenceNumber(generateReferenceNumber(null));
    refreshStatus();
})();
