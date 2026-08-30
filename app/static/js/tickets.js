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
    const BARANGAY_API_URL = "https://psgc.gitlab.io/api/cities-municipalities/0403400000/barangays/";

    const SO_TYPE_CHOICES = [
        { value: "new_installation", label: "New Installation" },
        { value: "relocation", label: "Relocation" },
        { value: "add_nap", label: "Add NAP" },
    ];
    const TN_TYPE_CHOICES = [
        { value: "No Internet", label: "No Internet" },
        { value: "Slow Internet", label: "Slow Internet" },
        { value: "Connection Problem", label: "Connection Problem" },
        { value: "Last-Mile Checking", label: "Last-Mile Checking" },
        { value: "Repair", label: "Repair" },
    ];

    let modalInstance = null;
    let currentCategory = "SO"; // "SO" | "TN"
    let barangaysLoaded = false;
    let barangayOptionsHtml = '<option value="">Select barangay</option>';
    let allSubscribers = [];
    let subscribersLoaded = false;
    let selectedSubscriber = null; // {id, subscriber_code, full_name, address, latitude, longitude}
    let addedTechnicians = []; // [{id, full_name}]

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

    function loadBarangays() {
        if (barangaysLoaded) return;
        barangaysLoaded = true;
        fetch(BARANGAY_API_URL)
            .then((r) => r.json())
            .then((list) => {
                const options = ['<option value="">Select barangay</option>'];
                (list || [])
                    .slice()
                    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                    .forEach((b) => {
                        options.push('<option value="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + "</option>");
                    });
                barangayOptionsHtml = options.join("");
                const select = document.getElementById("ticketFormBarangay");
                if (select && currentCategory === "SO") select.innerHTML = barangayOptionsHtml;
            })
            .catch(() => {
                barangayOptionsHtml = '<option value="">Could not load barangays -- type not available</option>';
                const select = document.getElementById("ticketFormBarangay");
                if (select && currentCategory === "SO") select.innerHTML = barangayOptionsHtml;
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
        const term = input.value.trim().toLowerCase();
        selectedSubscriber = null;
        document.getElementById("ticketFormSubscriberId").value = "";
        updateLocationForSubscriber();
        if (!term) {
            renderSubscriberResults([]);
            return;
        }
        loadSubscribers().then(() => {
            const matches = allSubscribers.filter(
                (s) =>
                    s.full_name.toLowerCase().includes(term) ||
                    (s.subscriber_code || "").toLowerCase().includes(term)
            );
            renderSubscriberResults(matches);
        });
    }

    function selectSubscriber(sub) {
        selectedSubscriber = sub;
        document.getElementById("ticketFormSubscriberId").value = sub.id;
        document.getElementById("ticketFormSubscriberInput").value = sub.subscriber_code + " — " + sub.full_name;
        renderSubscriberResults([]);
        updateLocationForSubscriber();
    }

    function updateLocationForSubscriber() {
        if (currentCategory !== "TN") return;
        const status = document.getElementById("ticketFormPinStatus");
        const autoInput = document.getElementById("ticketFormLocationAuto");
        const submitBtn = document.getElementById("ticketFormSubmitBtn");
        if (!selectedSubscriber) {
            autoInput.value = "";
            status.textContent = "Select the affected subscriber to fill this in from their registered address.";
            status.className = "form-text text-muted";
            submitBtn.disabled = false;
            return;
        }
        if (selectedSubscriber.latitude == null || selectedSubscriber.longitude == null) {
            autoInput.value = selectedSubscriber.address || "";
            status.textContent =
                "This subscriber has no registered location on file, so a trouble ticket can't be pinned for them yet.";
            status.className = "form-text text-danger";
            submitBtn.disabled = true;
            return;
        }
        autoInput.value = selectedSubscriber.address || "(no address on file, using registered coordinates)";
        status.textContent = "Location filled in from " + selectedSubscriber.full_name + "'s registered address.";
        status.className = "form-text text-success";
        submitBtn.disabled = false;
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
        addedTechnicians = [];
        document.getElementById("ticketFormSubscriberId").value = "";
        renderSubscriberResults([]);
        renderTechnicianChips();
        document.getElementById("ticketFormCreated").value = todayLabel();
        document.getElementById("ticketFormSubmitBtn").disabled = false;
    }

    function applyCategory(category, typeValue, typeLabel) {
        currentCategory = category;
        const choices = category === "SO" ? SO_TYPE_CHOICES : TN_TYPE_CHOICES;
        const typeSelect = document.getElementById("ticketFormType");
        typeSelect.innerHTML = choices
            .map((c) => '<option value="' + escapeHtml(c.value) + '">' + escapeHtml(c.label) + "</option>")
            .join("");
        typeSelect.value = typeValue;

        document.getElementById("ticketFormTitle").textContent =
            (category === "SO" ? "SO. " : "TN. ") + "New — " + typeLabel;

        const barangayWrapper = document.getElementById("ticketFormBarangayWrapper");
        const autoWrapper = document.getElementById("ticketFormLocationAutoWrapper");
        if (category === "SO") {
            barangayWrapper.classList.remove("d-none");
            autoWrapper.classList.add("d-none");
            document.getElementById("ticketFormBarangay").innerHTML = barangayOptionsHtml;
            loadBarangays();
        } else {
            barangayWrapper.classList.add("d-none");
            autoWrapper.classList.remove("d-none");
            updateLocationForSubscriber();
        }

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
        formData.append("request_type", document.getElementById("ticketFormType").value);
        formData.append("subscriber_id", document.getElementById("ticketFormSubscriberId").value || "0");
        formData.append("barangay", document.getElementById("ticketFormBarangay").value);
        formData.append("status", document.getElementById("ticketFormStatus").value);
        formData.append("notes", document.getElementById("ticketFormDescription").value);
        formData.append("priority_label", selectedOptionLabel(document.getElementById("ticketFormPriority")));
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
        formData.append("issue_type", document.getElementById("ticketFormType").value);
        formData.append("subscriber_id", document.getElementById("ticketFormSubscriberId").value || "0");
        formData.append("nap_id", "0");
        formData.append("latitude", selectedSubscriber ? selectedSubscriber.latitude : "");
        formData.append("longitude", selectedSubscriber ? selectedSubscriber.longitude : "");
        formData.append("priority", document.getElementById("ticketFormPriority").value);
        formData.append("address", selectedSubscriber ? selectedSubscriber.address || "" : "");

        const extra = [];
        const team = selectedOptionLabel(document.getElementById("ticketFormAssignedTeam"));
        if (team) extra.push("Assigned Team: " + team);
        if (addedTechnicians.length) extra.push("Technician(s) requested: " + addedTechnicians.map((t) => t.full_name).join(", "));
        const scheduled = document.getElementById("ticketFormScheduled").value;
        if (scheduled) extra.push("Scheduled: " + scheduled);
        const typed = document.getElementById("ticketFormDescription").value.trim();
        const description = [extra.join("\n"), typed].filter(Boolean).join("\n\n") || "Reported via the GeoMap Tickets menu.";
        formData.append("description", description);
        formData.append("csrf_token", CSRF_TOKEN);

        return fetch("/issues/report", {
            method: "POST",
            headers: { "X-CSRFToken": CSRF_TOKEN },
            body: formData,
        });
    }

    function handleSubmit(event) {
        event.preventDefault();
        document.getElementById("ticketFormGeneralError").classList.add("d-none");
        document.querySelectorAll("#ticketForm [data-error-for]").forEach((el) => (el.textContent = ""));

        if (!document.getElementById("ticketFormSubscriberId").value) {
            showGeneralError("Please select a subscriber.");
            return;
        }

        const submitBtn = document.getElementById("ticketFormSubmitBtn");
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

        const request = currentCategory === "SO" ? submitSO() : submitTN();

        request
            .then((response) => response.json().then((payload) => ({ response, payload })))
            .then(({ response, payload }) => {
                if (response.ok && payload.status === "success") {
                    modalInstance.hide();
                    if (window.showAlert) {
                        window.showAlert("success", payload.message);
                    }
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
        document.getElementById("ticketFormSubscriberInput").addEventListener("input", onSubscriberInput);
        document.getElementById("ticketFormSubscriberResults").addEventListener("click", (event) => {
            const btn = event.target.closest("[data-sub-id]");
            if (!btn) return;
            const sub = allSubscribers.find((s) => String(s.id) === btn.getAttribute("data-sub-id"));
            if (sub) selectSubscriber(sub);
        });
        document.addEventListener("click", (event) => {
            if (!event.target.closest("#ticketFormSubscriberInput") && !event.target.closest("#ticketFormSubscriberResults")) {
                renderSubscriberResults([]);
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
