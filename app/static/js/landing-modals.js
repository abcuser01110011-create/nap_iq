// Landing page popups: "Log in" (account number + phone) and "Apply online"
// (location -> coverage -> details). Buttons keep their normal href as a
// no-JS fallback; with JS they open the popup instead.
(function () {
    var csrfMeta = document.querySelector('meta[name="csrf-token"]');
    var CSRF = csrfMeta ? csrfMeta.getAttribute("content") : "";

    var loginModal = document.getElementById("loginModal");
    var applyModal = document.getElementById("applyModal");
    if (!loginModal || !applyModal) return;

    var lastTrigger = null;

    function parse(resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
            // A redirected (HTML) response is never a success here.
            return { ok: resp.ok && !resp.redirected, status: resp.status, data: data };
        });
    }

    function sendPost(url, body) {
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-CSRFToken": CSRF, Accept: "application/json" },
            body: JSON.stringify(body),
            credentials: "same-origin",
            cache: "no-store",
        }).then(parse);
    }

    // POST; if the page's CSRF token no longer matches the visitor's session
    // (stale cached page, phones resuming a tab...), fetch a fresh one and retry once.
    function postJSON(url, body) {
        return sendPost(url, body).then(function (r) {
            if (r.status === 400 && r.data && r.data.code === "csrf") {
                return fetch("/public/csrf-token", { credentials: "same-origin", cache: "no-store" })
                    .then(function (t) { return t.json(); })
                    .then(function (t) { if (t && t.token) CSRF = t.token; return sendPost(url, body); })
                    .catch(function () { return r; });
            }
            return r;
        });
    }

    function getJSON(url) {
        return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" }).then(parse);
    }

    function show(el, on) { if (on) el.removeAttribute("hidden"); else el.setAttribute("hidden", ""); }

    function clearErrors(form) {
        form.querySelectorAll(".lpm__field").forEach(function (f) { f.classList.remove("is-invalid"); });
        form.querySelectorAll("[data-error-for]").forEach(function (e) { e.textContent = ""; });
    }
    function showErrors(form, errors) {
        Object.keys(errors || {}).forEach(function (name) {
            var holder = form.querySelector('[data-error-for="' + name + '"]');
            if (holder) {
                holder.textContent = errors[name];
                holder.parentNode.classList.add("is-invalid");
            }
        });
    }
    function digitsOnly(input) {
        input.addEventListener("input", function () { input.value = input.value.replace(/\D/g, "").slice(0, 11); });
    }
    ["loginPhone", "applyPhone"].forEach(function (id) { var el = document.getElementById(id); if (el) digitsOnly(el); });

    // ---------- open / close ----------
    function openModal(modal, trigger) {
        closeAll(true);
        lastTrigger = trigger || lastTrigger;
        show(modal, true);
        document.body.classList.add("lpm-open");
        var first = modal.querySelector("input:not([type=hidden]), select");
        if (modal === loginModal && first) setTimeout(function () { first.focus(); }, 30);
        if (modal === applyModal) { initMap(); setTimeout(function () { if (map) map.invalidateSize(); }, 60); }
    }
    function closeAll(keepScrollLock) {
        show(loginModal, false);
        show(applyModal, false);
        if (!keepScrollLock) {
            document.body.classList.remove("lpm-open");
            if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
        }
    }

    document.querySelectorAll("[data-open-modal]").forEach(function (el) {
        el.addEventListener("click", function (e) {
            e.preventDefault();
            var which = el.getAttribute("data-open-modal");
            if (which === "apply") {
                openModal(applyModal, el);
                var plan = el.getAttribute("data-plan");
                if (plan) selectPlan(plan);
            } else {
                openModal(loginModal, el);
            }
        });
    });
    document.querySelectorAll("[data-switch-modal]").forEach(function (el) {
        el.addEventListener("click", function (e) {
            e.preventDefault();
            openModal(el.getAttribute("data-switch-modal") === "apply" ? applyModal : loginModal, lastTrigger);
        });
    });
    document.querySelectorAll("[data-close-modal]").forEach(function (el) {
        el.addEventListener("click", function () { closeAll(false); });
    });
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && (!loginModal.hasAttribute("hidden") || !applyModal.hasAttribute("hidden"))) closeAll(false);
    });

    // ---------- Log in ----------
    var loginForm = document.getElementById("loginForm");
    var loginAlert = document.getElementById("loginAlert");
    var loginSubmit = document.getElementById("loginSubmit");

    loginForm.addEventListener("submit", function (e) {
        e.preventDefault();
        clearErrors(loginForm);
        show(loginAlert, false);

        var body = {
            subscriber_code: loginForm.subscriber_code.value.trim(),
            contact_number: loginForm.contact_number.value.trim(),
        };
        var local = {};
        if (!body.subscriber_code) local.subscriber_code = "Your account number or full name is required.";
        if (!/^\d{11}$/.test(body.contact_number)) local.contact_number = "Phone number must be exactly 11 digits (numbers only).";
        if (Object.keys(local).length) { showErrors(loginForm, local); return; }

        loginSubmit.disabled = true;
        postJSON("/public/account-login", body).then(function (r) {
            if (r.ok && r.data.ok) {
                window.location.href = r.data.redirect || "/home";
                return;
            }
            loginSubmit.disabled = false;
            if (r.data && r.data.errors) {
                showErrors(loginForm, r.data.errors);
            } else {
                loginAlert.textContent = (r.data && r.data.message) || ("Couldn't log you in right now (error " + r.status + "). Please refresh the page and try again.");
                show(loginAlert, true);
            }
        }).catch(function () {
            loginSubmit.disabled = false;
            loginAlert.textContent = "Couldn't reach the server. Please check your connection and try again.";
            show(loginAlert, true);
        });
    });

    // ---------- Apply online ----------
    var DEFAULT_CENTER = [14.5995, 120.9842];
    var map = null, marker = null, accuracyCircle = null, currentFix = null, confirmedFix = null;

    var detectBtn = document.getElementById("applyDetectBtn");
    var checkBtn = document.getElementById("applyCheckCoverageBtn");
    var locError = document.getElementById("applyLocationError");
    var resultEl = document.getElementById("applyCoverageResult");
    var detailsForm = document.getElementById("applyDetailsForm");
    var applyAlert = document.getElementById("applyAlert");
    var applySubmit = document.getElementById("applySubmit");
    var addressField = document.getElementById("applyAddress");
    var lastAutoAddress = "";

    function initMap() {
        if (map || typeof L === "undefined") return;
        map = L.map(document.getElementById("applyMap"), { scrollWheelZoom: false }).setView(DEFAULT_CENTER, 11);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
        }).addTo(map);
    }

    function selectPlan(name) {
        var sel = document.getElementById("applyPlan");
        for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === name) { sel.value = name; return; }
        }
    }

    function placeFix(lat, lng, accuracy) {
        if (!map) return;
        if (marker) marker.setLatLng([lat, lng]); else marker = L.marker([lat, lng]).addTo(map);
        if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
        if (accuracy > 0) {
            accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: "#0D3B85", fillColor: "#0D3B85", fillOpacity: 0.12, weight: 1 }).addTo(map);
        }
        map.flyTo([lat, lng], 16, { animate: true, duration: 0.75 });
    }

    function reverseGeocode(lat, lng) {
        fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=" + lat + "&lon=" + lng, { headers: { Accept: "application/json" } })
            .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
            .then(function (d) {
                var a = (d && d.address) || {};
                var brgy = a.suburb || a.village || a.neighbourhood || a.quarter || a.hamlet;
                var parts = [a.road || a.pedestrian, brgy].filter(Boolean);
                var text = parts.length ? parts.join(", ") : d && d.display_name;
                if (text && (addressField.value === "" || addressField.value === lastAutoAddress)) {
                    addressField.value = text; lastAutoAddress = text;
                }
            }).catch(function () {});
    }

    function locError_(msg) { locError.textContent = msg; show(locError, true); }
    function setResult(html, ok) {
        resultEl.innerHTML = html;
        resultEl.className = "lpm__result" + (ok === true ? " ok" : ok === false ? " bad" : "");
    }

    detectBtn.addEventListener("click", function () {
        show(locError, false); setResult("", null); show(checkBtn, false); show(detailsForm, false); confirmedFix = null;
        if (!navigator.geolocation) { locError_("Your browser doesn't support location detection. Please call 0917 654 8563 to apply."); return; }
        var label = detectBtn.innerHTML;
        detectBtn.disabled = true; detectBtn.textContent = "Detecting…";
        navigator.geolocation.getCurrentPosition(function (pos) {
            detectBtn.disabled = false; detectBtn.innerHTML = label;
            currentFix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            placeFix(currentFix.lat, currentFix.lng, pos.coords.accuracy || 0);
            show(checkBtn, true);
            reverseGeocode(currentFix.lat, currentFix.lng);
        }, function (err) {
            detectBtn.disabled = false; detectBtn.innerHTML = label;
            locError_(err.code === err.PERMISSION_DENIED
                ? "Location permission was denied. Allow location access for this site in your browser settings, then try again."
                : "We couldn't detect your location. Please check your connection and try again.");
        }, { enableHighAccuracy: true, timeout: 20000 });
    });

    checkBtn.addEventListener("click", function () {
        if (!currentFix) return;
        show(locError, false);
        checkBtn.disabled = true; checkBtn.textContent = "Checking…";
        getJSON("/public/apply/coverage-check?latitude=" + encodeURIComponent(currentFix.lat) + "&longitude=" + encodeURIComponent(currentFix.lng)).then(function (r) {
            checkBtn.disabled = false; checkBtn.textContent = "Check coverage";
            if (!r.ok) { locError_((r.data && (r.data.error || r.data.message)) || ("Couldn't check coverage right now (error " + r.status + "). Please try again.")); return; }
            if (r.data.available) {
                var km = typeof r.data.distance_km === "number" ? " (" + r.data.distance_km.toFixed(1) + " km from the nearest NAP)" : "";
                setResult('<i class="bi bi-check-circle-fill"></i> Good news — this location is within coverage' + km + ".", true);
                confirmedFix = { lat: currentFix.lat, lng: currentFix.lng };
                show(detailsForm, true);
                detailsForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
            } else {
                setResult('<i class="bi bi-x-circle-fill"></i> Sorry, we don\'t currently have coverage at this location.', false);
                show(detailsForm, false);
            }
        }).catch(function () {
            checkBtn.disabled = false; checkBtn.textContent = "Check coverage";
            locError_("We couldn't reach the server to check coverage. Please check your internet connection and try again.");
        });
    });

    detailsForm.addEventListener("submit", function (e) {
        e.preventDefault();
        clearErrors(detailsForm); show(applyAlert, false);
        if (!confirmedFix) { applyAlert.textContent = "Please detect your location and check coverage first."; show(applyAlert, true); return; }

        var body = {
            full_name: detailsForm.full_name.value.trim(),
            address: detailsForm.address.value.trim(),
            contact_number: detailsForm.contact_number.value.trim(),
            plan_name: detailsForm.plan_name.value,
            latitude: confirmedFix.lat,
            longitude: confirmedFix.lng,
        };
        var local = {};
        if (!body.full_name) local.full_name = "Full name is required.";
        if (!body.address) local.address = "Installation address is required.";
        if (!/^\d{11}$/.test(body.contact_number)) local.contact_number = "Phone number must be exactly 11 digits (numbers only).";
        if (Object.keys(local).length) { showErrors(detailsForm, local); return; }

        applySubmit.disabled = true;
        postJSON("/public/apply", body).then(function (r) {
            applySubmit.disabled = false;
            if (r.ok && r.data.ok) {
                document.getElementById("applyCode").textContent = r.data.subscriber_code;
                loginForm.subscriber_code.value = r.data.subscriber_code;
                loginForm.contact_number.value = body.contact_number;
                show(document.getElementById("applyStepLocation"), false);
                show(detailsForm, false);
                show(document.getElementById("applySuccess"), true);
                return;
            }
            if (r.data && r.data.errors) showErrors(detailsForm, r.data.errors);
            else {
                applyAlert.textContent = r.status === 429
                    ? "Too many applications from this device. Please try again later."
                    : ((r.data && r.data.message) || "Couldn't submit your application. Please try again.");
                show(applyAlert, true);
            }
        }).catch(function () {
            applySubmit.disabled = false;
            applyAlert.textContent = "Couldn't reach the server. Please check your connection and try again.";
            show(applyAlert, true);
        });
    });

    document.getElementById("applyGoLogin").addEventListener("click", function () { openModal(loginModal, lastTrigger); });

    // ---------- Auto-open the Log in popup (?login=1) + flash toast ----------
    var params = new URLSearchParams(window.location.search);
    if (params.get("login") === "1") {
        openModal(loginModal, null);
        params.delete("login");
        var qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
    }
    document.querySelectorAll("[data-landing-toast]").forEach(function (t) {
        setTimeout(function () { t.classList.add("is-hiding"); setTimeout(function () { t.remove(); }, 400); }, 3500);
    });
})();
