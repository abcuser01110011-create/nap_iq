/* Technician live location: while a job is 'in_progress', stream this
   device's GPS fix to the server about once a second (and keep sending the
   latest fix every second even when the device is standing still, so the
   server's "last heard from" stamp stays fresh). The admin's live map and
   the customer's "Arriving" map read it from there.
   Activated by an element with id="liveLocation" carrying:
     data-url   -> POST endpoint (technician.update_live_location)
     data-csrf  -> CSRF token
   Optional child with id="liveLocationStatus" shows the current state. */
(function () {
    "use strict";

    var SEND_EVERY_MS = 1000;   // 1 second between updates
    var host = document.getElementById("liveLocation");
    if (!host || !navigator.geolocation) return;

    var url = host.getAttribute("data-url");
    var csrf = host.getAttribute("data-csrf");
    var statusEl = document.getElementById("liveLocationStatus");
    var sending = false;
    var latest = null;      // newest GPS fix from the device
    var lastSent = 0;

    function setStatus(text, isError) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle("text-danger", !!isError);
    }

    function fmt(d) {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    }

    function send() {
        if (sending || !latest) return;
        if (Date.now() - lastSent < SEND_EVERY_MS) return;
        sending = true;
        lastSent = Date.now();
        fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
            body: JSON.stringify({ latitude: latest.latitude, longitude: latest.longitude })
        }).then(function (r) {
            sending = false;
            if (r.ok) setStatus("Sharing your live location \u00b7 last sent " + fmt(new Date()));
            else setStatus("Could not share location (server error). Will retry.", true);
        }).catch(function () {
            sending = false;
            setStatus("Could not share location (offline?). Will retry.", true);
        });
    }

    // The device pushes a new fix whenever it has one...
    navigator.geolocation.watchPosition(
        function (pos) {
            latest = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
            send();
        },
        function (err) {
            setStatus(err.code === 1
                ? "Location permission denied. Allow location access so the office and customer can see you."
                : "Could not get your GPS position. Will retry.", true);
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );

    // ...and every second the latest fix is (re)sent, so a stationary or
    // briefly-silent GPS doesn't look like a lost connection to the office.
    setInterval(send, SEND_EVERY_MS);
})();
