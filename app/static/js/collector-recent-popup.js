/*
 * Read-only "Payment Details" popup for the collector Dashboard's
 * My Recent Collections list (app/templates/collector/index.html).
 *
 * Tapping a name fetches /collector/subscriber/<id>/payment.json (always
 * fresh, so a partial payment recorded a moment ago already shows the
 * reduced balance) and fills the popup. Nothing in the popup is editable;
 * "Add payment" opens the subscriber page where payments are recorded.
 */
(function () {
    "use strict";

    var modalEl = document.getElementById("recentPaymentModal");
    if (!modalEl) return;

    var $ = function (id) { return document.getElementById(id); };
    var els = {
        name: $("rpmName"), loading: $("rpmLoading"), error: $("rpmError"), content: $("rpmContent"),
        status: $("rpmStatus"), sub: $("rpmSub"), fee: $("rpmFee"), paidRow: $("rpmPaidRow"),
        paid: $("rpmPaid"), balance: $("rpmBalance"), due: $("rpmDue"), last: $("rpmLast"), open: $("rpmOpen")
    };
    var DASH = "\u2014", PESO = "\u20B1";
    var modal = window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(modalEl) : null;
    var requestId = 0;

    function money(v) { return v ? PESO + v : DASH; }

    function showState(state) {
        els.loading.classList.toggle("d-none", state !== "loading");
        els.error.classList.toggle("d-none", state !== "error");
        els.content.classList.toggle("d-none", state !== "ready");
        if (state !== "ready") els.open.classList.add("d-none");
    }

    function render(d) {
        els.name.textContent = d.full_name;
        els.status.className = "cx-status cx-status--" + d.status;
        els.status.textContent = d.status_label;
        els.sub.textContent = [d.subscriber_code, d.plan_type].filter(Boolean).join(" \u00B7 ");
        els.fee.textContent = money(d.monthly_fee);
        els.balance.textContent = money(d.balance);
        els.due.textContent = d.due_date || DASH;
        els.paidRow.classList.toggle("d-none", !d.paid_so_far);
        els.paid.textContent = money(d.paid_so_far);
        els.last.textContent = d.last_payment
            ? PESO + d.last_payment.amount + " \u00B7 " + d.last_payment.date +
              (d.last_payment.method ? " \u00B7 " + d.last_payment.method : "")
            : DASH;
        els.open.setAttribute("href", d.detail_url);
        els.open.classList.remove("d-none");
        showState("ready");
    }

    function open(btn) {
        var myId = ++requestId;
        els.name.textContent = btn.getAttribute("data-name") || "Payment Details";
        showState("loading");
        if (modal) modal.show();

        fetch(btn.getAttribute("data-payment-url"), {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (d) { if (myId === requestId) render(d); })
            .catch(function () { if (myId === requestId) showState("error"); });
    }

    document.querySelectorAll(".js-payment-popup").forEach(function (btn) {
        btn.addEventListener("click", function () { open(btn); });
    });
})();
