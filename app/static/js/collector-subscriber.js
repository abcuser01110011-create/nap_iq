/*
 * Payment Details popup on the collector's subscriber page
 * (app/templates/collector/subscriber.html).
 *
 *  - The subscriber is fixed by the page, so there is no search step.
 *  - Reference number is generated automatically (RCPT-<code>-<timestamp>)
 *    each time the popup opens and travels in a hidden field -- nothing to
 *    show or refresh.
 *  - Status is automatic: Payment Date before the subscriber's estimated
 *    due date -> Paid (confirmed), on it -> Due (pending), after it ->
 *    Overdue (overdue). Same rule as the old Record a Payment form.
 */
(function () {
    "use strict";

    var form = document.getElementById("collectorPaymentForm");
    if (!form) return;

    var modal = document.getElementById("paymentModal");
    var dateInput = document.getElementById("collectorPaymentDateInput");
    var refInput = document.getElementById("collectorReferenceNumberInput");
    var statusSelect = document.getElementById("collectorStatusSelect");
    var badge = document.getElementById("collectorStatusBadge");
    var help = document.getElementById("collectorStatusHelp");
    var dueIso = form.getAttribute("data-due-date") || "";
    var code = (form.getAttribute("data-code") || "GEN").replace(/[^A-Za-z0-9]/g, "");

    var LABELS = { confirmed: "Paid", pending: "Due", overdue: "Overdue" };
    var CLASSES = {
        confirmed: "badge fs-6 text-bg-success",
        pending: "badge fs-6 text-bg-warning",
        overdue: "badge fs-6 text-bg-danger",
    };

    function pad(n) { return String(n).padStart(2, "0"); }

    function generateReference() {
        var d = new Date();
        return "RCPT-" + code + "-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }

    function formatDue(iso) {
        var d = new Date(iso + "T00:00:00");
        return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    }

    function computeStatus(dateStr) {
        if (!dueIso || !dateStr) return null;
        var due = new Date(dueIso + "T00:00:00");
        var paid = new Date(dateStr + "T00:00:00");
        if (isNaN(due.getTime()) || isNaN(paid.getTime())) return null;
        if (paid.getTime() === due.getTime()) return "pending";
        return paid.getTime() < due.getTime() ? "confirmed" : "overdue";
    }

    function refreshStatus() {
        var dateStr = dateInput ? dateInput.value : "";
        var status = computeStatus(dateStr);
        if (!status) {
            badge.className = "badge fs-6 text-bg-secondary";
            badge.textContent = !dateStr ? "Enter a payment date" : "No due date on file \u2014 defaults to Paid";
            statusSelect.value = "confirmed";
            help.textContent = "";
            return;
        }
        statusSelect.value = status;
        badge.className = CLASSES[status];
        badge.textContent = LABELS[status];
        help.textContent = "Based on the payment date vs. the estimated due date (" + formatDue(dueIso) + ").";
    }

    function newReference() { if (refInput) refInput.value = generateReference(); }

    if (dateInput) dateInput.addEventListener("change", refreshStatus);
    if (modal) modal.addEventListener("show.bs.modal", newReference);
    form.addEventListener("submit", newReference);

    newReference();
    refreshStatus();
})();
