/**
 * Topbar notification bell popover.
 * ----------------------------------
 * The popover itself (open/close/position) is plain Bootstrap
 * dropdown markup — no JS needed for that part, same as every other
 * `data-bs-toggle="dropdown"` in this app. The one bit of behavior
 * that isn't "free" from Bootstrap is Facebook-style "clicking an
 * unread item marks it read": each unread `<a class="notif-dropdown-item">`
 * carries a `data-mark-read-url`, and on click this fires that
 * mark-as-read POST in the background (fire-and-forget, `keepalive`
 * so it survives the page unload) while letting the link's own
 * `href` navigate normally — no need to block or delay the click to
 * wait for a response neither the user nor this script cares about.
 */
(function () {
    var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : "";

    document.querySelectorAll(".notif-dropdown-item[data-mark-read-url]").forEach(function (item) {
        item.addEventListener("click", function () {
            fetch(item.getAttribute("data-mark-read-url"), {
                method: "POST",
                credentials: "same-origin",
                keepalive: true,
                headers: {
                    "X-CSRFToken": CSRF_TOKEN,
                    "X-Requested-With": "XMLHttpRequest",
                },
            }).catch(function () {
                /* Best-effort only — the item still opened its target page
                   either way, and it'll just show as unread next time. */
            });
            // No preventDefault(): the anchor's own href continues to
            // navigate the browser exactly as it would with no listener
            // attached at all.
        });
    });
})();
