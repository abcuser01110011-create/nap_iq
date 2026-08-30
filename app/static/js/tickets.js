/**
 * GeoMap "+ Tickets" quick-create dropdown + modal.
 *
 * Replaces the old "Table View" link. The dropdown offers two
 * groups: Service Order (SO) and Trouble Ticket (TN). Clicking a
 * type opens #ticketFormModal (see naps/map.html), reconfigured for
 * that category:
 *
 *   - SO "Add NAP" doesn't open the modal at all -- it just clicks
 *     the page's own existing #addNapModeBtn, since Add NAP is
 *     already a full feature here.
 *   - SO "New Installation" / "Relocation" submit to
 *     POST /service-requests/quick-add (app/routes/service_requests.py).
 *     Location is a free Barangay picker (Santa Cruz, Laguna, via the
 *     public PSGC API) since a service_request has no "must match a
 *     subscriber's exact pin" rule.
 *   - TN types submit to the existing POST /issues/report
 *     (app/routes/issues.py). That route requires the submitted
 *     latitude/longitude to exactly match the selected subscriber's
 *     own registered location (the "pin error" rule already used by
 *     the Report an Issue modal) -- so for TN, Location is a
 *     read-only field auto-filled from the chosen subscriber instead
 *     of a free picker.
 *
 * Priority/Assigned Team/Technician/Scheduled are collected in both
 * forms, but only Priority (TN) and Status (SO) map onto real
 * columns today -- the rest are folded into the description/notes
 * text server-side so nothing typed is lost. See the two routes'
 * docstrings for the full explanation.
 */
(function () {
    "use strict";

    const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').content
        : "";

    // Santa Cruz, Laguna's PSGC city/municipality code.
    // (Was 0403400000 -- not a real PSGC code, so this silently
    // 404'd and cached itself as an empty list. Santa Cruz, Laguna's
    // actual code is 0403426000.)
    //
    // psgc.gitlab.io itself has since become unreliable (frequent
    // 403/timeouts from this host), so this now points at PSGC
    // Cloud's equivalent "barangays of a city/municipality" endpoint
    // instead -- same code scheme, same request shape, just a host
    // that's actually up. See loadBarangays() below for why the
    // response is parsed defensively rather than assumed to be a
    // bare array.
    const BARANGAY_API_URL = "https://psgc.cloud/api/cities-municipalities/0403426000/barangays";

    let modalInstance = null;
    let currentCategory = "SO"; // "SO" | "TN"
    let currentTypeValue = ""; // e.g. "new_installation", "Fiber Break", "Repair"
    let barangaysLoaded = false;
    let barangaysLoading = false;
    let allBarangays = [];
    let allSubscribers = [];
    let subscribersLoaded = false;
    let selectedSubscriber = null; // {id, subscriber_code, full_name, address, latitude, longitude}
    let addedTechnicians = []; // [{id, full_name}]
    let allNaps = []; // Fiber Break's NAP picker (loaded lazily, once)
    let napsLoaded = false;
    let selectedNap = null; // {id, nap_code, name, address}

    // Fiber Break is the one TN type that reports against a whole NAP
    // rather than a single subscriber -- see applyCategory()/submitFiberBreak()
    // below for what that changes in the form and on submit.
    function isFiberBreakForm() {
        return currentCategory === "TN" && currentTypeValue === "Fiber Break";
    }

    function escapeHtml(str) {
        return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    function todayLabel() {
        const d = new Date();
        return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }

    // ------------------------------------------------------------------
    // Data loading (lazy, once)
    // ------------------------------------------------------------------

    // Fetched lazily, once, and cached in allBarangays for client-side
    // filtering (same shape as loadSubscribers() below). Unlike the
    // old <select> version, a failed fetch doesn't get stuck forever:
    // barangaysLoaded only flips to true on success, so the next time
    // the field is focused it tries again instead of silently staying
    // empty for the rest of the session.
    function loadBarangays() {
        if (barangaysLoaded || barangaysLoading) return Promise.resolve();
        barangaysLoading = true;
        return fetch(BARANGAY_API_URL)
            .then((r) => {
                if (!r.ok) throw new Error("barangay API responded " + r.status);
                return r.json();
            })
            .then((payload) => {
                // Different PSGC-style hosts wrap the list differently
                // (a bare array vs. `{ data: [...] }`) -- accept either
                // instead of assuming one shape and silently caching an
                // empty list when the host's format doesn't match.
                const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.data) ? payload.data : []);
                allBarangays = list
                    .map((b) => b.name)
                    .filter(Boolean)
                    .sort((a, b) => a.localeCompare(b));
                barangaysLoaded = true;
            })
            .catch(() => {
                allBarangays = [];
            })
            .finally(() => {
                barangaysLoading = false;
            });
    }

    function loadSubscribers() {
        if (subscribersLoaded) return Promise.resolve();
        return fetch("/api/subscribers")
            .then((r) => r.json())
            .then((data) => {
                allSubscribers = data || [];
                subscribersLoaded = true;
            })
            .catch(() => {
                allSubscribers = [];
            });
    }

    function loadNaps() {
        if (napsLoaded) return Promise.resolve();
        return fetch("/api/naps")
            .then((r) => r.json())
            .then((data) => {
                allNaps = data || [];
                napsLoaded = true;
            })
            .catch(() => {
                allNaps = [];
            });
    }

    function loadNextTicketCode(category) {
        const codeInput = document.getElementById("ticketFormCode");
        codeInput.value = "Loading…";
        fetch("/api/tickets/next-code?category=" + encodeURIComponent(category))
            .then((r) => r.json())
            .then((data) => {
                codeInput.value = (data && data.code) || "";
            })
            .catch(() => {
                codeInput.value = "";
            });
    }

    function loadPersonnel(personnelType, selectEl, placeholder) {
        selectEl.innerHTML = '<option value="">Loading…</option>';
        fetch("/api/personnel?type=" + encodeURIComponent(personnelType))
            .then((r) => r.json())
            .then((list) => {
                const options = ['<option value="">' + placeholder + "</option>"];
                (list || []).forEach((p) => {
                    options.push(
                        '<option value="' + p.id + '" data-name="' + escapeHtml(p.full_name) + '">' +
                            escapeHtml(p.full_name) + " (" + escapeHtml(p.status) + ")</option>"
                    );
                });
                selectEl.innerHTML = options.join("");
            })
            .catch(() => {
                selectEl.innerHTML = '<option value="">-- Could not load --</option>';
            });
    }

    // ------------------------------------------------------------------
    // Subscriber autocomplete
    // ------------------------------------------------------------------

    /* "Customer" field behaves differently per category, per how the
     * two ticket types actually use it:
     *   - TN (Trouble Ticket) needs a real subscriber match (the
     *     backend requires the pin to exactly match a registered
     *     subscriber's location), so it gets a live auto-recommend
     *     list as you type -- same floating list-group pattern the
     *     topbar's own NAP search already uses.
     *   - SO (Service Order) has no such requirement, so it stays a
     *     plain field: no list popping up while typing, just resolved
     *     against the subscriber list on blur/Enter so a name can
     *     still be linked when one matches.
     */

    function renderSubscriberResults(matches) {
        const box = document.getElementById("ticketFormSubscriberResults");
        if (!matches.length) {
            box.classList.add("d-none");
            box.innerHTML = "";
            return;
        }
        box.innerHTML = matches
            .slice(0, 8)
            .map(
                (s) =>
                    '<button type="button" class="list-group-item list-group-item-action" data-sub-id="' + s.id + '">' +
                        '<span class="fw-semibold">' + escapeHtml(s.subscriber_code) + "</span> — " +
                        escapeHtml(s.full_name) +
                        (s.address ? '<div class="small text-muted">' + escapeHtml(s.address) + "</div>" : "") +
                        "</button>"
            )
            .join("");
        box.classList.remove("d-none");
    }

    function onSubscriberInput() {
        const input = document.getElementById("ticketFormSubscriberInput");
        selectedSubscriber = null;
        document.getElementById("ticketFormSubscriberId").value = "";
        updateLocationForSubscriber();

        const term = input.value.trim().toLowerCase();

        if (!term) {
            // Nothing typed yet -- no hint text needed, and (for TN)
            // no suggestion list either.
            setSubscriberHelp("", "text-muted");
            if (currentCategory === "TN") renderSubscriberResults([]);
            return;
        }

        // Live validation for both categories: instead of a static
        // "Confirm with Tab or Enter." placeholder, show the actual
        // "no match" error as soon as what's typed doesn't match any
        // subscriber -- rather than waiting for blur/Enter (SO) or
        // only reacting once a suggestion is clicked (TN).
        loadSubscribers().then(() => {
            const matches = allSubscribers.filter(
                (s) =>
                    s.full_name.toLowerCase().includes(term) ||
                    (s.subscriber_code || "").toLowerCase().includes(term)
            );

            if (currentCategory === "TN") {
                renderSubscriberResults(matches);
            }

            if (!matches.length) {
                setSubscriberHelp("No matching customer on file for \"" + input.value.trim() + "\".", "text-danger");
            } else {
                // Still narrowing down -- clear any stale error rather
                // than showing a generic hint while they keep typing.
                setSubscriberHelp("", "text-muted");
            }
        });
    }

    function setSubscriberHelp(message, className) {
        const help = document.getElementById("ticketFormSubscriberHelp");
        if (!help) return;
        help.textContent = message;
        help.className = "form-text " + className;
    }

    function selectSubscriber(sub) {
        selectedSubscriber = sub;
        document.getElementById("ticketFormSubscriberId").value = sub.id;
        document.getElementById("ticketFormSubscriberInput").value = sub.subscriber_code + " — " + sub.full_name;
        renderSubscriberResults([]);
        setSubscriberHelp("Matched " + sub.full_name + ".", "text-success");
        updateLocationForSubscriber();
    }

    function resolveSubscriberFromInput() {
        if (currentCategory === "TN") return; // already resolved by clicking a suggestion
        const input = document.getElementById("ticketFormSubscriberInput");
        const term = input.value.trim().toLowerCase();
        if (!term) {
            selectedSubscriber = null;
            document.getElementById("ticketFormSubscriberId").value = "";
            setSubscriberHelp("", "text-muted");
            updateLocationForSubscriber();
            return;
        }
        loadSubscribers().then(() => {
            const match = allSubscribers.find(
                (s) =>
                    s.full_name.toLowerCase() === term ||
                    (s.subscriber_code || "").toLowerCase() === term ||
                    (s.subscriber_code + " — " + s.full_name).toLowerCase() === term
            );
            if (match) {
                selectedSubscriber = match;
                document.getElementById("ticketFormSubscriberId").value = match.id;
                setSubscriberHelp("Matched " + match.full_name + ".", "text-success");
            } else {
                selectedSubscriber = null;
                document.getElementById("ticketFormSubscriberId").value = "";
                setSubscriberHelp("No matching customer on file for \"" + input.value.trim() + "\".", "text-danger");
            }
            updateLocationForSubscriber();
        });
    }

    // The visible "Location" field was removed from the TN form (the
    // pin itself is never user-editable -- it's always the selected
    // subscriber's own registered coordinates, per the "pin error"
    // rule in app/routes/issues.py). This still has to run on every
    // subscriber pick for TN, though: it's what blocks submission
    // when a subscriber has no registered location on file, and it
    // now surfaces that through the existing Customer field's help
    // text instead of a dedicated field.
    function updateLocationForSubscriber() {
        if (currentCategory !== "TN") return;
        const submitBtn = document.getElementById("ticketFormSubmitBtn");
        if (!selectedSubscriber) {
            submitBtn.disabled = false;
            return;
        }
        if (selectedSubscriber.latitude == null || selectedSubscriber.longitude == null) {
            setSubscriberHelp(
                "This subscriber has no registered location on file, so a trouble ticket can't be pinned for them yet.",
                "text-danger"
            );
            submitBtn.disabled = true;
            return;
        }
        submitBtn.disabled = false;
    }

    // ------------------------------------------------------------------
    // NAP autocomplete (Fiber Break's Customer-field replacement)
    // ------------------------------------------------------------------

    /* Fiber Break reports an outage against a whole NAP, not one
     * customer, so its "Customer" field is swapped out for this NAP
     * picker instead -- same live "type to get recommendations" list-
     * group pattern the subscriber field above already uses, just
     * searching /api/naps (already loaded for the GeoMap itself) by
     * NAP code, name, or address rather than by subscriber. */

    function renderNapResults(matches) {
        const box = document.getElementById("ticketFormNapResults");
        if (!matches.length) {
            box.classList.add("d-none");
            box.innerHTML = "";
            return;
        }
        box.innerHTML = matches
            .slice(0, 8)
            .map(
                (n) =>
                    '<button type="button" class="list-group-item list-group-item-action" data-nap-id="' + n.id + '">' +
                        '<span class="fw-semibold">' + escapeHtml(n.nap_code) + "</span> — " +
                        escapeHtml(n.name) +
                        '<div class="small text-muted">' +
                            (n.address ? escapeHtml(n.address) + " · " : "") +
                            escapeHtml((n.connected_lines || []).length + " connected line(s)") +
                        "</div>" +
                        "</button>"
            )
            .join("");
        box.classList.remove("d-none");
    }

    function setNapHelp(message, className) {
        const help = document.getElementById("ticketFormNapHelp");
        if (!help) return;
        help.textContent = message;
        help.className = "form-text " + className;
    }

    function onNapInput() {
        const input = document.getElementById("ticketFormNapInput");
        selectedNap = null;
        document.getElementById("ticketFormNapId").value = "";

        const term = input.value.trim().toLowerCase();
        if (!term) {
            setNapHelp("", "text-muted");
            renderNapResults([]);
            return;
        }

        loadNaps().then(() => {
            const matches = allNaps.filter(
                (n) =>
                    (n.nap_code || "").toLowerCase().includes(term) ||
                    (n.name || "").toLowerCase().includes(term) ||
                    (n.address || "").toLowerCase().includes(term)
            );
            renderNapResults(matches);
            if (!matches.length) {
                setNapHelp("No matching NAP on file for \"" + input.value.trim() + "\".", "text-danger");
            } else {
                setNapHelp("", "text-muted");
            }
        });
    }

    function selectNap(nap) {
        selectedNap = nap;
        document.getElementById("ticketFormNapId").value = nap.id;
        document.getElementById("ticketFormNapInput").value = nap.nap_code + " — " + nap.name;
        renderNapResults([]);
        const lineCount = (nap.connected_lines || []).length;
        setNapHelp(
            "Matched " + nap.nap_code + " — " + lineCount + " connected subscriber(s) will be flagged critical.",
            "text-success"
        );
    }

    // ------------------------------------------------------------------
    // Barangay autocomplete (Location field, both categories)
    // ------------------------------------------------------------------

    function renderBarangayResults(matches) {
        const box = document.getElementById("ticketFormBarangayResults");
        if (!matches.length) {
            box.classList.add("d-none");
            box.innerHTML = "";
            return;
        }
        box.innerHTML = matches
            .slice(0, 8)
            .map((name) => '<button type="button" class="list-group-item list-group-item-action">' + escapeHtml(name) + "</button>")
            .join("");
        box.classList.remove("d-none");
    }

    function onBarangayInput() {
        const input = document.getElementById("ticketFormBarangayInput");
        const term = input.value.trim().toLowerCase();
        if (!term) {
            renderBarangayResults([]);
            return;
        }
        loadBarangays().then(() => {
            const matches = allBarangays.filter((name) => name.toLowerCase().includes(term));
            renderBarangayResults(matches);
        });
    }

    // ------------------------------------------------------------------
    // Technician chips
    // ------------------------------------------------------------------

    function renderTechnicianChips() {
        const box = document.getElementById("ticketFormTechnicianChips");
        box.innerHTML = addedTechnicians
            .map(
                (t) =>
                    '<span class="badge text-bg-light border d-inline-flex align-items-center gap-1">' +
                        escapeHtml(t.full_name) +
                        '<button type="button" class="btn-close btn-close-sm" style="font-size:.6rem;" data-remove-tech="' + t.id + '" aria-label="Remove"></button>' +
                        "</span>"
            )
            .join("");
    }

    function addTechnicianFromSelect() {
        const select = document.getElementById("ticketFormTechnicianSelect");
        const option = select.options[select.selectedIndex];
        if (!option || !option.value) return;
        const id = option.value;
        if (addedTechnicians.some((t) => String(t.id) === String(id))) return;
        addedTechnicians.push({ id, full_name: option.getAttribute("data-name") || option.textContent });
        renderTechnicianChips();
        select.value = "";
    }

    // ------------------------------------------------------------------
    // Modal open / reset / category switch
    // ------------------------------------------------------------------

    function resetForm() {
        document.getElementById("ticketForm").reset();
        document.getElementById("ticketFormGeneralError").classList.add("d-none");
        document.querySelectorAll("#ticketForm [data-error-for]").forEach((el) => (el.textContent = ""));
        document.querySelectorAll("#ticketForm .is-invalid").forEach((el) => el.classList.remove("is-invalid"));
        selectedSubscriber = null;
        selectedNap = null;
        addedTechnicians = [];
        document.getElementById("ticketFormSubscriberId").value = "";
        document.getElementById("ticketFormCustomerName").value = "";
        document.getElementById("ticketFormNapId").value = "";
        document.getElementById("ticketFormNapInput").value = "";
        document.getElementById("ticketFormPlan").value = "";
        document.getElementById("ticketFormContactNumber").value = "";
        setSubscriberHelp("", "text-muted");
        setNapHelp("", "text-muted");
        renderSubscriberResults([]);
        renderNapResults([]);
        renderBarangayResults([]);
        renderTechnicianChips();
        document.getElementById("ticketFormPriority").disabled = false;
        document.getElementById("ticketFormCreated").value = todayLabel();
        document.getElementById("ticketFormSubmitBtn").disabled = false;
    }

    function applyCategory(category, typeValue, typeLabel) {
        currentCategory = category;
        currentTypeValue = typeValue;
        const isFiberBreak = isFiberBreakForm();

        // Type is a fixed label now (set by whichever dropdown item
        // was clicked), not something the admin can change after the
        // fact -- the hidden field is what actually gets submitted.
        document.getElementById("ticketFormType").value = typeLabel;
        document.getElementById("ticketFormTypeValue").value = typeValue;

        document.getElementById("ticketFormTitle").textContent =
            category === "SO" ? "Service Order" : "Ticket Number";

        loadNextTicketCode(category);

        // Customer field is a completely different control per
        // category/type -- SO gets a plain free-text name (no lookup
        // at all, since the applicant usually isn't a subscriber
        // yet); TN keeps the live subscriber-match search, since the
        // backend requires the pin to exactly match a registered
        // subscriber's location. Fiber Break is the one exception:
        // it's a NAP-wide outage, not one customer's complaint, so it
        // swaps the Customer field out entirely for the NAP picker
        // below. Only one of the three wrappers is ever shown.
        const isSO = category === "SO";
        document.getElementById("ticketFormCustomerNameWrapper").classList.toggle("d-none", !isSO);
        document.getElementById("ticketFormSubscriberWrapper").classList.toggle("d-none", isSO || isFiberBreak);
        document.getElementById("ticketFormNapWrapper").classList.toggle("d-none", !isFiberBreak);
        document.getElementById("ticketFormSOExtraFields").classList.toggle("d-none", !isSO);

        setSubscriberHelp("", "text-muted");
        renderSubscriberResults([]);
        setNapHelp("", "text-muted");
        renderNapResults([]);
        if (isFiberBreak) loadNaps();

        // Barangay applies to SO and every other TN type (it's the
        // real submitted `barangay` for SO, and supplementary context
        // folded into the description for TN) -- but Fiber Break
        // drops it entirely: it's reported against a NAP, not a
        // barangay-scoped address, and the pin for every affected
        // ticket comes from each connected subscriber's own
        // registered location instead (see report_fiber_break() in
        // app/routes/issues.py).
        document.getElementById("ticketFormBarangayWrapper").classList.toggle("d-none", isFiberBreak);
        document.getElementById("ticketFormBarangayInput").value = "";
        renderBarangayResults([]);
        if (!isFiberBreak) loadBarangays();

        if (category === "TN" && !isFiberBreak) {
            updateLocationForSubscriber();
        }

        // Fiber Break always flags every connected line critical (see
        // report_fiber_break()'s docstring) -- lock the Priority
        // dropdown to Critical rather than leaving a selectable value
        // the backend would silently override anyway.
        const prioritySelect = document.getElementById("ticketFormPriority");
        prioritySelect.disabled = isFiberBreak;
        if (isFiberBreak) prioritySelect.value = "critical";

        // Status only makes sense as a real choice for SO (a
        // service_request can start anywhere); a brand-new trouble
        // ticket always starts "pending" (app/forms.py's
        // IssueReportForm docstring), so lock it for TN.
        const statusSelect = document.getElementById("ticketFormStatus");
        statusSelect.disabled = category === "TN";
        if (category === "TN") statusSelect.value = "pending";

        loadPersonnel("field_assistant", document.getElementById("ticketFormAssignedTeam"), "-- None --");
        loadPersonnel("technician", document.getElementById("ticketFormTechnicianSelect"), "-- Select Technician --");
    }

    function openTicketForm(category, typeValue, typeLabel) {
        resetForm();
        applyCategory(category, typeValue, typeLabel);
        modalInstance.show();
    }

    // ------------------------------------------------------------------
    // Submit
    // ------------------------------------------------------------------

    function selectedOptionLabel(selectEl) {
        const opt = selectEl.options[selectEl.selectedIndex];
        return opt && opt.value ? opt.textContent : "";
    }

    function showGeneralError(message) {
        const el = document.getElementById("ticketFormGeneralError");
        el.textContent = message;
        el.classList.remove("d-none");
    }

    function showFieldErrors(errors) {
        Object.keys(errors || {}).forEach((fieldName) => {
            const errorEl = document.querySelector('#ticketForm [data-error-for="' + fieldName + '"]');
            if (errorEl) errorEl.textContent = errors[fieldName].join(" ");
        });
    }

    // ------------------------------------------------------------------
    // Center-screen success toast
    // ------------------------------------------------------------------

    /** Centered, self-dismissing confirmation toast for a successfully
     *  created ticket. Fully self-contained (injects its own styles on
     *  first use) so no template/CSS changes were needed elsewhere.
     *  Stays up for at least TOAST_MIN_VISIBLE_MS, and disappears
     *  automatically then -- or immediately if the user clicks
     *  anywhere on the page (including on the toast itself) before
     *  that. Styled as a white card with a green check-in-a-ring icon
     *  and a few scattered "confetti" dots around it, matching the
     *  rest of the app's success-state visual language rather than a
     *  plain colored banner. */
    const TOAST_MIN_VISIBLE_MS = 3000;

    function ensureToastStyles() {
        if (document.getElementById("napiqTicketToastStyles")) return;
        const style = document.createElement("style");
        style.id = "napiqTicketToastStyles";
        style.textContent = [
            "#napiqTicketToast{position:fixed;top:50%;left:50%;",
            "transform:translate(-50%,-50%) scale(.96);z-index:2000;",
            "background:#fff;color:#1f2937;padding:2rem 2.75rem;",
            "border-radius:1.1rem;box-shadow:0 1.25rem 3rem rgba(15,23,42,.28);",
            "display:flex;flex-direction:column;align-items:center;gap:1rem;",
            "text-align:center;opacity:0;min-width:260px;",
            "transition:opacity .18s ease, transform .18s ease;pointer-events:none;}",
            "#napiqTicketToast.napiq-toast-show{opacity:1;transform:translate(-50%,-50%) scale(1);}",
            "#napiqTicketToast .napiq-toast-icon-wrap{position:relative;width:96px;height:96px;",
            "display:flex;align-items:center;justify-content:center;}",
            "#napiqTicketToast .napiq-toast-circle{width:64px;height:64px;border-radius:50%;",
            "background:#e3f9ec;display:flex;align-items:center;justify-content:center;",
            "box-shadow:0 0 0 6px rgba(34,197,94,.08);}",
            "#napiqTicketToast .napiq-toast-circle i{color:#16a34a;font-size:2rem;line-height:1;}",
            "#napiqTicketToast .napiq-toast-dot{position:absolute;border-radius:50%;}",
            "#napiqTicketToast .napiq-toast-dot-1{width:7px;height:7px;background:#60a5fa;top:2px;left:14px;}",
            "#napiqTicketToast .napiq-toast-dot-2{width:5px;height:5px;background:#fbbf24;top:10px;right:6px;}",
            "#napiqTicketToast .napiq-toast-dot-3{width:6px;height:6px;background:#34d399;bottom:14px;left:0;}",
            "#napiqTicketToast .napiq-toast-dot-4{width:4px;height:4px;background:#60a5fa;bottom:4px;right:16px;}",
            "#napiqTicketToast .napiq-toast-dot-5{width:5px;height:5px;background:#fbbf24;top:34px;left:-6px;}",
            "#napiqTicketToast .napiq-toast-dot-6{width:4px;height:4px;background:#34d399;top:30px;right:-8px;}",
            "#napiqTicketToast .napiq-toast-text{font-weight:700;font-size:1.2rem;color:#1f2937;}",
        ].join("");
        document.head.appendChild(style);
    }

    function showTicketSuccessToast(message) {
        ensureToastStyles();

        const existing = document.getElementById("napiqTicketToast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.id = "napiqTicketToast";
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
            '<div class="napiq-toast-text">' + escapeHtml(message) + "</div>";
        document.body.appendChild(toast);
        // Force a reflow before adding the "show" class so the
        // fade/scale transition actually plays instead of snapping in.
        void toast.offsetWidth;
        toast.classList.add("napiq-toast-show");

        let dismissed = false;
        let autoTimer = null;

        function dismiss() {
            if (dismissed) return;
            dismissed = true;
            if (autoTimer) clearTimeout(autoTimer);
            document.removeEventListener("click", onDocClick, true);
            toast.classList.remove("napiq-toast-show");
            setTimeout(() => toast.remove(), 200);
        }

        function onDocClick() {
            dismiss();
        }

        // Attach the click-anywhere listener on the next tick so the
        // very click that triggered this toast (the form's Create
        // button) doesn't immediately dismiss it.
        setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
        autoTimer = setTimeout(dismiss, TOAST_MIN_VISIBLE_MS);
    }

    /** Same dismissible-alert-above-the-map pattern napmap.js's own
     *  showAlert() uses -- duplicated here (rather than shared) since
     *  that one is private to napmap.js's own IIFE. */
    function showMapAlert(type, message) {
        const area = document.getElementById("mapAlertArea");
        if (!area) return;
        const alertId = "ticket-alert-" + Date.now();
        area.insertAdjacentHTML(
            "beforeend",
            '<div id="' + alertId + '" class="alert alert-' + type +
                ' alert-dismissible fade show shadow-sm" role="alert">' +
                escapeHtml(message) +
                '<button type="button" class="btn-close" data-bs-dismiss="alert"></button>' +
                "</div>"
        );
        setTimeout(() => {
            const el = document.getElementById(alertId);
            if (el && window.bootstrap) window.bootstrap.Alert.getOrCreateInstance(el).close();
        }, 3000);
    }

    function submitSO() {
        const formData = new FormData();
        formData.append("request_type", document.getElementById("ticketFormTypeValue").value);
        // Free-text customer name -- never matched against the
        // subscribers table (see ticketFormCustomerNameWrapper in
        // naps/map.html and QuickServiceRequestForm's docstring).
        formData.append("full_name", document.getElementById("ticketFormCustomerName").value.trim());
        formData.append("contact_number", document.getElementById("ticketFormContactNumber").value.trim());
        formData.append("barangay", document.getElementById("ticketFormBarangayInput").value);
        formData.append("status", document.getElementById("ticketFormStatus").value);
        formData.append("notes", document.getElementById("ticketFormDescription").value);
        formData.append("priority_label", selectedOptionLabel(document.getElementById("ticketFormPriority")));
        formData.append("plan_label", document.getElementById("ticketFormPlan").value);
        formData.append("assigned_team_id", document.getElementById("ticketFormAssignedTeam").value || "");
        formData.append("assigned_team_label", selectedOptionLabel(document.getElementById("ticketFormAssignedTeam")));
        formData.append(
            "technicians_label",
            addedTechnicians.map((t) => t.full_name).join(", ")
        );
        formData.append("scheduled", document.getElementById("ticketFormScheduled").value);
        formData.append("csrf_token", CSRF_TOKEN);

        return fetch("/service-requests/quick-add", {
            method: "POST",
            headers: { "X-CSRFToken": CSRF_TOKEN },
            body: formData,
        });
    }

    function submitTN() {
        const formData = new FormData();
        formData.append("issue_type", document.getElementById("ticketFormTypeValue").value);
        formData.append("subscriber_id", document.getElementById("ticketFormSubscriberId").value || "0");
        formData.append("nap_id", "0");
        formData.append("latitude", selectedSubscriber ? selectedSubscriber.latitude : "");
        formData.append("longitude", selectedSubscriber ? selectedSubscriber.longitude : "");
        formData.append("priority", document.getElementById("ticketFormPriority").value);
        formData.append("address", selectedSubscriber ? selectedSubscriber.address || "" : "");

        const extra = [];
        const barangay = document.getElementById("ticketFormBarangayInput").value.trim();
        if (barangay) extra.push("Barangay: " + barangay);
        const team = selectedOptionLabel(document.getElementById("ticketFormAssignedTeam"));
        if (team) extra.push("Assigned Team: " + team);
        if (addedTechnicians.length) extra.push("Technician(s) requested: " + addedTechnicians.map((t) => t.full_name).join(", "));
        const scheduled = document.getElementById("ticketFormScheduled").value;
        if (scheduled) extra.push("Scheduled: " + scheduled);
        const typed = document.getElementById("ticketFormDescription").value.trim();
        const description = [extra.join("\n"), typed].filter(Boolean).join("\n\n") || "Reported via the GeoMap Tickets menu.";
        formData.append("description", description);
        formData.append("assigned_team_id", document.getElementById("ticketFormAssignedTeam").value || "");
        formData.append("csrf_token", CSRF_TOKEN);

        return fetch("/issues/report", {
            method: "POST",
            headers: { "X-CSRFToken": CSRF_TOKEN },
            body: formData,
        });
    }

    function submitFiberBreak() {
        const formData = new FormData();
        formData.append("nap_id", document.getElementById("ticketFormNapId").value || "");
        formData.append("assigned_team_id", document.getElementById("ticketFormAssignedTeam").value || "");

        const extra = [];
        const team = selectedOptionLabel(document.getElementById("ticketFormAssignedTeam"));
        if (team) extra.push("Assigned Team: " + team);
        if (addedTechnicians.length) extra.push("Technician(s) requested: " + addedTechnicians.map((t) => t.full_name).join(", "));
        const scheduled = document.getElementById("ticketFormScheduled").value;
        if (scheduled) extra.push("Scheduled: " + scheduled);
        const typed = document.getElementById("ticketFormDescription").value.trim();
        const description = [extra.join("\n"), typed].filter(Boolean).join("\n\n");
        formData.append("description", description);
        formData.append("csrf_token", CSRF_TOKEN);

        return fetch("/issues/report-fiber-break", {
            method: "POST",
            headers: { "X-CSRFToken": CSRF_TOKEN },
            body: formData,
        });
    }

    function handleSubmit(event) {
        event.preventDefault();
        document.getElementById("ticketFormGeneralError").classList.add("d-none");
        document.querySelectorAll("#ticketForm [data-error-for]").forEach((el) => (el.textContent = ""));

        const isFiberBreak = isFiberBreakForm();

        if (isFiberBreak) {
            // Fiber Break needs the affected NAP, not a subscriber.
            if (!document.getElementById("ticketFormNapId").value) {
                showGeneralError("Please select the affected NAP.");
                return;
            }
        } else if (currentCategory === "TN") {
            // TN still needs a real subscriber match -- the backend
            // requires the pin to exactly match a registered
            // subscriber's location.
            if (!document.getElementById("ticketFormSubscriberId").value) {
                showGeneralError("Please select a subscriber.");
                return;
            }
        } else if (!document.getElementById("ticketFormCustomerName").value.trim()) {
            // SO's Customer field is free text -- just needs something
            // typed, not a match against any existing record.
            showGeneralError("Please enter the customer's name.");
            return;
        }

        const submitBtn = document.getElementById("ticketFormSubmitBtn");
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

        const request = currentCategory === "SO" ? submitSO() : (isFiberBreak ? submitFiberBreak() : submitTN());

        request
            .then((response) => response.json().then((payload) => ({ response, payload })))
            .then(({ response, payload }) => {
                if (response.ok && payload.status === "success") {
                    modalInstance.hide();
                    showTicketSuccessToast("Ticket Successfully Created!");
                    // Tells napmap.js (a separate script) to refresh
                    // immediately rather than waiting for its background
                    // timer/tab-focus refresh -- so the priority just set
                    // on this ticket (Repair's admin-chosen priority,
                    // Fiber Break's forced Critical, etc.) colors the
                    // affected subscriber marker(s) right away.
                    window.dispatchEvent(new CustomEvent("napiq:ticket-created"));
                } else if (payload.errors) {
                    showFieldErrors(payload.errors);
                    showGeneralError("Please fix the highlighted fields and try again.");
                } else {
                    showGeneralError("Something went wrong while saving. Please try again.");
                }
            })
            .catch(() => {
                showGeneralError("Could not reach the server. Check your connection and try again.");
            })
            .finally(() => {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Create';
            });
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    document.addEventListener("DOMContentLoaded", function () {
        const modalEl = document.getElementById("ticketFormModal");
        if (!modalEl || typeof bootstrap === "undefined") return;
        modalInstance = new bootstrap.Modal(modalEl);

        document.querySelectorAll(".ticket-type-option").forEach((item) => {
            item.addEventListener("click", (event) => {
                event.preventDefault();
                const category = item.getAttribute("data-category");
                const typeValue = item.getAttribute("data-type-value");
                const typeLabel = item.getAttribute("data-type-label");

                if (typeValue === "add_nap") {
                    // "Add NAP" isn't a ticket -- it's the page's own
                    // existing Add NAP mode. Just trigger that.
                    const addNapBtn = document.getElementById("addNapModeBtn");
                    if (addNapBtn) addNapBtn.click();
                    return;
                }
                openTicketForm(category, typeValue, typeLabel);
            });
        });

        document.getElementById("ticketForm").addEventListener("submit", handleSubmit);
        const subscriberInput = document.getElementById("ticketFormSubscriberInput");
        subscriberInput.addEventListener("input", onSubscriberInput);
        subscriberInput.addEventListener("blur", resolveSubscriberFromInput);
        subscriberInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                resolveSubscriberFromInput();
            }
        });
        document.getElementById("ticketFormSubscriberResults").addEventListener("click", (event) => {
            const btn = event.target.closest("[data-sub-id]");
            if (!btn) return;
            const sub = allSubscribers.find((s) => String(s.id) === btn.getAttribute("data-sub-id"));
            if (sub) selectSubscriber(sub);
        });

        const napInput = document.getElementById("ticketFormNapInput");
        napInput.addEventListener("input", onNapInput);
        document.getElementById("ticketFormNapResults").addEventListener("click", (event) => {
            const btn = event.target.closest("[data-nap-id]");
            if (!btn) return;
            const nap = allNaps.find((n) => String(n.id) === btn.getAttribute("data-nap-id"));
            if (nap) selectNap(nap);
        });

        const barangayInput = document.getElementById("ticketFormBarangayInput");
        barangayInput.addEventListener("input", onBarangayInput);
        document.getElementById("ticketFormBarangayResults").addEventListener("click", (event) => {
            const btn = event.target.closest(".list-group-item");
            if (!btn) return;
            barangayInput.value = btn.textContent;
            renderBarangayResults([]);
        });

        document.addEventListener("click", (event) => {
            if (!event.target.closest("#ticketFormSubscriberInput") && !event.target.closest("#ticketFormSubscriberResults")) {
                renderSubscriberResults([]);
            }
            if (!event.target.closest("#ticketFormNapInput") && !event.target.closest("#ticketFormNapResults")) {
                renderNapResults([]);
            }
            if (!event.target.closest("#ticketFormBarangayInput") && !event.target.closest("#ticketFormBarangayResults")) {
                renderBarangayResults([]);
            }
        });

        document.getElementById("ticketFormAddTechnicianBtn").addEventListener("click", addTechnicianFromSelect);
        document.getElementById("ticketFormTechnicianChips").addEventListener("click", (event) => {
            const btn = event.target.closest("[data-remove-tech]");
            if (!btn) return;
            const id = btn.getAttribute("data-remove-tech");
            addedTechnicians = addedTechnicians.filter((t) => String(t.id) !== String(id));
            renderTechnicianChips();
        });
    });
})();
