/*
 * Administrator "Add Payment" popup (app/templates/payments/_add_modal.html)
 * ------------------------------------------------------------------------
 * Works like the collector's Payment Details popup
 * (static/js/collector-subscriber.js):
 *  - Pick a subscriber (live search over /payments/subscribers.json).
 *  - The status pill (Paid / Due / Overdue / Partial), Monthly fee, Balance
 *    and Due date come from /payments/subscriber/<id>/billing.json -- the
 *    same _billing_state() numbers the collector sees.
 *  - Reference number is generated automatically (RCPT-<code>-<timestamp>).
 *  - Payment date is always today (the day it is recorded).
 *  - Status is always saved as Confirmed by the server.
 *
 * Open it from any element with  data-add-payment  (optionally
 * data-subscriber-id / data-amount), or by landing on /payments/?add=1.
 */
(function () {
    "use strict";

    var modalEl = document.getElementById("addPaymentModal");
    var form = document.getElementById("adminPaymentForm");
    if (!modalEl || !form || typeof bootstrap === "undefined") return;

    var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    var $ = function (id) { return document.getElementById(id); };
    var searchInput = $("apSearch"), resultsBox = $("apResults"), help = $("apHelp");
    var subIdInput = $("apSubscriberId"), refInput = $("apReference"), dateInput = $("apPaymentDate");
    var details = $("apDetails"), statusPill = $("apStatus"), feeEl = $("apFee"), balanceEl = $("apBalance");
    var dueEl = $("apDue"), paidRow = $("apPaidRow"), paidEl = $("apPaid");
    var amountInput = $("apAmount"), methodSelect = $("apMethod"), errorEl = $("apError"), submitBtn = $("apSubmit");

    var subscribers = [], loaded = false, selected = null, reqSeq = 0;

    function pad(n) { return String(n).padStart(2, "0"); }
    function todayIso() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
    function reference() {
        var d = new Date();
        var code = selected ? String(selected.subscriber_code).replace(/[^A-Za-z0-9]/g, "") : "GEN";
        return "RCPT-" + code + "-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
            pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }
    function stamp() { refInput.value = reference(); dateInput.value = todayIso(); }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function peso(v) { return v === null || v === undefined ? "\u2014" : "\u20B1" + v; }
    function setHelp(msg, cls) { help.textContent = msg; help.className = "form-text " + (cls || "text-muted"); }
    function showError(msg) { errorEl.textContent = msg; errorEl.classList.toggle("d-none", !msg); }

    function loadSubscribers() {
        if (loaded) return Promise.resolve();
        return fetch("/payments/subscribers.json", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (data) { subscribers = data || []; loaded = true; })
            .catch(function () { subscribers = []; });
    }

    function renderResults(list) {
        if (!list.length) { resultsBox.classList.add("d-none"); resultsBox.innerHTML = ""; return; }
        resultsBox.innerHTML = list.slice(0, 8).map(function (s) {
            return '<button type="button" class="list-group-item list-group-item-action" data-sub-id="' + s.id + '">' +
                '<span class="fw-semibold">' + esc(s.subscriber_code) + "</span> \u2014 " + esc(s.full_name) +
                (s.address ? '<div class="small text-muted">' + esc(s.address) + "</div>" : "") + "</button>";
        }).join("");
        resultsBox.classList.remove("d-none");
    }

    function clearSelection() {
        selected = null;
        subIdInput.value = "0";
        details.classList.add("d-none");
    }

    function selectSubscriber(sub, presetAmount) {
        selected = sub;
        subIdInput.value = sub.id;
        searchInput.value = sub.subscriber_code + " \u2014 " + sub.full_name;
        renderResults([]);
        setHelp("Matched " + sub.full_name + ".", "text-success");
        showError("");
        stamp();

        var mine = ++reqSeq;
        fetch("/payments/subscriber/" + sub.id + "/billing.json", { credentials: "same-origin" })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (b) {
                if (mine !== reqSeq) return;
                statusPill.className = "cx-status cx-status--" + b.status;
                statusPill.textContent = b.status_label;
                feeEl.textContent = peso(b.monthly_fee);
                balanceEl.textContent = peso(b.balance);
                dueEl.textContent = b.due_date || "\u2014";
                paidRow.classList.toggle("d-none", !b.paid_so_far);
                if (b.paid_so_far) paidEl.textContent = peso(b.paid_so_far);
                details.classList.remove("d-none");
                if (presetAmount) amountInput.value = presetAmount;
            })
            .catch(function () {
                if (mine !== reqSeq) return;
                setHelp("Could not load this subscriber's billing details.", "text-danger");
            });
    }

    function resetForm() {
        reqSeq++;
        form.reset();
        clearSelection();
        renderResults([]);
        setHelp("", "text-muted");
        showError("");
        submitBtn.disabled = false;
        stamp();
    }

    function openPopup(subscriberId, amount) {
        resetForm();
        modal.show();
        if (subscriberId) {
            loadSubscribers().then(function () {
                var sub = subscribers.find(function (s) { return String(s.id) === String(subscriberId); });
                if (sub) selectSubscriber(sub, amount ? parseFloat(amount).toFixed(2) : "");
            });
        } else if (amount) {
            amountInput.value = parseFloat(amount).toFixed(2);
        }
    }

    // Any "Add Payment" trigger. If it sits inside another popup (e.g. the
    // transactions popup), close that one first -- Bootstrap can't stack modals.
    document.addEventListener("click", function (e) {
        var trigger = e.target.closest("[data-add-payment]");
        if (!trigger) return;
        e.preventDefault();
        e.stopPropagation();
        var subId = trigger.getAttribute("data-subscriber-id");
        var amount = trigger.getAttribute("data-amount");
        var parent = trigger.closest(".modal.show");
        if (parent && parent !== modalEl) {
            parent.addEventListener("hidden.bs.modal", function () { openPopup(subId, amount); }, { once: true });
            bootstrap.Modal.getInstance(parent).hide();
        } else {
            openPopup(subId, amount);
        }
    }, true);

    searchInput.addEventListener("input", function () {
        clearSelection();
        var term = searchInput.value.trim().toLowerCase();
        if (!term) { setHelp("", "text-muted"); renderResults([]); return; }
        loadSubscribers().then(function () {
            var matches = subscribers.filter(function (s) {
                return (s.full_name || "").toLowerCase().indexOf(term) !== -1 ||
                    (s.subscriber_code || "").toLowerCase().indexOf(term) !== -1 ||
                    (s.address || "").toLowerCase().indexOf(term) !== -1;
            });
            renderResults(matches);
            setHelp(matches.length ? "" : 'No matching subscriber for "' + searchInput.value.trim() + '".',
                    matches.length ? "text-muted" : "text-danger");
        });
    });

    resultsBox.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-sub-id]");
        if (!btn) return;
        var sub = subscribers.find(function (s) { return String(s.id) === btn.getAttribute("data-sub-id"); });
        if (sub) selectSubscriber(sub);
    });

    form.addEventListener("submit", function (e) {
        if (!selected || subIdInput.value === "0") {
            e.preventDefault();
            showError("Please select the paying subscriber.");
            return;
        }
        var amt = parseFloat(amountInput.value);
        if (isNaN(amt) || amt <= 0) {
            e.preventDefault();
            showError("Amount must be greater than 0.");
            return;
        }
        stamp();
        submitBtn.disabled = true;   // no double-submits
    });

    modalEl.addEventListener("shown.bs.modal", function () {
        if (!selected) searchInput.focus();
    });

    // Landed here from the old /payments/add link or a prefilled one.
    var params = new URLSearchParams(window.location.search);
    if (params.get("add")) {
        openPopup(params.get("subscriber_id"), params.get("amount"));
        params.delete("add"); params.delete("subscriber_id"); params.delete("amount");
        var qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
})();
