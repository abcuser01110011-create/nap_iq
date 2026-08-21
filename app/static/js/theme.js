/**
 * NAP-IQ Display Theme (Dark Mode)
 * ---------------------------------
 * The active theme is a per-account preference, not a per-browser one:
 * `dashboard_base.html` renders `data-bs-theme` on <html> directly from
 * `current_user.theme_preference` (see app/models.py), so there's no
 * light-mode flash and the preference already follows the signed-in
 * user to any device — no localStorage involved. Every account
 * defaults to 'light' until it's explicitly switched to 'dark'.
 *
 * This file only needs to:
 *   1. Read the theme already applied to <html> by the server.
 *   2. When a `[data-theme-toggle]` switch changes, apply the new
 *      theme immediately (no reload) and persist it in the background
 *      via POST /settings/theme, rolling back if that save fails.
 *
 * Not loaded on the sign-in screen (base.html) at all — the login UI
 * is fixed to light mode regardless of any account's saved preference.
 */
(function () {
    "use strict";

    var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : "";

    function getCurrentTheme() {
        return document.documentElement.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-bs-theme", theme);
        syncToggleControls(theme);
        window.dispatchEvent(
            new CustomEvent("napiq:theme-changed", { detail: { theme: theme } })
        );
    }

    /** Applies the choice instantly, then persists it to the signed-in
     * account in the background. Rolls the UI back if the save fails,
     * so the toggle never claims a preference that wasn't actually
     * saved to the account. */
    function setTheme(theme, toggleEl) {
        if (theme !== "dark" && theme !== "light") return;

        var previousTheme = getCurrentTheme();
        applyTheme(theme);

        fetch("/settings/theme", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": CSRF_TOKEN,
            },
            body: JSON.stringify({ theme: theme }),
        })
            .then(function (response) {
                if (!response.ok) throw new Error("theme save failed");
            })
            .catch(function () {
                applyTheme(previousTheme);
                if (toggleEl) toggleEl.checked = previousTheme === "dark";
                window.alert("Couldn't save your display preference. Please try again.");
            });
    }

    function syncToggleControls(theme) {
        document.querySelectorAll("[data-theme-toggle]").forEach(function (el) {
            if (el.type === "checkbox") {
                el.checked = theme === "dark";
            }
        });
    }

    function wireToggleControls() {
        syncToggleControls(getCurrentTheme());
        document.querySelectorAll("[data-theme-toggle]").forEach(function (el) {
            el.addEventListener("change", function () {
                setTheme(el.checked ? "dark" : "light", el);
            });
        });
    }

    document.addEventListener("DOMContentLoaded", wireToggleControls);

    // Small public API used by static/js/napmap.js to pick a matching
    // light/dark basemap and react live to a toggle on the GeoMap page.
    window.NapIQTheme = {
        get: getCurrentTheme,
        set: setTheme,
    };
})();
