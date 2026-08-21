/**
 * Navigation Card — foundation (translation-project Phase 4, 20%)
 * -----------------------------------------------------------------
 * Ports the *shape* of the prototype's NavigationCard.tsx (see
 * napV4-route-line/src/components/navigation/NavigationCard.tsx) into
 * a Bootstrap card that floats over the GeoMap, the same way the
 * prototype's card floats over its Leaflet map. It intentionally
 * drops the prototype's Tailwind/dark-HUD styling in favor of the
 * NAP-IQ site's existing light Bootstrap `card` language, per this
 * phase's instructions.
 *
 * This phase is explicitly UI-foundation only — no OSRM routing, no
 * demo travel, no device GPS. It builds on top of the destination
 * selection store that already shipped in Phase 23 (15%)
 * (`window.NapIQNavigation`, defined in nav-destination.js) rather
 * than duplicating it: this file never stores its own copy of the
 * destination, it only *renders* whatever nav-destination.js already
 * has, plus a status/route/controls shell that future phases can
 * populate.
 *
 * Nothing here invents a fake route, fake ETA, or fake distance —
 * when there is no real route (always true this phase, since routing
 * doesn't exist yet) the card says so explicitly instead of showing
 * placeholder numbers that could be mistaken for real ones.
 *
 * Public surface kept deliberately small so later phases (route
 * details, progress, demo travel, device GPS, retry, origin
 * selection) can extend it without rewriting this file:
 *
 *   window.NapIQNavCard.refresh()        // re-render from current store state
 *   window.NapIQNavCard.setCollapsed(bool)
 *   window.NapIQNavCard.isCollapsed()
 *   window.NapIQNavCard.elements()       // { root, body, routeStatus, controls }
 *                                        // stable containers future phases can
 *                                        // target directly instead of re-rendering
 *                                        // the whole card.
 *
 * Phase 5 (25%, translation project) addition: render() now also
 * dispatches a `napiq:navcard-rendered` event after it rebuilds the
 * card DOM. This is the only change in this file for Phase 5 — it
 * lets nav-routing.js (which owns #navCardRouteStatus and
 * #navCardControls content once a route engine exists) re-apply its
 * own content after this card rebuilds those containers, without this
 * file needing to know anything about routing, OSRM, or origins.
 *
 * Phase 16 (80%, translation project) addition: the outermost <div
 * class="card"> rendered by renderExpandedCard()/renderCollapsedPill()
 * now also gets a `nav-card-enter` class (styled in napmap.css) for a
 * short fade/slide-in on every render -- a Bootstrap-native stand-in
 * for the prototype's framer-motion entrance animation. Purely
 * cosmetic; no other change in this file.
 */

(function () {
    var CONTAINER_ID = "navigationCard";
    var collapsed = false;

    var TYPE_LABELS = {
        subscriber: "Subscriber",
        nap: "Network Access Point",
        issue: "Complaint",
    };

    var TYPE_ICONS = {
        subscriber: "bi-person-fill",
        nap: "bi-hdd-network-fill",
        issue: "bi-exclamation-triangle-fill",
    };

    function getContainer() {
        return document.getElementById(CONTAINER_ID);
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    /**
     * Title mirrors the prototype's role-based heading
     * (`role === 'admin' ? 'Live technician tracking' : 'Field
     * navigation'`), read from the real logged-in user's role via a
     * data attribute on the container (see naps/map.html), not
     * hard-coded or guessed client-side.
     */
    function cardTitle(role) {
        return role === "administrator" ? "Live Technician Tracking" : "Field Navigation";
    }

    function cardIcon(role) {
        return role === "administrator" ? "bi-crosshair" : "bi-compass";
    }

    function renderCollapsedPill(destination) {
        var statusText = destination ? "Destination selected" : "Idle";
        return (
            '<div class="card shadow-sm nav-card-pill-card nav-card-enter">' +
            '<div class="card-body d-flex align-items-center gap-2 py-2 px-3">' +
            '<span class="nav-card-dot' + (destination ? " nav-card-dot-active" : "") + '" aria-hidden="true"></span>' +
            '<span class="small fw-semibold text-truncate" style="max-width: 11rem;">' + escapeHtml(statusText) + "</span>" +
            '<button type="button" class="btn btn-sm btn-light border ms-1" id="navCardExpandBtn" ' +
            'aria-expanded="false" aria-controls="navCardBody" title="Expand navigation panel">' +
            '<i class="bi bi-chevron-up"></i></button>' +
            "</div></div>"
        );
    }

    function renderDestinationSummary(destination) {
        var typeLabel = TYPE_LABELS[destination.type] || destination.type;
        var icon = TYPE_ICONS[destination.type] || "bi-geo-alt-fill";
        return (
            '<div class="d-flex align-items-start gap-2 rounded border bg-light px-2 py-2 mb-2">' +
            '<span class="nav-card-type-icon flex-shrink-0"><i class="bi ' + icon + '"></i></span>' +
            '<div class="min-w-0 flex-grow-1">' +
            '<span class="badge text-bg-primary mb-1">' + escapeHtml(typeLabel) + "</span>" +
            '<div class="fw-semibold text-truncate">' + escapeHtml(destination.label) + "</div>" +
            (destination.subtitle
                ? '<div class="text-muted small text-truncate">' + escapeHtml(destination.subtitle) + "</div>"
                : "") +
            '<div class="text-muted small font-monospace mt-1">' +
            destination.position.lat.toFixed(6) + ", " + destination.position.lng.toFixed(6) +
            "</div></div>" +
            '<button type="button" class="btn btn-sm btn-outline-secondary flex-shrink-0" id="navCardClearBtn" title="Clear destination">' +
            '<i class="bi bi-x-lg"></i></button>' +
            "</div>"
        );
    }

    /**
     * Route status area. This phase never has a real route (routing
     * isn't implemented yet), so this is always the honest "no route"
     * placeholder — never a fabricated distance/ETA. Given a stable
     * id (`navCardRouteStatus`) so a future routing phase can locate
     * and replace just this block.
     */
    function renderRouteStatusPlaceholder(hasDestination) {
        var message = hasDestination
            ? "No route calculated yet. Road routing isn&rsquo;t available in this build &mdash; a future phase will show distance, ETA, and live progress here."
            : "Route information will appear here once a destination is selected.";
        return (
            '<div id="navCardRouteStatus" class="nav-card-route-status rounded border bg-light px-2 py-2 mb-2" role="status">' +
            '<div class="d-flex align-items-start gap-2 text-muted small">' +
            '<i class="bi bi-signpost-split mt-1 flex-shrink-0"></i>' +
            "<span>" + message + "</span>" +
            "</div></div>"
        );
    }

    /**
     * Controls container. Deliberately empty of buttons this phase —
     * no demo travel, no device GPS, no retry, no origin picker exist
     * yet, so this phase does not render disabled/fake controls for
     * them. Future phases inject real controls into this same
     * `#navCardControls` element.
     */
    function renderControlsContainer(hasDestination) {
        var note = hasDestination
            ? "Navigation controls (start demo travel, use device GPS, retry route, choose origin) will appear here in a later phase."
            : "";
        return (
            '<div id="navCardControls" class="nav-card-controls">' +
            (note ? '<p class="text-muted small mb-0 fst-italic">' + note + "</p>" : "") +
            "</div>"
        );
    }

    function renderIdleBody() {
        return (
            '<div class="text-muted small" id="navCardEmptyState">' +
            '<i class="bi bi-signpost-split me-1"></i>' +
            "No navigation destination selected. Click a NAP, complaint, or subscriber marker on the map and choose " +
            '&ldquo;Set as destination&rdquo;.' +
            "</div>"
        );
    }

    function renderExpandedCard(role, destination) {
        var title = cardTitle(role);
        var icon = cardIcon(role);
        var hasDestination = !!destination;
        var statusBadge = hasDestination
            ? '<span class="badge text-bg-warning">Awaiting route</span>'
            : '<span class="badge text-bg-secondary">Idle</span>';

        var body = hasDestination
            ? renderDestinationSummary(destination) +
              renderRouteStatusPlaceholder(true) +
              renderControlsContainer(true)
            : renderIdleBody() +
              renderRouteStatusPlaceholder(false) +
              renderControlsContainer(false);

        return (
            '<div class="card shadow-sm nav-card-enter">' +
            '<div class="card-header d-flex align-items-center justify-content-between bg-white py-2">' +
            '<div class="d-flex align-items-center gap-2 min-w-0">' +
            '<i class="bi ' + icon + ' text-primary"></i>' +
            '<span class="fw-semibold text-truncate">' + escapeHtml(title) + "</span>" +
            "</div>" +
            '<div class="d-flex align-items-center gap-2 flex-shrink-0">' +
            statusBadge +
            '<button type="button" class="btn btn-sm btn-light border" id="navCardCollapseBtn" ' +
            'aria-expanded="true" aria-controls="navCardBody" title="Minimize navigation panel">' +
            '<i class="bi bi-chevron-down"></i></button>' +
            "</div></div>" +
            '<div class="card-body nav-card-body" id="navCardBody">' + body + "</div>" +
            "</div>"
        );
    }

    function attachHandlers(destination) {
        var expandBtn = document.getElementById("navCardExpandBtn");
        if (expandBtn) {
            expandBtn.addEventListener("click", function () {
                setCollapsed(false);
            });
        }
        var collapseBtn = document.getElementById("navCardCollapseBtn");
        if (collapseBtn) {
            collapseBtn.addEventListener("click", function () {
                setCollapsed(true);
            });
        }
        var clearBtn = document.getElementById("navCardClearBtn");
        if (clearBtn && window.NapIQNavigation) {
            clearBtn.addEventListener("click", function () {
                window.NapIQNavigation.clearDestination();
            });
        }
    }

    function render() {
        var container = getContainer();
        if (!container) return;

        var role = container.getAttribute("data-role") || "";
        var destination = window.NapIQNavigation ? window.NapIQNavigation.getDestination() : null;

        container.innerHTML = collapsed
            ? renderCollapsedPill(destination)
            : renderExpandedCard(role, destination);

        attachHandlers(destination);

        // Phase 5 (25%, translation project): let modules that hook into
        // #navCardRouteStatus / #navCardControls (e.g. nav-routing.js)
        // know the DOM was just rebuilt, so they can re-apply their own
        // content on top of this render without this file needing to
        // know they exist.
        window.dispatchEvent(new CustomEvent("napiq:navcard-rendered", {
            detail: { destination: destination, collapsed: collapsed },
        }));
    }

    function setCollapsed(next) {
        collapsed = !!next;
        render();
    }

    function isCollapsed() {
        return collapsed;
    }

    function elements() {
        return {
            root: getContainer(),
            body: document.getElementById("navCardBody"),
            routeStatus: document.getElementById("navCardRouteStatus"),
            controls: document.getElementById("navCardControls"),
        };
    }

    document.addEventListener("DOMContentLoaded", render);
    window.addEventListener("napiq:destination-changed", render);

    window.NapIQNavCard = {
        refresh: render,
        setCollapsed: setCollapsed,
        isCollapsed: isCollapsed,
        elements: elements,
    };
})();
