// Auto-dismisses the login page's flash toasts (see .login-toast-stack /
// .login-flash in login.css) ~3 seconds after they appear, instead of
// leaving them sitting on screen until the next page load.
(function () {
    var AUTOHIDE_MS = 3000;

    document.querySelectorAll("[data-toast-autohide]").forEach(function (toast) {
        setTimeout(function () {
            toast.classList.add("is-hiding");
            // Remove it once the fade-out animation finishes so it
            // doesn't leave an empty gap behind in the stack.
            toast.addEventListener(
                "animationend",
                function () {
                    toast.remove();
                },
                { once: true }
            );
        }, AUTOHIDE_MS);
    });
})();
