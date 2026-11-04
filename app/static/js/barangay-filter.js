/* barangay-filter.js
 * Barangay dropdown (with search) for the Subscribers and Payments tabs.
 *
 *   window.NapiqBarangay.value()        -> selected barangay ('' = All)
 *   window.NapiqBarangay.matches(row)   -> true if row passes the filter
 *   document event "barangay:change"    -> fired when the selection changes
 *
 * The selection is also written to the URL (?barangay=...) with
 * history.replaceState, so refreshes keep it. The status / period / month
 * links in the templates pass `barangay` along too.
 */
(function () {
    var root = document.getElementById('barangayFilter');
    if (!root) { window.NapiqBarangay = { value: function () { return ''; }, matches: function () { return true; } }; return; }

    var label = root.querySelector('.brgy-label');
    var search = document.getElementById('barangayFilterSearch');
    var items = Array.prototype.slice.call(root.querySelectorAll('.brgy-item'));
    var empty = root.querySelector('.brgy-empty');
    var selected = (root.getAttribute('data-selected') || '').trim();

    function norm(s) { return (s || '').trim().toLowerCase(); }

    function paint() {
        label.textContent = selected || 'All';
        items.forEach(function (it) {
            it.classList.toggle('active', norm(it.getAttribute('data-value')) === norm(selected));
        });
        root.classList.toggle('is-filtered', !!selected);
    }

    function syncUrl() {
        try {
            var url = new URL(window.location.href);
            if (selected) url.searchParams.set('barangay', selected);
            else url.searchParams.delete('barangay');
            window.history.replaceState(null, '', url);
        } catch (e) { /* ignore */ }
    }

    function filterList() {
        var term = norm(search.value);
        var shown = 0;
        items.forEach(function (it) {
            var v = it.getAttribute('data-value');
            var hit = !v ? !term : norm(v).indexOf(term) !== -1;   // keep "All" when not searching
            it.classList.toggle('d-none', !hit);
            if (hit && v) shown++;
        });
        empty.classList.toggle('d-none', shown > 0 || !term);
    }

    items.forEach(function (it) {
        it.addEventListener('click', function () {
            selected = it.getAttribute('data-value') || '';
            paint();
            syncUrl();
            bootstrap.Dropdown.getOrCreateInstance(root.querySelector('[data-bs-toggle="dropdown"]')).hide();
            document.dispatchEvent(new CustomEvent('barangay:change', { detail: { value: selected } }));
        });
    });

    search.addEventListener('input', filterList);
    root.addEventListener('shown.bs.dropdown', function () { search.value = ''; filterList(); search.focus(); });

    window.NapiqBarangay = {
        value: function () { return selected; },
        matches: function (row) {
            return !selected || norm(row.getAttribute('data-barangay')) === norm(selected);
        }
    };
    paint();
})();
