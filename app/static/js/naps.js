document.addEventListener("DOMContentLoaded", function () {

    // ---- Live "Available Ports" preview on the Add/Edit NAP form ----
    const totalInput = document.getElementById("totalPortsInput");
    const usedInput = document.getElementById("usedPortsInput");
    const availablePreview = document.getElementById("availablePortsPreview");

    function updateAvailablePreview() {
        if (!totalInput || !usedInput || !availablePreview) return;
        const total = parseInt(totalInput.value, 10);
        const used = parseInt(usedInput.value, 10);
        if (!isNaN(total) && !isNaN(used)) {
            availablePreview.value = Math.max(total - used, 0);
        } else {
            availablePreview.value = "";
        }
    }

    if (totalInput && usedInput) {
        totalInput.addEventListener("input", updateAvailablePreview);
        usedInput.addEventListener("input", updateAvailablePreview);
        updateAvailablePreview();
    }

    // ---- Shared Deactivate / Activate confirmation modal (NAP list page) ----
    const statusModal = document.getElementById("statusModal");
    if (statusModal) {
        statusModal.addEventListener("show.bs.modal", function (event) {
            const trigger = event.relatedTarget;
            const napId = trigger.getAttribute("data-nap-id");
            const napLabel = trigger.getAttribute("data-nap-label");
            const actionType = trigger.getAttribute("data-action-type"); // "deactivate" | "activate"

            const form = document.getElementById("statusChangeForm");
            const title = document.getElementById("statusModalTitle");
            const body = document.getElementById("statusModalBody");
            const label = document.getElementById("statusModalNapLabel");
            const confirmBtn = document.getElementById("statusModalConfirmBtn");

            const baseUrl = "/naps/" + napId + "/" + actionType;
            form.setAttribute("action", baseUrl);
            label.textContent = napLabel;

            if (actionType === "deactivate") {
                title.textContent = "Deactivate NAP";
                body.textContent = "Are you sure you want to deactivate this NAP? It will no longer be offered for new installations.";
                confirmBtn.textContent = "Deactivate";
                confirmBtn.className = "btn btn-danger";
            } else {
                title.textContent = "Activate NAP";
                body.textContent = "Are you sure you want to reactivate this NAP?";
                confirmBtn.textContent = "Activate";
                confirmBtn.className = "btn btn-success";
            }
        });
    }
});
