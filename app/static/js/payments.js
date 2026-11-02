/* payments.js -- Payments page: row -> details popup, copy-reference buttons. */
(function () {
    var tbody = document.getElementById('paymentsTableBody');
    var modalEl = document.getElementById('paymentDetailModal');
    if (!tbody || !modalEl) return;
    var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    var $ = function (id) { return document.getElementById(id); };

    function copy(text, btn) {
        function done() {
            if (!btn) return;
            var icon = btn.querySelector('i');
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

    function initials(name) {
        return name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    }

    function open(row) {
        var d = row.dataset;
        $('pdAvatar').textContent = initials(d.name);
        $('pdAmount').textContent = '₱' + d.amount;
        var st = $('pdStatus');
        st.className = 'disp-badge pay-status disp-badge-' + d.status;
        st.innerHTML = '<span class="pay-dot"></span>' + d.status.charAt(0).toUpperCase() + d.status.slice(1);
        $('pdName').textContent = d.name;
        $('pdCode').textContent = d.code;
        $('pdPlan').textContent = [d.plan, d.nap].filter(Boolean).join('  ·  ') || '—';
        $('pdMethodIcon').className = 'bi ' + d.methodIcon;
        $('pdMethod').textContent = d.method;
        $('pdRef').textContent = d.ref || '—';
        $('pdCopy').hidden = !d.ref;
        $('pdCopy').setAttribute('data-copy', d.ref || '');
        $('pdDate').textContent = d.date;
        $('pdCollector').textContent = d.collector;
        $('pdCreated').textContent = d.created;
        $('pdUpdated').textContent = d.updated;
        $('pdRemarks').textContent = d.remarks;
        $('pdRemarks').hidden = $('pdRemarksLabel').hidden = !d.remarks;
        $('pdEdit').href = d.edit;
        var form = $('pdVoidForm');
        form.hidden = !d.void;
        if (d.void) form.action = d.void;
        modal.show();
    }

    tbody.addEventListener('click', function (e) {
        var copyBtn = e.target.closest('.pay-copy');
        if (copyBtn) { e.stopPropagation(); copy(copyBtn.getAttribute('data-copy'), copyBtn); return; }
        if (e.target.closest('a, button, form')) return;
        var row = e.target.closest('tr.lf-row');
        if (row) open(row);
    });
    $('pdCopy').addEventListener('click', function () { copy(this.getAttribute('data-copy'), this); });
})();
