/* Technician live location: while a job is 'in_progress', send this
   device's GPS fix to the server immediately and then every 5 minutes.
   The customer's "Arriving" map reads it from there.
   Activated by an element with id="liveLocation" carrying:
     data-url   -> POST endpoint (technician.update_live_location)
     data-csrf  -> CSRF token
   Optional child with id="liveLocationStatus" shows the current state. */
(function () {
    "use strict";

    var INTERVAL_MS = 5 * 60 * 1000;
    var host = document.getElementById("liveLocation");
    if (!host || !navigator.geolocation) return;

    var url = host.getAttribute("data-url");
    var csrf = host.getAttribute("data-csrf");
    var statusEl = document.getElementById("liveLocationStatus");
    var sending = false;

    function setStatus(text, isError) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle("text-danger", !!isError);
    }

    function fmt(d) {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    function send() {
        if (sending) return;
        sending = true;
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                fetch(url, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
                    body: JSON.stringify({
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude
                    })
                }).then(function (r) {
                    sending = false;
                    if (r.ok) setStatus("Sharing your location with the customer · last sent " + fmt(new Date()));
                    else setStatus("Could not share location (server error). Will retry.", true);
                }).catch(function () {
                    sending = false;
                    setStatus("Could not share location (offline?). Will retry.", true);
                });
            },
            function (err) {
                sending = false;
                setStatus(err.code === 1
                    ? "Location permission denied. Allow location access so the customer can see you."
                    : "Could not get your GPS position. Will retry.", true);
            },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
        );
    }

    var lastSent = 0;
    function tick() { lastSent = Date.now(); send(); }

    tick();
    setInterval(tick, INTERVAL_MS);
    // Browsers pause timers in background tabs: catch up when the tech returns.
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden && Date.now() - lastSent >= INTERVAL_MS) tick();
    });
})();
