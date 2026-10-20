// Installation application tracker: checks every 20s and reloads the home
// screen when the stage changes (so the steps, note and badge all update).
(function () {
    var box = document.getElementById("appProgress");
    if (!box) return;
    var stage = box.getAttribute("data-stage");
    var url = box.getAttribute("data-url");
    if (!url || stage === "completed" || stage === "rejected") return;

    function check() {
        if (document.hidden) return;
        fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (!d) return;
                // Application finished/activated (no tracker any more) or stage moved on.
                if (!d.progress || d.progress.stage !== stage) window.location.reload();
            })
            .catch(function () {});
    }
    window.setInterval(check, 20000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
})();
