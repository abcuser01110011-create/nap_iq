/**
 * Navigation origin selection (Phase 8 — adapted onto Phase 23's
 * navigation architecture)
 * -----------------------------------------------------------------
 * This project's navigation feature took a different path than the
 * one the original Phase 8 delta (`nav_iq_PHASE8_50pct_manual_origin_picker.zip`)
 * was built against: that delta patches a `nav-card.js` / `nav-routing.js`
 * / OSRM-routing stack (its own "Phase 5–7") that was never built in
 * this project. What *was* built here, and shipped, is Phase 23's
 * destination-only selection (`nav-destination.js`) — deliberately
 * "no road routing, no GPS, no demo travel" (see
 * PHASE23_15_PERCENT_NOTES.md).
 *
 * This file adapts the *idea* of the Phase 8 origin picker — a
 * manually chosen route starting point, with its own store and event
 * — onto that existing shape instead of the missing one. It is a
 * sibling of `nav-destination.js`, not a patch on top of it: same
 * "tiny, dependency-free store + sidebar panel" pattern, same
 * "safe to include on any page" contract, same broadcast-a-
 * CustomEvent-on-change convention. Just as `nav-destination.js`
 * doesn't call OSRM, neither does this — an origin without any
 * routing engine to feed is still useful for the map-picker UI
 * (`nav-origin-picker.js`, loaded after this file) to demonstrate
 * and for a future routing phase to consume.
 *
 * Origin object shape (this project's own — not identical to the
 * original Phase 8 delta's, which nested coordinates under
 * `position`; this one stays flat like `nav-destination.js`'s
 * `position: {lat, lng}` field, for consistency within this project):
 *   { id, label, subtitle, position: {lat, lng}, source }
 *   source is 'manual-latlng' | 'manual-map'
 *
 * Public surface:
 *   window.NapIQNavOrigin.getOrigin()
 *   window.NapIQNavOrigin.setOrigin(lat, lng, label)
 *     // manual lat/lng entry (this file's own small form below)
 *   window.NapIQNavOrigin.setOriginPoint(origin)
 *     // origin: { id, label, subtitle, position: {lat, lng} } or
 *     // { id, label, subtitle, lat, lng } — used by
 *     // nav-origin-picker.js's map-click flow
 *   window.NapIQNavOrigin.clearOrigin()
 *   window.NapIQNavOrigin.previewCoordinates(lat, lng)
 *     // live-updates the lat/lng fields to show an in-progress map
 *     // pick without committing it to the store (nav-origin-picker.js)
 *   window.NapIQNavOrigin.refreshCoordinateFields()
 *     // reverts the lat/lng fields to whatever the store actually
 *     // holds (or blank) — called after a pick is cancelled
 *
 * Fires `napiq:origin-changed` on `window` (detail: the origin object,
 * or null) any time the origin changes — same convention as
 * `napiq:destination-changed` in nav-destination.js.
 *
 * Also fires `napiq:navorigin-panel-rendered` on `window` every time
 * `#navOriginPanel` is rebuilt, since (unlike the destination panel)
 * this one contains live sub-widgets (`nav-origin-picker.js`'s pick
 * button / picking status, and — since Phase 11 (55%) —
 * `nav-gps-origin.js`'s device-location button / tracking status)
 * that need to know when their container was just replaced so they
 * can re-render into the fresh DOM.
 *
 * --- Phase 11 (55%): device GPS origin ---
 * `setOriginPoint()` now accepts an optional `source` field on the
 * candidate object (see that function's own comment) so
 * `nav-gps-origin.js` can push a real `navigator.geolocation` fix in
 * as `source: "device-gps"`, distinguishable in the confirmed-state
 * badge below from a manually placed origin. `#navOriginGpsControls`
 * is a new render target next to `#navOriginPickerControls`, in both
 * the empty and confirmed states — `nav-gps-origin.js` is the only
 * file that writes into it, exactly as `nav-origin-picker.js` owns
 * `#navOriginPickerControls`.
 *
 * --- Phase 14 (70%): technician's own last-known DB position ---
 * `#navOriginTechnicianControls` is a third render target, next to
 * the GPS and map-picker ones, in both the empty and confirmed
 * states. `nav-technician-origin.js` is the only file that writes
 * into it (empty/absent entirely when the signed-in user isn't a
 * technician with a linked profile — see that file). It pushes
 * `source: "technician-db"`, shown below with its own badge so it's
 * always visually distinguishable from a manual pick, typed
 * coordinates, or a live device-GPS fix.
 *
 * --- Phase 8, second half: map picker <-> lat/lng form reconciliation ---
 * The lat/lng form (below) is now rendered in *both* the empty and
 * confirmed states, pre-filled with the current origin's coordinates
 * when one exists, instead of disappearing once an origin is set.
 * That makes the two origin-entry paths one visually consistent
 * control instead of two that only one of which is ever on screen:
 *   - Submitting valid coordinates always calls `setOrigin()`, which
 *     both creates a first origin AND moves an existing one (it just
 *     replaces `selectedOrigin` and re-broadcasts either way) — so
 *     typing new numbers over an already-picked point moves the
 *     marker, it doesn't need a separate "edit" mode.
 *   - `previewCoordinates(lat, lng)` / `refreshCoordinateFields()`
 *     let `nav-origin-picker.js` push the *in-progress* map pick into
 *     these same fields live (while a point is pending, before
 *     Confirm) without touching the store — confirming or cancelling
 *     the pick then naturally reconciles back to whatever the store
 *     actually holds. Both are no-ops if the fields aren't on screen,
 *     and both refuse to clobber a value the user is actively typing
 *     (checked via `document.activeElement`).
 */

(function () {
    let selectedOrigin = null; // { id, label, subtitle, position: {lat, lng}, source } | null

    function getOrigin() {
        return selectedOrigin;
    }

    /**
     * Manual lat/lng entry (this file's own small form in the empty
     * state of the panel). Returns true on success, false if the
     * coordinates are not valid numbers in range — this store never
     * guesses or clamps a bad value into something that looks valid;
     * the caller (the form handler below) is responsible for showing
     * that as an error.
     */
    function setOrigin(lat, lng, label) {
        const numLat = Number(lat);
        const numLng = Number(lng);
        if (!isFinite(numLat) || !isFinite(numLng)) return false;
        if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) return false;

        selectedOrigin = {
            id: "manual-latlng-" + Date.now(),
            label: label || "Manual coordinates",
            subtitle: numLat.toFixed(6) + ", " + numLng.toFixed(6),
            position: { lat: numLat, lng: numLng },
            source: "manual-latlng",
        };
        renderPanel();
        broadcast();
        return true;
    }

    /**
     * Map-click origin (Phase 8's picker, `nav-origin-picker.js`) —
     * and, since Phase 11 (55%), also the device-GPS origin
     * (`nav-gps-origin.js`), which is really the same shape of thing:
     * "here is a lat/lng and a human label for it, use it as the
     * origin." Accepts either `{ id, label, subtitle, position: {lat,
     * lng} }` or `{ id, label, subtitle, lat, lng }`. Returns true on
     * success, false if the coordinates are invalid or `candidate` is
     * missing entirely (same validation contract as `setOrigin`).
     *
     * `candidate.source`, if provided, is stored as-is (Phase 11 adds
     * `"device-gps"`, used by `renderPanel()` below to show a distinct
     * badge from a manually-placed origin). This is additive and
     * backward compatible: callers that don't pass `source` (i.e.
     * every pre-Phase-11 caller, `nav-origin-picker.js` included) keep
     * getting `"manual-map"`, exactly as before.
     */
    function setOriginPoint(candidate) {
        if (!candidate) return false;
        const pos = candidate.position || candidate;
        const numLat = Number(pos.lat);
        const numLng = Number(pos.lng);
        if (!isFinite(numLat) || !isFinite(numLng)) return false;
        if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) return false;

        selectedOrigin = {
            id: candidate.id || ("manual-map-" + Date.now()),
            label: candidate.label || "Picked on map",
            subtitle: candidate.subtitle || (numLat.toFixed(6) + ", " + numLng.toFixed(6)),
            position: { lat: numLat, lng: numLng },
            source: candidate.source || "manual-map",
        };
        renderPanel();
        broadcast();
        return true;
    }

    function clearOrigin() {
        if (!selectedOrigin) return;
        selectedOrigin = null;
        renderPanel();
        broadcast();
    }

    function broadcast() {
        window.dispatchEvent(new CustomEvent("napiq:origin-changed", { detail: selectedOrigin }));
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    function notifyPanelRendered() {
        window.dispatchEvent(new CustomEvent("napiq:navorigin-panel-rendered"));
    }

    /**
     * Shared lat/lng form markup, rendered in *both* the empty and
     * confirmed states (see file header). `prefillLat`/`prefillLng`
     * are the values to start the inputs with — the current origin's
     * position when one exists, or blank otherwise.
     */
    function coordFormHtml(prefillLat, prefillLng) {
        const hasOrigin = prefillLat != null && prefillLng != null;
        const latVal = hasOrigin ? Number(prefillLat).toFixed(6) : "";
        const lngVal = hasOrigin ? Number(prefillLng).toFixed(6) : "";
        return (
            '<form id="navOriginLatLngForm" class="row gx-1 gy-1 align-items-end mt-2">' +
            '<div class="col-6">' +
            '<label class="form-label small text-muted mb-0" for="navOriginLatInput">Lat</label>' +
            '<input type="number" step="any" class="form-control form-control-sm" id="navOriginLatInput" ' +
            'value="' + escapeHtml(latVal) + '" placeholder="14.2810">' +
            "</div>" +
            '<div class="col-6">' +
            '<label class="form-label small text-muted mb-0" for="navOriginLngInput">Lng</label>' +
            '<input type="number" step="any" class="form-control form-control-sm" id="navOriginLngInput" ' +
            'value="' + escapeHtml(lngVal) + '" placeholder="121.4150">' +
            "</div>" +
            '<div class="col-12">' +
            '<button type="submit" class="btn btn-sm btn-outline-primary w-100">' +
            '<i class="bi bi-check-lg me-1"></i>' + (hasOrigin ? "Move to these coordinates" : "Use these coordinates") +
            "</button>" +
            "</div>" +
            "</form>" +
            '<div id="navOriginFormError" class="text-danger small mt-1" aria-live="polite"></div>'
        );
    }

    /** Renders the "Navigation origin" card. No-op if the panel
     * container isn't on the page (same convention as
     * nav-destination.js's renderPanel — safe to include anywhere). */
    function renderPanel() {
        const panel = document.getElementById("navOriginPanel");
        if (!panel) return;

        if (!selectedOrigin) {
            panel.innerHTML =
                '<div class="text-muted small mb-2">' +
                '<i class="bi bi-flag me-1"></i>' +
                "No starting point set. Use your device location, pick one on the map, or enter coordinates below." +
                "</div>" +
                '<div id="navOriginGpsControls" class="mb-2"></div>' +
                '<div id="navOriginTechnicianControls" class="mb-2"></div>' +
                '<div id="navOriginPickerControls" class="mb-2"></div>' +
                coordFormHtml(null, null);
        } else {
            const o = selectedOrigin;
            // Phase 11 (55%): a device-GPS-derived origin is shown with
            // a distinct badge from a manually placed one, so the two
            // origin sources are always visually distinguishable at a
            // glance, per that phase's acceptance criteria. Manual
            // lat/lng entry and the manual map picker both still show
            // the original green "Origin" badge — unchanged.
            // Phase 14 (70%): a technician's own last-known DB
            // position gets its own badge, same idea as the Device
            // GPS one above — always visually distinguishable from a
            // manual pick/typed coordinates/live GPS fix.
            const badgeHtml = o.source === "device-gps"
                ? '<span class="badge text-bg-info mb-1"><i class="bi bi-broadcast me-1"></i>Device GPS</span>'
                : o.source === "technician-db"
                ? '<span class="badge text-bg-secondary mb-1"><i class="bi bi-person-badge me-1"></i>My Last Known Location</span>'
                : '<span class="badge text-bg-success mb-1"><i class="bi bi-flag-fill me-1"></i>Origin</span>';
            panel.innerHTML =
                '<div class="d-flex justify-content-between align-items-start">' +
                '<div class="min-w-0">' +
                badgeHtml +
                '<div class="fw-semibold text-truncate">' + escapeHtml(o.label) + "</div>" +
                (o.subtitle ? '<div class="text-muted small text-truncate">' + escapeHtml(o.subtitle) + "</div>" : "") +
                '<div class="text-muted small font-monospace mt-1">' +
                o.position.lat.toFixed(6) + ", " + o.position.lng.toFixed(6) +
                "</div>" +
                "</div>" +
                '<button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0" id="navOriginClearBtn" title="Clear origin">' +
                '<i class="bi bi-x-lg"></i>' +
                "</button>" +
                "</div>" +
                '<div id="navOriginGpsControls" class="mt-2"></div>' +
                '<div id="navOriginTechnicianControls" class="mt-2"></div>' +
                '<div id="navOriginPickerControls" class="mt-2"></div>' +
                coordFormHtml(o.position.lat, o.position.lng);

            const clearBtn = document.getElementById("navOriginClearBtn");
            if (clearBtn) clearBtn.addEventListener("click", clearOrigin);
        }

        const form = document.getElementById("navOriginLatLngForm");
        if (form) form.addEventListener("submit", handleLatLngSubmit);
        notifyPanelRendered();
    }

    function handleLatLngSubmit(evt) {
        evt.preventDefault();
        const latInput = document.getElementById("navOriginLatInput");
        const lngInput = document.getElementById("navOriginLngInput");
        const errorEl = document.getElementById("navOriginFormError");
        const ok = setOrigin(latInput.value, lngInput.value);
        if (!ok && errorEl) {
            errorEl.textContent = "Enter a valid latitude (-90 to 90) and longitude (-180 to 180).";
        }
    }

    /** Writes `lat`/`lng` straight into the coordinate inputs, if
     * they're on the page — used both by `previewCoordinates()` (an
     * in-progress map pick) and `refreshCoordinateFields()` (reverting
     * to the real stored origin). Never overwrites a field the user is
     * actively typing into. */
    function setFieldValues(lat, lng) {
        const latInput = document.getElementById("navOriginLatInput");
        const lngInput = document.getElementById("navOriginLngInput");
        if (!latInput || !lngInput) return;
        if (document.activeElement === latInput || document.activeElement === lngInput) return;
        latInput.value = lat == null ? "" : Number(lat).toFixed(6);
        lngInput.value = lng == null ? "" : Number(lng).toFixed(6);
    }

    /** Live-preview: shows an in-progress map pick's coordinates in
     * the lat/lng fields without touching the store. Called by
     * nav-origin-picker.js while a point is pending/unconfirmed. */
    function previewCoordinates(lat, lng) {
        setFieldValues(lat, lng);
    }

    /** Reverts the lat/lng fields to whatever the store actually
     * holds (or blank if nothing is set) — called by
     * nav-origin-picker.js after a pending pick is cancelled, so a
     * discarded preview doesn't linger in the form. */
    function refreshCoordinateFields() {
        if (selectedOrigin) {
            setFieldValues(selectedOrigin.position.lat, selectedOrigin.position.lng);
        } else {
            setFieldValues(null, null);
        }
    }

    document.addEventListener("DOMContentLoaded", renderPanel);

    window.NapIQNavOrigin = {
        getOrigin: getOrigin,
        setOrigin: setOrigin,
        setOriginPoint: setOriginPoint,
        clearOrigin: clearOrigin,
        previewCoordinates: previewCoordinates,
        refreshCoordinateFields: refreshCoordinateFields,
    };
})();
