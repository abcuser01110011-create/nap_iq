/**
 * Sign-in page light / dark toggle.
 * There is no signed-in account yet, so the choice is remembered per
 * browser (localStorage). First visit follows the device's setting.
 * The early <head> script in auth/login.html applies the saved theme
 * before first paint; this file only wires up the toggle button.
 */
(function () {
    "use strict";
    var KEY = "napiq-login-theme";
    var root = document.documentElement;

    function current() {
        return root.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
    }

    function apply(theme) {
        root.classList.add("login-theme-fade");
        window.setTimeout(function () { root.classList.remove("login-theme-fade"); }, 350);
        root.setAttribute("data-bs-theme", theme);
        document.querySelectorAll("[data-login-theme-toggle]").forEach(function (b) {
            b.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        var btn = document.querySelector("[data-login-theme-toggle]");
        if (!btn) return;
        btn.setAttribute("aria-pressed", current() === "dark" ? "true" : "false");
        btn.addEventListener("click", function () {
            var next = current() === "dark" ? "light" : "dark";
            apply(next);
            try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: just don't remember */ }
        });
    });
})();
