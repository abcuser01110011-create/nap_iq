/**
 * Service request "Approve" quick action (service_requests/form.html,
 * read-only detail page). Approving already advances the request
 * straight to 'scheduled' server-side (see approve_request()'s own
 * docstring in app/routes/service_requests.py) so it lands on the
 * Dispatch Board in one click -- but the admin still has to know
 * that happened and decide whether to go assign a field assistant
 * right now or leave it for later. Rather than a plain flash message
 * and a full-page redirect, this submits the same form over fetch()
 * and shows a decision toast in the same visual language as the
 * GeoMap's "Ticket Successfully Created!" toast (see
 * app/static/js/tickets.js's showTicketSuccessToast()) -- just with
 * two buttons instead of auto-dismissing, since this one needs an
 * actual choice rather than only a confirmation.
 *
 * Progressive enhancement: if fetch/JS fails for any reason, the form
 * still has its normal method="post" action -- a plain browser
 * submit still works, it just falls back to approve_request()'s
 * classic flash+redirect response instead of this toast.
 */
(function () {
    const form = document.getElementById("approveRequestForm");
    if (!form) return;

    const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
    const dispatchUrl = form.getAttribute("data-dispatch-url") || "/dispatch/";

    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    // ------------------------------------------------------------------
    // Decision toast -- same card/icon/dots visual language as
    // tickets.js's showTicketSuccessToast(), own style block/ids so
    // this page never has to load tickets.js just for this.
    // ------------------------------------------------------------------
    function ensureToastStyles() {
        if (document.getElementById("napiqApproveToastStyles")) return;
        const style = document.createElement("style");
        style.id = "napiqApproveToastStyles";
        style.textContent = [
            "#napiqApproveToast{position:fixed;top:50%;left:50%;",
            "transform:translate(-50%,-50%) scale(.96);z-index:2000;",
            "background:#fff;color:#1f2937;padding:2rem 2.75rem;",
            "border-radius:1.1rem;box-shadow:0 1.25rem 3rem rgba(15,23,42,.28);",
            "display:flex;flex-direction:column;align-items:center;gap:1rem;",
            "text-align:center;opacity:0;min-width:280px;max-width:360px;",
            "transition:opacity .18s ease, transform .18s ease;}",
            "#napiqApproveToast.napiq-toast-show{opacity:1;transform:translate(-50%,-50%) scale(1);}",
            "#napiqApproveToast .napiq-toast-icon-wrap{position:relative;width:96px;height:96px;",
            "display:flex;align-items:center;justify-content:center;}",
            "#napiqApproveToast .napiq-toast-circle{width:64px;height:64px;border-radius:50%;",
            "background:#e3f9ec;display:flex;align-items:center;justify-content:center;",
            "box-shadow:0 0 0 6px rgba(34,197,94,.08);}",
            "#napiqApproveToast .napiq-toast-circle i{color:#16a34a;font-size:2rem;line-height:1;}",
            "#napiqApproveToast .napiq-toast-dot{position:absolute;border-radius:50%;}",
            "#napiqApproveToast .napiq-toast-dot-1{width:7px;height:7px;background:#60a5fa;top:2px;left:14px;}",
            "#napiqApproveToast .napiq-toast-dot-2{width:5px;height:5px;background:#fbbf24;top:10px;right:6px;}",
            "#napiqApproveToast .napiq-toast-dot-3{width:6px;height:6px;background:#34d399;bottom:14px;left:0;}",
            "#napiqApproveToast .napiq-toast-dot-4{width:4px;height:4px;background:#60a5fa;bottom:4px;right:16px;}",
            "#napiqApproveToast .napiq-toast-dot-5{width:5px;height:5px;background:#fbbf24;top:34px;left:-6px;}",
            "#napiqApproveToast .napiq-toast-dot-6{width:4px;height:4px;background:#34d399;top:30px;right:-8px;}",
            "#napiqApproveToast .napiq-toast-text{font-weight:700;font-size:1.2rem;color:#1f2937;}",
            "#napiqApproveToast .napiq-toast-subtext{font-size:.9rem;color:#6b7280;margin-top:-.5rem;}",
            "#napiqApproveToast .napiq-toast-actions{display:flex;gap:.5rem;margin-top:.25rem;}",
            "#napiqApproveToast .napiq-toast-btn{border:none;border-radius:.6rem;padding:.55rem 1.1rem;",
            "font-weight:600;font-size:.9rem;cursor:pointer;}",
            "#napiqApproveToast .napiq-toast-btn-primary{background:#16a34a;color:#fff;}",
            "#napiqApproveToast .napiq-toast-btn-primary:hover{background:#15803d;}",
            "#napiqApproveToast .napiq-toast-btn-secondary{background:#f3f4f6;color:#374151;}",
            "#napiqApproveToast .napiq-toast-btn-secondary:hover{background:#e5e7eb;}",
        ].join("");
        document.head.appendChild(style);
    }

    /** Shows the decision toast. `onAssignNow`/`onLater` are called
     *  once the admin picks a button; the toast dismisses itself
     *  either way. There's no auto-dismiss and no click-anywhere
     *  dismiss here (unlike the ticket-created toast) since this one
     *  is a real decision, not just a confirmation the admin can
     *  glance at and ignore. */
    function showApproveDecisionToast(message, onAssignNow, onLater) {
        ensureToastStyles();

        const existing = document.getElementById("napiqApproveToast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.id = "napiqApproveToast";
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-live", "polite");
        toast.innerHTML =
            '<div class="napiq-toast-icon-wrap">' +
                '<span class="napiq-toast-dot napiq-toast-dot-1"></span>' +
                '<span class="napiq-toast-dot napiq-toast-dot-2"></span>' +
                '<span class="napiq-toast-dot napiq-toast-dot-3"></span>' +
                '<span class="napiq-toast-dot napiq-toast-dot-4"></span>' +
                '<span class="napiq-toast-dot napiq-toast-dot-5"></span>' +
                '<span class="napiq-toast-dot napiq-toast-dot-6"></span>' +
                '<div class="napiq-toast-circle"><i class="bi bi-check-lg"></i></div>' +
            "</div>" +
            '<div class="napiq-toast-text">' + escapeHtml(message) + "</div>" +
            '<div class="napiq-toast-subtext">A ticket is ready on the Dispatch Board.</div>' +
            '<div class="napiq-toast-actions">' +
                '<button type="button" class="napiq-toast-btn napiq-toast-btn-secondary" data-toast-action="later">Later</button>' +
                '<button type="button" class="napiq-toast-btn napiq-toast-btn-primary" data-toast-action="assign">Assign Now</button>' +
            "</div>";
        document.body.appendChild(toast);
        void toast.offsetWidth;
        toast.classList.add("napiq-toast-show");

        function dismiss() {
            toast.classList.remove("napiq-toast-show");
            setTimeout(() => toast.remove(), 200);
        }

        toast.querySelector('[data-toast-action="assign"]').addEventListener("click", () => {
            dismiss();
            onAssignNow();
        });
        toast.querySelector('[data-toast-action="later"]').addEventListener("click", () => {
            dismiss();
            onLater();
        });
    }

    form.addEventListener("submit", function (event) {
        event.preventDefault();

        if (!confirm("Approve this service request?")) return;

        const submitBtn = form.querySelector("button[type=submit]");
        if (submitBtn) submitBtn.disabled = true;

        fetch(form.action, {
            method: "POST",
            headers: {
                "X-CSRFToken": CSRF_TOKEN,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: new FormData(form),
        })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then(({ ok, data }) => {
                if (!ok) {
                    alert((data && data.message) || "Could not approve this request.");
                    if (submitBtn) submitBtn.disabled = false;
                    return;
                }
                showApproveDecisionToast(
                    data.message || "Service request was approved.",
                    () => { window.location.href = dispatchUrl; },
                    () => { window.location.reload(); }
                );
            })
            .catch(() => {
                // Network hiccup or similar -- fall back to a normal
                // full-page submit rather than leaving the admin stuck.
                // Note: HTMLFormElement.submit() intentionally does not
                // re-fire the "submit" event, so this can't loop back
                // into this same handler.
                form.submit();
            });
    });
})();
