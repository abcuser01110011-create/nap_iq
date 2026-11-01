/* reports-ui.js
 * Reports & Analytics page:
 *   - draws the Overview charts (sparklines, growth line, donuts) as plain
 *     inline SVG from the JSON in #repData -- no chart library needed
 *   - "Export Report" button: Overview -> CSV of the dashboard figures,
 *     any other tab -> CSV of the table currently on screen
 * Colours come from CSS classes (see reports.css) so dark mode just works.
 */
(function () {
    var NS = 'http://www.w3.org/2000/svg';
    var dataEl = document.getElementById('repData');
    var DATA = null;
    try { DATA = dataEl ? JSON.parse(dataEl.textContent) : null; } catch (e) { DATA = null; }

    function el(name, attrs, parent) {
        var n = document.createElementNS(NS, name);
        for (var k in (attrs || {})) n.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(n);
        return n;
    }
    function svgIn(host, w, h) {
        host.innerHTML = '';
        return el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img' }, host);
    }
    function fmt(n) { return Number(n).toLocaleString(); }

    var gradId = 0;
    function areaDefs(svg) {
        var id = 'repGrad' + (++gradId);
        var defs = el('defs', {}, svg);
        var g = el('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        el('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': 0.28 }, g);
        el('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': 0.02 }, g);
        return id;
    }
    function smoothPath(pts) {
        if (pts.length < 2) return '';
        var d = 'M' + pts[0][0] + ',' + pts[0][1];
        for (var i = 1; i < pts.length; i++) {
            var cx = (pts[i - 1][0] + pts[i][0]) / 2;
            d += ' C' + cx + ',' + pts[i - 1][1] + ' ' + cx + ',' + pts[i][1] + ' ' + pts[i][0] + ',' + pts[i][1];
        }
        return d;
    }

    /* ---- sparkline inside a KPI card ---- */
    function drawSpark(host) {
        var key = host.getAttribute('data-spark');
        var vals = DATA && DATA.sparks && DATA.sparks[key];
        var w = host.clientWidth, h = host.clientHeight;
        if (!vals || vals.length < 2 || w < 10 || h < 10) { host.innerHTML = ''; return; }
        var svg = svgIn(host, w, h);
        var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        var span = (max - min) || 1;
        var pts = vals.map(function (v, i) {
            return [i * (w / (vals.length - 1)), h - 4 - ((v - min) / span) * (h - 10)];
        });
        var gid = areaDefs(svg);
        var line = smoothPath(pts);
        el('path', { d: line + ' L' + w + ',' + h + ' L0,' + h + ' Z', fill: 'url(#' + gid + ')' }, svg);
        el('path', { d: line, class: 'rep-spark-line', fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
    }

    /* ---- subscriber growth line/area chart ---- */
    function niceTicks(lo, hi, count) {
        var span = hi - lo || 1;
        var raw = span / count;
        var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
        var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
            .filter(function (s) { return s >= raw; })[0] || raw;
        var start = Math.floor(lo / step) * step, ticks = [];
        for (var t = start; t <= hi + step * 0.999; t += step) ticks.push(Math.round(t * 100) / 100);
        return ticks;
    }
    function drawGrowth(host) {
        var pts = DATA && DATA.growth;
        var w = host.clientWidth, h = host.clientHeight;
        if (!pts || pts.length < 2 || w < 80 || h < 60) return;
        var svg = svgIn(host, w, h);
        var vals = pts.map(function (p) { return p.value; });
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        var pad = Math.max(1, (hi - lo) * 0.25);
        var ticks = niceTicks(Math.max(0, lo - pad), hi + pad, 4);
        var yMin = ticks[0], yMax = ticks[ticks.length - 1];
        var L = 44, R = 18, T = 14, B = 26;
        var X = function (i) { return L + i * ((w - L - R) / (pts.length - 1)); };
        var Y = function (v) { return T + (1 - (v - yMin) / ((yMax - yMin) || 1)) * (h - T - B); };

        ticks.forEach(function (t) {
            el('line', { x1: L, x2: w - R, y1: Y(t), y2: Y(t), class: 'rep-grid-line' }, svg);
            var tx = el('text', { x: L - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'rep-axis' }, svg);
            tx.textContent = t >= 1000 ? (t / 1000).toFixed(t % 1000 ? 1 : 0) + 'k' : fmt(t);
        });
        var every = Math.ceil(pts.length / Math.max(2, Math.floor((w - L - R) / 70)));
        var shown = [];
        for (var i = 0; i < pts.length; i += every) shown.push(i);
        if (shown[shown.length - 1] !== pts.length - 1) {
            if (pts.length - 1 - shown[shown.length - 1] < every * 0.6) shown.pop();
            shown.push(pts.length - 1);
        }
        shown.forEach(function (i) {
            var tx = el('text', { x: X(i), y: h - 6, 'text-anchor': i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle'), class: 'rep-axis' }, svg);
            tx.textContent = pts[i].label;
        });

        var xy = pts.map(function (p, i) { return [X(i), Y(p.value)]; });
        var gid = areaDefs(svg);
        svg.setAttribute('class', 'rep-c-primary');
        var line = smoothPath(xy);
        el('path', { d: line + ' L' + X(pts.length - 1) + ',' + (h - B) + ' L' + X(0) + ',' + (h - B) + ' Z', fill: 'url(#' + gid + ')' }, svg);
        el('path', { d: line, class: 'rep-main-line', fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, svg);
        xy.forEach(function (p, i) {
            el('circle', { cx: p[0], cy: p[1], r: i === xy.length - 1 ? 5 : 3.2, class: 'rep-dot' }, svg);
        });

        // Tooltip bubble on the latest point
        var last = xy[xy.length - 1], txt = fmt(pts[pts.length - 1].value) + ' Subscribers';
        var bw = txt.length * 6.4 + 18, bx = Math.min(w - R - bw, Math.max(L, last[0] - bw / 2)), by = Math.max(2, last[1] - 40);
        el('rect', { x: bx, y: by, width: bw, height: 26, rx: 8, class: 'rep-tip' }, svg);
        var tt = el('text', { x: bx + bw / 2, y: by + 17, 'text-anchor': 'middle', class: 'rep-tip-text' }, svg);
        tt.textContent = txt;
    }

    /* ---- donut ---- */
    function drawDonut(host, segs, centerMain, centerSub) {
        var w = host.clientWidth, h = host.clientHeight;
        var size = Math.min(w, h, 230);
        if (size < 60) return;
        var svg = svgIn(host, size, size);
        var stroke = Math.max(10, size * 0.14), r = (size - stroke) / 2, c = size / 2;
        var circ = 2 * Math.PI * r;
        el('circle', { cx: c, cy: c, r: r, fill: 'none', 'stroke-width': stroke, class: 'rep-donut-track' }, svg);
        var total = segs.reduce(function (a, s) { return a + s.value; }, 0);
        var offset = 0;
        if (total > 0) {
            segs.forEach(function (s) {
                if (s.value <= 0) return;
                var len = s.value / total * circ;
                el('circle', {
                    cx: c, cy: c, r: r, fill: 'none', 'stroke-width': stroke,
                    class: 'rep-seg-' + s.cls,
                    'stroke-dasharray': Math.max(0, len - (segs.length > 1 ? 2 : 0)) + ' ' + circ,
                    'stroke-dashoffset': -offset,
                    transform: 'rotate(-90 ' + c + ' ' + c + ')'
                }, svg);
                offset += len;
            });
        }
        var t1 = el('text', { x: c, y: c + (centerSub ? 2 : 8), 'text-anchor': 'middle', class: 'rep-donut-main', 'font-size': size * 0.2 }, svg);
        t1.textContent = centerMain;
        if (centerSub) {
            var t2 = el('text', { x: c, y: c + size * 0.15, 'text-anchor': 'middle', class: 'rep-donut-sub', 'font-size': Math.max(10, size * 0.075) }, svg);
            t2.textContent = centerSub;
        }
    }

    function drawAll() {
        if (!DATA) return;
        document.querySelectorAll('[data-spark]').forEach(drawSpark);
        var g = document.getElementById('repGrowthChart'); if (g) drawGrowth(g);
        var di = document.getElementById('repIssueDonut');
        if (di) drawDonut(di, DATA.issues.map(function (s) { return { value: s.count, cls: s.key }; }), fmt(DATA.issues_total), 'Total Issues');
        var dn = document.getElementById('repNapDonut');
        if (dn) drawDonut(dn, [{ value: DATA.nap_capacity_pct, cls: 'primary' }, { value: 100 - DATA.nap_capacity_pct, cls: 'rest' }], DATA.nap_capacity_pct + '%', 'Total Capacity');
    }
    drawAll();
    window.addEventListener('resize', drawAll);
    window.addEventListener('load', drawAll);
    if (window.ResizeObserver) {
        var ro = new ResizeObserver(drawAll);
        document.querySelectorAll('.rep-chart, .rep-spark, .rep-donut').forEach(function (n) { ro.observe(n); });
    }
    // Redraw when the theme toggles (colours are CSS-driven, but gradients cache)
    new MutationObserver(drawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });

    /* ---- Export (CSV) ---- */
    function csvCell(v) {
        v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    function download(name, rows) {
        var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    var btn = document.getElementById('repExportBtn');
    if (btn) btn.addEventListener('click', function () {
        var stamp = new Date().toISOString().slice(0, 10);
        var slug = btn.getAttribute('data-report') || 'report';
        var rows = [];
        if (DATA && DATA.export) {
            rows.push(['PG Networks - Reports & Analytics', DATA.export.range], []);
            rows.push(['Metric', 'Value']);
            DATA.export.kpis.forEach(function (k) { rows.push(k); });
            rows.push([], ['Issues (created in range)', 'Count', '%']);
            DATA.issues.forEach(function (s) { rows.push([s.label, s.count, s.pct]); });
            rows.push([], ['NAP utilization', 'NAPs', '%']);
            DATA.nap_classes.forEach(function (s) { rows.push([s.label, s.count, s.pct]); });
            rows.push([], ['Subscriber growth', 'Subscribers']);
            DATA.growth.forEach(function (p) { rows.push([p.label, p.value]); });
        } else {
            var table = document.querySelector('.disp-table');
            if (!table) { alert('There is no table to export for the current filters.'); return; }
            table.querySelectorAll('tr').forEach(function (tr) {
                if (tr.classList.contains('d-none')) return;
                rows.push(Array.prototype.map.call(tr.children, function (c) { return c.innerText; }));
            });
        }
        download('pg-networks-' + slug + '-' + stamp + '.csv', rows);
    });
})();
