/**
 * Manual map origin picker (Phase 8 — adapted onto Phase 23's
 * navigation architecture)
 * -----------------------------------------------------------------
 * Ported from the original Phase 8 delta
 * (`nap_iq_PHASE8_50pct_manual_origin_picker.zip`)'s
 * `nav-origin-picker.js`, which targeted a `nav-card.js` /
 * `nav-routing.js` stack that doesn't exist in this project. The
 * interaction it implements is unchanged: click a button to arm a
 * one-time map-click listener, drop a temporary marker on the next
 * click, confirm or cancel it, and keep a solid marker in sync with
 * whatever the origin store currently holds. What's different here is
 * what it plugs into:
 *
 *   - Store: `window.NapIQNavOrigin` (this project's `nav-origin.js`,
 *     itself modeled on `nav-destination.js`) instead of the original
 *     delta's own same-named module.
 *   - Map instance: `window.NapIQMap`, now actually exposed by
 *     napmap.js as part of this adaptation (the original delta always
 *     hit its "map not available yet" fallback, since napmap.js had
 *     never been supplied to that translation project). This module
 *     also listens for the `napiq:map-ready` event napmap.js fires
 *     right after creating the map, so it renders its real controls
 *     the moment the map exists even if this script happened to load
 *     and run first.
 *   - Render target: a single `#navOriginPickerControls` container
 *     that `nav-origin.js`'s `renderPanel()` creates (in both the
 *     empty and confirmed states), instead of the original delta's
 *     two separate `nav-card.js` hook points
 *     (`#navCardOriginPickerStatus` / `#navCardPickOriginBtnHost`).
 *     Re-renders on `napiq:navorigin-panel-rendered` (this project's
 *     equivalent of the original `napiq:navcard-rendered`).
 *   - Placement-mode coordination: the original delta explicitly
 *     could not coordinate with napmap.js's "Add NAP" / "Report
 *     issue" click-to-place modes because napmap.js wasn't part of
 *     that translation project. It is here, so this version actually
 *     does it: starting a pick cancels either of those modes via
 *     `window.NapIQMapModes.exitPlacementModes()`, and napmap.js's
 *     `enterAddMode()` / `enterIssueMode()` call this module's
 *     `stopPicking()` right back — the same mutual "only one
 *     placement mode at a time" rule those two modes already enforce
 *     between themselves.
 *
 * Origin object shape produced on confirm (matches this project's
 * `nav-origin.js` / `nav-destination.js` convention — flat
 * `position: {lat, lng}`, not the original delta's identical-in-
 * substance but differently-nested shape):
 *   { id: string, label: string, subtitle: string,
 *     position: { lat: number, lng: number } }
 *
 * Not done here, same as the original delta (out of scope for this
 * adaptation, not newly discovered):
 *   - No road routing consumes the confirmed origin yet — there is no
 *     routing engine in this project at all (see nav-origin.js's file
 *     header and PHASE23_15_PERCENT_NOTES.md). A future phase that
 *     adds one can read `window.NapIQNavOrigin.getOrigin()` /
 *     `window.NapIQNavigation.getDestination()` and listen for both
 *     `napiq:origin-changed` and `napiq:destination-changed`.
 *   - Device GPS origin — was out of scope for the whole original
 *     Phase 8, and still is here.
 *
 * --- Phase 8, second half additions ---
 *   - Live lat/lng sync: `onMapClick()` now pushes the just-dropped
 *     pending point into nav-origin.js's coordinate fields via
 *     `NapIQNavOrigin.previewCoordinates()`; any cancel path reverts
 *     them via `refreshCoordinateFields()`. See nav-origin.js's file
 *     header for the full reconciliation contract.
 *   - Coordinate tooltip: both the pending and confirmed markers now
 *     carry a permanent Leaflet tooltip showing their lat/lng, via
 *     `bindCoordTooltip()`.
 *   - Destination-clear coordination: this project's destination
 *     selection (nav-destination.js) is a popup-button click, not a
 *     map-click placement mode like Add NAP / Report Issue, so it
 *     never actually contends with this picker's own map-click
 *     listener or DOM. There is no bug here to fix. This still wires
 *     `napiq:destination-changed` defensively per spec: if a manual
 *     origin pick is pending (unconfirmed) when the destination is
 *     cleared, it's cancelled cleanly rather than left dangling
 *     alongside a sidebar that just changed underneath it.
 *   - Keyboard: Confirm/Cancel/Pick are native `<button>`s (Enter/
 *     Space already work), but this controls host is torn down and
 *     rebuilt on every `render()`, which silently drops DOM focus.
 *     Each user-initiated action now explicitly refocuses the
 *     relevant button afterward (`focusPickBtn()`/`focusConfirmBtn()`)
 *     so a keyboard user's place in the flow — including reaching
 *     Confirm/Cancel the instant a point becomes pending, ready for
 *     Escape — is never silently lost. The status region also carries
 *     `aria-live="polite"` so state changes are announced either way.
 */
(function () {
    var STATE_IDLE = "idle"; // not picking, no unconfirmed point
    var STATE_PICKING = "picking"; // crosshair active, waiting for a map click
    var STATE_PENDING = "pending"; // temporary marker placed, awaiting confirm/cancel

    var pickState = STATE_IDLE;
    var pendingLatLng = null; // {lat, lng} of the not-yet-confirmed point
    var tempMarker = null; // L.Marker for the pending (unconfirmed) point
    var confirmedMarker = null; // L.Marker for the current, confirmed manual origin
    var clickHandlerBound = false;

    function map() {
        return window.NapIQMap || null;
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    function formatCoords(lat, lng) {
        return lat.toFixed(6) + ", " + lng.toFixed(6);
    }

    // ---- Distinct marker icon (must read as neither a NAP, issue,
    // nor subscriber marker at a glance) ----
    //
    // NAP markers: blue rounded rectangle (buildIcon() in napmap.js).
    // Subscriber markers: person glyph. Issue markers: colored
    // triangle. This picker's marker is a teardrop *pin with a flag*
    // in emerald, a shape none of those three use, so it reads as
    // "starting point" at a glance and is colorblind-distinguishable
    // by shape alone, not just color. Unchanged from the original
    // Phase 8 delta.
    function originPinHtml(pending) {
        var stroke = pending ? "#f59e0b" : "#065f46"; // amber ring while unconfirmed, deep emerald once confirmed
        var fill = pending ? "#34d399" : "#10b981";
        var dash = pending ? ' stroke-dasharray="3,3"' : "";
        return (
            '<div class="nav-origin-marker-wrap' + (pending ? " nav-origin-marker-pending" : "") + '">' +
            '<svg width="34" height="44" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg" ' +
            'style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));">' +
            '<path d="M17 2C9.3 2 3 8.1 3 15.6C3 25.9 17 42 17 42C17 42 31 25.9 31 15.6C31 8.1 24.7 2 17 2Z" ' +
            'fill="' + fill + '" stroke="' + stroke + '" stroke-width="2.5"' + dash + '/>' +
            '<circle cx="17" cy="16" r="6.5" fill="#ffffff"/>' +
            '<path d="M14 16.6L16.2 18.8L20.4 13.6" stroke="' + fill + '" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"/>' +
            "</svg></div>"
        );
    }

    function originIcon(pending) {
        return window.L.divIcon({
            className: "nav-origin-div-icon",
            html: originPinHtml(pending),
            iconSize: [34, 44],
            iconAnchor: [17, 42],
            popupAnchor: [0, -40],
        });
    }

    // ---- Coordinate tooltip (polish item: both the pending and the
    // confirmed marker carry a permanent tooltip with their lat/lng,
    // so the coordinates are visible on the map itself, not just in
    // the sidebar panel) ----
    function bindCoordTooltip(marker, lat, lng, pending) {
        if (!marker || typeof marker.bindTooltip !== "function") return;
        var label = (pending ? "Pending origin: " : "Origin: ") + formatCoords(lat, lng);
        marker.bindTooltip(label, {
            permanent: true,
            direction: "top",
            offset: [0, -38],
            className: "nav-origin-tooltip" + (pending ? " nav-origin-tooltip-pending" : ""),
        });
    }

    // ---- Temporary (unconfirmed) marker ----

    function placeTempMarker(latlng) {
        clearTempMarker();
        var m = map();
        if (!m || !window.L) return;
        tempMarker = window.L.marker([latlng.lat, latlng.lng], {
            icon: originIcon(true),
            interactive: false,
            keyboard: false,
            zIndexOffset: 900,
        }).addTo(m);
        bindCoordTooltip(tempMarker, latlng.lat, latlng.lng, true);
    }

    function clearTempMarker() {
        var m = map();
        if (tempMarker && m) m.removeLayer(tempMarker);
        tempMarker = null;
    }

    // ---- Confirmed marker (mirrors whatever the store currently has,
    // regardless of whether it was set by this picker or the lat/lng
    // form in nav-origin.js) ----

    function syncConfirmedMarker() {
        var m = map();
        if (confirmedMarker && m) {
            m.removeLayer(confirmedMarker);
            confirmedMarker = null;
        }
        var origin = window.NapIQNavOrigin ? window.NapIQNavOrigin.getOrigin() : null;
        if (!origin || !m || !window.L) return;
        confirmedMarker = window.L.marker([origin.position.lat, origin.position.lng], {
            icon: originIcon(false),
            interactive: false,
            keyboard: false,
            zIndexOffset: 800,
        }).addTo(m);
        bindCoordTooltip(confirmedMarker, origin.position.lat, origin.position.lng, false);
    }

    // ---- Map click handling ----

    function onMapClick(evt) {
        if (pickState !== STATE_PICKING) return;
        pendingLatLng = { lat: evt.latlng.lat, lng: evt.latlng.lng };
        placeTempMarker(pendingLatLng);
        pickState = STATE_PENDING;
        setCursor(false);
        // Reconciliation with the lat/lng form (nav-origin.js): show
        // this not-yet-confirmed point in the fields immediately, so
        // the map pick and the form always agree on what's on screen.
        if (window.NapIQNavOrigin) {
            window.NapIQNavOrigin.previewCoordinates(pendingLatLng.lat, pendingLatLng.lng);
        }
        render();
        focusConfirmBtn();
    }

    function ensureClickHandler() {
        var m = map();
        if (!m || !window.L || clickHandlerBound) return;
        m.on("click", onMapClick);
        clickHandlerBound = true;
    }

    function setCursor(picking) {
        var el = document.getElementById("napMap");
        if (!el) return;
        el.classList.toggle("origin-pick-mode-cursor", !!picking);
    }

    // ---- Actions ----

    function startPicking() {
        var m = map();
        if (!m) return; // graceful no-op if the map isn't up yet
        // Only one map-click placement mode at a time — yield Add NAP /
        // Report Issue mode if either is active (see file header).
        if (window.NapIQMapModes && typeof window.NapIQMapModes.exitPlacementModes === "function") {
            window.NapIQMapModes.exitPlacementModes();
        }
        // Phase 18 (90%): a live GPS watch left running in the
        // background would keep pushing accepted fixes into the
        // origin store while the user is mid-pick (picking or
        // pending-unconfirmed), which — via this file's own
        // `onOriginChanged()` below — would silently cancel their
        // in-progress pick out from under them with no explanation.
        // An explicit "pick on map" action should win over a passive
        // background watch, the same way starting GPS tracking
        // already cancels an in-progress pick (nav-gps-origin.js's
        // own `startTracking()`). Symmetric, not new behavior.
        if (window.NapIQNavGpsOrigin && typeof window.NapIQNavGpsOrigin.getState === "function") {
            var gpsState = window.NapIQNavGpsOrigin.getState();
            if (gpsState && gpsState.tracking && typeof window.NapIQNavGpsOrigin.stopTracking === "function") {
                window.NapIQNavGpsOrigin.stopTracking();
            }
        }
        ensureClickHandler();
        cancelPending();
        pickState = STATE_PICKING;
        setCursor(true);
        render();
        focusPickBtn();
    }

    function stopPicking() {
        if (pickState === STATE_IDLE) return;
        pickState = STATE_IDLE;
        cancelPending();
        setCursor(false);
        render();
        focusPickBtn();
    }

    function cancelPending() {
        clearTempMarker();
        pendingLatLng = null;
        // Discard the live preview and fall back to whatever the
        // store actually holds (or blank) — see nav-origin.js's file
        // header for the reconciliation contract.
        if (window.NapIQNavOrigin) window.NapIQNavOrigin.refreshCoordinateFields();
    }

    function confirmPending() {
        if (!pendingLatLng || !window.NapIQNavOrigin) return;
        var origin = {
            id: "manual-map-" + Date.now(),
            label: "Picked on map",
            subtitle: formatCoords(pendingLatLng.lat, pendingLatLng.lng),
            position: { lat: pendingLatLng.lat, lng: pendingLatLng.lng },
        };
        var ok = window.NapIQNavOrigin.setOriginPoint(origin);
        clearTempMarker();
        pendingLatLng = null;
        pickState = STATE_IDLE;
        setCursor(false);
        if (!ok) {
            render("That point could not be used as an origin. Try another spot on the map.");
            focusPickBtn();
            return;
        }
        // napiq:origin-changed (fired by setOriginPoint) triggers
        // nav-origin.js's renderPanel(), which rebuilds
        // #navOriginPickerControls and fires
        // napiq:navorigin-panel-rendered — our listener below calls
        // render() again then. This direct call just avoids a
        // one-frame flash of stale "pending" UI in the meantime.
        render();
        focusPickBtn();
    }

    function cancelPicking() {
        cancelPending();
        pickState = STATE_IDLE;
        setCursor(false);
        render();
        focusPickBtn();
    }

    // ---- Rendering into nav-origin.js's #navOriginPickerControls ----

    function statusHtml(errorMessage) {
        if (errorMessage) {
            return '<div class="text-danger small">' + escapeHtml(errorMessage) + "</div>";
        }
        if (!map()) {
            return (
                '<div class="text-muted small fst-italic">' +
                "Map isn&rsquo;t ready yet." +
                "</div>"
            );
        }
        if (pickState === STATE_PICKING) {
            return (
                '<div class="d-flex align-items-center gap-2 text-primary small">' +
                '<i class="bi bi-cursor-fill"></i>' +
                "<span>Click anywhere on the map to drop a starting point&hellip;</span>" +
                "</div>"
            );
        }
        if (pickState === STATE_PENDING && pendingLatLng) {
            return (
                '<div class="nav-origin-pending-confirm">' +
                '<div class="small mb-1">' +
                '<i class="bi bi-record-circle text-warning me-1"></i>' +
                "Starting point set to <span class=\"font-monospace\">" +
                escapeHtml(formatCoords(pendingLatLng.lat, pendingLatLng.lng)) +
                "</span> &mdash; not yet confirmed." +
                "</div>" +
                '<div class="d-flex gap-2">' +
                '<button type="button" class="btn btn-sm btn-success flex-grow-1" id="navOriginConfirmBtn">' +
                '<i class="bi bi-check-lg me-1"></i>Use this point</button>' +
                '<button type="button" class="btn btn-sm btn-outline-secondary" id="navOriginCancelPickBtn">' +
                "Cancel</button>" +
                "</div></div>"
            );
        }
        return "";
    }

    function pickButtonHtml() {
        if (!map()) return "";
        var picking = pickState === STATE_PICKING;
        return (
            '<button type="button" class="btn btn-sm ' + (picking ? "btn-primary" : "btn-outline-primary") + ' w-100" ' +
            'id="navOriginPickBtn" aria-pressed="' + (picking ? "true" : "false") + '">' +
            '<i class="bi bi-cursor-fill me-1"></i>' + (picking ? "Cancel picking" : "Pick on map") +
            "</button>"
        );
    }

    function render(errorMessage) {
        var host = document.getElementById("navOriginPickerControls");
        if (!host) return;
        var btn = pickButtonHtml();
        var status = statusHtml(errorMessage);
        // aria-live so state changes (armed / pending / error) are
        // announced to screen readers even on the rare re-render that
        // isn't paired with one of the explicit focus moves below.
        host.innerHTML =
            (btn ? '<div class="mb-2">' + btn + "</div>" : "") +
            '<div aria-live="polite" aria-atomic="true">' + status + "</div>";
        attachHandlers();
    }

    // ---- Keyboard focus management ----
    // render() always rebuilds #navOriginPickerControls's innerHTML
    // from scratch, which silently drops DOM focus even when "the
    // same" button is still logically there. Each user-initiated
    // action below explicitly restores focus to the button that makes
    // sense next, so a keyboard user never loses their place.
    function focusPickBtn() {
        var btn = document.getElementById("navOriginPickBtn");
        if (btn) btn.focus();
    }

    function focusConfirmBtn() {
        var btn = document.getElementById("navOriginConfirmBtn");
        if (btn) btn.focus();
    }

    function attachHandlers() {
        var pickBtn = document.getElementById("navOriginPickBtn");
        if (pickBtn) {
            pickBtn.addEventListener("click", function () {
                if (pickState === STATE_PICKING) {
                    stopPicking();
                } else {
                    startPicking();
                }
            });
        }
        var confirmBtn = document.getElementById("navOriginConfirmBtn");
        if (confirmBtn) confirmBtn.addEventListener("click", confirmPending);
        var cancelBtn = document.getElementById("navOriginCancelPickBtn");
        if (cancelBtn) cancelBtn.addEventListener("click", cancelPicking);
    }

    function handleKeydown(evt) {
        if (evt.key === "Escape" && (pickState === STATE_PICKING || pickState === STATE_PENDING)) {
            cancelPicking();
        }
    }

    function onOriginChanged() {
        // Whatever changed the origin (this picker or nav-origin.js's
        // lat/lng form), drop any of *this* module's unconfirmed
        // in-progress state and resync the confirmed-origin marker.
        pickState = STATE_IDLE;
        clearTempMarker();
        pendingLatLng = null;
        setCursor(false);
        syncConfirmedMarker();
        // render() happens via napiq:navorigin-panel-rendered below,
        // once nav-origin.js has rebuilt #navOriginPickerControls.
    }

    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("napiq:origin-changed", onOriginChanged);
    // Defensive coordination with nav-destination.js (see file header:
    // this project's destination selection doesn't actually contend
    // with the picker's map-click listener today, but a pending,
    // unconfirmed origin pick shouldn't be left dangling if the
    // destination underneath it is cleared out from under the sidebar).
    window.addEventListener("napiq:destination-changed", function (evt) {
        if (evt.detail === null && pickState === STATE_PENDING) {
            cancelPending();
            pickState = STATE_IDLE;
            setCursor(false);
            render();
        }
    });
    // nav-origin.js rebuilds #navOriginPickerControls's markup from
    // scratch on every renderPanel() call (both the empty and
    // confirmed states include it) and fires this event right after —
    // that's our cue to render our own controls into the fresh DOM.
    window.addEventListener("napiq:navorigin-panel-rendered", function () {
        render();
    });
    // napmap.js may finish creating window.NapIQMap after or before
    // this script's own DOMContentLoaded handler runs, depending on
    // script load timing — listen for its ready event so the real
    // "Pick on map" button appears the moment the map exists either way.
    window.addEventListener("napiq:map-ready", function () {
        syncConfirmedMarker();
        render();
    });
    document.addEventListener("DOMContentLoaded", function () {
        syncConfirmedMarker();
        render();
    });

    window.NapIQNavOriginPicker = {
        startPicking: startPicking,
        stopPicking: stopPicking,
        cancelPicking: cancelPicking,
        confirmPending: confirmPending,
        getState: function () {
            return { pickState: pickState, pendingLatLng: pendingLatLng };
        },
    };
})();
