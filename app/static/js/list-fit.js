/* list-fit.js
 * Shared behaviour for the Subscribers-style list pages (Tickets, NAP
 * Management, Payments):
 *   - instant client-side search over the rows already loaded
 *   - 10-per-page pill pager (fixed 7-slot window)
 *   - row height sized so 10 rows exactly fill the table card
 *
 * Markup contract (all optional except the table body + rows):
 *   <input data-lf-search>                 search box
 *   <span data-lf-count data-lf-noun="ticket">   record counter
 *   <tbody data-lf-body> <tr class="lf-row" data-search="...">
 *   <tr data-lf-nomatch class="d-none"> ... <span data-lf-nomatch-q></span>
 *   <div data-lf-pager hidden><ul data-lf-pager-list></ul></div>
 *   <table data-lf-table>                  gets --subs-row-h
 */
(function () {
    var body = document.querySelector('[data-lf-body]');
    if (!body) return;

    var PAGE_SIZE = 10;
    var input = document.querySelector('[data-lf-search]');
    var rows = Array.prototype.slice.call(body.querySelectorAll('tr.lf-row'));
    var noMatchRow = body.querySelector('[data-lf-nomatch]');
    var noMatchQuery = body.querySelector('[data-lf-nomatch-q]');
    var counter = document.querySelector('[data-lf-count]');
    var pager = document.querySelector('[data-lf-pager]');
    var pagerList = document.querySelector('[data-lf-pager-list]');
    var table = document.querySelector('[data-lf-table]');
    var noun = (counter && counter.getAttribute('data-lf-noun')) || 'record';
    var originalCount = counter ? counter.textContent : '';

    var card = document.querySelector('.disp-table-card');
    var fitRows = null;
    var page = 1;
    var matches = rows.slice();

    function pageItem(label, target, opts) {
        opts = opts || {};
        var li = document.createElement('li');
        li.className = 'subs-pager-item' + (opts.active ? ' is-active' : '') + (opts.disabled ? ' is-disabled' : '') + (opts.gap ? ' is-gap' : '') + (opts.nav ? ' is-nav' : '');
        var a = document.createElement('a');
        a.className = 'subs-pager-link';
        a.href = '#';
        a.innerHTML = label;
        if (opts.aria) a.setAttribute('aria-label', opts.aria);
        if (opts.active) a.setAttribute('aria-current', 'page');
        if (opts.disabled) { a.setAttribute('aria-disabled', 'true'); a.tabIndex = -1; }
        a.addEventListener('click', function (e) {
            e.preventDefault();
            if (opts.disabled || opts.active) return;
            page = target;
            render();
        });
        li.appendChild(a);
        return li;
    }

    function render() {
        var total = matches.length;
        var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (page > pages) page = pages;
        var start = (page - 1) * PAGE_SIZE;
        var end = Math.min(start + PAGE_SIZE, total);

        // Fewer than a full page: let the card shrink to its rows instead of
        // leaving a big empty box.
        if (card) card.classList.toggle('lf-short', total < PAGE_SIZE);
        if (fitRows) fitRows();

        rows.forEach(function (row) { row.classList.add('d-none'); });
        matches.slice(start, end).forEach(function (row) { row.classList.remove('d-none'); });

        if (counter) {
            var term = input ? input.value.trim() : '';
            counter.textContent = term
                ? total + ' ' + noun + (total === 1 ? '' : 's') + ' shown'
                : originalCount;
        }

        if (!pager || !pagerList) return;
        pager.hidden = total <= PAGE_SIZE;
        if (total <= PAGE_SIZE) return;

        pagerList.innerHTML = '';
        pagerList.appendChild(pageItem('prev', page - 1, { disabled: page === 1, nav: true, aria: 'Previous page' }));

        var slots = [];
        if (pages <= 7) {
            for (var i = 1; i <= pages; i++) slots.push(i);
        } else if (page <= 4) {
            slots = [1, 2, 3, 4, 5, 'gap', pages];
        } else if (page >= pages - 3) {
            slots = [1, 'gap', pages - 4, pages - 3, pages - 2, pages - 1, pages];
        } else {
            slots = [1, 'gap', page - 1, page, page + 1, 'gap', pages];
        }
        slots.forEach(function (n, idx) {
            if (n === 'gap') {
                var prevN = slots[idx - 1], nextN = slots[idx + 1];
                pagerList.appendChild(pageItem('&hellip;', Math.round((prevN + nextN) / 2), { gap: true }));
            } else {
                pagerList.appendChild(pageItem(String(n), n, { active: n === page }));
            }
        });
        pagerList.appendChild(pageItem('next', page + 1, { disabled: page === pages, nav: true, aria: 'Next page' }));
    }

    function applyFilter() {
        var term = input ? input.value.trim().toLowerCase() : '';
        matches = rows.filter(function (row) {
            return !term || (row.dataset.search || row.textContent.toLowerCase()).indexOf(term) !== -1;
        });
        page = 1;
        if (noMatchRow) {
            var showEmpty = term && matches.length === 0;
            noMatchRow.classList.toggle('d-none', !showEmpty);
            if (showEmpty && noMatchQuery) noMatchQuery.textContent = input.value.trim();
        }
        render();
    }

    if (input) input.addEventListener('input', applyFilter);
    applyFilter();

    // ---- Fit-to-screen row height ----
    var wrap = table && table.closest('.table-responsive');
    if (table && wrap) {
        var fit = function () {
            if (card && card.classList.contains('lf-short')) {
                table.style.setProperty('--subs-row-h', '48px');
                return;
            }
            var thead = table.querySelector('thead');
            var avail = wrap.clientHeight - (thead ? thead.offsetHeight : 0) - 1;
            table.style.setProperty('--subs-row-h', Math.max(40, avail / PAGE_SIZE) + 'px');
        };
        fitRows = fit;
        fit();
        window.addEventListener('resize', fit);
        window.addEventListener('load', fit);
        if (window.ResizeObserver) new ResizeObserver(fit).observe(wrap);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    }
})();
