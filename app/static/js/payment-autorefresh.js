/*
 * Keeps a customer page up to date while an online payment is still being
 * confirmed. Polls /customer/payments/status.json (the server asks HitPay
 * for the checkout's result) and reloads the page the moment nothing is
 * pending any more -- the status then shows Paid / Partial on its own.
 * Stops after ~1 minute; a manual refresh works as before.
 */
(function () {
    "use strict";
    var script = document.currentScript;
    var url = script && script.getAttribute("data-url");
    if (!url) return;
    var tries = 0, MAX = 15, EVERY = 4000;

    function tick() {
        tries++;
        fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (data && data.pending === 0) { window.location.reload(); return; }
                if (tries < MAX) setTimeout(tick, EVERY);
            })
            .catch(function () { if (tries < MAX) setTimeout(tick, EVERY); });
    }
    setTimeout(tick, 2000);
})();
