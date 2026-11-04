/*
 * Payment Details popup on the collector's subscriber page
 * (app/templates/collector/subscriber.html).
 *
 *  - The subscriber is fixed by the page, so there is no search step.
 *  - Reference number is generated automatically (RCPT-<code>-<timestamp>)
 *    each time the popup opens and travels in a hidden field -- nothing to
 *    show or refresh.
 *  - Payment Date is not asked for: it is always today's date (the day
 *    the payment is recorded), kept in a hidden field.
 *  - Status is automatic: today before the subscriber's estimated
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
    var dueIso = form.getAttribute("data-due-date") || "";
    var code = (form.getAttribute("data-code") || "GEN").replace(/[^A-Za-z0-9]/g, "");

    var LABELS = { confirmed: "Paid", pending: "Due", overdue: "Overdue" };
    var CLASSES = {
        confirmed: "cx-status cx-status--confirmed",
        pending: "cx-status cx-status--pending",
        overdue: "cx-status cx-status--overdue",
    };

    function pad(n) { return String(n).padStart(2, "0"); }

    function todayIso() {
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }

    function stampToday() { if (dateInput) dateInput.value = todayIso(); }

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
            badge.className = CLASSES.confirmed;
            badge.textContent = "Paid";
            statusSelect.value = "confirmed";
            return;
        }
        statusSelect.value = status;
        badge.className = CLASSES[status];
        badge.textContent = LABELS[status];
    }

    function newReference() { if (refInput) refInput.value = generateReference(); }

    function onOpen() { newReference(); stampToday(); refreshStatus(); }

    if (modal) modal.addEventListener("show.bs.modal", onOpen);
    form.addEventListener("submit", function () { newReference(); stampToday(); });

    onOpen();
})();
