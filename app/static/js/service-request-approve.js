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
    const optionsUrl = form.getAttribute("data-options-url") || "";
    const assignUrl = form.getAttribute("data-assign-url") || "";

    function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value == null ? "" : String(value);
        return div.innerHTML;
    }

    // ------------------------------------------------------------------
    // Forced "assign a technician" flow: after approving, a modal popup
    // appears over a full-screen overlay. Clicking outside it, Escape and
    // browser back do not dismiss it -- the only way out is to assign a
    // technician (step 1: "Assign Now", step 2: pick from the list).
    // ------------------------------------------------------------------
    function ensureStyles() {
        if (document.getElementById("napiqApproveToastStyles")) return;
        const style = document.createElement("style");
        style.id = "napiqApproveToastStyles";
        style.textContent = [
            "#napiqApproveOverlay{position:fixed;inset:0;z-index:2000;background:rgba(15,23,42,.55);",
            "display:flex;align-items:center;justify-content:center;padding:1rem;overflow-y:auto;}",
            "#napiqApproveToast{background:#fff;color:#1f2937;padding:2rem 2.25rem;border-radius:1.1rem;",
            "box-shadow:0 1.25rem 3rem rgba(15,23,42,.28);display:flex;flex-direction:column;align-items:center;",
            "gap:1rem;text-align:center;width:100%;max-width:360px;margin:auto;",
            "animation:napiqPop .18s ease;}",
            "#napiqApproveToast.napiq-wide{max-width:480px;align-items:stretch;text-align:left;padding:1.5rem;}",
            "@keyframes napiqPop{from{opacity:0;transform:scale(.96);}to{opacity:1;transform:none;}}",
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
            "#napiqApproveToast .napiq-toast-actions{display:flex;gap:.5rem;margin-top:.25rem;}",
            "#napiqApproveToast .napiq-toast-btn{border:none;border-radius:.6rem;padding:.6rem 1.3rem;",
            "font-weight:600;font-size:.92rem;cursor:pointer;}",
            "#napiqApproveToast .napiq-toast-btn:disabled{opacity:.55;cursor:not-allowed;}",
            "#napiqApproveToast .napiq-toast-btn-primary{background:#16a34a;color:#fff;}",
            "#napiqApproveToast .napiq-toast-btn-primary:hover:not(:disabled){background:#15803d;}",
            /* technician list */
            "#napiqApproveToast .napiq-tl-title{font-weight:700;font-size:1.15rem;margin:0;}",
            "#napiqApproveToast .napiq-tl-sub{font-size:.85rem;color:#6b7280;margin:.15rem 0 0;}",
            "#napiqApproveToast .napiq-tl-list{display:flex;flex-direction:column;gap:.5rem;max-height:52vh;overflow-y:auto;padding:.15rem;}",
            "#napiqApproveToast .napiq-tl-item{display:flex;align-items:center;gap:.75rem;width:100%;text-align:left;",
            "background:#fff;border:2px solid #e5e7eb;border-radius:.8rem;padding:.7rem .85rem;cursor:pointer;font:inherit;color:inherit;}",
            "#napiqApproveToast .napiq-tl-item:hover{border-color:#93c5fd;}",
            "#napiqApproveToast .napiq-tl-item.is-selected{border-color:#16a34a;background:#f0fdf4;}",
            "#napiqApproveToast .napiq-tl-avatar{flex:0 0 38px;height:38px;border-radius:50%;background:#e0e7ff;color:#3730a3;",
            "display:flex;align-items:center;justify-content:center;font-weight:700;}",
            "#napiqApproveToast .napiq-tl-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;}",
            "#napiqApproveToast .napiq-tl-name{font-weight:600;overflow-wrap:anywhere;}",
            "#napiqApproveToast .napiq-tl-meta{font-size:.78rem;color:#6b7280;}",
            "#napiqApproveToast .napiq-tl-badge{flex:0 0 auto;font-size:.72rem;font-weight:700;border-radius:999px;padding:.2rem .6rem;}",
            "#napiqApproveToast .napiq-tl-badge--recommended{background:#dcfce7;color:#166534;}",
            "#napiqApproveToast .napiq-tl-badge--available{background:#dbeafe;color:#1e40af;}",
            "#napiqApproveToast .napiq-tl-badge--busy{background:#fef3c7;color:#92400e;}",
            "#napiqApproveToast .napiq-tl-badge--offline{background:#e5e7eb;color:#374151;}",
            "#napiqApproveToast .napiq-tl-error{background:#fee2e2;color:#991b1b;border-radius:.6rem;padding:.6rem .8rem;font-size:.85rem;}",
            "#napiqApproveToast .napiq-tl-footer{display:flex;justify-content:flex-end;margin-top:.25rem;}",
        ].join("");
        document.head.appendChild(style);
    }

    function getOverlay() {
        ensureStyles();
        let overlay = document.getElementById("napiqApproveOverlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "napiqApproveOverlay";
            // Clicking the dark area does nothing on purpose (forced flow).
            overlay.addEventListener("click", (e) => e.stopPropagation());
            const card = document.createElement("div");
            card.id = "napiqApproveToast";
            card.setAttribute("role", "dialog");
            card.setAttribute("aria-modal", "true");
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            document.body.style.overflow = "hidden";
            // Escape must not close it either.
            document.addEventListener("keydown", blockEscape, true);
        }
        return overlay.querySelector("#napiqApproveToast");
    }

    function blockEscape(e) {
        if (e.key === "Escape" && document.getElementById("napiqApproveOverlay")) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    /** Step 1: "approved" confirmation with a single Assign Now button. */
    function showApprovedStep(message, onAssignNow) {
        const card = getOverlay();
        card.classList.remove("napiq-wide");
        card.innerHTML =
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
            '<div class="napiq-toast-actions">' +
                '<button type="button" class="napiq-toast-btn napiq-toast-btn-primary" data-toast-action="assign">Assign Now</button>' +
            "</div>";
        card.querySelector('[data-toast-action="assign"]').addEventListener("click", onAssignNow);
    }

    /** Step 2: list every technician (Recommended / Available / Busy / Offline). */
    function showTechnicianStep() {
        const card = getOverlay();
        card.classList.add("napiq-wide");
        card.innerHTML =
            "<div><h3 class=\"napiq-tl-title\">Assign a technician</h3>" +
            "<p class=\"napiq-tl-sub\">Choose who will handle this installation.</p></div>" +
            '<div class="napiq-tl-list" data-tl-list><div class="napiq-tl-sub">Loading technicians\u2026</div></div>' +
            '<div class="napiq-tl-error" data-tl-error hidden></div>' +
            '<div class="napiq-tl-footer">' +
                '<button type="button" class="napiq-toast-btn napiq-toast-btn-primary" data-tl-assign disabled>Assign Technician</button>' +
            "</div>";

        const listEl = card.querySelector("[data-tl-list]");
        const errorEl = card.querySelector("[data-tl-error]");
        const assignBtn = card.querySelector("[data-tl-assign]");
        let selectedId = null;

        function showError(text) {
            errorEl.textContent = text;
            errorEl.hidden = false;
        }

        function select(id) {
            selectedId = id;
            listEl.querySelectorAll(".napiq-tl-item").forEach((el) => {
                el.classList.toggle("is-selected", Number(el.getAttribute("data-id")) === id);
            });
            assignBtn.disabled = selectedId == null;
        }

        fetch(optionsUrl, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then(({ ok, data }) => {
                if (!ok) throw new Error();
                const techs = data.technicians || [];
                if (data.already_assigned) {
                    window.location.reload();
                    return;
                }
                if (!techs.length) {
                    listEl.innerHTML = '<div class="napiq-tl-sub">No technicians are set up yet. Add a technician first, then assign one from the Dispatch Board.</div>';
                    showError("There is no technician to assign right now.");
                    return;
                }
                listEl.innerHTML = techs.map((t) => {
                    const bits = [];
                    bits.push(t.open_jobs + " open job" + (t.open_jobs === 1 ? "" : "s"));
                    if (t.distance_km != null) bits.push(t.distance_km + " km away");
                    if (t.phone) bits.push(t.phone);
                    return '<button type="button" class="napiq-tl-item" data-id="' + t.id + '">' +
                        '<span class="napiq-tl-avatar">' + escapeHtml((t.name || "?").trim().charAt(0).toUpperCase()) + "</span>" +
                        '<span class="napiq-tl-main"><span class="napiq-tl-name">' + escapeHtml(t.name) + "</span>" +
                        '<span class="napiq-tl-meta">' + escapeHtml(bits.join(" \u00b7 ")) + "</span></span>" +
                        '<span class="napiq-tl-badge napiq-tl-badge--' + escapeHtml(t.status) + '">' + escapeHtml(t.status_label) + "</span>" +
                        "</button>";
                }).join("");
                listEl.querySelectorAll(".napiq-tl-item").forEach((el) => {
                    el.addEventListener("click", () => select(Number(el.getAttribute("data-id"))));
                });
                // Pre-select the recommended technician (top of the list).
                const rec = techs.find((t) => t.status === "recommended");
                if (rec) select(rec.id);
                if (!data.dispatchable) {
                    showError("This request isn't scheduled yet, so a technician can't be dispatched from here. Use the Dispatch Board.");
                    assignBtn.disabled = true;
                    selectedId = null;
                }
            })
            .catch(() => {
                listEl.innerHTML = "";
                showError("Couldn't load the technician list. Please check your connection and try again.");
                assignBtn.textContent = "Try again";
                assignBtn.disabled = false;
                assignBtn.onclick = () => showTechnicianStep();
            });

        assignBtn.addEventListener("click", () => {
            if (assignBtn.onclick || selectedId == null) return;
            assignBtn.disabled = true;
            assignBtn.textContent = "Assigning\u2026";
            errorEl.hidden = true;
            fetch(assignUrl, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-CSRFToken": CSRF_TOKEN, Accept: "application/json" },
                body: JSON.stringify({ technician_id: selectedId }),
            })
                .then((r) => r.json().catch(() => ({})).then((data) => ({ ok: r.ok, data })))
                .then(({ ok, data }) => {
                    if (!ok || !data.ok) {
                        showError((data && data.message) || "Couldn't assign this technician. Please try again.");
                        assignBtn.disabled = false;
                        assignBtn.textContent = "Assign Technician";
                        return;
                    }
                    card.classList.remove("napiq-wide");
                    card.innerHTML =
                        '<div class="napiq-toast-icon-wrap"><div class="napiq-toast-circle"><i class="bi bi-check-lg"></i></div></div>' +
                        '<div class="napiq-toast-text">' + escapeHtml(data.message || "Technician assigned.") + "</div>";
                    setTimeout(() => window.location.reload(), 1100);
                })
                .catch(() => {
                    showError("Couldn't reach the server. Please try again.");
                    assignBtn.disabled = false;
                    assignBtn.textContent = "Assign Technician";
                });
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
                showApprovedStep(
                    data.message || "Service request was approved.",
                    () => showTechnicianStep()
                );
            })
            .catch(() => {
                // Network hiccup or similar -- fall back to a normal
                // full-page submit rather than leaving the admin stuck.
                form.submit();
            });
    });
})();
