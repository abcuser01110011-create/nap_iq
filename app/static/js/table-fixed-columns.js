/*
 * Keeps list-table columns from jumping between pages.
 *
 * A normal auto-layout table sizes each column to whatever rows are visible,
 * so flipping to a page with shorter/longer text makes the columns shift.
 * This script measures every column ONCE with all rows shown (including the
 * rows paginated out of view), then locks those widths (as percentages, so
 * the table stays responsive) with table-layout: fixed.
 *
 * Applies to every main list table (.disp-table / .subs-table) site-wide.
 * Opt out of one table with data-no-fixed-cols; a table that already has its
 * own <colgroup> is left alone.
 */
(function () {
    var SELECTOR = 'table.disp-table, table.subs-table';

    function lock(table) {
        if (table.dataset.colsLocked || table.hasAttribute('data-no-fixed-cols')) return;
        if (table.querySelector('colgroup')) { table.dataset.colsLocked = '1'; return; }
        var headRow = table.tHead && table.tHead.rows[0];
        if (!headRow || !table.offsetWidth) return; // hidden (tab/modal) -> try again when shown
        var ths = Array.prototype.slice.call(headRow.cells);
        if (!ths.length) return;

        // Show rows hidden by pagination/search so every row counts.
        var hidden = [];
        Array.prototype.forEach.call(table.tBodies, function (tb) {
            Array.prototype.forEach.call(tb.rows, function (r) {
                if (r.classList.contains('d-none') && !r.hasAttribute('data-lf-nomatch')) {
                    r.classList.remove('d-none');
                    hidden.push(r);
                }
            });
        });

        var prevLayout = table.style.tableLayout;
        table.style.tableLayout = 'auto';
        var widths = ths.map(function (th) { return th.getBoundingClientRect().width; });
        var total = widths.reduce(function (a, b) { return a + b; }, 0);

        hidden.forEach(function (r) { r.classList.add('d-none'); });
        table.style.tableLayout = prevLayout;
        if (!total) return;

        var cg = document.createElement('colgroup');
        widths.forEach(function (w) {
            var col = document.createElement('col');
            col.style.width = (w / total * 100).toFixed(2) + '%';
            cg.appendChild(col);
        });
        table.insertBefore(cg, table.firstChild);
        table.style.tableLayout = 'fixed';
        table.style.width = '100%';
        table.classList.add('cols-locked');
        table.dataset.colsLocked = '1';
    }

    // Long text wraps inside its fixed column instead of widening it.
    var style = document.createElement('style');
    style.textContent = 'table.cols-locked td, table.cols-locked th { overflow-wrap: anywhere; }';
    document.head.appendChild(style);

    function run() {
        Array.prototype.forEach.call(document.querySelectorAll(SELECTOR), lock);
    }

    function start() {
        var go = function () { run(); };
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(go); else go();
    }

    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);

    // Tables inside tabs / modals are measured when they become visible.
    document.addEventListener('shown.bs.tab', run);
    document.addEventListener('shown.bs.modal', run);
})();
