/**
 * Coverage Area barangay picker -- Add/Edit User form
 * (app/templates/users/form.html), Payment Collector accounts only.
 *
 * `users.coverage_area` (app/models.py) is a single free-text column,
 * but a collector often covers more than one barangay. This adds the
 * same barangay search the ticket form uses for its Location field
 * (see the BARANGAY_API_URL comment in static/js/tickets.js -- same
 * public PSGC-style API, same city/municipality code) so an admin can
 * add several barangays as removable chips. A barangay is added
 * automatically -- no separate "+ Add" button -- by picking a result
 * from the dropdown or by typing a name and pressing Enter.
 *
 * The visible search input/button/chips are just UI -- the field
 * that's actually submitted is the hidden #coverageAreaValue input
 * (WTForms' form.coverage_area, rendered type="hidden" in the
 * template). It's kept in sync as a comma-separated string
 * ("San Jose, San Roque, Bubukal") every time a chip is added or
 * removed, so app/routes/users.py needs no changes: it already just
 * strips and stores whatever string arrives.
 */
(function () {
    "use strict";

    const input = document.getElementById("coverageAreaInput");
    const resultsBox = document.getElementById("coverageAreaResults");
    const chipsBox = document.getElementById("coverageAreaChips");
    const hiddenField = document.getElementById("coverageAreaValue");

    // The field only exists on the Add/Edit User form; bail out
    // quietly anywhere else this script might get bundled/loaded.
    if (!input || !resultsBox || !chipsBox || !hiddenField) return;

    // Santa Cruz, Laguna's PSGC city/municipality code, same host and
    // endpoint tickets.js's barangay picker uses -- see that file for
    // the full history of why this particular URL was chosen.
    const BARANGAY_API_URL = "https://psgc.cloud/api/cities-municipalities/0403426000/barangays";

    let barangaysLoaded = false;
    let barangaysLoading = false;
    let allBarangays = [];
    let coverageBarangays = []; // string[], the chips currently added

    function escapeHtml(str) {
        return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
    }

    // Fetched lazily, once, and cached for client-side filtering. Only
    // flips barangaysLoaded on success, so a failed fetch (host down,
    // offline, etc.) gets retried next time the field is used instead
    // of staying empty for the rest of the session.
    function loadBarangays() {
        if (barangaysLoaded || barangaysLoading) return Promise.resolve();
        barangaysLoading = true;
        return fetch(BARANGAY_API_URL)
            .then((r) => {
                if (!r.ok) throw new Error("barangay API responded " + r.status);
                return r.json();
            })
            .then((payload) => {
                // Accept either a bare array or `{ data: [...] }` --
                // different PSGC-style hosts wrap the list differently.
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

    function syncHiddenField() {
        hiddenField.value = coverageBarangays.join(", ");
    }

    function renderChips() {
        chipsBox.innerHTML = coverageBarangays
            .map(
                (name, i) =>
                    '<span class="badge text-bg-light border d-inline-flex align-items-center gap-1">' +
                        escapeHtml(name) +
                        '<button type="button" class="btn-close btn-close-sm" style="font-size:.6rem;" ' +
                            'data-remove-barangay="' + i + '" aria-label="Remove ' + escapeHtml(name) + '"></button>' +
                        "</span>"
            )
            .join("");
        syncHiddenField();
    }

    function renderResults(matches) {
        if (!matches.length) {
            resultsBox.classList.add("d-none");
            resultsBox.innerHTML = "";
            return;
        }
        resultsBox.innerHTML = matches
            .slice(0, 8)
            .map((name) => '<button type="button" class="list-group-item list-group-item-action">' + escapeHtml(name) + "</button>")
            .join("");
        resultsBox.classList.remove("d-none");
    }

    function onInput() {
        const term = input.value.trim().toLowerCase();
        if (!term) {
            renderResults([]);
            return;
        }
        loadBarangays().then(() => {
            const matches = allBarangays.filter((name) => name.toLowerCase().includes(term));
            renderResults(matches);
        });
    }

    // Adds a barangay chip, whether it came from picking a dropdown
    // result or from typing a name and clicking "+ Add" / pressing
    // Enter directly (the barangay list is a courtesy autocomplete,
    // not an enforced whitelist -- same spirit as the ticket form's
    // free-text Barangay field).
    function addBarangay(name) {
        const clean = (name || "").trim();
        if (!clean) return;
        if (coverageBarangays.some((b) => b.toLowerCase() === clean.toLowerCase())) {
            input.value = "";
            renderResults([]);
            return;
        }
        coverageBarangays.push(clean);
        renderChips();
        input.value = "";
        renderResults([]);
        input.focus();
    }

    function removeBarangayAt(index) {
        coverageBarangays.splice(index, 1);
        renderChips();
    }

    // Edit mode: the hidden field is pre-rendered with the account's
    // existing `coverage_area` value (see users/form.html), a
    // comma-separated string -- split it back into chips on load.
    (function prefill() {
        const existing = (hiddenField.value || "").trim();
        if (!existing) return;
        coverageBarangays = existing
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        renderChips();
    })();

    input.addEventListener("input", onInput);
    input.addEventListener("keydown", (event) => {
        // Enter adds the typed/highlighted barangay instead of
        // submitting the whole Add/Edit User form.
        if (event.key === "Enter") {
            event.preventDefault();
            addBarangay(input.value);
        }
    });
    resultsBox.addEventListener("click", (event) => {
        const btn = event.target.closest("button");
        if (!btn) return;
        addBarangay(btn.textContent);
    });

    chipsBox.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-remove-barangay]");
        if (!btn) return;
        removeBarangayAt(parseInt(btn.getAttribute("data-remove-barangay"), 10));
    });

    // Click-away closes the dropdown, same pattern as tickets.js.
    document.addEventListener("click", (event) => {
        if (!event.target.closest("#coverageAreaInput") && !event.target.closest("#coverageAreaResults")) {
            renderResults([]);
        }
    });
})();
