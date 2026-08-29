// Auto-dismisses the post-login .flash-stack toasts (see style.css /
// theme-dark.css) ~3 seconds after they appear, instead of leaving
// them on screen until the person clicks the close button themselves.
// Same 3-second timing as the login page's own toasts
// (login-toast.js) and the GeoMap's alert-area toasts
// (napmap.js's showAlert()), so every toast in the app now
// auto-dismisses after the same interval.
(function () {
    var AUTOHIDE_MS = 3000;

    document.querySelectorAll(".flash-stack .alert").forEach(function (toast) {
        setTimeout(function () {
            // Bootstrap's own Alert component handles the fade-out and
            // removes the element from the DOM once it finishes —
            // same as clicking the toast's own close button.
            bootstrap.Alert.getOrCreateInstance(toast).close();
        }, AUTOHIDE_MS);
    });
})();
