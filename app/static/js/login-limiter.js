// Live countdown while sign-in is locked (see app/login_attempts.py).
// Disables the Sign in button until the lockout ends, then re-enables it.
(function () {
    var box = document.querySelector("[data-lockout-seconds]");
    if (!box) return;

    var remaining = parseInt(box.getAttribute("data-lockout-seconds"), 10) || 0;
    var text = box.querySelector("[data-lockout-text]");
    var submit = document.querySelector(".login-submit[type='submit']");
    if (submit) submit.disabled = true;

    function label(sec) {
        var m = Math.floor(sec / 60), s = sec % 60;
        return m + ":" + (s < 10 ? "0" : "") + s;
    }
    function render() {
        text.textContent = "Too many failed sign-in attempts. Sign-in is temporarily locked. Try again in " + label(remaining) + ".";
    }

    render();
    var timer = setInterval(function () {
        remaining -= 1;
        if (remaining <= 0) {
            clearInterval(timer);
            text.textContent = "You can try signing in again now.";
            if (submit) submit.disabled = false;
            return;
        }
        render();
    }, 1000);
})();
