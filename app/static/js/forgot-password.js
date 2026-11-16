/* Staff "Forgot?" popup: email -> 6-digit code -> new password.
   Talks to /forgot-password/{send,verify,reset} (app/routes/auth.py). */
(function () {
    var overlay = document.getElementById("fpOverlay");
    if (!overlay) return;
    var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
    var steps = overlay.querySelectorAll("[data-fp-step]");
    var emailInput = document.getElementById("fpEmail");
    var codeInput = document.getElementById("fpCode");
    var pass = document.getElementById("fpPass");
    var pass2 = document.getElementById("fpPass2");
    var email = "";
    var cooldownTimer = null;

    function show(name) {
        steps.forEach(function (s) { s.hidden = s.getAttribute("data-fp-step") !== name; });
        setError("");
    }
    function setError(msg) {
        overlay.querySelectorAll("[data-fp-error]").forEach(function (el) {
            el.textContent = msg; el.hidden = !msg;
        });
    }
    function post(url, body) {
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
            body: JSON.stringify(body),
            credentials: "same-origin"
        }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (r.status === 429) throw new Error("Too many attempts. Please wait a few minutes and try again.");
                if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
                return d;
            });
        });
    }
    function busy(btn, on) { btn.disabled = on; }
    function open() {
        emailInput.value = ""; codeInput.value = ""; pass.value = ""; pass2.value = "";
        show("email"); overlay.hidden = false; emailInput.focus();
    }
    function close() { overlay.hidden = true; }
    function cooldown(btn, secs) {
        clearInterval(cooldownTimer);
        btn.disabled = true;
        (function tick() {
            if (secs <= 0) { btn.disabled = false; btn.textContent = "Resend code"; return; }
            btn.textContent = "Resend code in " + secs + "s"; secs--;
            cooldownTimer = setTimeout(tick, 1000);
        })();
    }

    document.querySelectorAll("[data-forgot-open]").forEach(function (b) { b.addEventListener("click", open); });
    overlay.querySelectorAll("[data-fp-close]").forEach(function (b) { b.addEventListener("click", close); });
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !overlay.hidden) close(); });

    var sendBtn = overlay.querySelector("[data-fp-send]");
    var resendBtn = overlay.querySelector("[data-fp-resend]");
    function sendCode(btn, onOk) {
        email = emailInput.value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError("Enter a valid email address."); return; }
        setError(""); busy(btn, true);
        post("/forgot-password/send", { email: email }).then(function () {
            overlay.querySelector("[data-fp-email]").textContent = email;
            onOk();
        }).catch(function (e) { setError(e.message); }).then(function () {
            if (btn !== resendBtn) busy(btn, false);
        });
    }
    sendBtn.addEventListener("click", function () {
        sendCode(sendBtn, function () { show("code"); codeInput.focus(); cooldown(resendBtn, 30); });
    });
    emailInput.addEventListener("keydown", function (e) { if (e.key === "Enter") sendBtn.click(); });
    resendBtn.addEventListener("click", function () {
        sendCode(resendBtn, function () { codeInput.value = ""; cooldown(resendBtn, 30); });
    });

    var verifyBtn = overlay.querySelector("[data-fp-verify]");
    codeInput.addEventListener("input", function () { codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6); });
    codeInput.addEventListener("keydown", function (e) { if (e.key === "Enter") verifyBtn.click(); });
    verifyBtn.addEventListener("click", function () {
        var code = codeInput.value.trim();
        if (code.length !== 6) { setError("Enter the 6-digit code."); return; }
        setError(""); busy(verifyBtn, true);
        post("/forgot-password/verify", { email: email, code: code })
            .then(function () { show("password"); pass.focus(); })
            .catch(function (e) { setError(e.message); })
            .then(function () { busy(verifyBtn, false); });
    });

    var resetBtn = overlay.querySelector("[data-fp-reset]");
    pass2.addEventListener("keydown", function (e) { if (e.key === "Enter") resetBtn.click(); });
    resetBtn.addEventListener("click", function () {
        setError(""); busy(resetBtn, true);
        post("/forgot-password/reset", { password: pass.value, confirm_password: pass2.value })
            .then(function () { pass.value = ""; pass2.value = ""; show("done"); })
            .catch(function (e) { setError(e.message); })
            .then(function () { busy(resetBtn, false); });
    });
})();
