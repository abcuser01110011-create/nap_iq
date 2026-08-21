/**
 * Installation Planning — Phase 3 (40%): "Plan Installation" map mode
 * -----------------------------------------------------------------
 * Translates the prototype's `planning` / `proposed` state
 * (src/pages/MapDashboard.tsx) into a fourth Leaflet map-click
 * placement mode, following the exact "new small JS module" pattern
 * nav-origin-picker.js already established for the same reason: this
 * feature needs to coordinate with napmap.js's Add-NAP/Report-Issue
 * modes and with the navigation feature's manual origin picker
 * without napmap.js having to know its internals up front.
 *
 * What this phase does (see PLAN_INSTALL_10_PERCENT_NOTES.md and
 * PLAN_INSTALL_25_PERCENT_NOTES.md for the phases before this one,
 * and INSTALLATION_PLANNING_PHASES.md's Phase 3 section for the exact
 * scope line):
 *   - An admin-only "Plan Installation" button (Jinja-gated in
 *     naps/map.html; this whole script is only loaded for
 *     administrators, so `role === 'admin'` never needs re-checking
 *     in JS) toggles a distinct "planning" mode.
 *   - While active, clicking the map drops a temporary
 *     proposed-installation pin -- a magenta diamond, deliberately a
 *     different shape *and* color from every other marker already on
 *     this map (NAP: colored teardrop/buildIcon(); Issue: colored
 *     triangle/buildIssueIcon(); Subscriber: purple circle/
 *     buildSubscriberIcon(); Customer-recommendation: purple teardrop;
 *     Navigation origin: emerald teardrop-with-checkmark/
 *     nav-origin-picker.js) so it can never be confused with any of
 *     them, including the visually-closest one (the navigation
 *     feature's own manual origin picker).
 *   - Clicking again while planning moves the pin (same "click again
 *     to reposition" convention Add-NAP/Report-Issue already use).
 *   - Cancel (banner button) or toggling the mode button off clears
 *     the pin and exits the mode.
 *   - Joins the existing "only one placement mode at a time" chain:
 *     entering planning mode exits Add-NAP/Report-Issue
 *     (window.NapIQMapModes.exitPlacementModes(), napmap.js) and the
 *     manual origin picker (window.NapIQNavOriginPicker.stopPicking(),
 *     nav-origin-picker.js) -- the same two calls
 *     nav-origin-picker.js's own startPicking() already makes.
 *     napmap.js's enterAddMode()/enterIssueMode() and
 *     NapIQMapModes.exitPlacementModes() have been extended
 *     (guarded by `if (window.NapIQInstallPlanner)`, since this
 *     script only exists for administrators) to call this module's
 *     own exitPlanningMode() right back, completing the same mutual
 *     yield relationship those other modes already enforce among
 *     themselves.
 *
 * --- Phase 4 (55%) additions: Installation Planner suggestion panel ---
 * Translates the prototype's InstallationPlanner "suggest" step
 * (src/components/planning/InstallationPlanner.tsx) into a Bootstrap
 * card rendered into `#installPlannerCard` (naps/map.html), styled
 * like the existing Navigation Card (nav-card.js) it shares a slot
 * with:
 *   - Every time a pin is placed/moved (placeProposedMarker()), this
 *     module calls the Phase 2 data contract
 *     (`GET /api/naps/nearest-available?lat=&lng=`,
 *     PLAN_INSTALL_25_PERCENT_NOTES.md) and renders whatever it
 *     returns -- the real nearest NAP with real open capacity, or the
 *     honest "no NAP available" message. Nothing here fabricates a
 *     NAP or a distance.
 *   - `#installPlannerCard` reuses the exact same `.nav-card`
 *     positioning class as `#navigationCard` (same bottom-right slot,
 *     same width/z-index), and the two are kept mutually exclusive by
 *     toggling `d-none` on whichever one shouldn't show --
 *     `enterPlanningMode()` hides the Navigation Card,
 *     `exitPlanningMode()` shows it again, mirroring the prototype's
 *     `{!planning && <NavigationCard/>}` / `{planning && proposed &&
 *     <InstallationPlanner/>}` pattern (`planning` alone hides
 *     NavigationCard; `proposed` additionally being set is what shows
 *     InstallationPlanner). nav-card.js itself is untouched --  it
 *     keeps rendering into `#navigationCard` exactly as before, this
 *     module only ever toggles that container's own `d-none` class
 *     from the outside.
 *   - A `requestSeq` counter guards against the one race that would
 *     otherwise produce a visibly wrong result even this early (an
 *     in-flight fetch resolving after the pin has since moved or been
 *     cleared): a response is only rendered if it's still the latest
 *     request issued. This is a minimal correctness guard, not the
 *     full stale-request discipline (aborting in-flight requests,
 *     covering every intermediate state) the plan explicitly assigns
 *     to Phase 7 (see the "Deliberately NOT done this phase" list
 *     below).
 *   - The suggestion card's "Use this NAP & add subscriber" button is
 *     rendered but intentionally inert this phase (no click handler)
 *     -- Phase 5 is what turns it into the subscriber-creation form.
 *
 * --- Phase 5 (70%) additions: subscriber-creation form step ---
 * Translates the prototype's InstallationPlanner "form" step and
 * create() function (src/components/planning/InstallationPlanner.tsx):
 *   - The suggestion card's "Use this NAP & add subscriber" button
 *     (rendered inert in Phase 4) is now wired up: clicking it
 *     replaces the panel's content with a short form (subscriber
 *     code, subscriber name, barangay/address, plan type) via
 *     `renderSuggestFormStep()`. Field set intentionally matches only
 *     what INSTALLATION_PLANNING_PHASES.md's Phase 5 section asks
 *     for -- see MapQuickInstallSubscriberForm's docstring
 *     (app/forms.py) for why contact_number/email are not collected.
 *   - Submitting the form (`submitSubscriberForm()`) POSTs to
 *     `POST /subscribers/quick-add` (app/routes/subscribers.py,
 *     Phase 5) with the same X-CSRFToken-header pattern
 *     napmap.js's quickAddForm already uses for `/naps/quick-add`,
 *     plus the dropped pin's lat/lng and the suggested NAP's id
 *     (`currentSuggestionNap`, captured when the suggestion was
 *     rendered) -- a real Subscriber row, CSRF-protected and
 *     server-validated exactly like every other create path in this
 *     app.
 *   - On success, a plain confirmation line with the new subscriber's
 *     code is shown. This is deliberately NOT the prototype's
 *     polished "done" step (code chip styling, map marker refresh,
 *     clearing the pin, exiting planning mode, a "Done" button) --
 *     INSTALLATION_PLANNING_PHASES.md assigns that explicitly to
 *     Phase 6 ("Success state + map refresh"). This phase only has to
 *     prove the real database row gets created; the pin and planning
 *     mode are deliberately left as-is afterward for Phase 6 to
 *     finish.
 *   - On a validation or server error (bad/missing field, the NAP no
 *     longer having capacity, a network failure), the same inline
 *     error area is used to show the real message(s) the server
 *     returned rather than failing silently, and the Create button is
 *     re-enabled so the admin can fix the field and retry.
 *
 * --- Phase 6 (85%) additions: success state + map refresh ---
 * Translates the prototype's "done" step
 * (src/components/planning/InstallationPlanner.tsx's `step === 'done'`
 * branch):
 *   - On a successful create (Phase 5's `submitSubscriberForm()`),
 *     `finishAfterCreate()` now runs instead of the old plain
 *     confirmation line:
 *       1. The just-created subscriber (the real row
 *          `POST /subscribers/quick-add` returned -- not anything held
 *          only in this module's own state) is handed to
 *          `window.NapIQMapModes.addSubscriberMarker()` (napmap.js,
 *          Phase 6), which pushes it into napmap.js's own
 *          `allSubscribers` dataset and rebuilds the *existing*
 *          subscriber marker layer from it -- the same layer/dataset
 *          `renderSubscriberMarkers()` already uses for every other
 *          subscriber marker on this map. No page reload, and no
 *          second, parallel marker-drawing path is introduced (see
 *          "Architecture notes" below for why a reload was not needed
 *          here).
 *       2. The dropped pin is removed from the map and planning mode's
 *          own chrome (the mode button, the banner, the map cursor
 *          class) is reset back to its idle state -- but, unlike
 *          `exitPlanningMode()`, the Installation Planner card itself
 *          is deliberately left showing, now with the "done" step's
 *          content, instead of being hidden -- so the confirmation
 *          survives the pin/mode reset.
 *       3. `renderDoneStep()` renders the prototype's own "done"
 *          copy -- a check icon, "Subscriber created & linked.", and
 *          the new subscriber's code in a chip -- with a "Done" button
 *          matching the prototype's own (`onClose`), which here hides
 *          the Installation Planner card and shows the Navigation Card
 *          again (mirroring `{!planning && <NavigationCard/>}`).
 *   - `INSTALLATION_PLANNING_PHASES.md`'s Phase 6 section asks for
 *     "clear the dropped pin and exit planning mode" as part of the
 *     post-create steps, distinct from "provide a Done action that
 *     closes the panel" -- so, unlike the prototype (where the pin/
 *     planning-mode reset and the panel closing both happen together,
 *     only once "Done" is clicked), this phase resets the pin and
 *     planning-mode chrome immediately on a successful create, and
 *     leaves *closing the confirmation panel itself* as the separate
 *     action the "Done" button performs. Both of the plan's bullet
 *     points still end up satisfied; they just aren't tied to the
 *     same click.
 *
 * Architecture notes / decisions made this phase:
 *   - **No full-page reload.** The existing map already supports
 *     adding a subscriber marker without one (`allSubscribers` +
 *     `renderSubscriberMarkers()` in napmap.js, Phase 23/15%) -- this
 *     phase only had to expose a way for this module to feed one new
 *     row into that existing dataset from outside napmap.js's own
 *     closure, which is what `NapIQMapModes.addSubscriberMarker()`
 *     (napmap.js, Phase 6) is for. A reload was the documented fallback
 *     in the plan for a map that couldn't do this already; that
 *     fallback was not needed.
 *   - **The "Show Subscribers" layer toggle is forced on** by
 *     `addSubscriberMarker()` if it was off, the same way
 *     `focusSubscriber()` (napmap.js) already forces it on -- otherwise
 *     the new subscriber would be added to a layer the admin currently
 *     has hidden and "visibly on the map" (this phase's acceptance
 *     criterion) would not actually hold.
 *
 * --- Phase 7 (95%) additions: error handling, edge cases, RBAC hardening ---
 * `INSTALLATION_PLANNING_PHASES.md`'s Phase 7 section asks this whole
 * feature to be tested and fixed against a checklist of edge cases.
 * Most of that checklist turned out, on inspection, to already be
 * handled correctly by Phases 3-6 (see PLAN_INSTALL_95_PERCENT_NOTES.md
 * for the full trace of each item); the one real gap this phase fixes
 * is in `submitSubscriberForm()`:
 *   - **Stale create-response guard.** `requestSeq` (Phase 4) already
 *     advances the instant the pin moves, is cleared, or planning mode
 *     exits. `submitSubscriberForm()` now captures that counter
 *     (`submitSeq`) the moment the POST is sent, and re-checks it once
 *     the response arrives. Without this, a slow `POST
 *     /subscribers/quick-add` response could resolve *after* the admin
 *     had already dropped a new pin (or cancelled) -- and
 *     `finishAfterCreate()` would then rip the *new* pin off the map,
 *     reset planning mode's chrome out from under whatever the admin
 *     was doing, and overwrite the *new* suggestion/form/"done" step
 *     with the old request's confirmation. A stale success now still
 *     calls `NapIQMapModes.addSubscriberMarker()` unconditionally (the
 *     row is real and must not be lost) but skips every pin/chrome/card
 *     mutation `finishAfterCreate()` would otherwise make. A stale
 *     error is only logged -- the card/button ids it would have
 *     written to may by then belong to a different pin's suggestion or
 *     form, not this request's.
 *
 * Everything else in the Phase 7 checklist (cancelling mid-flow at
 * each step; submitting invalid/missing data; a non-administrator
 * hitting the create endpoint directly; repeatedly toggling planning
 * mode; interaction with the navigation feature's own mode-yielding
 * chain) was traced against the existing code and confirmed already
 * correct without needing a change -- see
 * PLAN_INSTALL_95_PERCENT_NOTES.md for the item-by-item trace and the
 * new automated tests that lock each of those in.
 */
(function () {
    var SUGGEST_URL = "/api/naps/nearest-available";
    var CREATE_URL = "/subscribers/quick-add"; // Phase 5 (70%)

    // Same CSRF pattern napmap.js's quickAddForm already uses for
    // POST /naps/quick-add: read the token once from the page's
    // <meta name="csrf-token"> tag (base.html/dashboard_base.html),
    // send it back as the X-CSRFToken header on every POST this
    // module makes.
    var CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : "";

    var planningActive = false;
    var proposedLatLng = null; // {lat, lng} of the currently-dropped pin
    var proposedMarker = null; // L.Marker for the pin
    var requestSeq = 0; // incremented on every fetch; guards against a stale response overwriting a newer one
    var currentSuggestionNap = null; // Phase 5: the nap object from the last successful suggestion, remembered so the form step knows what to link to
    var connectorLine = null; // L.Polyline linking the prospect pin to the recommended NAP, once one is found

    function map() {
        return window.NapIQMap || null;
    }

    function formatCoords(lat, lng) {
        return lat.toFixed(6) + ", " + lng.toFixed(6);
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    // ---- Distinct marker icon --------------------------------------
    // A rotated-square (diamond) pin in magenta/pink (#d63384, not
    // used anywhere else on this map), with a small house glyph so it
    // also reads as "prospective installation" rather than any
    // existing marker type at a glance -- shape *and* color both
    // differ from NAP/issue/subscriber/customer-recommendation/
    // navigation-origin markers (see this file's header comment).
    function proposedPinHtml() {
        return (
            '<div class="plan-install-marker-wrap">' +
            '<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg" ' +
            'style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));">' +
            '<path d="M15 0C6.7 0 0 6.7 0 15c0 11.25 15 27 15 27s15-15.75 15-27C30 6.7 23.3 0 15 0z" ' +
            'fill="#d63384" stroke="#ffffff" stroke-width="1.5"/>' +
            '<rect x="9.5" y="9.5" width="11" height="11" transform="rotate(45 15 15)" fill="#ffffff"/>' +
            "</svg></div>"
        );
    }

    function proposedPinIcon() {
        return window.L.divIcon({
            className: "plan-install-marker-icon",
            html: proposedPinHtml(),
            iconSize: [30, 42],
            iconAnchor: [15, 40],
            popupAnchor: [0, -36],
        });
    }

    // ---- Pin placement ------------------------------------------------

    function placeProposedMarker(latlng) {
        proposedLatLng = { lat: latlng.lat, lng: latlng.lng };
        var m = map();
        if (!m || !window.L) return;

        if (proposedMarker) {
            proposedMarker.setLatLng(latlng);
        } else {
            proposedMarker = window.L.marker(latlng, {
                icon: proposedPinIcon(),
                interactive: false,
                keyboard: false,
                zIndexOffset: 1100,
            }).addTo(m);
        }

        if (typeof proposedMarker.bindTooltip === "function") {
            proposedMarker.unbindTooltip();
            proposedMarker.bindTooltip("Prospect: " + formatCoords(latlng.lat, latlng.lng), {
                permanent: true,
                direction: "top",
                offset: [0, -36],
                className: "plan-install-tooltip",
            });
        }

        // The pin just moved, so any line drawn to a previous
        // suggestion no longer points anywhere meaningful — clear it
        // now and let the fresh fetchSuggestion() below redraw it
        // (drawConnectorLine()) once the new nearest NAP is known.
        clearConnectorLine();

        updateBannerText();
        fetchSuggestion(proposedLatLng);
    }

    /** Draws a dashed line from the dropped prospect pin to the
     *  recommended NAP returned by fetchSuggestion(), so the
     *  suggestion card's NAP reads as visibly *connected* to the pin
     *  on the map, not just named in a side panel. Straight
     *  point-to-point (not a road-following route — that's the
     *  separate navigation feature in nav-routing.js): this is only
     *  meant to show *which* NAP was picked and roughly how far, the
     *  same way the prototype's own line-to-recommendation affordance
     *  works. Magenta to match the prospect pin itself
     *  (proposedPinHtml()) so the two visibly belong together. */
    function drawConnectorLine(fromLatLng, toLatLng) {
        clearConnectorLine();
        var m = map();
        if (!m || !window.L) return;

        var latlngs = [
            [fromLatLng.lat, fromLatLng.lng],
            [toLatLng.lat, toLatLng.lng],
        ];

        connectorLine = window.L.polyline(latlngs, {
            color: "#d63384",
            weight: 4,
            opacity: 0.95,
            dashArray: "9,6",
            lineCap: "round",
            interactive: false,
            className: "plan-install-connector-line",
        }).addTo(m);
    }

    function clearConnectorLine() {
        var m = map();
        if (connectorLine && m) {
            m.removeLayer(connectorLine);
        }
        connectorLine = null;
    }

    function clearProposedMarker() {
        var m = map();
        if (proposedMarker && m) {
            m.removeLayer(proposedMarker);
        }
        proposedMarker = null;
        proposedLatLng = null;
        currentSuggestionNap = null; // Phase 5: no pin, no suggestion to link a new subscriber to
        requestSeq++; // invalidate any in-flight lookup for the pin just cleared
        clearConnectorLine();
        hideInstallPlannerCard();
        updateBannerText();
    }

    function updateBannerText() {
        var el = document.getElementById("planInstallModeBannerText");
        if (!el) return;
        if (proposedLatLng) {
            el.textContent =
                "Prospect pinned at " + formatCoords(proposedLatLng.lat, proposedLatLng.lng) +
                ". Click elsewhere to move it, or Cancel to clear.";
        } else {
            el.textContent = "Tap anywhere on the map to drop a prospect pin for a potential subscriber location.";
        }
    }

    // ---- Installation Planner suggestion panel (Phase 4, 55%) -------

    function getInstallPlannerCard() {
        return document.getElementById("installPlannerCard");
    }

    function getNavigationCard() {
        return document.getElementById("navigationCard");
    }

    /** Hides the Navigation Card so it and the Installation Planner
     *  card are never both visible at once (same bottom-right slot),
     *  mirroring the prototype's `!planning` visibility check. */
    function hideNavigationCard() {
        var el = getNavigationCard();
        if (el) el.classList.add("d-none");
    }

    /** Shows the Navigation Card again. nav-card.js's own render()
     *  is untouched -- this only ever toggles the container's class,
     *  never its content. */
    function showNavigationCard() {
        var el = getNavigationCard();
        if (el) el.classList.remove("d-none");
    }

    function cardShell(bodyHtml, badgeLabel) {
        return (
            '<div class="card shadow-sm nav-card-enter">' +
            '<div class="card-header d-flex align-items-center justify-content-between bg-white py-2">' +
            '<div class="d-flex align-items-center gap-2 min-w-0">' +
            '<i class="bi bi-geo-fill text-info"></i>' +
            '<span class="fw-semibold text-truncate">Plan Installation</span>' +
            "</div>" +
            '<span class="badge text-bg-info">' + escapeHtml(badgeLabel || "Suggestion") + "</span>" +
            "</div>" +
            '<div class="card-body">' + bodyHtml + "</div>" +
            "</div>"
        );
    }

    /** badgeLabel is optional (defaults to "Suggestion" -- Phase 4's
     *  original label); Phase 5's form step passes "New Subscriber"
     *  so the panel's header still reflects which step is showing. */
    function renderInstallPlannerCard(html, badgeLabel) {
        var el = getInstallPlannerCard();
        if (!el) return;
        el.innerHTML = cardShell(html, badgeLabel);
        el.classList.remove("d-none");
    }

    /** Hides and empties the Installation Planner card. Safe to call
     *  more than once. */
    function hideInstallPlannerCard() {
        var el = getInstallPlannerCard();
        if (!el) return;
        el.classList.add("d-none");
        el.innerHTML = "";
        currentSuggestionNap = null; // Phase 5: no card, no suggestion to link a new subscriber to
    }

    function renderSuggestionLoading() {
        renderInstallPlannerCard(
            '<div class="d-flex align-items-center gap-2 text-muted small">' +
            '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>' +
            "<span>Looking for the nearest available NAP&hellip;</span>" +
            "</div>"
        );
    }

    function renderSuggestionError() {
        clearConnectorLine(); // no confirmed NAP to point at
        renderInstallPlannerCard(
            '<div class="text-danger small">' +
            '<i class="bi bi-exclamation-triangle-fill me-1"></i>' +
            "Could not reach the server to look up the nearest NAP. Check your connection and try clicking the map again." +
            "</div>"
        );
    }

    /** No NAP with available capacity nearby -- the prototype's own
     *  `!suggestion` branch, rendered honestly rather than skipped or
     *  faked (see PLAN_INSTALL_25_PERCENT_NOTES.md §3's documented
     *  `no_nap_available` contract). */
    function renderNoNapAvailable() {
        clearConnectorLine(); // no suitable NAP to point at
        renderInstallPlannerCard(
            '<div class="text-muted small">' +
            '<i class="bi bi-exclamation-circle me-1"></i>' +
            "No NAP with available slots near this location." +
            "</div>"
        );
    }

    function renderSuggestionSuccess(data) {
        var nap = data.nap || {};
        currentSuggestionNap = nap; // Phase 5: remembered for the form step's "Create & link to <NAP code>" submit

        // Visible line from the dropped pin to the recommended NAP, so
        // the connection between "where the prospect is" and "which
        // NAP they'd be assigned to" is obvious on the map itself, not
        // just implied by the suggestion card. proposedLatLng is the
        // request's own origin point, so it's still current here.
        if (proposedLatLng && typeof nap.latitude === "number" && typeof nap.longitude === "number") {
            drawConnectorLine(proposedLatLng, { lat: nap.latitude, lng: nap.longitude });
        }

        var distance = typeof data.distance_km === "number" ? data.distance_km.toFixed(2) + " km" : "\u2014";
        var openSlots = typeof data.available_ports === "number" ? data.available_ports : "\u2014";

        var html =
            '<div class="rounded border bg-light px-2 py-2 mb-2">' +
            '<span class="badge text-bg-primary mb-1">' + escapeHtml(nap.nap_code || "NAP") + "</span>" +
            '<div class="fw-semibold text-truncate">' + escapeHtml(nap.name || "\u2014") + "</div>" +
            '<div class="text-muted small text-truncate">' + escapeHtml(nap.address || "\u2014") + "</div>" +
            '<dl class="row mb-0 mt-2 small">' +
            '<dt class="col-6">Distance</dt><dd class="col-6 text-end">' + escapeHtml(distance) + "</dd>" +
            '<dt class="col-6">Open slots</dt><dd class="col-6 text-end">' + escapeHtml(String(openSlots)) + "</dd>" +
            "</dl>" +
            "</div>" +
            // Phase 5 (70%): now wired to the subscriber-creation form
            // step below, matching the prototype's setStep('form').
            '<button type="button" class="btn btn-success w-100" id="installPlannerUseNapBtn">' +
            '<i class="bi bi-person-plus-fill me-1"></i>Use this NAP &amp; add subscriber' +
            "</button>";

        renderInstallPlannerCard(html);

        var useBtn = document.getElementById("installPlannerUseNapBtn");
        if (useBtn) useBtn.addEventListener("click", renderSuggestFormStep);
    }

    // ---- Subscriber-creation form step (Phase 5, 70%) ----------------

    /** Translates the prototype's InstallationPlanner "form" step:
     *  subscriber code, subscriber name, barangay/address, plan type,
     *  and a "Create & link to <NAP code>" submit button. Requires
     *  `currentSuggestionNap` and `proposedLatLng` to both still be
     *  set (the button that leads here only ever renders when both
     *  are) -- if either is somehow missing, do nothing rather than
     *  render a form with nothing to submit against. */
    function renderSuggestFormStep() {
        var nap = currentSuggestionNap;
        if (!nap || !proposedLatLng) return;

        var napCodeLabel = escapeHtml(nap.nap_code || "NAP");
        var html =
            '<div class="small text-muted mb-2">Linking new subscriber to ' +
            '<span class="badge text-bg-primary">' + napCodeLabel + "</span></div>" +
            '<div class="mb-2">' +
            '<label class="form-label small mb-1" for="installPlannerSubCode">Subscriber code</label>' +
            '<input type="text" class="form-control form-control-sm" id="installPlannerSubCode" ' +
            'maxlength="20" placeholder="e.g. SUB-0012">' +
            "</div>" +
            '<div class="mb-2">' +
            '<label class="form-label small mb-1" for="installPlannerSubName">Subscriber name</label>' +
            '<input type="text" class="form-control form-control-sm" id="installPlannerSubName" ' +
            'maxlength="100" placeholder="Full name">' +
            "</div>" +
            '<div class="mb-2">' +
            '<label class="form-label small mb-1" for="installPlannerSubAddress">Barangay / address</label>' +
            '<textarea class="form-control form-control-sm" id="installPlannerSubAddress" rows="2" ' +
            'maxlength="255" placeholder="Street, Barangay, City/Municipality, Province"></textarea>' +
            "</div>" +
            '<div class="mb-2">' +
            '<label class="form-label small mb-1" for="installPlannerSubPlan">Plan type</label>' +
            '<select class="form-select form-select-sm" id="installPlannerSubPlan">' +
            buildPlanTypeOptionsHtml() +
            "</select>" +
            "</div>" +
            '<div id="installPlannerCreateError" class="text-danger small mb-2 d-none"></div>' +
            '<button type="button" class="btn btn-success w-100" id="installPlannerCreateBtn">' +
            '<i class="bi bi-person-plus-fill me-1"></i>Create &amp; link to ' + napCodeLabel +
            "</button>";

        renderInstallPlannerCard(html, "New Subscriber");

        var createBtn = document.getElementById("installPlannerCreateBtn");
        if (createBtn) createBtn.addEventListener("click", submitSubscriberForm);
    }

    /** Builds the <option> markup for the "Plan type" dropdown by
     *  reading naps/map.html's existing #installPlannerPlanTypes
     *  <datalist> (server-rendered from the union of the database's
     *  distinct existing Subscriber.plan_type values and Settings >
     *  App Settings > Plans' curated list -- see app/routes/naps.py's
     *  geomap()) rather than duplicating that lookup here, so this
     *  dropdown always matches whatever that datalist already has.
     *  Now that plan type is a real <select> instead of a free-text
     *  `<input list=...>`, a blank "-- None --" choice is prepended
     *  since (unlike a datalist-backed input) a <select> always has
     *  something selected. */
    function buildPlanTypeOptionsHtml() {
        var options = '<option value="">-- None --</option>';
        var datalist = document.getElementById("installPlannerPlanTypes");
        if (!datalist) return options;
        datalist.querySelectorAll("option").forEach(function (opt) {
            var value = opt.getAttribute("value") || "";
            if (!value) return;
            options += '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + "</option>";
        });
        return options;
    }

    function createButtonLabel(nap) {
        return '<i class="bi bi-person-plus-fill me-1"></i>Create &amp; link to ' + escapeHtml(nap.nap_code || "NAP");
    }

    /** Shows the given {field: [messages]} dict (the same shape
     *  form.errors already produces, matching napmap.js's
     *  showQuickAddErrors()/payload.errors handling for
     *  /naps/quick-add) as plain text inside the form step's error
     *  area. Also accepts a "_general" key for a non-field message
     *  (a network failure, an unexpected response shape). */
    function showFormErrors(errors) {
        var errorEl = document.getElementById("installPlannerCreateError");
        if (!errorEl) return;
        var messages = [];
        Object.keys(errors || {}).forEach(function (key) {
            (errors[key] || []).forEach(function (msg) {
                messages.push(msg);
            });
        });
        errorEl.textContent = messages.length
            ? messages.join(" ")
            : "Something went wrong while creating the subscriber. Please try again.";
        errorEl.classList.remove("d-none");
    }

    function restoreCreateButton(nap) {
        var btn = document.getElementById("installPlannerCreateBtn");
        if (!btn) return;
        btn.disabled = false;
        btn.innerHTML = createButtonLabel(nap);
    }

    /** POSTs the form step's fields to POST /subscribers/quick-add
     *  (app/routes/subscribers.py, Phase 5). CSRF-protected the same
     *  way napmap.js's quickAddForm already protects
     *  POST /naps/quick-add. On success, hands off to
     *  `finishAfterCreate()` (Phase 6) for the map refresh and "done"
     *  step. */
    function submitSubscriberForm() {
        var nap = currentSuggestionNap;
        var latlng = proposedLatLng;
        if (!nap || !latlng) return;

        // Phase 7 (95%) hardening: remember which pin/suggestion
        // "session" this create belongs to. `requestSeq` already
        // advances the instant the pin moves, is cleared, or planning
        // mode exits (fetchSuggestion()/clearProposedMarker()), so if
        // it has moved on by the time this POST resolves, the pin,
        // card, and mode chrome this response would otherwise touch
        // no longer belong to it -- see the staleness checks below.
        var submitSeq = requestSeq;

        var codeEl = document.getElementById("installPlannerSubCode");
        var nameEl = document.getElementById("installPlannerSubName");
        var addressEl = document.getElementById("installPlannerSubAddress");
        var planEl = document.getElementById("installPlannerSubPlan");
        var errorEl = document.getElementById("installPlannerCreateError");
        var btn = document.getElementById("installPlannerCreateBtn");

        if (errorEl) {
            errorEl.classList.add("d-none");
            errorEl.textContent = "";
        }

        var formData = new FormData();
        formData.append("subscriber_code", codeEl ? codeEl.value : "");
        formData.append("full_name", nameEl ? nameEl.value : "");
        formData.append("address", addressEl ? addressEl.value : "");
        formData.append("plan_type", planEl ? planEl.value : "");
        formData.append("latitude", latlng.lat);
        formData.append("longitude", latlng.lng);
        formData.append("nap_id", nap.id);

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Creating&hellip;';
        }

        fetch(CREATE_URL, {
            method: "POST",
            headers: { "X-CSRFToken": CSRF_TOKEN },
            body: formData,
        })
            .then(function (response) {
                return response.json().then(function (data) {
                    return { ok: response.ok, status: response.status, data: data };
                });
            })
            .then(function (result) {
                // Phase 7 (95%): a newer pin drop, a cleared pin, or an
                // exited planning mode all bump requestSeq -- if that's
                // happened since this request was sent, nothing on
                // screen (pin, card, mode chrome) belongs to this
                // request anymore.
                var stale = submitSeq !== requestSeq;

                if (result.ok && result.data && result.data.status === "success") {
                    var sub = result.data.subscriber || {};
                    if (stale) {
                        // The row is real and must not be lost -- add
                        // it to the map exactly like a fresh create
                        // would -- but skip finishAfterCreate()'s
                        // pin-removal/chrome-reset/"done"-step, all of
                        // which are scoped to whatever the admin has
                        // since moved on to, not this request.
                        if (window.NapIQMapModes && typeof window.NapIQMapModes.addSubscriberMarker === "function") {
                            window.NapIQMapModes.addSubscriberMarker(sub);
                        }
                        return;
                    }
                    finishAfterCreate(sub, nap); // Phase 6 (85%): done step + map refresh
                } else if (stale) {
                    // A failed/rejected create for a pin/session that's
                    // no longer current: nothing on screen is this
                    // request's to update (the same card/button ids may
                    // now belong to a different pin's suggestion or
                    // form), so only note it for diagnostics.
                    console.warn("Subscriber create failed after its pin/session had already changed; no UI updated.", result);
                } else if (result.data && result.data.errors) {
                    showFormErrors(result.data.errors);
                    restoreCreateButton(nap);
                } else {
                    showFormErrors({
                        _general: ["Something went wrong while creating the subscriber. Please try again."],
                    });
                    restoreCreateButton(nap);
                }
            })
            .catch(function (err) {
                console.error("Create subscriber failed:", err);
                if (submitSeq !== requestSeq) return; // stale -- see success branch above
                showFormErrors({
                    _general: ["Could not reach the server. Check your connection and try again."],
                });
                restoreCreateButton(nap);
            });
    }

    function fetchSuggestion(latlng) {
        var mySeq = ++requestSeq;
        renderSuggestionLoading();

        var url = SUGGEST_URL + "?lat=" + encodeURIComponent(latlng.lat) + "&lng=" + encodeURIComponent(latlng.lng);

        fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
            .then(function (response) {
                return response.json().then(function (data) {
                    return { ok: response.ok, data: data };
                });
            })
            .then(function (result) {
                // Stale-response guard: if a newer pin drop has already
                // fired another request, or planning mode/the pin were
                // cleared while this was in flight, drop this result on
                // the floor rather than render it. Full stale-request
                // discipline (aborting the in-flight fetch itself) is
                // Phase 7's job -- this is the minimal guard needed so
                // this phase doesn't ship a visible race.
                if (mySeq !== requestSeq || !planningActive || !proposedLatLng) return;

                if (result.ok && result.data && result.data.status === "success") {
                    renderSuggestionSuccess(result.data);
                } else if (result.ok && result.data && result.data.status === "no_nap_available") {
                    renderNoNapAvailable();
                } else {
                    renderSuggestionError();
                }
            })
            .catch(function (err) {
                console.error("Nearest-available-NAP lookup failed:", err);
                if (mySeq !== requestSeq || !planningActive || !proposedLatLng) return;
                renderSuggestionError();
            });
    }

    // ---- Success state + map refresh (Phase 6, 85%) ------------------

    /** Renders the prototype's own "done" step: a check icon,
     *  "Subscriber created & linked.", the new subscriber's code in a
     *  chip, and a "Done" button. Matching the prototype's `onClose`,
     *  "Done" here hides the Installation Planner card and shows the
     *  Navigation Card again -- the last piece of state this feature
     *  still needs to reset after a successful create. */
    function renderDoneStep(subscriber, nap) {
        var codeLabel = escapeHtml((subscriber && subscriber.subscriber_code) || "");
        var napLabel = escapeHtml((subscriber && subscriber.nap_code) || (nap && nap.nap_code) || "NAP");

        var html =
            '<div class="text-center py-2">' +
            '<i class="bi bi-check-circle-fill text-success" style="font-size:2rem;"></i>' +
            '<p class="small mb-1 mt-2">Subscriber created &amp; linked to ' + napLabel + ".</p>" +
            '<div class="d-flex align-items-center justify-content-center gap-2 small text-muted mb-1">' +
            "New line code " + '<span class="badge text-bg-primary">' + codeLabel + "</span>" +
            "</div>" +
            '<button type="button" class="btn btn-secondary w-100 mt-3" id="installPlannerDoneBtn">Done</button>' +
            "</div>";

        renderInstallPlannerCard(html, "Created");

        var doneBtn = document.getElementById("installPlannerDoneBtn");
        if (doneBtn) {
            doneBtn.addEventListener("click", function () {
                hideInstallPlannerCard();
                showNavigationCard();
            });
        }
    }

    /** Runs after a successful create (submitSubscriberForm()'s
     *  success branch): refreshes the map's subscriber markers with
     *  the real new row, resets the pin and planning-mode's own
     *  chrome, and shows the "done" step in the panel (left up to the
     *  admin to dismiss via "Done" -- see this file's header comment
     *  for why the panel itself isn't torn down here too). */
    function finishAfterCreate(subscriber, nap) {
        // Real map refresh: hand the real created row to napmap.js's
        // own subscriber dataset/marker layer (Phase 6, napmap.js) --
        // no page reload, no second marker-drawing path.
        if (window.NapIQMapModes && typeof window.NapIQMapModes.addSubscriberMarker === "function") {
            window.NapIQMapModes.addSubscriberMarker(subscriber);
        }

        // Clear the dropped pin from the map without hiding the
        // Installation Planner card -- clearProposedMarker() would
        // hide it, and the "done" step below needs that same card.
        var m = map();
        if (proposedMarker && m) {
            m.removeLayer(proposedMarker);
        }
        proposedMarker = null;
        proposedLatLng = null;
        clearConnectorLine();
        requestSeq++; // invalidate any stale in-flight suggestion lookup

        resetPlanningModeChrome();

        renderDoneStep(subscriber, nap);
    }

    // ---- Mode enter/exit ------------------------------------------------

    function enterPlanningMode() {
        if (planningActive) return;

        // Only one "placement mode" is active at a time -- same rule
        // Add-NAP/Report-Issue/the manual origin picker already
        // enforce among themselves (see this file's header comment).
        if (window.NapIQMapModes && typeof window.NapIQMapModes.exitPlacementModes === "function") {
            window.NapIQMapModes.exitPlacementModes();
        }
        if (window.NapIQNavOriginPicker && typeof window.NapIQNavOriginPicker.stopPicking === "function") {
            window.NapIQNavOriginPicker.stopPicking();
        }

        planningActive = true;

        var btn = document.getElementById("planInstallModeBtn");
        if (btn) {
            btn.classList.remove("btn-info");
            btn.classList.add("btn-outline-danger");
            btn.innerHTML = '<i class="bi bi-x-lg me-1"></i>Cancel Plan Installation';
        }

        var banner = document.getElementById("planInstallModeBanner");
        if (banner) banner.classList.remove("d-none");

        var mapEl = document.getElementById("napMap");
        if (mapEl) mapEl.classList.add("plan-install-mode-cursor");

        // Mirrors the prototype's `{!planning && <NavigationCard/>}`:
        // the Navigation Card hides the moment planning mode starts,
        // even before a pin is dropped. The Installation Planner card
        // itself only appears once a pin is placed (fetchSuggestion()).
        hideNavigationCard();

        updateBannerText();
    }

    /** Resets planning mode's own chrome -- the mode button, the
     *  banner, and the map's cursor class -- back to idle. Shared by
     *  `exitPlanningMode()` and `finishAfterCreate()` (Phase 6), which
     *  both need this same reset but differ on what happens to the
     *  Installation Planner card itself (see each caller). */
    function resetPlanningModeChrome() {
        planningActive = false;

        var btn = document.getElementById("planInstallModeBtn");
        if (btn) {
            btn.classList.remove("btn-outline-danger");
            btn.classList.add("btn-info");
            btn.innerHTML = '<i class="bi bi-geo-fill me-1"></i>Plan Installation';
        }

        var banner = document.getElementById("planInstallModeBanner");
        if (banner) banner.classList.add("d-none");

        var mapEl = document.getElementById("napMap");
        if (mapEl) mapEl.classList.remove("plan-install-mode-cursor");
    }

    /** Cleans up planning-mode UI/state. Safe to call more than once. */
    function exitPlanningMode() {
        if (!planningActive) {
            // Still clear a stray pin if one is ever left over, but
            // don't touch button/banner state that's already correct.
            if (proposedMarker) clearProposedMarker();
            return;
        }

        resetPlanningModeChrome();
        clearProposedMarker(); // also hides the Installation Planner card
        showNavigationCard();
    }

    function setup() {
        var btn = document.getElementById("planInstallModeBtn");
        // The button (and this whole script) only exist for
        // administrators (Jinja-gated in naps/map.html). If it's
        // missing, there's nothing to wire up.
        if (!btn) return;

        var cancelBtn = document.getElementById("planInstallModeCancelBtn");

        btn.addEventListener("click", function () {
            if (planningActive) {
                exitPlanningMode();
            } else {
                enterPlanningMode();
            }
        });

        if (cancelBtn) {
            cancelBtn.addEventListener("click", exitPlanningMode);
        }

        function onMapReady() {
            var m = map();
            if (!m) return;
            m.on("click", function (e) {
                if (!planningActive) return;
                placeProposedMarker(e.latlng);
            });
        }

        if (map()) {
            onMapReady();
        } else {
            window.addEventListener("napiq:map-ready", onMapReady, { once: true });
        }
    }

    document.addEventListener("DOMContentLoaded", setup);

    // Exposed so napmap.js (Add-NAP/Report-Issue modes) and
    // nav-origin-picker.js (via NapIQMapModes.exitPlacementModes(),
    // which now also calls this) can make Plan Installation mode
    // yield, the same mutual relationship those modes already have
    // with each other.
    window.NapIQInstallPlanner = {
        exitPlanningMode: exitPlanningMode,
    };
})();
