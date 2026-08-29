// Sign-in / sign-out loading transition.
//
// Shared by auth/login.html (the sign-in form) and base.html (the
// logout form in the navbar) -- both mark their <form> with
// data-auth-transition="signin" or "signout" and get the exact same
// full-screen overlay, just with different title/step copy.
//
// Deliberately a *client-side-only* delay in front of a completely
// normal form submission, not a fetch()-based rewrite of the login
// flow: the first submit is intercepted and the overlay plays for a
// fixed minimum duration, then form.submit() fires the real POST.
// form.submit() does not re-trigger the 'submit' event, so this can't
// loop, and because it's a real navigation, success (redirect to the
// dashboard) and failure (login page re-rendered with a flashed
// error) both come back through completely unchanged -- this file
// never has to know or guess which one happened.
(function () {
    var DURATION_MS = 5000;

    var CONFIGS = {
        signin: {
            title: "Signing you in",
            steps: ["Verifying credentials", "Establishing secure tunnel", "Syncing topology"],
        },
        signout: {
            title: "Signing out",
            steps: ["Closing active session", "Clearing local cache"],
        },
    };

    function buildOverlay(config) {
        var overlay = document.createElement("div");
        overlay.className = "auth-transition-overlay";

        var stepsHtml = config.steps
            .map(function (label, index) {
                return (
                    '<li class="auth-transition-step" data-state="' + (index === 0 ? "active" : "pending") + '">' +
                    '<span class="auth-transition-step-icon">' +
                    '<i class="bi bi-check-lg"></i>' +
                    '<span class="auth-transition-step-dot"></span>' +
                    "</span>" +
                    '<span class="auth-transition-step-label">' + label + "</span>" +
                    "</li>"
                );
            })
            .join("");

        var iconUrl = window.NAPIQ_LOADER_ICON_URL || "";

        overlay.innerHTML =
            '<div class="auth-transition-panel">' +
            '<div class="auth-transition-icon-ring">' +
            '<span class="auth-transition-ping"></span>' +
            '<span class="auth-transition-ping auth-transition-ping--delay"></span>' +
            '<div class="auth-transition-icon-box">' +
            '<img src="' + iconUrl + '" alt="" class="auth-transition-logo">' +
            "</div>" +
            "</div>" +
            '<h2 class="auth-transition-title">' + config.title + "</h2>" +
            '<ul class="auth-transition-steps">' + stepsHtml + "</ul>" +
            '<div class="auth-transition-progress"><div class="auth-transition-progress-bar"></div></div>' +
            "</div>";

        document.body.appendChild(overlay);
        // Added in its 0-opacity state above, then flipped on the next
        // frame so the CSS opacity transition actually plays instead
        // of the overlay just appearing already-visible.
        requestAnimationFrame(function () {
            overlay.classList.add("is-visible");
        });

        return overlay;
    }

    function runStepAnimation(overlay, stepCount) {
        var steps = overlay.querySelectorAll(".auth-transition-step");
        var bar = overlay.querySelector(".auth-transition-progress-bar");

        requestAnimationFrame(function () {
            bar.style.transitionDuration = DURATION_MS + "ms";
            bar.style.width = "100%";
        });

        for (var i = 0; i < stepCount; i++) {
            (function (index) {
                var atTime = Math.round((DURATION_MS * (index + 1)) / (stepCount + 1));
                setTimeout(function () {
                    steps[index].setAttribute("data-state", "done");
                    if (steps[index + 1]) {
                        steps[index + 1].setAttribute("data-state", "active");
                    }
                }, atTime);
            })(i);
        }
    }

    document.addEventListener("submit", function (event) {
        var form = event.target;
        if (!(form instanceof HTMLFormElement)) return;

        var kind = form.getAttribute("data-auth-transition");
        var config = CONFIGS[kind];
        if (!config) return;

        // Already playing (e.g. an extra click on the submit button
        // while the overlay is up) -- swallow it rather than letting a
        // second real submission through early.
        if (form.dataset.napiqTransitioning) {
            event.preventDefault();
            return;
        }

        event.preventDefault();
        form.dataset.napiqTransitioning = "true";

        var overlay = buildOverlay(config);
        runStepAnimation(overlay, config.steps.length);

        setTimeout(function () {
            form.submit();
        }, DURATION_MS);
    });
})();
