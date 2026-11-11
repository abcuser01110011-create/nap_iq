/**
 * Notification popup.
 * --------------------
 * Clicking a notification (in the topbar bell dropdown, or on the
 * Notifications page) opens a popup with its full title/message/time
 * instead of navigating to another page. Any element carrying
 * `data-notif-title` is a trigger; it may also carry:
 *   data-notif-message, data-notif-time  -> shown in the popup
 *   data-notif-link                      -> adds a "View details" button
 *   data-mark-read-url                   -> POSTed in the background so the
 *                                           notification is marked read
 */
(function () {
    var meta = document.querySelector('meta[name="csrf-token"]');
    var CSRF_TOKEN = meta ? meta.getAttribute("content") : "";

    var modalEl = document.getElementById("notifDetailModal");
    if (!modalEl) return;
    var modal = window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(modalEl) : null;
    var els = {
        title: document.getElementById("notifDetailTitle"),
        time: document.getElementById("notifDetailTime"),
        message: document.getElementById("notifDetailMessage"),
        open: document.getElementById("notifDetailOpen")
    };

    function markRead(item) {
        var url = item.getAttribute("data-mark-read-url");
        if (!url) return;
        item.removeAttribute("data-mark-read-url");
        fetch(url, {
            method: "POST",
            credentials: "same-origin",
            keepalive: true,
            headers: { "X-CSRFToken": CSRF_TOKEN, "X-Requested-With": "XMLHttpRequest" }
        }).then(function (r) {
            if (r.ok) markReadInUi(item);
        }).catch(function () { /* best effort: it just stays unread until next time */ });
    }

    function markReadInUi(item) {
        item.classList.remove("notif-unread", "notif-item--unread");
        item.querySelectorAll(".notif-dot").forEach(function (d) {
            if (d.classList.contains("align-self-start")) d.remove();
            else d.style.background = "transparent";
        });
        var badge = document.querySelector("#notifBellToggle .badge");
        if (badge) {
            var n = parseInt(badge.textContent, 10) - 1;
            if (n > 0) badge.textContent = n; else badge.remove();
        }
        var pill = item.querySelector(".disp-badge-pending");
        if (pill) {
            pill.textContent = "Read";
            pill.classList.remove("disp-badge-pending");
            pill.classList.add("disp-badge-closed");
        }
        var check = item.querySelector("form[action*='/read']");
        if (check) check.remove();
    }

    function show(item) {
        els.title.textContent = item.getAttribute("data-notif-title") || "Notification";
        els.time.textContent = item.getAttribute("data-notif-time") || "";
        els.message.textContent = item.getAttribute("data-notif-message") || "";
        var link = item.getAttribute("data-notif-link");
        if (link) {
            els.open.setAttribute("href", link);
            els.open.classList.remove("d-none");
        } else {
            els.open.classList.add("d-none");
        }
        markRead(item);
        if (modal) modal.show();
    }

    document.addEventListener("click", function (e) {
        if (e.target.closest("form")) return; // the row's own "mark as read" button
        var item = e.target.closest("[data-notif-title]");
        if (!item) return;
        e.preventDefault();
        // Close the bell dropdown first so the popup isn't stacked under it.
        var toggle = document.getElementById("notifBellToggle");
        if (toggle && item.closest(".notif-dropdown") && window.bootstrap) {
            var dd = window.bootstrap.Dropdown.getInstance(toggle);
            if (dd) dd.hide();
        }
        show(item);
    });
})();
