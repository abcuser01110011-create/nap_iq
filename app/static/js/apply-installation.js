// Drives customer/apply.html's "Detect my location" -> "Check
// coverage" sequence before the rest of the application form is shown
// -- the web equivalent of ApplyForServiceScreen.tsx's location step,
// minus the native GPS consent modal (the browser's own permission
// prompt on getCurrentPosition already plays that role here) and
// minus the mobile screen's tap-proof map: same reasoning still
// applies (no manually placed pin), it's just enforced by never
// wiring up a Leaflet click/drag handler at all rather than by
// omitting one from a WebView page.
(function () {
    var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : null;

    var DEFAULT_CENTER = [14.5995, 120.9842]; // Manila -- same fallback ApplyForServiceScreen uses

    var mapEl = document.getElementById("applyMap");
    if (!mapEl || typeof L === "undefined") return;

    var map = L.map(mapEl, { zoomControl: true, dragging: true, scrollWheelZoom: false }).setView(DEFAULT_CENTER, 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    var marker = null;
    var accuracyCircle = null;

    function placeFix(lat, lng, accuracy) {
        if (marker) {
            marker.setLatLng([lat, lng]);
        } else {
            marker = L.marker([lat, lng]).addTo(map);
        }
        if (accuracyCircle) {
            map.removeLayer(accuracyCircle);
            accuracyCircle = null;
        }
        if (accuracy && accuracy > 0) {
            accuracyCircle = L.circle([lat, lng], {
                radius: accuracy,
                color: "#2258e6",
                fillColor: "#2258e6",
                fillOpacity: 0.12,
                weight: 1,
            }).addTo(map);
        }
        map.flyTo([lat, lng], 16, { animate: true, duration: 0.75 });
    }

    var detectBtn = document.getElementById("applyDetectBtn");
    var checkCoverageBtn = document.getElementById("applyCheckCoverageBtn");
    var errorEl = document.getElementById("applyLocationError");
    var resultEl = document.getElementById("applyCoverageResult");
    var latField = document.getElementById("applyLatitude");
    var lngField = document.getElementById("applyLongitude");
    var detailsForm = document.getElementById("applyDetailsForm");
    var addressField = document.getElementById("address");

    var currentFix = null; // {lat, lng}

    // Tracks the last value *we* wrote into the address field (as
    // opposed to something the customer typed themselves) so a second
    // "Detect my location" click can safely refresh it, while a
    // manual edit in between is never clobbered — same "don't
    // overwrite the customer's own input" rule as any other
    // autofill on this form.
    var lastAutoFilledAddress = "";

    // Reverse-geocodes a fix via OpenStreetMap's Nominatim (same
    // provider already credited in this map's tile attribution, and
    // the same one napmap.js's resolveSubscriberAddress() uses for
    // the admin map's subscriber popups) and fills the Installation
    // Address field with "<street>, <barangay>" when it resolves.
    // Nominatim's reverse endpoint returns the barangay/village under
    // whichever of `suburb`/`village`/`neighbourhood`/`quarter` it
    // happened to tag that area with -- there's no single reliable
    // key for "barangay" across all of its OSM-sourced data, so all
    // four are tried in order. Best-effort only: a failed or empty
    // lookup just leaves the field for the customer to fill in by
    // hand, same as before this existed.
    function reverseGeocodeAddress(lat, lng) {
        if (!addressField) return;
        var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=" + lat + "&lon=" + lng;
        fetch(url, { headers: { Accept: "application/json" } })
            .then(function (response) {
                if (!response.ok) throw new Error("geocode request failed");
                return response.json();
            })
            .then(function (data) {
                var addr = (data && data.address) || {};
                var barangay = addr.suburb || addr.village || addr.neighbourhood || addr.quarter || addr.hamlet;
                var street = addr.road || addr.pedestrian;
                var parts = [street, barangay].filter(Boolean);
                var text = parts.length ? parts.join(", ") : data && data.display_name;
                if (!text) return;

                if (addressField.value === "" || addressField.value === lastAutoFilledAddress) {
                    addressField.value = text;
                    lastAutoFilledAddress = text;
                }
            })
            .catch(function () {
                // Silent -- this is a convenience only, the customer can
                // still type the address in by hand.
            });
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.classList.remove("d-none");
    }

    function clearError() {
        errorEl.classList.add("d-none");
        errorEl.textContent = "";
    }

    function setResult(html, isAvailable) {
        resultEl.innerHTML = html;
        resultEl.className = "small mb-2" + (isAvailable === true ? " text-success" : isAvailable === false ? " text-danger" : "");
    }

    detectBtn.addEventListener("click", function () {
        clearError();
        setResult("", null);
        checkCoverageBtn.classList.add("d-none");
        detailsForm.classList.add("d-none");

        if (!navigator.geolocation) {
            showError("Your browser doesn't support location detection. Please contact PG Networks support for help applying.");
            return;
        }

        detectBtn.disabled = true;
        detectBtn.textContent = "Detecting…";

        navigator.geolocation.getCurrentPosition(
            function (position) {
                detectBtn.disabled = false;
                detectBtn.innerHTML = '<i class="bi bi-geo-alt me-1"></i>Detect my location';

                currentFix = { lat: position.coords.latitude, lng: position.coords.longitude };
                placeFix(currentFix.lat, currentFix.lng, position.coords.accuracy || null);
                checkCoverageBtn.classList.remove("d-none");
                reverseGeocodeAddress(currentFix.lat, currentFix.lng);
            },
            function (err) {
                detectBtn.disabled = false;
                detectBtn.innerHTML = '<i class="bi bi-geo-alt me-1"></i>Detect my location';

                if (err.code === err.PERMISSION_DENIED) {
                    showError("Location permission was denied. Allow location access for this site in your browser settings, then try again.");
                } else {
                    showError("We couldn't detect your location. Please check your connection and try again.");
                }
            },
            { enableHighAccuracy: true, timeout: 20000 }
        );
    });

    checkCoverageBtn.addEventListener("click", function () {
        if (!currentFix) return;
        clearError();
        checkCoverageBtn.disabled = true;
        checkCoverageBtn.textContent = "Checking…";

        fetch("/portal/apply/coverage-check", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": CSRF_TOKEN,
            },
            body: JSON.stringify({ latitude: currentFix.lat, longitude: currentFix.lng }),
        })
            .then(function (resp) {
                return resp.json().then(function (data) {
                    return { ok: resp.ok, data: data };
                });
            })
            .then(function (result) {
                checkCoverageBtn.disabled = false;
                checkCoverageBtn.textContent = "Check coverage";

                if (!result.ok) {
                    showError((result.data && result.data.error) || "Couldn't check coverage right now. Please try again.");
                    return;
                }

                if (result.data.available) {
                    var distance = typeof result.data.distance_km === "number" ? result.data.distance_km.toFixed(1) + " km from the nearest NAP" : "";
                    setResult('<i class="bi bi-check-circle-fill me-1"></i>Good news — this location is within coverage' + (distance ? " (" + distance + ")." : ".") , true);
                    latField.value = currentFix.lat;
                    lngField.value = currentFix.lng;
                    detailsForm.classList.remove("d-none");
                } else {
                    setResult('<i class="bi bi-x-circle-fill me-1"></i>Sorry, we don\'t currently have coverage at this location.', false);
                    detailsForm.classList.add("d-none");
                }
            })
            .catch(function () {
                checkCoverageBtn.disabled = false;
                checkCoverageBtn.textContent = "Check coverage";
                showError("Couldn't check coverage right now. Please check your connection and try again.");
            });
    });
})();
