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
 *  - Status badge (Paid / Due / Overdue) is rendered by the server from the
 *    subscriber's estimated due date, so it updates as soon as a payment is
 *    recorded. A recorded payment is always saved as confirmed server-side.
 */
(function () {
    "use strict";

    var form = document.getElementById("collectorPaymentForm");
    if (!form) return;

    var modal = document.getElementById("paymentModal");
    var dateInput = document.getElementById("collectorPaymentDateInput");
    var refInput = document.getElementById("collectorReferenceNumberInput");
    var code = (form.getAttribute("data-code") || "GEN").replace(/[^A-Za-z0-9]/g, "");

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

    function newReference() { if (refInput) refInput.value = generateReference(); }

    function onOpen() { newReference(); stampToday(); }

    if (modal) modal.addEventListener("show.bs.modal", onOpen);
    form.addEventListener("submit", function () { newReference(); stampToday(); });

    onOpen();
})();
