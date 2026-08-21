/**
 * Navigation destination selection (Phase 23, 15%)
 * ---------------------------------------------------
 * Ported from the napV4-route-line prototype's `NavigationStore.tsx`
 * — but only the *destination selection* slice of that store. This
 * phase is explicitly "no road routing, no GPS, no demo travel" (see
 * PHASE23_15_PERCENT_NOTES.md), so nothing here calls OSRM, watches
 * device location, or animates a technician along a route. Those
 * remain for a future phase.
 *
 * What this module actually is: a tiny, dependency-free store for
 * "which real NAP-IQ entity is currently selected as a navigation
 * destination", plus the small sidebar panel on the GeoMap that shows
 * it. It is deliberately generic — it knows nothing about NAPs,
 * issues, or subscribers. napmap.js (which already loads all three
 * datasets) builds the destination object and hands it to
 * `NapIQNavigation.setDestination(...)`; this module just stores it,
 * renders it, and broadcasts it.
 *
 * The destination object shape matches the backend contract already
 * documented in PHASE23_10_PERCENT_NOTES.md (`app/navigation_contract.py`'s
 * `destination_json()`):
 *   { id, type, label, subtitle, position: {lat, lng}, issueId? }
 *
 * Future navigation code (routing, GPS, demo travel) can read the
 * current selection at any time via `NapIQNavigation.getDestination()`
 * or listen for changes:
 *
 *   window.addEventListener('napiq:destination-changed', (event) => {
 *     const destination = event.detail; // the object above, or null
 *   });
 */

(function () {
    let selectedDestination = null;

    const TYPE_LABELS = {
        subscriber: "Subscriber",
        nap: "NAP",
        issue: "Complaint",
    };

    const TYPE_ICONS = {
        subscriber: "bi-person-fill",
        nap: "bi-hdd-network-fill",
        issue: "bi-exclamation-triangle-fill",
    };

    function getDestination() {
        return selectedDestination;
    }

    /**
     * Sets the current navigation destination. `destination` must
     * already be in the documented shape (id, type, label, subtitle,
     * position). Re-renders the sidebar panel and notifies any
     * listener (future routing code) via a CustomEvent.
     */
    function setDestination(destination) {
        if (!destination || !destination.position) {
            console.error("NapIQNavigation.setDestination: invalid destination", destination);
            return;
        }
        selectedDestination = destination;
        renderPanel();
        broadcast();
    }

    function clearDestination() {
        selectedDestination = null;
        renderPanel();
        broadcast();
    }

    function broadcast() {
        window.dispatchEvent(
            new CustomEvent("napiq:destination-changed", { detail: selectedDestination })
        );
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    /** Renders the "Navigation destination" card. No-op if the panel
     * container isn't on the page (so this file is safe to include
     * anywhere, not just naps/map.html). */
    function renderPanel() {
        const panel = document.getElementById("navDestinationPanel");
        if (!panel) return;

        if (!selectedDestination) {
            panel.innerHTML =
                '<div class="text-muted small">' +
                '<i class="bi bi-signpost-split me-1"></i>' +
                "No navigation destination selected. Click a marker on the map and choose " +
                '"Set as destination".' +
                "</div>";
            return;
        }

        const d = selectedDestination;
        const typeLabel = TYPE_LABELS[d.type] || d.type;
        const icon = TYPE_ICONS[d.type] || "bi-geo-alt-fill";

        panel.innerHTML =
            '<div class="d-flex justify-content-between align-items-start">' +
            '<div class="min-w-0">' +
            '<span class="badge text-bg-primary mb-1"><i class="bi ' + icon + ' me-1"></i>' + escapeHtml(typeLabel) + "</span>" +
            '<div class="fw-semibold text-truncate">' + escapeHtml(d.label) + "</div>" +
            (d.subtitle ? '<div class="text-muted small text-truncate">' + escapeHtml(d.subtitle) + "</div>" : "") +
            '<div class="text-muted small font-monospace mt-1">' +
            d.position.lat.toFixed(6) + ", " + d.position.lng.toFixed(6) +
            "</div>" +
            "</div>" +
            '<button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0" id="navDestinationClearBtn" title="Clear destination">' +
            '<i class="bi bi-x-lg"></i>' +
            "</button>" +
            "</div>";

        const clearBtn = document.getElementById("navDestinationClearBtn");
        if (clearBtn) {
            clearBtn.addEventListener("click", clearDestination);
        }
    }

    document.addEventListener("DOMContentLoaded", renderPanel);

    window.NapIQNavigation = {
        getDestination: getDestination,
        setDestination: setDestination,
        clearDestination: clearDestination,
    };
})();
