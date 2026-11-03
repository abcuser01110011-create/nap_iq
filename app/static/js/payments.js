/* payments.js -- Payments page: row click -> transactions popup, copy-reference buttons. */
(function () {
    var tbody = document.querySelector('[data-lf-body]');
    var modalEl = document.getElementById('paymentHistoryModal');
    var content = document.getElementById('paymentHistoryContent');
    if (!tbody || !modalEl || !content) return;
    var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    var seq = 0;

    function copy(text, btn) {
        function done() {
            var icon = btn && btn.querySelector('i');
            if (!icon) return;
            var old = icon.className;
            icon.className = 'bi bi-check2';
            setTimeout(function () { icon.className = old; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () {});
        } else {
            var ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) {}
            ta.remove();
        }
    }

    function openHistory(url) {
        var mine = ++seq;
        content.innerHTML = '<div class="modal-body text-center text-muted py-5"><div class="spinner-border spinner-border-sm me-2"></div>Loading transactions\u2026</div>';
        modal.show();
        fetch(url, { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
            .then(function (html) { if (mine === seq) content.innerHTML = html; })
            .catch(function () {
                if (mine !== seq) return;
                content.innerHTML = '<div class="modal-header"><h5 class="modal-title">Transactions</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
                    '<div class="modal-body text-center text-muted py-4">Could not load transactions. Please try again.</div>';
            });
    }

    tbody.addEventListener('click', function (e) {
        var row = e.target.closest('tr[data-history]');
        if (!row) return;
        if (e.target.closest('a')) return;            // "record payment" link
        openHistory(row.getAttribute('data-history'));
    });

    content.addEventListener('click', function (e) {
        var btn = e.target.closest('.pay-copy');
        if (btn) copy(btn.getAttribute('data-copy'), btn);
    });
})();
