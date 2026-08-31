/**
 * NAP-IQ GeoMap
 * ---------------
 * Fetches all NAP records from GET /api/naps once on page load, then
 * does everything else (marker rendering, search, filtering) entirely
 * client-side against that in-memory dataset. No NAP markers are ever
 * hard-coded here — every marker traces back to a row returned by
 * the Flask API, which itself reads straight from MySQL.
 */

(function () {
    // Default view: Sta. Cruz, Laguna town center.
    const DEFAULT_CENTER = [14.2810, 121.4150];
    const DEFAULT_ZOOM = 14;

    const STATUS_COLORS = {
        active: "#198754",
        inactive: "#6c757d",
        maintenance: "#dc3545",
        full: "#fd7e14",
        pending: "#0d6efd",
    };

    const PRIORITY_COLORS = {
        low: "#6c757d",
        medium: "#ffc107",
        high: "#fd7e14",
        critical: "#dc3545",
    };

    // How fast a priority-colored marker pulses, in seconds per pulse
    // cycle -- lower is faster. Critical pulses noticeably faster than
    // the rest so it reads as more urgent at a glance, with each lower
    // priority pulsing a bit slower than the one above it.
    const PRIORITY_PULSE_SECONDS = {
        critical: 0.6,
        high: 1.1,
        medium: 1.6,
        low: 2.2,
    };

    // Responsive icon sizing: Leaflet divIcons are plain HTML/CSS, so
    // by default they stay a fixed *pixel* size on screen no matter
    // the zoom level. That's fine at/above the zoom the icons were
    // designed for, but zooming out packs more ground into the same
    // pixel area, so those same fixed-pixel icons end up sitting on
    // top of each other (see the province-level view where nearby
    // NAP/issue markers visually merge into one blob).
    //
    // ICON_FULL_SIZE_ZOOM is the zoom level at and above which every
    // icon renders at its normal/exact design size (zooming in
    // further never makes them any bigger). Below that, icon size
    // shrinks smoothly down to ICON_MIN_SCALE once zoom reaches
    // ICON_MIN_SCALE_ZOOM, so far-apart markers stay legible while
    // nearby ones overlap far less than they would at full size.
    const ICON_FULL_SIZE_ZOOM = 15;
    const ICON_MIN_SCALE_ZOOM = 8;
    const ICON_MIN_SCALE = 0.35;

    // Live refresh: how often the map silently re-fetches /api/naps,
    // /api/issues, and /api/subscribers and re-renders, so a NAP or
    // subscriber added elsewhere shows up here without a manual
    // reload. This timer is only a background safety net -- the
    // instant paths are the "Refresh" button and the tab-focus
    // listener set up in init(), both of which call refreshLiveData()
    // immediately instead of waiting for this interval to elapse. See
    // refreshLiveData()'s docstring below for the full rationale.
    const LIVE_REFRESH_INTERVAL_MS = 15000;

    /** Current icon scale factor (0 < scale <= 1) for the live map zoom. */
    function getIconScale() {
        if (!map) return 1;
        const zoom = map.getZoom();
        if (zoom >= ICON_FULL_SIZE_ZOOM) return 1;
        if (zoom <= ICON_MIN_SCALE_ZOOM) return ICON_MIN_SCALE;
        const t = (zoom - ICON_MIN_SCALE_ZOOM) / (ICON_FULL_SIZE_ZOOM - ICON_MIN_SCALE_ZOOM);
        return ICON_MIN_SCALE + t * (1 - ICON_MIN_SCALE);
    }

    // Issue statuses that count as "still active" for connection-line
    // coloring purposes -- a resolved/closed issue shouldn't keep a
    // subscriber's line flagged red/orange forever.
    const OPEN_ISSUE_STATUSES = ["pending", "assigned", "in_progress"];
    const PRIORITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
    // Color used for a subscriber↔NAP connection line when that
    // subscriber has no currently-open reported issue -- reads as
    // "healthy" at a glance, same green as an Active NAP.
    const NO_ISSUE_LINE_COLOR = "#198754";

    const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : "";

    let map;
    let markerLayer;
    let issueMarkerLayer;
    let recommendationLayer;   // Phase 22: the customer pin from a NAP recommendation
    let subscriberMarkerLayer; // Phase 23 (15%): subscriber markers, for destination selection
    // Bug-fix notice ("Need to add"): visible connection lines, drawn
    // alongside the subscriber/issue marker layers above and toggled
    // by the exact same "Show Subscribers" / "Show Issues" controls
    // (no new UI). subscriberConnectionLayer draws a line from every
    // plotted subscriber to its assigned NAP; issueConnectionLayer
    // draws a red line from every plotted issue to its NAP, mirroring
    // the subscriber connection so both read the same way at a glance.
    let subscriberConnectionLayer;
    let issueConnectionLayer;
    // Coverage radius ring: a single L.circle for whichever NAP is
    // currently focused/clicked (see focusedNapForRadius below),
    // radius sourced from Settings > App Settings > Max Connection
    // Radius (meters) -- see AppSettings.nap_connection_radius_meters
    // in app/models.py. A geographic L.circle (not a fixed-pixel
    // divIcon) so the ring is always a true to-scale radius in meters
    // at any zoom level, rather than an approximation that only looks
    // right at one zoom.
    let coverageRadiusLayer;
    let napConnectionRadiusMeters = 0; // 0 = no limit set / feature off
    // The single NAP whose coverage ring is currently shown -- set by
    // focusNapOnMap() below. Previously every visible NAP drew its own
    // ring simultaneously, which made overlapping installations
    // unreadable; now only the clicked/focused NAP's ring is ever on
    // the map at once, and it moves to the newly clicked NAP instead
    // of adding another one alongside it.
    let focusedNapForRadius = null;
    let allNaps = [];              // full NAP dataset from the API
    let allIssues = [];            // full technical issue dataset from the API
    let allSubscribers = [];       // active subscribers, for the Report Issue form
    const markersById = {};        // rebuilt on every renderNapMarkers() call
    const issueMarkersById = {};   // rebuilt on every renderIssueMarkers() call
    const subscriberMarkersById = {}; // rebuilt on every renderSubscriberMarkers() call

    /** Looks up a NAP's in-memory record (with lat/lng) by id from the
     * full allNaps dataset -- deliberately NOT markersById, since a
     * NAP can be filtered off the map (status/port filters) while its
     * subscribers/issues are still shown; the connection line should
     * still be able to find where that NAP actually is. */
    function findNapById(napId) {
        if (napId == null) return null;
        return allNaps.find((nap) => nap.id === napId) || null;
    }

    /**
     * "Change the color of connection line base on the reported
     * issues" -- looks at every OPEN (pending/assigned/in_progress)
     * technical issue tied to this subscriber and returns the color
     * for the worst (highest-priority) one found, so a subscriber's
     * connection line reads red/orange the moment they have a
     * critical/high open complaint, and green when they don't have
     * any active complaint at all. Resolved/closed issues are
     * ignored -- once a problem is fixed the line should go back to
     * "healthy" green rather than staying colored forever.
     */
    /** Returns the priority key ("critical"/"high"/"medium"/"low") of a
     * subscriber's worst currently-open reported issue, or null if
     * they have none. Shared by the connection-line color and the
     * subscriber marker icon so both agree on the same issue. */
    function getSubscriberWorstOpenPriority(subscriberId) {
        let worstPriority = null;
        allIssues.forEach((issue) => {
            if (issue.subscriber_id !== subscriberId) return;
            if (OPEN_ISSUE_STATUSES.indexOf(issue.status) === -1) return;
            if (!worstPriority || PRIORITY_RANK[issue.priority] > PRIORITY_RANK[worstPriority]) {
                worstPriority = issue.priority;
            }
        });
        return worstPriority;
    }

    function getSubscriberConnectionColor(subscriberId) {
        const worstPriority = getSubscriberWorstOpenPriority(subscriberId);
        return worstPriority ? (PRIORITY_COLORS[worstPriority] || NO_ISSUE_LINE_COLOR) : NO_ISSUE_LINE_COLOR;
    }

    // Dark-mode basemap: originally this swapped in a CARTO "dark_all"
    // raster tile layer (basemaps.cartocdn.com) whenever the app's display
    // theme (js/theme.js, Settings > Display Settings) was dark. CARTO has
    // since retired free/keyless access to that raster tile service --
    // without an API key it now serves every tile back stamped with a
    // diagonal "API KEY REQUIRED" watermark, which is what shows up on the
    // GeoMap. Rather than requiring every deployment to sign up for a CARTO
    // key, we now always load the free, keyless OpenStreetMap tile layer
    // and fake the dark look with a CSS filter on Leaflet's tile pane
    // instead of swapping to a different tile server. `tileLayer` is the
    // currently-active Leaflet layer so it can be removed/replaced if the
    // theme changes while this page is already open.
    let tileLayer;

    const LIGHT_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    const LIGHT_TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors";

    // CSS filter applied to the tile pane to approximate a dark basemap
    // using the same keyless OSM tiles (invert colors, then re-rotate hue
    // so it doesn't look like a photo negative, and knock the brightness/
    // contrast down a touch so it isn't blinding).
    const DARK_TILE_FILTER = "invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9)";
    const DARK_TILE_FILTER_STYLE_ID = "napiq-dark-tile-filter-style";

    function isDarkTheme() {
        return !!(window.NapIQTheme && window.NapIQTheme.get() === "dark");
    }

    function ensureDarkTileFilterStyleInjected() {
        if (document.getElementById(DARK_TILE_FILTER_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = DARK_TILE_FILTER_STYLE_ID;
        style.textContent =
            "#napMap.napiq-dark-tiles .leaflet-tile-pane { filter: " + DARK_TILE_FILTER + "; }";
        document.head.appendChild(style);
    }

    function applyBasemapForCurrentTheme() {
        if (!map) return;
        ensureDarkTileFilterStyleInjected();

        // Tiles themselves never change -- only the CSS filter toggles.
        if (!tileLayer) {
            tileLayer = L.tileLayer(LIGHT_TILE_URL, { maxZoom: 19, attribution: LIGHT_TILE_ATTRIBUTION });
            tileLayer.addTo(map);
            tileLayer.bringToBack();
        }

        const mapContainer = map.getContainer();
        mapContainer.classList.toggle("napiq-dark-tiles", isDarkTheme());
    }

    // Live-swap the basemap if Dark Mode is toggled while this page is
    // already open, instead of requiring a reload. The coverage radius
    // ring's color is theme-dependent too (see buildCoverageRadiusCircle()),
    // so it needs rebuilding right alongside the basemap.
    window.addEventListener("napiq:theme-changed", function () {
        applyBasemapForCurrentTheme();
        renderNapMarkers();
    });

    // ------------------------------------------------------------------
    // GeoMap Layers/Filters persistence (per-browser, via localStorage)
    // ------------------------------------------------------------------
    // Previously the Layers/Filters dropdowns' *starting* state was set
    // from Settings > App Settings > Default GeoMap Filters, but nothing
    // a person actually changed on the map itself was ever saved -- every
    // reload reset back to that admin-configured default. That settings
    // section has been removed; instead, every control listed below now
    // remembers whatever it was last set to on THIS browser and restores
    // it automatically on the next load, with the checked/selected
    // attributes already in the markup only acting as the very first
    // (pre-any-save) starting point.
    const GEOMAP_FILTER_STORAGE_KEY = "napiq:geomapFilters";

    // Checkbox control ids (Layers + Filters dropdowns). Every one of
    // these already has a unique id in naps/map.html.
    const GEOMAP_FILTER_CHECKBOX_IDS = [
        "showNapsToggle",
        "showIssuesToggle",
        "showSubscribersToggle",
        "showCoverageRadiusToggle",
        "filterActive",
        "filterInactive",
        "filterMaintenance",
        "filterFullStatus",
        "issueFilterPending",
        "issueFilterAssigned",
        "issueFilterInProgress",
        "issueFilterResolved",
        "issueFilterClosed",
        "issuePriorityLow",
        "issuePriorityMedium",
        "issuePriorityHigh",
        "issuePriorityCritical",
    ];
    // Select control ids (currently just Port Availability).
    const GEOMAP_FILTER_SELECT_IDS = ["portsFilter"];

    // Reads every control's *current* state and writes it to
    // localStorage. Wrapped in try/catch since localStorage can throw
    // (private browsing, disabled storage, quota, etc.) -- if that
    // happens the map still works, it just won't remember choices
    // across reloads.
    function saveGeoMapFilterPrefs() {
        try {
            const state = {};
            GEOMAP_FILTER_CHECKBOX_IDS.forEach((id) => {
                const el = document.getElementById(id);
                if (el) state[id] = el.checked;
            });
            GEOMAP_FILTER_SELECT_IDS.forEach((id) => {
                const el = document.getElementById(id);
                if (el) state[id] = el.value;
            });
            localStorage.setItem(GEOMAP_FILTER_STORAGE_KEY, JSON.stringify(state));
        } catch (err) {
            // Ignore -- see comment above.
        }
    }

    // Applies any previously-saved state to the controls, before the
    // first render. Controls with no saved value yet (first-ever visit,
    // or a brand-new control added later) simply keep whatever
    // checked/selected value is already in the markup.
    function restoreGeoMapFilterPrefs() {
        let saved = null;
        try {
            const raw = localStorage.getItem(GEOMAP_FILTER_STORAGE_KEY);
            saved = raw ? JSON.parse(raw) : null;
        } catch (err) {
            saved = null;
        }
        if (!saved || typeof saved !== "object") return;

        GEOMAP_FILTER_CHECKBOX_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el && typeof saved[id] === "boolean") el.checked = saved[id];
        });
        GEOMAP_FILTER_SELECT_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el && typeof saved[id] === "string") el.value = saved[id];
        });
    }

    document.addEventListener("DOMContentLoaded", init);

    async function init() {
        // Phase 33 (default GeoMap focus, instant version): if
        // naps.geomap() already resolved a default-focus NAP
        // server-side, its lat/lng were rendered straight onto
        // #napMap's data attributes (see map.html) — read them here,
        // *before* the map is even created, and use them as the
        // initial setView() target instead of DEFAULT_CENTER/
        // DEFAULT_ZOOM. Marker data (allNaps etc.) hasn't loaded yet
        // at this point, but it doesn't need to have: the coordinates
        // came from the server, not from the client-side dataset.
        // This is what avoids the old "map opens zoomed out at the
        // whole city, then flies over to the focus NAP a moment
        // later" flash — the very first frame the map ever renders is
        // already the correct one. focusDefaultCriticalNap() below
        // (called once allNaps has loaded) only opens that NAP's
        // detail panel; it deliberately does NOT move the map again.
        const mapElForInitialView = document.getElementById("napMap");
        const initialFocusLat = mapElForInitialView
            ? parseFloat(mapElForInitialView.getAttribute("data-focus-nap-lat"))
            : NaN;
        const initialFocusLng = mapElForInitialView
            ? parseFloat(mapElForInitialView.getAttribute("data-focus-nap-lng"))
            : NaN;
        const hasServerFocus = Number.isFinite(initialFocusLat) && Number.isFinite(initialFocusLng);
        const initialCenter = hasServerFocus ? [initialFocusLat, initialFocusLng] : DEFAULT_CENTER;
        const initialZoom = hasServerFocus ? NAP_FOCUS_ZOOM : DEFAULT_ZOOM;

        map = L.map("napMap").setView(initialCenter, initialZoom);

        // Phase 8 (adapted): the manual origin picker (nav-origin-picker.js)
        // needs the live Leaflet map instance to draw its marker and listen
        // for clicks, but everything above this line is a closure-private
        // variable. Expose it read-only-by-convention on window, plus a
        // one-shot ready event so listeners registered before this file
        // finishes loading don't have to guess when it's safe to use it.
        window.NapIQMap = map;
        window.dispatchEvent(new CustomEvent("napiq:map-ready"));

        applyBasemapForCurrentTheme();

        // Added to the map before markerLayer so the rings always sit
        // *underneath* the NAP icons/labels in the stacking order,
        // instead of drawing over and partly hiding them.
        coverageRadiusLayer = L.layerGroup().addTo(map);
        markerLayer = L.layerGroup().addTo(map);
        issueMarkerLayer = L.layerGroup().addTo(map);
        recommendationLayer = L.layerGroup().addTo(map);
        // Read once at load -- set from Settings > App Settings, so it
        // can't change without a page reload anyway (see map.html's
        // data-nap-connection-radius-meters, rendered from
        // AppSettings.nap_connection_radius_meters).
        napConnectionRadiusMeters =
            parseInt(document.getElementById("napMap").dataset.napConnectionRadiusMeters, 10) || 0;
        // Phase 23 (15%): subscriber markers start OFF the map (not
        // added to `map` yet) since they're a brand-new layer no prior
        // phase had — the "Show Subscribers" toggle below decides
        // whether they're ever added. Existing NAP/issue layers are
        // untouched and keep their previous always-on behavior.
        subscriberMarkerLayer = L.layerGroup();
        // Connection-line layers start OFF the map too, same as
        // subscriberMarkerLayer -- renderSubscriberMarkers()/
        // renderIssueMarkers() add or remove them together with their
        // matching marker layer so a line is never shown without its
        // markers (or vice versa).
        subscriberConnectionLayer = L.layerGroup();
        issueConnectionLayer = L.layerGroup();

        await loadNaps();
        await loadIssues();
        await loadSubscribers();

        populateNapSelectForIssue();
        populateSubscriberSelect();

        // Apply whatever Layers/Filters state was saved on a previous
        // visit (if any) before the very first render, so the map draws
        // correctly the first time instead of flashing the markup
        // defaults and then re-rendering.
        restoreGeoMapFilterPrefs();

        renderAll();
        // Delegated click handling for every "Set as destination"
        // button, in any popup (NAP/issue/subscriber). One listener
        // covers all of them since Leaflet re-injects popup HTML into
        // the DOM fresh each time a marker opens.
        map.on("popupopen", handleDestinationButtonInPopup);
        // Same delegated-listener pattern, for the issue popup's
        // "View Ticket" button (see handleViewTicketButtonInPopup).
        map.on("popupopen", handleViewTicketButtonInPopup);
        // Rebuild every marker layer whenever the zoom level settles,
        // so icon sizes (see getIconScale()) track the new zoom
        // instead of staying pinned at whatever size they were built
        // at on the last render.
        map.on("zoomend", renderAll);
        focusDefaultCriticalNap();
        focusIssueFromQueryParam();
        await focusNapRecommendationFromQueryParam();
        // Phase 13 (65%): runs after the other two focus helpers so a
        // page linking with both ?issue_id= (legacy) and the newer
        // ?navigate_type=/?navigate_id= pair has this one win — it's
        // the one that also arms NapIQNavigation, not just pans the
        // map. allNaps/allIssues/allSubscribers are already loaded by
        // this point, same precondition the two calls above rely on.
        focusNavigationFromQueryParam();

        // Re-render whenever a NAP filter control changes, and remember
        // the new state for next time (see GeoMap filter persistence
        // helpers above).
        document.querySelectorAll(".status-filter").forEach((el) => {
            el.addEventListener("change", () => {
                saveGeoMapFilterPrefs();
                renderAll();
            });
        });
        document.getElementById("portsFilter").addEventListener("change", () => {
            saveGeoMapFilterPrefs();
            renderAll();
        });

        // Re-render whenever an issue filter control changes, and save it.
        document.querySelectorAll(".issue-status-filter").forEach((el) => {
            el.addEventListener("change", () => {
                saveGeoMapFilterPrefs();
                renderAll();
            });
        });
        document.querySelectorAll(".issue-priority-filter").forEach((el) => {
            el.addEventListener("change", () => {
                saveGeoMapFilterPrefs();
                renderAll();
            });
        });

        // Show/Hide NAPs, Issues, Subscribers, and Coverage Radius layer
        // toggles -- save on every change so the choice survives a reload.
        document.querySelectorAll(".layer-toggle").forEach((el) => {
            el.addEventListener("change", () => {
                saveGeoMapFilterPrefs();
                renderAll();
            });
        });

        // Search interactions.
        const searchInput = document.getElementById("napSearchInput");
        searchInput.addEventListener("input", handleSearchInput);
        searchInput.addEventListener("focus", handleSearchInput);
        document.addEventListener("click", (event) => {
            const dropdown = document.getElementById("napSearchResults");
            if (!dropdown.contains(event.target) && event.target !== searchInput) {
                dropdown.classList.add("d-none");
            }
        });

        setupQuickAdd();
        setupReportIssue();
        setupTicketDetailsModal();
        setupNapDetailPanel();

        // Background safety net -- see refreshLiveData()'s docstring.
        setInterval(refreshLiveData, LIVE_REFRESH_INTERVAL_MS);

        // Instant catch-up the moment this tab becomes the active one
        // again (e.g. added a subscriber on another page/tab, then
        // switched back here) instead of waiting for the interval
        // above to eventually get to it.
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) refreshLiveData();
        });
        window.addEventListener("focus", () => refreshLiveData());

        // Instant catch-up right after the "+ Tickets" modal creates a
        // ticket (tickets.js, a separate script) -- without this, a
        // freshly-created issue's priority (e.g. a Repair ticket's
        // admin-chosen priority, or a Fiber Break's forced Critical)
        // wouldn't color the affected subscriber's marker until the
        // background timer/focus refresh above eventually got to it.
        // `force=true` since a ticket was just successfully saved, not
        // an ambient background tick -- there's nothing here to avoid
        // interrupting.
        window.addEventListener("napiq:ticket-created", () => refreshLiveData(true));
    }

    /** Rebuilds the NAP, issue, and subscriber marker layers. */
    function renderAll() {
        renderNapMarkers();
        renderIssueMarkers();
        renderSubscriberMarkers();
    }

    /**
     * Keeps the GeoMap current without requiring a manual browser
     * reload. Data can change out from under this page in ways it has
     * no other way of knowing about -- a subscriber added on the
     * Subscribers page, a NAP added from another session, an issue
     * reported, a payment flipping a connected line's status, etc. --
     * since loadNaps()/loadIssues()/loadSubscribers() previously only
     * ever ran once, in init(). This re-runs all three and
     * re-renders every marker layer, the two <datalist>-backing
     * selects, and -- if a NAP's detail panel is currently open --
     * that panel's own numbers (slot usage, connected lines), so it
     * never sits frozen at whatever it showed the moment it was
     * opened.
     *
     * Called from two places, in increasing order of "how fast does
     * this need to feel":
     *   - LIVE_REFRESH_INTERVAL_MS timer (init()) -- a background
     *     safety net for a tab that's just been sitting open;
     *   - the tab regaining focus/visibility (init()) -- covers the
     *     common "added something on another page/tab, switched back
     *     here" case within a moment of switching, not up to 15s later.
     *
     * `force` skips the "don't interrupt an in-progress form" guards
     * below; nothing currently calls refreshLiveData(true), but the
     * guards stay opt-out-able for any future caller that fires
     * outside the timer/focus paths (which fire without the person
     * asking for them, so they need to stay interruption-safe).
     */
    async function refreshLiveData(force) {
        if (!force) {
            if (document.hidden) return;
            if (addModeActive || issueModeActive) return;
            const quickAddModalEl = document.getElementById("quickAddModal");
            const reportIssueModalEl = document.getElementById("reportIssueModal");
            if (quickAddModalEl && quickAddModalEl.classList.contains("show")) return;
            if (reportIssueModalEl && reportIssueModalEl.classList.contains("show")) return;
        }

        const previouslyOpenNapId = openNapDetailNapId;

        await Promise.all([loadNaps(), loadIssues(), loadSubscribers()]);

        renderAll();
        populateNapSelectForIssue();
        populateSubscriberSelect();

        if (previouslyOpenNapId !== null) {
            const updatedNap = findNapById(previouslyOpenNapId);
            if (updatedNap) {
                populateNapDetailPanel(updatedNap);
            } else {
                closeNapDetailPanel();
            }
        }
    }

    /**
     * Step 2/3 of the flow described in the chat explanation:
     * fetch JSON from the Flask API and store it in memory.
     */
    async function loadNaps() {
        try {
            const response = await fetch("/api/naps");
            if (!response.ok) throw new Error("Request failed: " + response.status);
            allNaps = await response.json();
        } catch (err) {
            console.error("Failed to load NAP data:", err);
            allNaps = [];
            const mapEl = document.getElementById("napMap");
            mapEl.insertAdjacentHTML(
                "afterend",
                '<div class="alert alert-danger mt-2">Could not load NAP data from the server. ' +
                    "Check that Flask and MySQL are running, then refresh this page.</div>"
            );
        }
    }

    async function loadIssues() {
        try {
            const response = await fetch("/api/issues");
            if (!response.ok) throw new Error("Request failed: " + response.status);
            allIssues = await response.json();
        } catch (err) {
            console.error("Failed to load technical issue data:", err);
            allIssues = [];
            showAlert("danger", "Could not load technical issues from the server.");
        }
    }

    async function loadSubscribers() {
        try {
            const response = await fetch("/api/subscribers");
            if (!response.ok) throw new Error("Request failed: " + response.status);
            allSubscribers = await response.json();
        } catch (err) {
            console.error("Failed to load subscriber data:", err);
            allSubscribers = [];
        }
    }

    /** Reads the current filter UI state. */
    function getActiveFilters() {
        const statuses = Array.from(document.querySelectorAll(".status-filter"))
            .filter((el) => el.checked)
            .map((el) => el.value);
        const portsMode = document.getElementById("portsFilter").value; // all | available | full
        return { statuses, portsMode };
    }

    /** Returns true if a NAP passes the current status + port filters. */
    function passesFilters(nap, filters) {
        if (!filters.statuses.includes(nap.status)) return false;

        if (filters.portsMode === "available" && nap.available_ports <= 0) return false;
        if (filters.portsMode === "full" && nap.available_ports > 0) return false;

        return true;
    }

    /** Rebuilds the NAP marker layer from allNaps based on current filters. */
    function renderNapMarkers() {
        markerLayer.clearLayers();
        Object.keys(markersById).forEach((key) => delete markersById[key]);

        const showNaps = document.getElementById("showNapsToggle").checked;
        if (!showNaps) {
            coverageRadiusLayer.clearLayers();
            updateResultCount();
            return;
        }

        const filters = getActiveFilters();
        let shown = 0;
        allNaps.forEach((nap) => {
            if (!passesFilters(nap, filters)) return;

            const marker = L.marker([nap.latitude, nap.longitude], {
                icon: buildIcon(nap),
                title: nap.nap_code + " - " + nap.name,
            });
            // NAP markers no longer use a Leaflet popup (see
            // openNapDetailPanel() below) -- clicking one flies the
            // map in to focus on it (see focusNapOnMap() below) and
            // opens/re-populates the right-side slide-in detail panel.
            marker.on("click", () => focusNapOnMap(nap));
            markerLayer.addLayer(marker);
            markersById[nap.id] = marker;
            shown += 1;
        });

        // Only ever draw one coverage ring at a time -- whichever NAP
        // is currently focused (see focusNapOnMap()) -- rather than
        // one per visible NAP. Re-run here too (not just from
        // focusNapOnMap) so a filter change that hides the focused
        // NAP also clears its ring instead of leaving it orphaned.
        renderCoverageRadiusForFocusedNap();

        updateResultCount();
    }

    /**
     * Draws (or clears) the single coverage-radius ring for whichever
     * NAP is currently focused/clicked, per focusedNapForRadius. Only
     * ever shows at most one ring on the map -- see the "Show
     * Coverage Radius" comment on buildCoverageRadiusCircle() below
     * for the ring's own styling.
     */
    function renderCoverageRadiusForFocusedNap() {
        coverageRadiusLayer.clearLayers();

        // Coverage radius toggle only exists in the DOM at all when an
        // admin has set a Max Connection Radius above 0 (see map.html)
        // -- 0 means "no limit", so there's nothing to draw either way.
        const coverageToggle = document.getElementById("showCoverageRadiusToggle");
        const showCoverageRadius =
            napConnectionRadiusMeters > 0 && !!coverageToggle && coverageToggle.checked;
        if (!showCoverageRadius || !focusedNapForRadius) return;

        // Don't draw a ring for a NAP that's no longer actually
        // plotted (filtered out, or Show NAPs turned off).
        if (!markersById[focusedNapForRadius.id]) return;

        coverageRadiusLayer.addLayer(buildCoverageRadiusCircle(focusedNapForRadius));
    }

    /**
     * Builds one coverage-radius ring for a NAP: a true geographic
     * L.circle (radius in meters, not pixels) centered on the NAP, so
     * it stays accurate to Settings > App Settings > Max Connection
     * Radius at every zoom level instead of just approximating it at
     * whichever zoom it was drawn at.
     *
     * Styled as a soft dashed glow rather than a solid shape so it
     * reads as a boundary/coverage indicator layered on top of the
     * basemap, not as another opaque map feature competing with the
     * NAP/issue/subscriber markers -- colored from the app's own
     * --napiq-primary (light) / --napiq-info (dark) tokens so it
     * matches whichever display theme is active (see theme.js /
     * theme-dark.css) instead of a fixed color that would clash with
     * one of the two modes. `interactive: false` keeps clicks passing
     * straight through to the map/marker underneath -- the ring is a
     * visual boundary only, never something you click on.
     */
    function buildCoverageRadiusCircle(nap) {
        const dark = isDarkTheme();
        const color = dark ? "#38bdf8" : "#0f5fa6"; // --napiq-info / --napiq-primary
        return L.circle([nap.latitude, nap.longitude], {
            radius: napConnectionRadiusMeters,
            interactive: false,
            color: color,
            weight: 1.5,
            opacity: dark ? 0.8 : 0.65,
            dashArray: "6 5",
            fillColor: color,
            fillOpacity: dark ? 0.09 : 0.06,
            className: "napiq-coverage-ring " + (dark ? "napiq-coverage-ring-dark" : "napiq-coverage-ring-light"),
        });
    }

    /** Updates the "X of Y shown" counter for whichever layers are visible. */
    function updateResultCount() {
        const counter = document.getElementById("mapResultCount");
        if (!counter) return;
        const napCount = Object.keys(markersById).length;
        const issueCount = Object.keys(issueMarkersById).length;
        const subscriberCount = Object.keys(subscriberMarkersById).length;
        let text =
            napCount + " of " + allNaps.length + " NAP(s), " +
            issueCount + " of " + allIssues.length + " issue(s) shown";
        if (subscriberCount > 0 || document.getElementById("showSubscribersToggle").checked) {
            text += ", " + subscriberCount + " of " + allSubscribers.length + " subscriber(s) shown";
        }
        counter.textContent = text;
    }

    /**
     * Builds the NAP marker icon for a given NAP: the provided
     * radio-tower/signal artwork (window.NAP_ICON_URL, set by
     * naps/map.html from the real static URL), with a small
     * status-colored badge dot layered over its bottom-right corner
     * so the existing status-at-a-glance behavior (active/inactive/
     * full/maintenance/pending, same colors as the legend) is still
     * preserved even though the artwork itself is a single fixed
     * color.
     *
     * A small floating label sits just above the icon showing the
     * NAP's name and, beside it, its port-usage percentage (used_ports
     * / total_ports, same figure shown in the detail panel and colored
     * with the same red/yellow/green thresholds). The label is
     * pointer-events:none and positioned outside the icon's own
     * iconSize box, so it never affects the marker's click hit area
     * or its geo-anchor point.
     *
     * Every pixel dimension below is multiplied by getIconScale(), so
     * the whole marker (artwork, status dot, and label) shrinks
     * smoothly as the map zooms out instead of staying full-size and
     * piling on top of neighboring markers -- and is never any bigger
     * than its normal design size when zoomed in. The name/percentage
     * label is dropped entirely below a legibility threshold so a
     * zoomed-out cluster of NAPs doesn't turn into a wall of tiny
     * unreadable text on top of the overlap.
     */
    function buildIcon(nap) {
        const status = nap.status;
        const color = STATUS_COLORS[status] || "#0d6efd";
        const usagePct = nap.total_ports > 0
            ? Math.round((nap.used_ports / nap.total_ports) * 100)
            : 0;
        const usageColor =
            usagePct >= NAP_USAGE_DANGER_PCT
                ? "#dc3545"
                : usagePct >= NAP_USAGE_WARNING_PCT
                    ? "#b8860b"
                    : "#198754";

        const scale = getIconScale();
        const w = Math.round(34 * scale);
        const h = Math.round(31 * scale);
        const dot = Math.max(4, Math.round(10 * scale));
        const dotOffset = Math.round(2 * scale);
        const dotBorder = Math.max(1, Math.round(2 * scale));

        // Below this scale the label would be too small to read and
        // just adds visual clutter to an already-dense cluster, so
        // it's skipped entirely rather than shrunk further.
        const showLabel = scale >= 0.7;
        let labelHtml = "";
        if (showLabel) {
            const fontSize = Math.max(9, Math.round(11 * scale));
            labelHtml =
                '<div class="nap-marker-label" style="position:absolute;bottom:100%;left:50%;' +
                'transform:translateX(-50%);margin-bottom:3px;white-space:nowrap;display:flex;' +
                'align-items:center;gap:4px;background:transparent;border:none;padding:0;' +
                'font-size:' + fontSize + 'px;line-height:1.4;color:#212529;' +
                'text-shadow:0 0 3px #fff,0 0 3px #fff,0 1px 2px rgba(0,0,0,.5);pointer-events:none;">' +
                '<span class="fw-semibold">' + escapeHtml(nap.name || "") + "</span>" +
                '<span style="color:' + usageColor + ';font-weight:700;">' + usagePct + "%</span>" +
                "</div>";
        }

        const html =
            '<div class="nap-marker-wrap" style="position:relative;width:' + w + 'px;height:' + h + 'px;">' +
            labelHtml +
            '<img src="' + (window.NAP_ICON_URL || "") + '" width="' + w + '" height="' + h + '" ' +
            'alt="" style="display:block;filter:drop-shadow(0 2px 2px rgba(0,0,0,.35));">' +
            // status badge dot, bottom-right corner of the artwork
            '<span style="position:absolute;right:-' + dotOffset + 'px;bottom:-' + dotOffset + 'px;' +
            'width:' + dot + 'px;height:' + dot + 'px;border-radius:50%;background:' + color + ';' +
            'border:' + dotBorder + 'px solid #ffffff;box-shadow:0 1px 2px rgba(0,0,0,.4);"></span>' +
            "</div>";

        return L.divIcon({
            html: html,
            className: "nap-marker-icon" + (status === "pending" ? " nap-marker-pending" : ""),
            iconSize: [w, h],
            iconAnchor: [Math.round(w / 2), Math.round(h * (27 / 31))],
            popupAnchor: [0, -Math.round(h * (24 / 31))],
        });
    }

    // Usage-badge / progress-bar color thresholds for the NAP detail
    // panel, matching the exact convention already used elsewhere in
    // the dashboard (reports/index.html's pct >= near_capacity_threshold
    // / >= 70 ladder, where near_capacity_threshold is
    // NEAR_CAPACITY_THRESHOLD_PCT = 90 in app/routes/reports.py):
    // red >=90%, yellow >=70%, green below that.
    const NAP_USAGE_DANGER_PCT = 90;
    const NAP_USAGE_WARNING_PCT = 70;

    // id of the NAP currently shown in the detail panel, or null when
    // closed. Only used so re-clicking is harmless; open/close state
    // itself lives on the panel element's class (see below).
    let openNapDetailNapId = null;

    // Zoom level a NAP marker click flies in to -- close enough to see
    // the individual NAP clearly (matches the zoom search results and
    // "navigate here" links already fly to, e.g. selectNap() further
    // down) without feeling like a jarring jump-cut.
    const NAP_FOCUS_ZOOM = 18;
    // How long (seconds) the fly-in animation takes when the map
    // actually needs to zoom in (e.g. from the province-level
    // default). Kept snappy rather than the old 1.1s.
    const NAP_FOCUS_FLY_DURATION = 0.6;
    // How long (seconds) a plain pan takes when the map is already at
    // (or past) NAP_FOCUS_ZOOM and is just recentering on a different
    // marker -- see focusMapOn() below for why this is a pan instead
    // of a flyTo in that case.
    const NAP_FOCUS_PAN_DURATION = 0.35;

    /**
     * Moves the map to `latlng`, zooming in to at least `minZoom`
     * without ever zooming back out. Leaflet's flyTo() always eases
     * the zoom through a slight swoop -- even for a short hop where
     * the zoom level doesn't actually need to change -- which reads
     * as an unwanted "shake" when clicking between two nearby
     * markers that are already at/above the target zoom. So: only
     * use flyTo() when a real zoom change is needed; otherwise do a
     * plain animated pan, which moves in a straight line with no
     * swoop.
     */
    function focusMapOn(latlng, minZoom, flyDuration, panDuration) {
        if (!map) return;
        const currentZoom = map.getZoom();
        if (currentZoom >= minZoom) {
            map.panTo(latlng, {
                animate: true,
                duration: panDuration,
            });
        } else {
            map.flyTo(latlng, minZoom, {
                duration: flyDuration,
                // Closer to 1 = straighter/faster-feeling path with
                // less of the curved "fly" swoop than the default
                // 0.25, while still easing in/out.
                easeLinearity: 0.5,
            });
        }
    }

    /**
     * Handles a click on a NAP marker: moves the map to center on
     * that NAP (zooming in from a zoomed-out view, e.g. the province-
     * level default) and opens its detail panel. Never zooms *out* --
     * if the user is already closer than NAP_FOCUS_ZOOM (e.g. they
     * clicked a neighboring NAP while already zoomed in), it keeps
     * their current zoom level and just pans over to the new NAP
     * instead of pulling back out first (see focusMapOn() above).
     */
    function focusNapOnMap(nap) {
        focusMapOn(
            [nap.latitude, nap.longitude],
            NAP_FOCUS_ZOOM,
            NAP_FOCUS_FLY_DURATION,
            NAP_FOCUS_PAN_DURATION
        );
        openNapDetailPanel(nap);
        // Move the single coverage ring over to this NAP (see
        // renderCoverageRadiusForFocusedNap() above).
        focusedNapForRadius = nap;
        renderCoverageRadiusForFocusedNap();
    }

    // How long (ms) the panel's slide out/in swap takes when switching
    // from one NAP's details to another -- kept in sync with the
    // .napmap-detail-panel transition duration in napmap.css (see
    // NAP_DETAIL_PANEL_TRANSITION_MS note there). A few ms of buffer
    // on top of the CSS duration makes sure the slide-out has visibly
    // finished before the new content pops in and slides back.
    const NAP_DETAIL_PANEL_SWITCH_MS = 200;

    /**
     * Opens the right-side NAP detail slide-in panel (#napDetailPanel
     * in naps/map.html) populated with `nap`'s data -- replaces the
     * old marker popup (see renderNapMarkers() above).
     *
     * - Panel closed -> just populate and slide in.
     * - Panel already open showing this same NAP -> re-populate in
     *   place (no animation needed, nothing actually changed).
     * - Panel already open showing a *different* NAP -> slide out,
     *   swap the content, then slide back in, so switching between
     *   markers reads as a deliberate swap instead of the text
     *   flickering in place.
     */
    function openNapDetailPanel(nap) {
        const panel = document.getElementById("napDetailPanel");
        if (!panel) return;

        const isOpen = panel.classList.contains("napmap-detail-panel-open");
        const isSwitchingToDifferentNap = isOpen && openNapDetailNapId !== nap.id;

        if (isSwitchingToDifferentNap) {
            panel.classList.remove("napmap-detail-panel-open");
            window.setTimeout(() => {
                populateNapDetailPanel(nap);
                panel.classList.add("napmap-detail-panel-open");
            }, NAP_DETAIL_PANEL_SWITCH_MS);
            openNapDetailNapId = nap.id;
            return;
        }

        openNapDetailNapId = nap.id;
        populateNapDetailPanel(nap);
        panel.classList.add("napmap-detail-panel-open");
    }

    /** Converts a "#rrggbb" hex color into an "rgba(r,g,b,alpha)"
     * string -- used to derive a slot LED segment's translucent fill
     * and glow from its solid border color. */
    function hexToRgba(hex, alpha) {
        const clean = hex.replace("#", "");
        const r = parseInt(clean.substring(0, 2), 16);
        const g = parseInt(clean.substring(2, 4), 16);
        const b = parseInt(clean.substring(4, 6), 16);
        return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
    }

    /** Current usage-tier color, matching the badge/text-bg-* colors
     * populateNapDetailPanel() already used for the same thresholds. */
    function getUsageTierColor(usagePct) {
        if (usagePct >= NAP_USAGE_DANGER_PCT) return "#dc3545";
        if (usagePct >= NAP_USAGE_WARNING_PCT) return "#ffc107";
        return "#198754";
    }

    /**
     * Fills #napDetailPanel's fields in from `nap`'s data. Split out
     * of openNapDetailPanel() so the slide-out/slide-in swap above can
     * call this once the old content has finished sliding away.
     */
    function populateNapDetailPanel(nap) {
        const panel = document.getElementById("napDetailPanel");
        if (!panel) return;

        const usagePct = nap.total_ports > 0
            ? Math.round((nap.used_ports / nap.total_ports) * 100)
            : 0;

        document.getElementById("napDetailCode").textContent = nap.nap_code;
        document.getElementById("napDetailName").textContent = nap.name;
        document.getElementById("napDetailLocation").textContent = nap.address || "\u2014";

        const usageBadge = document.getElementById("napDetailUsageBadge");
        usageBadge.textContent = usagePct + "%";
        usageBadge.classList.remove("text-bg-success", "text-bg-warning", "text-bg-danger");
        usageBadge.classList.add(
            usagePct >= NAP_USAGE_DANGER_PCT
                ? "text-bg-danger"
                : usagePct >= NAP_USAGE_WARNING_PCT
                    ? "text-bg-warning"
                    : "text-bg-success"
        );

        document.getElementById("napDetailSlotSummary").textContent =
            nap.used_ports + " used \u00b7 " + nap.available_ports + " open";

        const slotBar = document.getElementById("napDetailSlotBar");
        if (slotBar) {
            slotBar.innerHTML = "";
            const ledColor = getUsageTierColor(usagePct);
            const total = Math.max(0, nap.total_ports || 0);
            const used = Math.max(0, Math.min(nap.used_ports || 0, total));
            for (let i = 0; i < total; i++) {
                const segment = document.createElement("div");
                const isOn = i < used;
                segment.className = "napmap-detail-slot-segment" + (isOn ? " napmap-detail-slot-segment-on" : "");
                if (isOn) {
                    segment.style.setProperty("--slot-led-color", ledColor);
                    segment.style.setProperty("--slot-led-fill", hexToRgba(ledColor, 0.35));
                    segment.style.setProperty("--slot-led-glow", hexToRgba(ledColor, 0.55));
                }
                slotBar.appendChild(segment);
            }
        }

        document.getElementById("napDetailTotalSlots").textContent = nap.total_ports + " total slots";

        const lines = nap.connected_lines || [];
        document.getElementById("napDetailLinesHeading").textContent =
            "Connected lines (" + lines.length + ")";

        const linesList = document.getElementById("napDetailLinesList");
        linesList.innerHTML = "";
        if (lines.length === 0) {
            const empty = document.createElement("div");
            empty.className = "napmap-detail-empty-lines";
            empty.textContent = "No subscribers connected to this NAP yet.";
            linesList.appendChild(empty);
        } else {
            lines.forEach((line) => {
                const row = document.createElement("a");
                row.className = "napmap-detail-line-row";
                row.href = "/subscribers/" + line.subscriber_id;
                row.innerHTML =
                    '<span class="badge napmap-detail-line-code">' +
                    escapeHtml(line.subscriber_code) + "</span>" +
                    '<span class="napmap-detail-line-name">' + escapeHtml(line.full_name) + "</span>" +
                    '<span class="badge ' + paymentStatusBadgeClass(line.payment_status) + '">' +
                    escapeHtml(line.payment_status) + "</span>" +
                    '<i class="bi bi-chevron-right napmap-detail-line-chevron"></i>';
                linesList.appendChild(row);
            });
        }

        panel.setAttribute("aria-hidden", "false");
    }

    /** Closes the NAP detail slide-in panel (slides it back off-screen). */
    function closeNapDetailPanel() {
        const panel = document.getElementById("napDetailPanel");
        if (!panel) return;
        panel.classList.remove("napmap-detail-panel-open");
        panel.setAttribute("aria-hidden", "true");
        openNapDetailNapId = null;
    }

    /**
     * Bootstrap badge class for a connected line's payment status,
     * matching the same status->color language payments/list.html
     * already uses (confirmed/"Paid" -> success, pending/"Pending" ->
     * secondary, overdue/"Overdue" -> danger, voided/"Voided" ->
     * dark), keyed here off the human-readable label
     * naps_json()/_connected_lines() sends instead of the raw status.
     */
    function paymentStatusBadgeClass(paymentStatus) {
        switch (paymentStatus) {
            case "Paid": return "text-bg-success";
            case "Pending": return "text-bg-secondary";
            case "Overdue": return "text-bg-danger";
            case "Voided": return "text-bg-dark";
            default: return "text-bg-secondary"; // "No payment"
        }
    }

    /**
     * Wires up the NAP detail panel's close (X) button and makes
     * clicking anywhere else on the map close it too -- the same
     * "click elsewhere dismisses it" behavior a Leaflet popup gets for
     * free. Marker clicks don't bubble up to this map "click"
     * listener, so clicking a different NAP marker re-populates the
     * panel (via its own marker "click" handler in renderNapMarkers())
     * rather than triggering this close handler first.
     */
    function setupNapDetailPanel() {
        const closeBtn = document.getElementById("napDetailCloseBtn");
        if (closeBtn) closeBtn.addEventListener("click", closeNapDetailPanel);
        map.on("click", closeNapDetailPanel);
        setupTicketsDropdownPanelToggle();
    }

    /**
     * The "+ Tickets" dropdown menu (#ticketsDropdownBtn) lives in the
     * same top-right corner the NAP detail panel slides in under (see
     * .napmap-detail-panel's "docked below the top-right button row"
     * comment in napmap.css) -- when the panel is already open and the
     * dropdown opens on top of it, the dropdown's own items end up
     * behind the panel (panel z-index 1003 vs. Bootstrap's dropdown
     * z-index), so the "New Installation" / "Fiber Break" etc. options
     * become impossible to click.
     *
     * Rather than fight z-index ordering, this temporarily slides the
     * detail panel back out (without touching its "open" state/content
     * -- see .napmap-detail-panel-suppressed in napmap.css, which wins
     * over .napmap-detail-panel-open) for as long as the dropdown is
     * open, and slides it back into view the moment the dropdown
     * closes. If the panel wasn't open to begin with, these classes
     * are no-ops.
     */
    function setupTicketsDropdownPanelToggle() {
        const dropdownToggle = document.getElementById("ticketsDropdownBtn");
        const panel = document.getElementById("napDetailPanel");
        if (!dropdownToggle || !panel) return;
        const dropdownEl = dropdownToggle.closest(".dropdown");
        if (!dropdownEl) return;

        dropdownEl.addEventListener("show.bs.dropdown", () => {
            panel.classList.add("napmap-detail-panel-suppressed");
        });
        dropdownEl.addEventListener("hide.bs.dropdown", () => {
            panel.classList.remove("napmap-detail-panel-suppressed");
        });
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    // ---------------- Issue markers ----------------

    /** Reads the current issue filter UI state. */
    function getActiveIssueFilters() {
        const statuses = Array.from(document.querySelectorAll(".issue-status-filter"))
            .filter((el) => el.checked)
            .map((el) => el.value);
        const priorities = Array.from(document.querySelectorAll(".issue-priority-filter"))
            .filter((el) => el.checked)
            .map((el) => el.value);
        return { statuses, priorities };
    }

    /** Returns true if an issue passes the current status + priority filters. */
    function passesIssueFilters(issue, filters) {
        if (!filters.statuses.includes(issue.status)) return false;
        if (!filters.priorities.includes(issue.priority)) return false;
        return true;
    }

    /** Rebuilds the issue marker layer from allIssues based on current filters. */
    function renderIssueMarkers() {
        issueMarkerLayer.clearLayers();
        issueConnectionLayer.clearLayers();
        Object.keys(issueMarkersById).forEach((key) => delete issueMarkersById[key]);

        const showIssues = document.getElementById("showIssuesToggle").checked;
        if (showIssues) {
            if (!map.hasLayer(issueConnectionLayer)) issueConnectionLayer.addTo(map);
        } else {
            if (map.hasLayer(issueConnectionLayer)) map.removeLayer(issueConnectionLayer);
            updateResultCount();
            return;
        }

        const filters = getActiveIssueFilters();
        allIssues.forEach((issue) => {
            if (!passesIssueFilters(issue, filters)) return;

            const marker = L.marker([issue.latitude, issue.longitude], {
                icon: buildIssueIcon(issue.priority),
                title: (issue.issue_code || "Issue") + " - " + issue.issue_type,
            });
            marker.bindPopup(buildIssuePopupHtml(issue));
            issueMarkerLayer.addLayer(marker);
            issueMarkersById[issue.id] = marker;

            // "Reported issues must have a visible line connection to
            // their nap" -- same treatment as the subscriber↔NAP line
            // above, colored by this issue's own priority (same
            // PRIORITY_COLORS palette as the issue marker/legend) so
            // a critical issue's line reads red while a low-priority
            // one reads gray, instead of every issue line looking
            // identically severe.
            const nap = findNapById(issue.nap_id);
            if (nap) {
                const line = L.polyline(
                    [
                        [issue.latitude, issue.longitude],
                        [nap.latitude, nap.longitude],
                    ],
                    {
                        color: PRIORITY_COLORS[issue.priority] || "#dc3545",
                        weight: 2.5,
                        opacity: 0.8,
                        dashArray: "4,4",
                        interactive: false,
                    }
                );
                issueConnectionLayer.addLayer(line);
            }
        });

        updateResultCount();
    }

    /**
     * Builds a marker icon for a technical issue. Deliberately a
     * circular warning badge (not the teardrop pin used for NAPs) so
     * issue markers are visually distinguishable from NAP markers at
     * a glance, colored by priority rather than status. Wrapped in a
     * priority-pulse ring (see .priority-pulse-wrap in napmap.css) so
     * a reported issue reads as "live" on the map, pulsing faster the
     * more urgent its priority is.
     */
    function buildIssueIcon(priority) {
        const color = PRIORITY_COLORS[priority] || "#0d6efd";
        const pulseSeconds = PRIORITY_PULSE_SECONDS[priority] || 1.6;
        const scale = getIconScale();
        const s = Math.round(22 * scale);
        const svg =
            '<svg width="' + s + '" height="' + s + '" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="11" cy="11" r="7" fill="' + color + '"/>' +
            '<text x="11" y="14.5" font-size="10" font-weight="bold" text-anchor="middle" fill="#ffffff" ' +
            'font-family="Arial, sans-serif">!</text>' +
            "</svg>";
        // Small priority label ("CRITICAL", "HIGH", ...) shown above the
        // badge, colored to match its priority so the marker's urgency
        // reads at a glance without opening the popup. Font size is
        // deliberately fixed (not multiplied by the zoom-based icon
        // `scale`) so labels stay a constant, small on-screen size and
        // don't grow/overlap each other when zoomed in.
        const labelText = priority ? String(priority).toUpperCase() : "";
        const label = labelText
            ? '<div class="issue-marker-label" style="color:' + color + ';">' + labelText + "</div>"
            : "";
        const html =
            '<div class="priority-pulse-wrap" style="color:' + color + ';--pulse-duration:' + pulseSeconds + 's;">' +
            svg +
            label +
            "</div>";

        return L.divIcon({
            html: html,
            className: "issue-marker-icon",
            iconSize: [s, s],
            iconAnchor: [Math.round(s / 2), Math.round(s / 2)],
            popupAnchor: [0, -Math.round(s / 2)],
        });
    }

    /** Builds a "pending" (not-yet-saved) issue marker icon — same
     * shape, distinct pulsing blue color, at the "medium" pulse rate. */
    function buildPendingIssueIcon() {
        const scale = getIconScale();
        const s = Math.round(22 * scale);
        const svg =
            '<svg width="' + s + '" height="' + s + '" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="11" cy="11" r="7" fill="#0d6efd"/>' +
            '<text x="11" y="14.5" font-size="10" font-weight="bold" text-anchor="middle" fill="#ffffff" ' +
            'font-family="Arial, sans-serif">!</text>' +
            "</svg>";
        const label = '<div class="issue-marker-label" style="color:#0d6efd;">NEW</div>';
        const html =
            '<div class="priority-pulse-wrap" style="color:#0d6efd;--pulse-duration:' +
            PRIORITY_PULSE_SECONDS.medium +
            's;">' +
            svg +
            label +
            "</div>";

        return L.divIcon({
            html: html,
            className: "issue-marker-icon issue-marker-pending",
            iconSize: [s, s],
            iconAnchor: [Math.round(s / 2), Math.round(s / 2)],
            popupAnchor: [0, -Math.round(s / 2)],
        });
    }

    /** Turns "in_progress" into "In Progress", etc. */
    function formatStatusLabel(value) {
        return String(value)
            .split("_")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }

    /** Builds the popup HTML shown when an issue marker is clicked. */
    function buildIssuePopupHtml(issue) {
        const priorityColor = PRIORITY_COLORS[issue.priority] || "#6c757d";
        return (
            '<div class="issue-popup">' +
            '<div class="issue-popup-code">' + escapeHtml(issue.issue_code || ("Issue #" + issue.id)) + "</div>" +
            "<h6>" + escapeHtml(issue.issue_type) + "</h6>" +
            '<dl class="row mb-1">' +
            '<dt class="col-5">Priority</dt><dd class="col-7">' +
                '<span class="legend-dot legend-dot-square" style="background:' + priorityColor + '"></span> ' +
                formatStatusLabel(issue.priority) + "</dd>" +
            '<dt class="col-5">Status</dt><dd class="col-7">' + formatStatusLabel(issue.status) + "</dd>" +
            '<dt class="col-5">Subscriber</dt><dd class="col-7">' +
                escapeHtml(issue.subscriber_code ? issue.subscriber_code + " — " + issue.subscriber_name : (issue.subscriber_name || "\u2014")) +
                "</dd>" +
            '<dt class="col-5">NAP</dt><dd class="col-7">' + escapeHtml(issue.nap_code || "\u2014") + "</dd>" +
            '<dt class="col-5">Description</dt><dd class="col-7">' + escapeHtml(issue.description || "\u2014") + "</dd>" +
            '<dt class="col-5">Reported</dt><dd class="col-7">' + formatDateTime(issue.created_at) + "</dd>" +
            "</dl>" +
            '<div class="d-flex gap-1">' +
            '<a class="btn btn-sm btn-outline-warning flex-fill" href="/issues/' + issue.id + '">View Issue</a>' +
            '<button type="button" class="btn btn-sm btn-outline-info flex-fill" ' +
            'data-view-ticket-id="' + issue.id + '">' +
            '<i class="bi bi-file-earmark-text me-1"></i>View Ticket</button>' +
            "</div>" +
            "</div>"
        );
    }

    // ---------------- View Ticket (read-only ticket details) ----------------
    // The GeoMap issue popup's old "Set as destination" button is now
    // "View Ticket" -- it opens #ticketDetailsModal (naps/map.html)
    // populated from the same in-memory issue record the popup itself
    // was built from (allIssues), no extra API call needed.
    //
    // A ticket's Assigned Team / Technician(s) requested / Barangay /
    // Scheduled values have no dedicated columns (see tickets.js's
    // submitTN()/submitFiberBreak() docstring) -- they're folded as
    // "Label: value" lines onto the front of `description`, separated
    // from the free-typed text by a blank line. parseTicketExtras()
    // reverses that so the modal can show them as their own fields
    // instead of leaving them buried in the Description text.
    const TICKET_EXTRA_LABELS = ["Assigned Team", "Technician(s) requested", "Barangay", "Scheduled"];

    function parseTicketExtras(description) {
        const extras = { assignedTeam: "", technicians: "", barangay: "", scheduled: "" };
        if (!description) return { extras: extras, description: "" };

        const lines = String(description).split("\n");
        let splitAt = 0;
        for (; splitAt < lines.length; splitAt++) {
            const line = lines[splitAt];
            const match = TICKET_EXTRA_LABELS.find((label) => line.indexOf(label + ": ") === 0);
            if (!match) break;
            const value = line.slice(match.length + 2).trim();
            if (match === "Assigned Team") extras.assignedTeam = value;
            else if (match === "Technician(s) requested") extras.technicians = value;
            else if (match === "Barangay") extras.barangay = value;
            else if (match === "Scheduled") extras.scheduled = value;
        }

        const rest = lines.slice(splitAt).join("\n").trim();
        return { extras: extras, description: rest };
    }

    let ticketDetailsModalInstance = null;

    /** Wires the #ticketDetailsModal instance up once at init(). */
    function setupTicketDetailsModal() {
        const modalEl = document.getElementById("ticketDetailsModal");
        if (!modalEl || typeof bootstrap === "undefined") return;
        ticketDetailsModalInstance = new bootstrap.Modal(modalEl);
    }

    /** Fills #ticketDetailsModal from an in-memory issue record and shows it. */
    function openTicketDetailsModal(issue) {
        if (!ticketDetailsModalInstance) return;

        const parsed = parseTicketExtras(issue.description);
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value || "\u2014";
        };

        setText("ticketDetailsCode", issue.issue_code || ("Issue #" + issue.id));
        setText("ticketDetailsType", issue.issue_type);
        setText("ticketDetailsNap", issue.nap_code);
        setText("ticketDetailsPriority", formatStatusLabel(issue.priority));
        setText("ticketDetailsStatus", formatStatusLabel(issue.status));
        setText("ticketDetailsAssignedTeam", parsed.extras.assignedTeam);
        setText("ticketDetailsTechnicians", parsed.extras.technicians);
        setText("ticketDetailsCreated", formatDateTime(issue.created_at));
        setText("ticketDetailsDescription", parsed.description);

        const priorityDot = document.getElementById("ticketDetailsPriorityDot");
        if (priorityDot) priorityDot.style.background = PRIORITY_COLORS[issue.priority] || "#6c757d";

        const viewIssueLink = document.getElementById("ticketDetailsViewIssueLink");
        if (viewIssueLink) viewIssueLink.href = "/issues/" + issue.id;

        ticketDetailsModalInstance.show();
    }

    /**
     * Delegated handler, attached once to `map`'s "popupopen" event
     * (see init()) -- same pattern as handleDestinationButtonInPopup.
     * Every issue popup this file builds may contain one
     * `[data-view-ticket-id]` button; this wires its click to look
     * the issue up (by id, in allIssues) and open the ticket modal.
     */
    function handleViewTicketButtonInPopup(event) {
        const container = event.popup.getElement();
        if (!container) return;
        const btn = container.querySelector("[data-view-ticket-id]");
        if (!btn) return;

        btn.addEventListener("click", () => {
            const entityId = Number(btn.getAttribute("data-view-ticket-id"));
            const issue = allIssues.find((i) => i.id === entityId);
            if (issue) openTicketDetailsModal(issue);
        });
    }

    // ---------------- Subscriber markers (Phase 23, 15%) ----------------
    // Subscribers had no marker layer before this phase — they only
    // fed the Report Issue form's dropdown (loadSubscribers(), still
    // used exactly as before). This section is purely additive: a new
    // optional layer, off by default, that plots the same
    // already-loaded `allSubscribers` dataset (no new API call) so a
    // real subscriber can be selected as a navigation destination the
    // same way a NAP or issue can. Existing NAP/issue marker code
    // above is completely untouched.

    // Zoom level a subscriber marker click flies in to, and how long
    // the animation takes -- same values as NAP_FOCUS_ZOOM /
    // NAP_FOCUS_FLY_DURATION above so NAP and subscriber clicks feel
    // consistent with each other.
    const SUBSCRIBER_FOCUS_ZOOM = NAP_FOCUS_ZOOM;
    const SUBSCRIBER_FOCUS_FLY_DURATION = NAP_FOCUS_FLY_DURATION;
    const SUBSCRIBER_FOCUS_PAN_DURATION = NAP_FOCUS_PAN_DURATION;

    /**
     * Handles a click on a subscriber marker: moves the map to center
     * on that subscriber (same never-zoom-out, shake-free behavior as
     * focusNapOnMap()/focusMapOn() above) and opens its popup. Shared
     * by both a direct marker click (see renderSubscriberMarkers()
     * below) and focusSubscriber() (search-result / "navigate here"
     * flow).
     */
    function focusSubscriberOnMap(subscriber, marker) {
        focusMapOn(
            [subscriber.latitude, subscriber.longitude],
            SUBSCRIBER_FOCUS_ZOOM,
            SUBSCRIBER_FOCUS_FLY_DURATION,
            SUBSCRIBER_FOCUS_PAN_DURATION
        );
        if (marker) marker.openPopup();
    }

    /** Rebuilds the subscriber marker layer from allSubscribers. Only
     * subscribers with known coordinates can be plotted — same
     * skip-if-unplottable rule /api/naps and /api/issues already use
     * (subscriber latitude/longitude is nullable in the schema). */
    function renderSubscriberMarkers() {
        subscriberMarkerLayer.clearLayers();
        subscriberConnectionLayer.clearLayers();
        Object.keys(subscriberMarkersById).forEach((key) => delete subscriberMarkersById[key]);

        const toggle = document.getElementById("showSubscribersToggle");
        const showSubscribers = toggle ? toggle.checked : false;

        // The alert badge + pulse only shows on a subscriber's own
        // marker when "Show Issues" is checked -- unchecked, every
        // subscriber marker stays the plain person icon regardless of
        // whether it has an open issue, so "Show Issues" is what
        // switches the pulsing alert look on, not just the presence
        // of an issue.
        const showIssuesToggle = document.getElementById("showIssuesToggle");
        const showIssuesEnabled = showIssuesToggle ? showIssuesToggle.checked : false;

        if (showSubscribers) {
            if (!map.hasLayer(subscriberMarkerLayer)) subscriberMarkerLayer.addTo(map);
            if (!map.hasLayer(subscriberConnectionLayer)) subscriberConnectionLayer.addTo(map);
        } else {
            if (map.hasLayer(subscriberMarkerLayer)) map.removeLayer(subscriberMarkerLayer);
            if (map.hasLayer(subscriberConnectionLayer)) map.removeLayer(subscriberConnectionLayer);
            updateResultCount();
            return;
        }

        allSubscribers.forEach((subscriber) => {
            if (subscriber.latitude == null || subscriber.longitude == null) return;

            // Computed once per subscriber and reused for the marker
            // icon (person vs. pulsing alert badge) -- but only fed
            // to the icon builder when "Show Issues" is on, so the
            // alert badge/pulse appears together with that toggle
            // instead of always showing for a subscriber with an
            // open issue.
            const worstPriority = showIssuesEnabled ? getSubscriberWorstOpenPriority(subscriber.id) : null;

            const marker = L.marker([subscriber.latitude, subscriber.longitude], {
                icon: buildSubscriberIcon(worstPriority),
                title: subscriber.subscriber_code + " - " + subscriber.full_name,
            });
            marker.bindPopup(buildSubscriberPopupHtml(subscriber));
            // Leaflet's bindPopup() adds its own "click marker -> open
            // popup instantly" handler. We strip that (nothing else is
            // listening for "click" on a freshly-created marker yet,
            // so this is safe) and replace it with focusSubscriberOnMap()
            // so the map flies/zooms in first instead of the popup
            // snapping open at whatever zoom level the user was
            // already at.
            marker.off("click");
            marker.on("click", () => focusSubscriberOnMap(subscriber, marker));
            subscriberMarkerLayer.addLayer(marker);
            subscriberMarkersById[subscriber.id] = marker;

            // "Subscribers connection to nap must be visible when I
            // enable the subscribers checkbox" -- a line from the
            // subscriber to its assigned NAP, when that NAP's location
            // is known. Colored by getSubscriberConnectionColor() --
            // green when the subscriber has no open reported issue,
            // otherwise the color of their worst open issue's priority
            // (same palette the issue markers/legend already use), so
            // a glance at the map shows which links are unhealthy.
            const nap = findNapById(subscriber.nap_id);
            if (nap) {
                const line = L.polyline(
                    [
                        [subscriber.latitude, subscriber.longitude],
                        [nap.latitude, nap.longitude],
                    ],
                    {
                        color: getSubscriberConnectionColor(subscriber.id),
                        weight: 2.5,
                        opacity: 0.8,
                        dashArray: "4,4",
                        interactive: false,
                    }
                );
                subscriberConnectionLayer.addLayer(line);
            }
        });

        updateResultCount();
    }

    /** Small circular marker for subscribers — visually distinct from
     * both the NAP teardrop pin and the issue warning badge. When the
     * subscriber has a currently-open reported issue, `priority` is
     * passed in and the normal person icon is swapped for the same
     * warning-badge look issues use (colored + pulsed at that
     * priority's rate) so a subscriber with a problem stands out from
     * a healthy one without needing to open its popup. */
    function buildSubscriberIcon(priority) {
        const s = Math.round(22 * getIconScale());

        if (priority) {
            const color = PRIORITY_COLORS[priority] || NO_ISSUE_LINE_COLOR;
            const pulseSeconds = PRIORITY_PULSE_SECONDS[priority] || 1.6;
            // Same r=7 circle as the normal (no-issue) icon below, so
            // the subscriber marker reads as the same on-screen size
            // whether or not it currently has an open issue -- only
            // the badge's color/glyph and the pulse change.
            const svg =
                '<svg width="' + s + '" height="' + s + '" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
                '<circle cx="11" cy="11" r="7" fill="' + color + '"/>' +
                '<text x="11" y="14.5" font-size="10" font-weight="bold" text-anchor="middle" fill="#ffffff" ' +
                'font-family="Arial, sans-serif">!</text>' +
                "</svg>";
            const html =
                '<div class="priority-pulse-wrap" style="color:' + color + ';--pulse-duration:' + pulseSeconds + 's;">' +
                svg +
                "</div>";

            return L.divIcon({
                html: html,
                className: "subscriber-marker-icon subscriber-marker-icon-alert",
                iconSize: [s, s],
                iconAnchor: [Math.round(s / 2), Math.round(s / 2)],
                popupAnchor: [0, -Math.round(s / 2)],
            });
        }

        // Body circle at r=7 -- matches the alert badge's r=7 circle
        // above so the marker is the same on-screen size in both
        // states. Head/shoulders scaled down to match (originally
        // drawn around an r=9 body).
        const svg =
            '<svg width="' + s + '" height="' + s + '" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="11" cy="11" r="7" fill="#6f42c1" stroke="#ffffff" stroke-width="2"/>' +
            '<circle cx="11" cy="9.06" r="2.02" fill="#ffffff"/>' +
            '<path d="M6.72 15.28c0-2.33 1.94-3.89 4.28-3.89s4.28 1.56 4.28 3.89" fill="#ffffff"/>' +
            "</svg>";

        return L.divIcon({
            html: svg,
            className: "subscriber-marker-icon",
            iconSize: [s, s],
            iconAnchor: [Math.round(s / 2), Math.round(s / 2)],
            popupAnchor: [0, -Math.round(s / 2)],
        });
    }

    /** Builds the popup HTML shown when a subscriber marker is clicked. */
    function buildSubscriberPopupHtml(subscriber) {
        return (
            '<div class="subscriber-popup">' +
            '<div class="nap-popup-code">' + escapeHtml(subscriber.subscriber_code) + "</div>" +
            "<h6>" + escapeHtml(subscriber.full_name) + "</h6>" +
            '<dl class="row mb-1">' +
            '<dt class="col-5">Address</dt><dd class="col-7">' + escapeHtml(subscriber.address || "\u2014") + "</dd>" +
            "</dl>" +
            '<div class="d-flex gap-1">' +
            '<a class="btn btn-sm btn-outline-secondary flex-fill" href="/subscribers/' + subscriber.id + '">View Subscriber</a>' +
            '<button type="button" class="btn btn-sm btn-outline-success flex-fill" ' +
            'data-dest-type="subscriber" data-dest-id="' + subscriber.id + '">' +
            '<i class="bi bi-signpost-split me-1"></i>Set as destination</button>' +
            "</div>" +
            "</div>"
        );
    }

    // ---------------- Navigation destination selection (Phase 23, 15%) ----------------
    // Translates the prototype's NavigationDestination concept (see
    // src/types/index.ts + src/store/NavigationStore.tsx) into plain
    // JSON built from data already loaded above (allNaps, allIssues,
    // allSubscribers — every value here traces back to a real
    // database row, nothing hard-coded). The shape matches the
    // backend contract already documented in
    // PHASE23_10_PERCENT_NOTES.md (app/navigation_contract.py's
    // destination_json()), so a future phase that adds a
    // server-rendered destination (e.g. from a technician's own
    // assignment list) produces an identical-looking object.
    //
    // This phase stops at *selecting* a destination and exposing it
    // (via NapIQNavigation, see nav-destination.js) — no routing, no
    // GPS, no demo travel is wired up here.

    function buildDestinationFromNap(nap) {
        return {
            id: "nap-" + nap.id,
            type: "nap",
            label: nap.name,
            subtitle: nap.nap_code,
            position: { lat: nap.latitude, lng: nap.longitude },
        };
    }

    function buildDestinationFromIssue(issue) {
        return {
            id: "issue-" + issue.id,
            type: "issue",
            label: issue.issue_code || ("Issue #" + issue.id),
            subtitle: issue.subscriber_name || issue.address || "",
            position: { lat: issue.latitude, lng: issue.longitude },
            issueId: issue.id,
        };
    }

    function buildDestinationFromSubscriber(subscriber) {
        return {
            id: "subscriber-" + subscriber.id,
            type: "subscriber",
            label: subscriber.full_name,
            subtitle: subscriber.subscriber_code,
            position: { lat: subscriber.latitude, lng: subscriber.longitude },
        };
    }

    /**
     * Phase 13 (65%, navigation destination panels): reads the
     * `?navigate_type=`/`?navigate_id=` pair naps.geomap() rendered
     * onto #napMap's data attributes (see map.html) — set by the
     * "Navigate" button on naps/view.html, subscribers/view.html, and
     * issues/view.html — and, if present, looks the real entity up in
     * whichever in-memory dataset already holds it (allNaps/
     * allIssues/allSubscribers), pans/opens its popup the same way a
     * search result or a legacy `?issue_id=` link does, and — the
     * part those two don't do — immediately arms it as the active
     * navigation destination via NapIQNavigation, using the exact
     * same buildDestinationFrom*() helper a "Set as destination"
     * popup click uses. So a NAP/subscriber/issue reached this way is
     * indistinguishable, from here on, from one picked by hand on the
     * map.
     *
     * Same "runs once after the initial render, empty attribute means
     * no focus" shape as focusIssueFromQueryParam() above. An unknown
     * navigate_type (already filtered server-side, but defensive
     * here too) or unknown/foreign id simply selects nothing.
     */
    function focusNavigationFromQueryParam() {
        const mapEl = document.getElementById("napMap");
        const navigateType = mapEl ? mapEl.getAttribute("data-navigate-type") : "";
        const rawId = mapEl ? mapEl.getAttribute("data-navigate-id") : "";
        if (!navigateType || !rawId) return;

        const entityId = Number(rawId);
        if (!Number.isInteger(entityId)) return;

        let destination = null;

        if (navigateType === "nap") {
            const nap = allNaps.find((n) => n.id === entityId);
            if (nap) {
                selectNap(nap);
                destination = buildDestinationFromNap(nap);
            }
        } else if (navigateType === "issue") {
            const issue = allIssues.find((i) => i.id === entityId);
            if (issue) {
                focusIssue(issue);
                destination = buildDestinationFromIssue(issue);
            }
        } else if (navigateType === "subscriber") {
            const subscriber = allSubscribers.find((s) => s.id === entityId);
            if (subscriber && subscriber.latitude != null && subscriber.longitude != null) {
                focusSubscriber(subscriber);
                destination = buildDestinationFromSubscriber(subscriber);
            }
        }

        if (!destination || !window.NapIQNavigation) return;
        window.NapIQNavigation.setDestination(destination);
    }

    /**
     * Delegated handler, attached once to `map`'s "popupopen" event
     * (see init()). Every popup this file builds (NAP/issue/subscriber)
     * may contain one `[data-dest-type][data-dest-id]` button; this
     * finds it inside whichever popup just opened and wires its click
     * to look the real entity up (by id, in the same in-memory arrays
     * the map already uses) and hand it to NapIQNavigation.
     */
    function handleDestinationButtonInPopup(event) {
        const container = event.popup.getElement();
        if (!container) return;
        const btn = container.querySelector("[data-dest-type][data-dest-id]");
        if (!btn) return;

        btn.addEventListener("click", () => {
            const destType = btn.getAttribute("data-dest-type");
            const entityId = Number(btn.getAttribute("data-dest-id"));
            let destination = null;

            if (destType === "nap") {
                const nap = allNaps.find((n) => n.id === entityId);
                if (nap) destination = buildDestinationFromNap(nap);
            } else if (destType === "issue") {
                const issue = allIssues.find((i) => i.id === entityId);
                if (issue) destination = buildDestinationFromIssue(issue);
            } else if (destType === "subscriber") {
                const subscriber = allSubscribers.find((s) => s.id === entityId);
                if (subscriber) destination = buildDestinationFromSubscriber(subscriber);
            }

            if (!destination || !window.NapIQNavigation) return;

            window.NapIQNavigation.setDestination(destination);

            btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Destination set';
            btn.disabled = true;
            window.setTimeout(() => {
                btn.innerHTML = '<i class="bi bi-signpost-split me-1"></i>Set as destination';
                btn.disabled = false;
            }, 1500);
        });
    }

    /** Formats an ISO timestamp string for display; falls back gracefully. */
    function formatDateTime(isoString) {
        if (!isoString) return "\u2014";
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return escapeHtml(isoString);
        return escapeHtml(
            date.toLocaleString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
            })
        );
    }

    // ---------------- Search (Phase 23, 85%: NAP + Subscriber + Complaint) ----------------
    //
    // Through Phase 16 this box only ever searched allNaps. Phase 17 of
    // the integration plan ("Search -> destination -> route") asks that
    // the existing map search be *extended*, not replaced, to also
    // match subscribers and complaints (technical issues), and that a
    // search result can optionally become a navigation destination and
    // open navigation "explicit user action" — never automatically just
    // because a query was typed or a result was highlighted.
    //
    // Design used here to satisfy that "explicit action" requirement
    // without touching the plain-NAP behavior every earlier phase
    // already relies on: each result row now has two independent click
    // targets.
    //   - Clicking the row body (unchanged from before, extended to
    //     subscribers/complaints): forces the right filter/layer toggle
    //     on, re-renders, pans/zooms the map to the entity, and opens
    //     its existing popup. This is the exact same behavior
    //     selectNap()/focusIssue()/focusSubscriber() already provide
    //     for a marker click, a "Navigate" link, or a legacy
    //     ?issue_id= — nothing new is invented here.
    //   - Clicking the small destination button on the right of a row
    //     performs that same focus+open *and* arms the entity as the
    //     navigation destination via NapIQNavigation.setDestination(),
    //     using the identical buildDestinationFrom*() helpers the
    //     in-popup "Set as destination" button already uses (see
    //     handleDestinationButtonInPopup() above). This is the only
    //     path in this file that sets a destination from search, and
    //     it only runs on that explicit click.
    //   - No route is requested by either path. Route calculation is
    //     driven entirely by nav-routing.js once both an origin and a
    //     destination exist, unchanged from Phases 5-15 — search never
    //     touches that.

    const SEARCH_TYPE_META = {
        nap: { label: "NAP", icon: "bi-hdd-network-fill", badge: "text-bg-primary" },
        subscriber: { label: "Subscriber", icon: "bi-person-fill", badge: "napiq-badge-subscriber" },
        issue: { label: "Complaint", icon: "bi-exclamation-triangle-fill", badge: "text-bg-danger" },
    };

    const SEARCH_RESULTS_PER_TYPE = 4;

    /** Builds the combined, capped result list across all three entity
     * types for a given lowercased query. Entities without usable
     * coordinates are skipped since a search result must be focusable
     * on the map (matches the existing NAP-only behavior, which only
     * ever offered NAPs, which always have coordinates). */
    function findSearchMatches(query) {
        const naps = allNaps
            .filter(
                (nap) =>
                    nap.nap_code.toLowerCase().includes(query) ||
                    nap.name.toLowerCase().includes(query)
            )
            .slice(0, SEARCH_RESULTS_PER_TYPE)
            .map((nap) => ({
                type: "nap",
                entity: nap,
                primary: nap.nap_code,
                secondary: nap.name,
            }));

        const subscribers = allSubscribers
            .filter(
                (s) =>
                    s.latitude != null &&
                    s.longitude != null &&
                    ((s.full_name && s.full_name.toLowerCase().includes(query)) ||
                        (s.subscriber_code && s.subscriber_code.toLowerCase().includes(query)) ||
                        (s.address && s.address.toLowerCase().includes(query)))
            )
            .slice(0, SEARCH_RESULTS_PER_TYPE)
            .map((s) => ({
                type: "subscriber",
                entity: s,
                primary: s.full_name,
                secondary: s.subscriber_code,
            }));

        const issues = allIssues
            .filter(
                (issue) =>
                    (issue.issue_code && issue.issue_code.toLowerCase().includes(query)) ||
                    (issue.subscriber_name && issue.subscriber_name.toLowerCase().includes(query)) ||
                    (issue.address && issue.address.toLowerCase().includes(query))
            )
            .slice(0, SEARCH_RESULTS_PER_TYPE)
            .map((issue) => ({
                type: "issue",
                entity: issue,
                primary: issue.issue_code || "Complaint #" + issue.id,
                secondary: issue.subscriber_name || issue.address || "",
            }));

        return naps.concat(subscribers, issues);
    }

    function focusSearchResult(match) {
        if (match.type === "nap") selectNap(match.entity);
        else if (match.type === "subscriber") focusSubscriber(match.entity);
        else if (match.type === "issue") focusIssue(match.entity);
    }

    function buildDestinationForSearchResult(match) {
        if (match.type === "nap") return buildDestinationFromNap(match.entity);
        if (match.type === "subscriber") return buildDestinationFromSubscriber(match.entity);
        if (match.type === "issue") return buildDestinationFromIssue(match.entity);
        return null;
    }

    function handleSearchInput() {
        const query = document.getElementById("napSearchInput").value.trim().toLowerCase();
        const dropdown = document.getElementById("napSearchResults");

        if (!query) {
            dropdown.classList.add("d-none");
            dropdown.innerHTML = "";
            return;
        }

        const matches = findSearchMatches(query);

        if (matches.length === 0) {
            dropdown.innerHTML = '<div class="list-group-item text-muted small">No matches found.</div>';
            dropdown.classList.remove("d-none");
            return;
        }

        dropdown.innerHTML = matches
            .map((match, index) => {
                const meta = SEARCH_TYPE_META[match.type];
                return (
                    '<div class="list-group-item nap-search-result-item d-flex align-items-center gap-2" data-result-index="' +
                    index + '">' +
                    '<button type="button" class="btn btn-link p-0 text-start text-decoration-none flex-grow-1 min-w-0" ' +
                    'data-search-focus-index="' + index + '">' +
                    '<span class="badge ' + meta.badge + ' me-1"><i class="bi ' + meta.icon + '"></i> ' + meta.label + "</span>" +
                    '<span class="fw-semibold">' + escapeHtml(match.primary || "") + "</span>" +
                    (match.secondary
                        ? ' <span class="text-muted small">&middot; ' + escapeHtml(match.secondary) + "</span>"
                        : "") +
                    "</button>" +
                    '<button type="button" class="btn btn-sm btn-outline-success flex-shrink-0" ' +
                    'data-search-dest-index="' + index + '" title="Set as navigation destination">' +
                    '<i class="bi bi-signpost-split"></i>' +
                    "</button>" +
                    "</div>"
                );
            })
            .join("");

        dropdown.classList.remove("d-none");

        dropdown.querySelectorAll("[data-search-focus-index]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const match = matches[Number(btn.getAttribute("data-search-focus-index"))];
                if (match) focusSearchResult(match);
                dropdown.classList.add("d-none");
            });
        });

        dropdown.querySelectorAll("[data-search-dest-index]").forEach((btn) => {
            btn.addEventListener("click", (event) => {
                event.stopPropagation();
                const match = matches[Number(btn.getAttribute("data-search-dest-index"))];
                if (!match) return;

                // Explicit action: focus/open the entity exactly like a
                // plain row click would, then arm it as the navigation
                // destination. Nothing here requests a route — that
                // still requires the user to separately pick/confirm an
                // origin in the navigation card, same as every other
                // "Set as destination" entry point in this file.
                focusSearchResult(match);
                const destination = buildDestinationForSearchResult(match);
                if (destination && window.NapIQNavigation) {
                    window.NapIQNavigation.setDestination(destination);
                }
                dropdown.classList.add("d-none");
            });
        });
    }

    /**
     * Called when a search result is chosen. Makes sure the matching
     * NAP's status/port filters are enabled (so its marker is
     * guaranteed to be visible), re-renders, then zooms to it and
     * opens its detail panel.
     */
    function selectNap(nap) {
        const statusCheckbox = document.querySelector(
            '.status-filter[value="' + nap.status + '"]'
        );
        if (statusCheckbox && !statusCheckbox.checked) statusCheckbox.checked = true;
        document.getElementById("portsFilter").value = "all";

        // Set before renderNapMarkers() so its own
        // renderCoverageRadiusForFocusedNap() call already draws the
        // ring for this NAP instead of the previously-focused one.
        focusedNapForRadius = nap;
        renderNapMarkers();

        focusMapOn(
            [nap.latitude, nap.longitude],
            NAP_FOCUS_ZOOM,
            NAP_FOCUS_FLY_DURATION,
            NAP_FOCUS_PAN_DURATION
        );
        openNapDetailPanel(nap);
    }

    /**
     * Phase 33 (default GeoMap focus): reads the `focus_nap_id`
     * naps.geomap() computed server-side — the NAP with the most
     * critical-priority issues, ties broken by earliest-reported
     * critical issue (see `_default_focus_nap_id()` in
     * app/routes/naps.py) — off #napMap's data attribute and, if
     * present, forces its status filter on, re-renders, and opens its
     * detail panel, exactly like selectNap() does for a marker click —
     * so the very first thing an administrator sees on a fresh visit/
     * reload/re-login is whichever site has the most critical
     * problems, not the fixed city-wide DEFAULT_CENTER/DEFAULT_ZOOM.
     *
     * Unlike selectNap(), this deliberately does NOT call
     * focusMapOn()/flyTo the map to this NAP: init() above already
     * set the map's *initial* view straight to this same NAP's
     * location/zoom (from the data-focus-nap-lat/lng attributes,
     * known before this function even runs), so panning again here
     * would just be a second, redundant animation on top of a view
     * that's already correct — the exact "zooms out, then flies back
     * in" flash this whole approach exists to avoid.
     *
     * Deliberately runs *before* focusIssueFromQueryParam()/
     * focusNapRecommendationFromQueryParam()/
     * focusNavigationFromQueryParam() below, so a link that already
     * asks for a specific issue/subscriber/recommendation/nav
     * destination still wins — this is only the *default* landing
     * spot, not an override.
     */
    function focusDefaultCriticalNap() {
        const mapEl = document.getElementById("napMap");
        const raw = mapEl ? mapEl.getAttribute("data-focus-nap-id") : "";
        if (!raw) return;

        const napId = Number(raw);
        if (!Number.isInteger(napId)) return;

        const nap = allNaps.find((n) => n.id === napId);
        if (!nap) return; // unknown/foreign id — map just loads normally

        const statusCheckbox = document.querySelector(
            '.status-filter[value="' + nap.status + '"]'
        );
        if (statusCheckbox && !statusCheckbox.checked) statusCheckbox.checked = true;
        document.getElementById("portsFilter").value = "all";

        // See selectNap() above for why this is set before
        // renderNapMarkers() rather than after.
        focusedNapForRadius = nap;
        renderNapMarkers();
        openNapDetailPanel(nap);
    }

    /**
     * Phase 20 (phase_8.pdf technician item #6, "Issue location on
     * GeoMap"): reads the focus issue id naps.geomap() rendered onto
     * #napMap's data attribute (see map.html) and, if present, hands
     * off to focusIssue() below. Runs once, after the initial
     * renderAll() on page load, so allIssues is already populated.
     */
    function focusIssueFromQueryParam() {
        const mapEl = document.getElementById("napMap");
        const raw = mapEl ? mapEl.getAttribute("data-focus-issue-id") : "";
        if (!raw) return;

        const issueId = Number(raw);
        if (!Number.isInteger(issueId)) return;

        const issue = allIssues.find((i) => i.id === issueId);
        if (!issue) return; // unknown/foreign id — map just loads normally

        focusIssue(issue);
    }

    /**
     * Makes sure `issue` will actually render (forcing its status and
     * priority filter checkboxes on if needed, same idea as
     * selectNap() above for a NAP), re-renders, then pans/zooms to it
     * and opens its popup.
     */
    function focusIssue(issue) {
        const statusCheckbox = document.querySelector(
            '.issue-status-filter[value="' + issue.status + '"]'
        );
        if (statusCheckbox && !statusCheckbox.checked) statusCheckbox.checked = true;

        const priorityCheckbox = document.querySelector(
            '.issue-priority-filter[value="' + issue.priority + '"]'
        );
        if (priorityCheckbox && !priorityCheckbox.checked) priorityCheckbox.checked = true;

        const showIssuesToggle = document.getElementById("showIssuesToggle");
        if (showIssuesToggle && !showIssuesToggle.checked) showIssuesToggle.checked = true;

        renderIssueMarkers();

        const marker = issueMarkersById[issue.id];
        map.flyTo([issue.latitude, issue.longitude], 18);
        if (marker) {
            marker.openPopup();
        }
    }

    /**
     * Phase 13 (65%) equivalent of selectNap()/focusIssue() above,
     * for a subscriber. Forces the "Show Subscribers" layer toggle on
     * (subscriber markers are off by default — see the subscriber
     * marker section below) rather than a status/priority filter,
     * since subscribers have no such filters, then pans/zooms and
     * opens the popup exactly the same way.
     */
    function focusSubscriber(subscriber) {
        const showSubscribersToggle = document.getElementById("showSubscribersToggle");
        if (showSubscribersToggle && !showSubscribersToggle.checked) {
            showSubscribersToggle.checked = true;
        }

        renderSubscriberMarkers();

        const marker = subscriberMarkersById[subscriber.id];
        focusSubscriberOnMap(subscriber, marker);
    }

    /**
     * Phase 22 (phase_11.pdf requirement 8, "display the result on
     * the GeoMap"): reads the recommend-request id naps.geomap()
     * rendered onto #napMap's data attribute (see map.html) and, if
     * present, fetches the ranked NAP recommendation for that service
     * request from GET /api/service-requests/<id>/recommend-nap and
     * plots it. Same "runs once after the initial render, empty
     * attribute means no focus" shape as focusIssueFromQueryParam()
     * above, extended with its own fetch since — unlike an issue,
     * which is already in allIssues from loadIssues() — a single
     * service request's recommendation isn't part of any dataset this
     * page loads by default.
     */
    async function focusNapRecommendationFromQueryParam() {
        const mapEl = document.getElementById("napMap");
        const raw = mapEl ? mapEl.getAttribute("data-recommend-request-id") : "";
        if (!raw) return;

        const requestId = Number(raw);
        if (!Number.isInteger(requestId)) return;

        // This fetch runs automatically on page load, not from a button
        // click, so there's no button to attach a spinner/disabled state
        // to the way handleReportIssueSubmit() does. Use the page's
        // existing mapAlertArea/showAlert() pattern instead: a dismissible
        // "loading" alert inserted right before the fetch, removed in
        // `finally` once the fetch settles (success or error) rather than
        // waiting for showAlert()'s normal 6-second auto-dismiss.
        const loadingAlertId = "napRecommendLoadingAlert";
        const area = document.getElementById("mapAlertArea");
        if (area) {
            area.insertAdjacentHTML(
                "beforeend",
                '<div id="' + loadingAlertId + '" class="alert alert-info alert-dismissible fade show shadow-sm" role="alert">' +
                    '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>' +
                    "Loading NAP recommendation…" +
                    '<button type="button" class="btn-close" data-bs-dismiss="alert"></button>' +
                    "</div>"
            );
        }

        try {
            const response = await fetch("/api/service-requests/" + requestId + "/recommend-nap");
            if (!response.ok) throw new Error("Request failed: " + response.status);
            const data = await response.json();
            plotNapRecommendation(data);
        } catch (err) {
            console.error("Failed to load NAP recommendation:", err);
            showAlert("danger", "Could not load the NAP recommendation for this service request.");
        } finally {
            const loadingEl = document.getElementById(loadingAlertId);
            if (loadingEl) bootstrap.Alert.getOrCreateInstance(loadingEl).close();
        }
    }

    /**
     * Plots the customer location from a NAP recommendation feed into
     * its own layer (recommendationLayer, cleared and rebuilt each
     * call rather than accumulated), makes sure the recommended NAP's
     * marker will actually render (forcing the 'active' status filter
     * on and the ports filter to 'all', same idea as selectNap()/
     * focusIssue() above), fits the map to show both the customer pin
     * and the recommended NAP, and opens the recommended NAP's detail
     * panel — the customer pin's own popup is still available on
     * click but isn't force-opened, so nothing competes with the
     * detail panel for attention.
     */
    function plotNapRecommendation(data) {
        recommendationLayer.clearLayers();

        const customerMarker = L.marker([data.customer_latitude, data.customer_longitude], {
            icon: buildCustomerIcon(),
            title: "Customer location (Service Request #" + data.service_request_id + ")",
        });
        customerMarker.bindPopup(
            '<div class="nap-popup"><div class="nap-popup-code">Service Request #' +
                data.service_request_id + "</div>" +
                "<h6>Customer Location</h6>" +
                '<a class="btn btn-sm btn-outline-primary w-100" href="/service-requests/' +
                data.service_request_id + '/recommend-nap">View Recommendations</a></div>'
        );
        recommendationLayer.addLayer(customerMarker);

        const bounds = [[data.customer_latitude, data.customer_longitude]];

        if (data.recommended_nap_id) {
            const statusCheckbox = document.querySelector('.status-filter[value="active"]');
            if (statusCheckbox && !statusCheckbox.checked) statusCheckbox.checked = true;
            document.getElementById("portsFilter").value = "all";

            renderNapMarkers();

            const recommendedMarker = markersById[data.recommended_nap_id];
            if (recommendedMarker) {
                bounds.push(recommendedMarker.getLatLng());
            }
        }

        if (bounds.length > 1) {
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
        } else {
            map.flyTo(bounds[0], 17);
        }

        if (data.recommended_nap_id) {
            const recommendedNap = allNaps.find((n) => n.id === data.recommended_nap_id);
            if (recommendedNap) {
                openNapDetailPanel(recommendedNap);
            }
        }
    }

    /** Builds the marker icon for a NAP recommendation's customer
     * location pin — same teardrop shape as buildIcon() above, but a
     * distinct color (purple) so it's never mistaken for a NAP
     * marker at a glance. */
    function buildCustomerIcon() {
        const svg =
            '<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="M15 0C6.7 0 0 6.7 0 15c0 11.25 15 27 15 27s15-15.75 15-27C30 6.7 23.3 0 15 0z" ' +
            'fill="#6f42c1" stroke="#ffffff" stroke-width="1.5"/>' +
            '<circle cx="15" cy="15" r="6" fill="#ffffff"/>' +
            "</svg>";

        return L.divIcon({
            html: svg,
            className: "nap-marker-icon customer-marker-icon",
            iconSize: [30, 42],
            iconAnchor: [15, 40],
            popupAnchor: [0, -36],
        });
    }
    // ---------------- Add NAP from map click ----------------

    let addModeActive = false;
    let pendingMarker = null;
    let pendingLatLng = null;
    let quickAddModalInstance = null;

    function setupQuickAdd() {
        quickAddModalInstance = new bootstrap.Modal(document.getElementById("quickAddModal"));

        const addBtn = document.getElementById("addNapModeBtn");
        const bannerCancelBtn = document.getElementById("addModeCancelBtn");
        const modalCancelBtn = document.getElementById("quickAddCancelBtn");
        const quickAddForm = document.getElementById("quickAddForm");
        const quickAddModalEl = document.getElementById("quickAddModal");

        addBtn.addEventListener("click", () => {
            if (addModeActive) {
                exitAddMode();
            } else {
                enterAddMode();
            }
        });

        bannerCancelBtn.addEventListener("click", exitAddMode);
        modalCancelBtn.addEventListener("click", exitAddMode);

        // Covers the modal's own [x] close button too.
        quickAddModalEl.addEventListener("hidden.bs.modal", () => {
            if (addModeActive) exitAddMode();
        });

        map.on("click", (e) => {
            if (!addModeActive) return;
            placePendingMarker(e.latlng);
            openQuickAddModal(e.latlng);
        });

        quickAddForm.addEventListener("submit", handleQuickAddSubmit);
    }

    function enterAddMode() {
        // Only one "placement mode" is active at a time.
        if (issueModeActive) exitIssueMode();
        // Phase 8 (adapted): the manual origin picker is also a
        // map-click placement mode, so it yields the same way.
        if (window.NapIQNavOriginPicker) window.NapIQNavOriginPicker.stopPicking();
        // Installation Planning Phase 3 (40%): so is Plan Installation
        // mode. Guarded the same way — this module only exists for
        // administrators, so the guard also covers "script never loaded".
        if (window.NapIQInstallPlanner) window.NapIQInstallPlanner.exitPlanningMode();

        addModeActive = true;

        const btn = document.getElementById("addNapModeBtn");
        btn.classList.remove("btn-primary");
        btn.classList.add("btn-outline-danger");
        btn.innerHTML = '<i class="bi bi-x-lg me-1"></i>Cancel Add NAP';

        document.getElementById("addModeBanner").classList.remove("d-none");
        document.getElementById("napMap").classList.add("add-mode-cursor");
    }

    /** Cleans up add-mode UI/state. Safe to call more than once. */
    function exitAddMode() {
        addModeActive = false;

        const btn = document.getElementById("addNapModeBtn");
        btn.classList.remove("btn-outline-danger");
        btn.classList.add("btn-primary");
        btn.innerHTML = '<i class="bi bi-plus-lg me-1"></i>Add NAP';

        document.getElementById("addModeBanner").classList.add("d-none");
        document.getElementById("napMap").classList.remove("add-mode-cursor");

        if (pendingMarker) {
            map.removeLayer(pendingMarker);
            pendingMarker = null;
        }
        pendingLatLng = null;

        clearQuickAddErrors();
        document.getElementById("quickAddForm").reset();

        if (quickAddModalInstance) {
            quickAddModalInstance.hide();
        }
    }

    /** Places (or moves) the temporary pending marker at the clicked location. */
    function placePendingMarker(latlng) {
        pendingLatLng = latlng;

        if (pendingMarker) {
            pendingMarker.setLatLng(latlng);
        } else {
            pendingMarker = L.marker(latlng, {
                icon: buildIcon("pending"),
                draggable: true,
                zIndexOffset: 1000,
            }).addTo(map);

            pendingMarker.on("dragend", () => {
                pendingLatLng = pendingMarker.getLatLng();
                updateLatLngFields(pendingLatLng);
            });
        }

        updateLatLngFields(latlng);
    }

    function updateLatLngFields(latlng) {
        document.getElementById("quickAddLatitude").value = latlng.lat.toFixed(7);
        document.getElementById("quickAddLongitude").value = latlng.lng.toFixed(7);
    }

    function openQuickAddModal(latlng) {
        updateLatLngFields(latlng);
        clearQuickAddErrors();
        quickAddModalInstance.show();
    }

    function clearQuickAddErrors() {
        document.getElementById("quickAddGeneralError").classList.add("d-none");
        document.getElementById("quickAddGeneralError").textContent = "";
        document.querySelectorAll("#quickAddForm [data-error-for]").forEach((el) => {
            el.textContent = "";
        });
        document.querySelectorAll("#quickAddForm .is-invalid").forEach((el) => {
            el.classList.remove("is-invalid");
        });
    }

    /**
     * Submits the quick-add form via fetch(). This is the frontend
     * validation pass (required attributes, min="1" on ports, etc.);
     * the response is only ever trusted once Flask has re-validated
     * everything and MySQL has actually stored the row.
     */
    async function handleQuickAddSubmit(event) {
        event.preventDefault();
        clearQuickAddErrors();

        if (!pendingLatLng) {
            showAlert("danger", "Click a location on the map first.");
            return;
        }

        const form = document.getElementById("quickAddForm");
        const submitBtn = document.getElementById("quickAddSubmitBtn");
        const formData = new FormData(form);

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

        try {
            const response = await fetch("/naps/quick-add", {
                method: "POST",
                headers: { "X-CSRFToken": CSRF_TOKEN },
                body: formData,
            });
            const payload = await response.json();

            if (response.ok && payload.status === "success") {
                allNaps.push(payload.nap);
                populateNapSelectForIssue();
                renderAll();
                showAlert("success", payload.message);
                exitAddMode();
            } else if (response.status === 400 && payload.errors) {
                showQuickAddErrors(payload.errors);
            } else {
                document.getElementById("quickAddGeneralError").textContent =
                    "Something went wrong while saving. Please try again.";
                document.getElementById("quickAddGeneralError").classList.remove("d-none");
            }
        } catch (err) {
            console.error("Quick-add request failed:", err);
            document.getElementById("quickAddGeneralError").textContent =
                "Could not reach the server. Check your connection and try again.";
            document.getElementById("quickAddGeneralError").classList.remove("d-none");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save NAP';
        }
    }

    /** Maps Flask-WTF's {field_name: [messages]} error dict onto the form. */
    function showQuickAddErrors(errors) {
        Object.keys(errors).forEach((fieldName) => {
            const messages = errors[fieldName];
            const errorEl = document.querySelector(
                '#quickAddForm [data-error-for="' + fieldName + '"]'
            );
            const inputEl = document.querySelector('#quickAddForm [name="' + fieldName + '"]');

            if (errorEl) errorEl.textContent = messages.join(" ");
            if (inputEl) inputEl.classList.add("is-invalid");
        });
    }

    /** Shows a dismissible Bootstrap alert above the map. */
    function showAlert(type, message) {
        const area = document.getElementById("mapAlertArea");
        const alertId = "alert-" + Date.now();
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
            if (el) bootstrap.Alert.getOrCreateInstance(el).close();
        }, 3000);
    }

    // ---------------- Report an Issue from map click ----------------

    let issueModeActive = false;
    let pendingIssueMarker = null;
    let pendingIssueLatLng = null;
    let reportIssueModalInstance = null;

    /** Fills the Subscriber <select> from allSubscribers (loaded on page init).
     *  If there are no subscribers at all, the dropdown is disabled and its
     *  only option says so plainly, instead of silently showing just the
     *  generic placeholder with nothing to actually pick. */
    function populateSubscriberSelect() {
        const select = document.getElementById("reportIssueSubscriber");
        if (allSubscribers.length === 0) {
            select.innerHTML = '<option value="0" selected>-- No subscribers found --</option>';
            select.disabled = true;
            return;
        }
        select.disabled = false;
        const options = ['<option value="0" selected>-- Select Subscriber --</option>'];
        allSubscribers.forEach((sub) => {
            options.push(
                '<option value="' + sub.id + '">' +
                    escapeHtml(sub.subscriber_code + " — " + sub.full_name) +
                    "</option>"
            );
        });
        select.innerHTML = options.join("");
    }

    /** Fills the NAP <select> from allNaps (loaded on page init). */
    function populateNapSelectForIssue() {
        const select = document.getElementById("reportIssueNap");
        const previousValue = select.value || "0";
        const options = ['<option value="0">None</option>'];
        allNaps.forEach((nap) => {
            options.push(
                '<option value="' + nap.id + '">' +
                    escapeHtml(nap.nap_code + " — " + nap.name) +
                    "</option>"
            );
        });
        select.innerHTML = options.join("");
        select.value = previousValue;
    }

    function setupReportIssue() {
        reportIssueModalInstance = new bootstrap.Modal(document.getElementById("reportIssueModal"));

        const reportBtn = document.getElementById("reportIssueModeBtn");
        const bannerCancelBtn = document.getElementById("issueModeCancelBtn");
        const modalCancelBtn = document.getElementById("reportIssueCancelBtn");
        const reportForm = document.getElementById("reportIssueForm");
        const reportModalEl = document.getElementById("reportIssueModal");
        const subscriberSelect = document.getElementById("reportIssueSubscriber");

        // reportIssueModeBtn was removed from the GeoMap toolbar (the
        // "+ Tickets" quick-create modal now covers reporting a
        // trouble ticket), so this is optional: everything else in
        // this function (the subscriber-select auto-fill, the modal's
        // own submit handling) still works standalone, just with no
        // button left to enter "issue mode" (click-to-drop-a-pin) from.
        if (reportBtn) {
            reportBtn.addEventListener("click", () => {
                if (issueModeActive) {
                    exitIssueMode();
                } else {
                    enterIssueMode();
                }
            });
        }

        bannerCancelBtn.addEventListener("click", exitIssueMode);
        modalCancelBtn.addEventListener("click", exitIssueMode);

        reportModalEl.addEventListener("hidden.bs.modal", () => {
            if (issueModeActive) exitIssueMode();
        });

        map.on("click", (e) => {
            if (!issueModeActive) return;
            placePendingIssueMarker(e.latlng);
            openReportIssueModal(e.latlng);
        });

        // Auto-fill NAP + Address when a subscriber is chosen, AND
        // snap the pending pin onto that subscriber's exact registered
        // coordinates. "Point it in a subscriber's exact location, if
        // not it will not proceed or show pin error": the pin the
        // admin places on the map is what gets saved as the issue's
        // location, so it has to be the subscriber's own location, not
        // an approximate nearby spot -- snapping removes the guesswork
        // and validatePinAgainstSubscriber() below still catches it if
        // the pin is dragged off afterward.
        subscriberSelect.addEventListener("change", () => {
            const subscriberId = Number(subscriberSelect.value);
            const subscriber = allSubscribers.find((s) => s.id === subscriberId);
            if (!subscriber) {
                clearPinValidation();
                return;
            }

            if (subscriber.nap_id) {
                document.getElementById("reportIssueNap").value = String(subscriber.nap_id);
            }
            if (subscriber.address) {
                document.getElementById("reportIssueAddress").value = subscriber.address;
            }

            if (subscriber.latitude == null || subscriber.longitude == null) {
                showPinError(
                    "This subscriber has no registered map location on file, so an issue pin can't be " +
                    "placed for them. Update their subscriber record with a location first."
                );
                return;
            }

            placePendingIssueMarker(L.latLng(subscriber.latitude, subscriber.longitude));
            if (!reportIssueModalInstance || !document.getElementById("reportIssueModal").classList.contains("show")) {
                reportIssueModalInstance.show();
            }
            showPinOk(subscriber);
        });

        reportForm.addEventListener("submit", handleReportIssueSubmit);
    }

    /**
     * True if `latlng` is (within float/decimal rounding tolerance)
     * the same point as `subscriber`'s registered latitude/longitude.
     * The tolerance (~5 meters) exists only to absorb
     * JS-float-vs-MySQL-DECIMAL(10,7) rounding, not to allow a
     * meaningfully different location through.
     */
    function isAtSubscriberLocation(latlng, subscriber) {
        if (!latlng || !subscriber || subscriber.latitude == null || subscriber.longitude == null) return false;
        const EPSILON = 0.00005;
        return (
            Math.abs(latlng.lat - subscriber.latitude) < EPSILON &&
            Math.abs(latlng.lng - subscriber.longitude) < EPSILON
        );
    }

    /** Re-checks the current pending pin against whichever subscriber
     * is currently selected in the Report Issue form, and updates the
     * pin-status message / disables-or-enables the submit button
     * accordingly. Returns true only when it's safe to submit. */
    function validatePinAgainstSubscriber() {
        const subscriberId = Number(document.getElementById("reportIssueSubscriber").value);
        const subscriber = allSubscribers.find((s) => s.id === subscriberId);

        if (!subscriber) {
            clearPinValidation();
            return false; // subscriber_id is required regardless
        }
        if (subscriber.latitude == null || subscriber.longitude == null) {
            showPinError(
                "This subscriber has no registered map location on file, so an issue pin can't be " +
                "placed for them. Update their subscriber record with a location first."
            );
            return false;
        }
        if (!isAtSubscriberLocation(pendingIssueLatLng, subscriber)) {
            showPinError(
                "Pin error: the reported location must be the subscriber's exact registered address. " +
                "Re-select the subscriber to snap the pin back automatically."
            );
            return false;
        }
        showPinOk(subscriber);
        return true;
    }

    /** Shows a red pin-status message under the lat/lng fields and
     * disables the submit button until the pin is fixed. */
    function showPinError(message) {
        const el = document.getElementById("reportIssuePinStatus");
        if (!el) return;
        el.className = "small mt-1 text-danger";
        el.innerHTML = '<i class="bi bi-exclamation-octagon-fill me-1"></i>' + message;
        const submitBtn = document.getElementById("reportIssueSubmitBtn");
        if (submitBtn) submitBtn.disabled = true;
    }

    /** Shows a green pin-status confirmation and re-enables submit. */
    function showPinOk(subscriber) {
        const el = document.getElementById("reportIssuePinStatus");
        if (!el) return;
        el.className = "small mt-1 text-success";
        el.innerHTML =
            '<i class="bi bi-geo-alt-fill me-1"></i>Pin matches ' +
            escapeHtml(subscriber.subscriber_code) + "'s exact registered location.";
        const submitBtn = document.getElementById("reportIssueSubmitBtn");
        if (submitBtn) submitBtn.disabled = false;
    }

    /** Resets the pin-status area to its neutral "not yet chosen"
     * state and keeps submit disabled -- a subscriber must be
     * selected (and matched) before an issue can be reported at all. */
    function clearPinValidation() {
        const el = document.getElementById("reportIssuePinStatus");
        if (el) {
            if (allSubscribers.length === 0) {
                el.className = "small mt-1 text-danger";
                el.innerHTML =
                    '<i class="bi bi-exclamation-octagon-fill me-1"></i>No subscribers found. ' +
                    "Add a subscriber first before an issue can be reported.";
            } else {
                el.className = "small mt-1 text-muted";
                el.textContent = "Select the affected subscriber to snap the pin to their exact registered location.";
            }
        }
        const submitBtn = document.getElementById("reportIssueSubmitBtn");
        if (submitBtn) submitBtn.disabled = true;
    }

    function enterIssueMode() {
        // Only one "placement mode" is active at a time.
        if (addModeActive) exitAddMode();
        // Phase 8 (adapted): the manual origin picker is also a
        // map-click placement mode, so it yields the same way.
        if (window.NapIQNavOriginPicker) window.NapIQNavOriginPicker.stopPicking();
        // Installation Planning Phase 3 (40%): so is Plan Installation mode.
        if (window.NapIQInstallPlanner) window.NapIQInstallPlanner.exitPlanningMode();

        issueModeActive = true;

        const btn = document.getElementById("reportIssueModeBtn");
        if (btn) {
            btn.classList.remove("btn-warning");
            btn.classList.add("btn-outline-danger");
            btn.innerHTML = '<i class="bi bi-x-lg me-1"></i>Cancel Report';
        }

        document.getElementById("issueModeBanner").classList.remove("d-none");
        document.getElementById("napMap").classList.add("add-mode-cursor");
    }

    /** Cleans up issue-report-mode UI/state. Safe to call more than once. */
    function exitIssueMode() {
        issueModeActive = false;

        const btn = document.getElementById("reportIssueModeBtn");
        if (btn) {
            btn.classList.remove("btn-outline-danger");
            btn.classList.add("btn-warning");
            btn.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Report an Issue';
        }

        document.getElementById("issueModeBanner").classList.add("d-none");
        document.getElementById("napMap").classList.remove("add-mode-cursor");

        if (pendingIssueMarker) {
            map.removeLayer(pendingIssueMarker);
            pendingIssueMarker = null;
        }
        pendingIssueLatLng = null;

        clearReportIssueErrors();
        document.getElementById("reportIssueForm").reset();
        clearPinValidation();

        if (reportIssueModalInstance) {
            reportIssueModalInstance.hide();
        }
    }

    function placePendingIssueMarker(latlng) {
        pendingIssueLatLng = latlng;

        if (pendingIssueMarker) {
            pendingIssueMarker.setLatLng(latlng);
        } else {
            pendingIssueMarker = L.marker(latlng, {
                icon: buildPendingIssueIcon(),
                draggable: true,
                zIndexOffset: 1000,
            }).addTo(map);

            pendingIssueMarker.on("dragend", () => {
                pendingIssueLatLng = pendingIssueMarker.getLatLng();
                updateIssueLatLngFields(pendingIssueLatLng);
                // Dragging the pin away from the selected subscriber's
                // exact location is exactly the "not pointed at the
                // subscriber" case the pin-error rule exists for.
                validatePinAgainstSubscriber();
            });
        }

        updateIssueLatLngFields(latlng);
    }

    function updateIssueLatLngFields(latlng) {
        document.getElementById("reportIssueLatitude").value = latlng.lat.toFixed(7);
        document.getElementById("reportIssueLongitude").value = latlng.lng.toFixed(7);
    }

    function openReportIssueModal(latlng) {
        updateIssueLatLngFields(latlng);
        clearReportIssueErrors();
        // A fresh map click starts a new pin with no subscriber chosen
        // yet for it -- reset the Subscriber dropdown and pin-status
        // area so a stale "Pin matches ..." message from a previous
        // report doesn't linger against this new, unrelated pin.
        document.getElementById("reportIssueSubscriber").value = "0";
        clearPinValidation();
        reportIssueModalInstance.show();
    }

    function clearReportIssueErrors() {
        document.getElementById("reportIssueGeneralError").classList.add("d-none");
        document.getElementById("reportIssueGeneralError").textContent = "";
        document.querySelectorAll("#reportIssueForm [data-error-for]").forEach((el) => {
            el.textContent = "";
        });
        document.querySelectorAll("#reportIssueForm .is-invalid").forEach((el) => {
            el.classList.remove("is-invalid");
        });
    }

    /**
     * Submits the Report Issue form via fetch(). As with the NAP
     * quick-add flow, this is only the frontend's first pass — Flask
     * re-validates every field (including latitude/longitude) before
     * anything is written to MySQL.
     */
    async function handleReportIssueSubmit(event) {
        event.preventDefault();
        clearReportIssueErrors();

        if (!pendingIssueLatLng) {
            showAlert("danger", "Click the problem location on the map first.");
            return;
        }

        // Final client-side gate, in addition to the submit button
        // already being disabled while the pin doesn't match: "it
        // will not proceed" if the pin isn't the subscriber's exact
        // location. Flask re-checks the same thing server-side below
        // regardless -- this just avoids a round trip for the common
        // case and gives an immediate pin-error message.
        if (!validatePinAgainstSubscriber()) {
            return;
        }

        const form = document.getElementById("reportIssueForm");
        const submitBtn = document.getElementById("reportIssueSubmitBtn");
        const formData = new FormData(form);

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Submitting...';

        try {
            const response = await fetch("/issues/report", {
                method: "POST",
                headers: { "X-CSRFToken": CSRF_TOKEN },
                body: formData,
            });
            const payload = await response.json();

            if (response.ok && payload.status === "success") {
                // The backend merges a new report into whichever open
                // issue the subscriber already has (see issues.py's
                // report_issue()) rather than always creating a new
                // row, so `payload.issue` may be an update to an
                // issue we're already holding in `allIssues` -- if we
                // always pushed, that subscriber would end up with
                // two entries pointing at the exact same coordinates
                // and renderIssueMarkers() would draw two overlapping
                // "!" badges on top of each other. Replace the
                // existing entry by id when there is one; only push
                // when this is a genuinely new issue.
                const existingIndex = allIssues.findIndex((i) => i.id === payload.issue.id);
                if (existingIndex !== -1) {
                    allIssues[existingIndex] = payload.issue;
                } else {
                    allIssues.push(payload.issue);
                }
                renderAll();
                showAlert("success", payload.message);
                exitIssueMode();
            } else if (response.status === 400 && payload.errors) {
                showReportIssueErrors(payload.errors);
            } else {
                document.getElementById("reportIssueGeneralError").textContent =
                    "Something went wrong while submitting. Please try again.";
                document.getElementById("reportIssueGeneralError").classList.remove("d-none");
            }
        } catch (err) {
            console.error("Report-issue request failed:", err);
            document.getElementById("reportIssueGeneralError").textContent =
                "Could not reach the server. Check your connection and try again.";
            document.getElementById("reportIssueGeneralError").classList.remove("d-none");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Submit Report';
        }
    }

    /** Maps Flask-WTF's {field_name: [messages]} error dict onto the form. */
    function showReportIssueErrors(errors) {
        Object.keys(errors).forEach((fieldName) => {
            const messages = errors[fieldName];
            const errorEl = document.querySelector(
                '#reportIssueForm [data-error-for="' + fieldName + '"]'
            );
            const inputEl = document.querySelector('#reportIssueForm [name="' + fieldName + '"]');

            if (errorEl) errorEl.textContent = messages.join(" ");
            if (inputEl) inputEl.classList.add("is-invalid");
        });
    }

    // Phase 8 (adapted): lets nav-origin-picker.js cancel Add-NAP /
    // Report-Issue mode when the user starts picking a manual origin,
    // so exactly one map-click mode is ever active — the same rule
    // enterAddMode()/enterIssueMode() already enforce between
    // themselves. Safe to call anytime; both underlying functions are
    // no-ops if their mode isn't active.
    // Installation Planning Phase 3 (40%): nap-install-planner.js's own
    // enterPlanningMode() calls this same function (mirroring how
    // nav-origin-picker.js's startPicking() already does) before
    // activating, so Plan Installation mode also yields Add-NAP/
    // Report-Issue. The reverse direction (this function itself exiting
    // planning mode, so the origin picker's startPicking() also yields
    // it) is handled here too, guarded the same way as the two calls
    // above -- window.NapIQInstallPlanner only exists for administrators.
    //
    // Installation Planning Phase 6 (85%): also exposes
    // addSubscriberMarker(), so nap-install-planner.js can push a
    // just-created subscriber (the real row POST /subscribers/quick-
    // add just returned) into this closure's own `allSubscribers`
    // dataset and rebuild the existing subscriber marker layer -- the
    // exact same data path loadSubscribers()/renderSubscriberMarkers()
    // already use for every other subscriber marker on this map, so
    // the new pin is a real marker sourced from the same in-memory
    // dataset, not a one-off DOM element bolted on from outside.
    window.NapIQMapModes = {
        exitPlacementModes: function () {
            if (addModeActive) exitAddMode();
            if (issueModeActive) exitIssueMode();
            if (window.NapIQInstallPlanner) window.NapIQInstallPlanner.exitPlanningMode();
        },
        /** Adds (or, if already present, replaces) one subscriber in
         * the in-memory `allSubscribers` dataset and re-renders the
         * subscriber marker layer from it -- the same rebuild
         * renderSubscriberMarkers() already does after loadSubscribers()
         * or a "Show Subscribers" toggle. Forces that layer toggle on
         * first (same as focusSubscriber() above) so the new marker is
         * actually visible immediately rather than silently added to a
         * layer the admin currently has hidden. No network request is
         * made here -- `subscriber` is the real row the caller already
         * got back from its own create POST. */
        addSubscriberMarker: function (subscriber) {
            if (!subscriber || subscriber.id == null) return;

            const entry = {
                id: subscriber.id,
                subscriber_code: subscriber.subscriber_code,
                full_name: subscriber.full_name,
                address: subscriber.address,
                latitude: subscriber.latitude,
                longitude: subscriber.longitude,
                nap_id: subscriber.nap_id,
            };

            const existingIndex = allSubscribers.findIndex((s) => s.id === entry.id);
            if (existingIndex >= 0) {
                allSubscribers[existingIndex] = entry;
            } else {
                allSubscribers.push(entry);
            }

            const toggle = document.getElementById("showSubscribersToggle");
            if (toggle && !toggle.checked) toggle.checked = true;

            renderSubscriberMarkers();
        },
    };
})();