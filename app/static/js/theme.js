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
 *   2. When a `[data-theme-toggle-btn]` button is clicked, flip to the
 *      other theme immediately (no reload), play a small click
 *      animation + icon crossfade, and persist the choice in the
 *      background via POST /settings/theme, rolling back if that
 *      save fails.
 *   3. Crossfade the page's colors (instead of a hard flash) while
 *      the new theme applies.
 *
 * `[data-theme-toggle]` checkboxes are still supported for backward
 * compatibility, in case any other page still renders one.
 *
 * Not loaded on the sign-in screen (base.html) at all — the login UI
 * is fixed to light mode regardless of any account's saved preference.
 */
(function () {
    "use strict";

    var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : "";

    // How long the page-wide color crossfade runs for. Kept in sync
    // with the `--napiq-theme-fade-duration` custom property in
    // style.css — if you change one, change the other.
    var FADE_DURATION_MS = 350;
    var fadeTimeoutId = null;

    function getCurrentTheme() {
        return document.documentElement.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
    }

    function applyTheme(theme) {
        var root = document.documentElement;

        // Crossfade background/text/border colors across the page
        // instead of snapping instantly to the new theme.
        root.classList.add("napiq-theme-transition");
        window.clearTimeout(fadeTimeoutId);
        fadeTimeoutId = window.setTimeout(function () {
            root.classList.remove("napiq-theme-transition");
        }, FADE_DURATION_MS);

        root.setAttribute("data-bs-theme", theme);
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
                if (toggleEl && toggleEl.type === "checkbox") {
                    toggleEl.checked = previousTheme === "dark";
                }
                window.alert("Couldn't save your display preference. Please try again.");
            });
    }

    function syncToggleControls(theme) {
        document.querySelectorAll("[data-theme-toggle]").forEach(function (el) {
            if (el.type === "checkbox") {
                el.checked = theme === "dark";
            }
        });
        document.querySelectorAll("[data-theme-toggle-btn]").forEach(function (el) {
            el.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
        });
    }

    /** Quick scale/rotate pulse on the toggle button itself, replayable
     * even on rapid repeated clicks. */
    function playClickAnimation(btn) {
        btn.classList.remove("is-toggling");
        // Force a reflow so re-adding the class restarts the animation.
        void btn.offsetWidth;
        btn.classList.add("is-toggling");
        btn.addEventListener("animationend", function handler() {
            btn.classList.remove("is-toggling");
            btn.removeEventListener("animationend", handler);
        });
    }

    function wireToggleControls() {
        syncToggleControls(getCurrentTheme());

        // Icon toggle button (Settings > Display Settings).
        document.querySelectorAll("[data-theme-toggle-btn]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var nextTheme = getCurrentTheme() === "dark" ? "light" : "dark";
                playClickAnimation(btn);
                setTheme(nextTheme, btn);
            });
        });

        // Legacy checkbox/switch support, if one exists anywhere.
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
