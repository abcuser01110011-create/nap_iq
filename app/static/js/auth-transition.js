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
// duration sized to the user's current connection, then form.submit()
// fires the real POST. form.submit() does not re-trigger the 'submit'
// event, so this can't loop, and because it's a real navigation,
// success (redirect to the dashboard) and failure (login page
// re-rendered with a flashed error) both come back through completely
// unchanged -- this file never has to know or guess which one
// happened.
//
// Duration + a live "connection" readout come from network-speed.js
// (window.NAPIQNetworkSpeed), which must be loaded first. If it isn't
// present for some reason, this falls back to the old fixed 3s so the
// overlay still works.
(function () {
    var FALLBACK_DURATION_MS = 3000;
    var FALLBACK_QUALITY_DURATION_MS = { fast: 1800, moderate: 2800, slow: 4200, offline: 4200 };

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

    function networkSpeed() {
        return window.NAPIQNetworkSpeed || null;
    }

    function currentNetworkState() {
        var ns = networkSpeed();
        if (ns) return ns.getState();
        return { quality: "unknown", downlinkMbps: null, source: "unavailable" };
    }

    function durationForQuality(quality) {
        var ns = networkSpeed();
        var table = (ns && ns.QUALITY_DURATION_MS) || FALLBACK_QUALITY_DURATION_MS;
        return table[quality] || FALLBACK_DURATION_MS;
    }

    function networkLabel(state) {
        switch (state.quality) {
            case "fast":
                return "Fast connection";
            case "moderate":
                return "Stable connection";
            case "slow":
                return "Slow connection";
            case "offline":
                return "No connection detected";
            default:
                return "Checking connection\u2026";
        }
    }

    function buildOverlay(config, netState) {
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
            '<div class="auth-transition-network" data-quality="' + netState.quality + '">' +
            '<span class="auth-transition-network-dot"></span>' +
            '<span class="auth-transition-network-label">' + networkLabel(netState) + "</span>" +
            "</div>" +
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

    function updateNetworkReadout(overlay, netState) {
        var el = overlay.querySelector(".auth-transition-network");
        if (!el) return;
        el.setAttribute("data-quality", netState.quality);
        var label = el.querySelector(".auth-transition-network-label");
        if (label) label.textContent = networkLabel(netState);
    }

    // Drives both the numbered step list and the progress bar off a
    // single total duration, and exposes `retarget()` so the running
    // animation can be reaimed at a new total duration mid-flight
    // (used when the live network reading changes while the overlay
    // is already showing) without visibly jumping.
    function runStepAnimation(overlay, stepCount, totalDuration) {
        var steps = overlay.querySelectorAll(".auth-transition-step");
        var bar = overlay.querySelector(".auth-transition-progress-bar");
        var stepTimers = [];

        function scheduleSteps(duration, elapsed) {
            stepTimers.forEach(clearTimeout);
            stepTimers = [];
            for (var i = 0; i < stepCount; i++) {
                (function (index) {
                    var atTime = Math.round((duration * (index + 1)) / (stepCount + 1));
                    var delay = atTime - elapsed;
                    if (delay <= 0) {
                        steps[index].setAttribute("data-state", "done");
                        if (steps[index + 1]) steps[index + 1].setAttribute("data-state", "active");
                        return;
                    }
                    stepTimers.push(
                        setTimeout(function () {
                            steps[index].setAttribute("data-state", "done");
                            if (steps[index + 1]) steps[index + 1].setAttribute("data-state", "active");
                        }, delay)
                    );
                })(i);
            }
        }

        function driveBar(duration, elapsed) {
            var remaining = Math.max(duration - elapsed, 50);
            if (elapsed <= 0) {
                requestAnimationFrame(function () {
                    bar.style.transition = "width " + duration + "ms linear";
                    bar.style.width = "100%";
                });
                return;
            }
            // Freeze the bar at its current on-screen width first, then
            // retarget the transition to reach 100% over whatever time
            // is left -- avoids a visible snap when the target duration
            // changes mid-animation.
            var frozenWidth = getComputedStyle(bar).width;
            bar.style.transition = "none";
            bar.style.width = frozenWidth;
            void bar.offsetWidth; // force reflow so the transition-none takes effect first
            requestAnimationFrame(function () {
                bar.style.transition = "width " + remaining + "ms linear";
                bar.style.width = "100%";
            });
        }

        scheduleSteps(totalDuration, 0);
        driveBar(totalDuration, 0);

        return {
            retarget: function (newDuration, elapsed) {
                scheduleSteps(newDuration, elapsed);
                driveBar(newDuration, elapsed);
            },
        };
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

        var startedAt = Date.now();
        var netState = currentNetworkState();
        var plannedDuration = netState.quality === "unknown" ? FALLBACK_DURATION_MS : durationForQuality(netState.quality);

        var overlay = buildOverlay(config, netState);
        var animation = runStepAnimation(overlay, config.steps.length, plannedDuration);

        var submitTimer = setTimeout(submitForm, plannedDuration);

        function submitForm() {
            if (unsubscribe) unsubscribe();
            form.submit();
        }

        // Real time: if the connection's measured quality changes
        // while the overlay is up (a Network Information API `change`
        // event, or a fresh active-probe result landing), reflect it
        // in the readout immediately, and -- if it's a big enough
        // swing -- retarget the remaining animation so a connection
        // that turns out to be slower than first read doesn't leave
        // the bar sitting at 100% waiting on a still-pending request
        // (or, symmetrically, doesn't make a fast connection wait out
        // a needlessly long animation).
        var ns = networkSpeed();
        var unsubscribe = ns
            ? ns.subscribe(function (nextState) {
                  updateNetworkReadout(overlay, nextState);

                  var nextDuration = durationForQuality(nextState.quality);
                  if (nextDuration === plannedDuration) return;

                  var elapsed = Date.now() - startedAt;
                  var remainingPlanned = plannedDuration - elapsed;
                  if (remainingPlanned <= 150) return; // basically done already; not worth reaiming

                  var remainingNext = nextDuration - elapsed;
                  if (Math.abs(remainingNext - remainingPlanned) < 250) return; // not a meaningful swing

                  clearTimeout(submitTimer);
                  plannedDuration = Math.max(nextDuration, elapsed + 250);
                  animation.retarget(plannedDuration, elapsed);
                  submitTimer = setTimeout(submitForm, plannedDuration - elapsed);
              })
            : null;
    });
})();
