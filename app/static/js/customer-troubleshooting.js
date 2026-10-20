// Troubleshooting guide: auto-sliding carousel (every 3s) + steps popup per issue type.
(function () {
    var AUTOPLAY_MS = 3000;
    var root = document.getElementById("tsGuide");
    if (!root) return;
    var track = root.querySelector(".ts-track");
    var cards = Array.prototype.slice.call(track.querySelectorAll(".ts-card"));
    var dotsWrap = root.querySelector(".ts-dots");
    var prev = root.querySelector("[data-ts-prev]");
    var next = root.querySelector("[data-ts-next]");
    var modalEl = document.getElementById("tsModal");
    var dots = [];
    var count = cards.length;
    // Infinite loop: a clone of the first card sits after the last one. When the slide reaches the
    // clone we silently jump back to the real first card, so it always keeps swiping forward.
    var clone = cards[0].cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    clone.tabIndex = -1;
    track.appendChild(clone);
    var allCards = cards.concat([clone]);
    var timer = null, hovering = false, touching = false, modalOpen = false, resumeAt = 0;

    cards.forEach(function (card, i) {
        var d = document.createElement("span");
        d.className = "ts-dot";
        dotsWrap.appendChild(d);
        dots.push(d);
    });

    function offsetOf(i) { return allCards[i].offsetLeft - cards[0].offsetLeft; }
    function maxScroll() { return track.scrollWidth - track.clientWidth; }
    function goTo(i) {
        i = Math.max(0, Math.min(count, i));
        track.scrollTo({ left: Math.min(offsetOf(i), maxScroll()), behavior: "smooth" });
    }
    function jumpTo(x) {
        track.classList.add("is-jumping");
        track.scrollLeft = x;
        window.requestAnimationFrame(function () { track.classList.remove("is-jumping"); });
    }
    function rawIndex() {
        var x = track.scrollLeft, best = 0, bestDist = Infinity;
        allCards.forEach(function (c, i) {
            var dist = Math.abs(offsetOf(i) - x);
            if (dist < bestDist) { best = i; bestDist = dist; }
        });
        return best;
    }
    function currentIndex() { return rawIndex() % count; }
    function update() {
        var i = currentIndex();
        dots.forEach(function (d, n) { d.classList.toggle("is-active", n === i); });
    }
    // Once the clone is fully in view, jump back to the real first card (looks identical).
    var wrapTimer = null;
    function wrapIfNeeded() {
        if (Math.abs(track.scrollLeft - Math.min(offsetOf(count), maxScroll())) <= 2) jumpTo(0);
    }
    function goPrev() {
        var i = rawIndex();
        if (i <= 0 || track.scrollLeft <= 2) {
            jumpTo(Math.min(offsetOf(count), maxScroll()));
            window.requestAnimationFrame(function () { goTo(count - 1); });
        } else { goTo(i - 1); }
    }
    function goNext() { goTo(rawIndex() + 1); }

    // ---- auto slide every 3s; loops back to the first card ----
    function tick() {
        if (hovering || touching || modalOpen || document.hidden || Date.now() < resumeAt) return;
        if (root.matches(":hover") || root.contains(document.activeElement)) return;
        if (maxScroll() <= 4) return; // everything already visible
        goNext();
    }
    function startAuto() { if (!timer) timer = window.setInterval(tick, AUTOPLAY_MS); }
    function pauseBriefly() { resumeAt = Date.now() + AUTOPLAY_MS; }

    prev.addEventListener("click", function () { pauseBriefly(); goPrev(); });
    next.addEventListener("click", function () { pauseBriefly(); goNext(); });
    track.addEventListener("scroll", function () {
        window.requestAnimationFrame(update);
        window.clearTimeout(wrapTimer);
        wrapTimer = window.setTimeout(wrapIfNeeded, 90);
    }, { passive: true });
    root.addEventListener("mouseenter", function () { hovering = true; });
    root.addEventListener("mouseover", function () { hovering = true; });
    root.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse" || e.pointerType === "pen") hovering = true; });
    root.addEventListener("pointerleave", function () { hovering = false; pauseBriefly(); });
    root.addEventListener("mouseleave", function () { hovering = false; pauseBriefly(); });
    root.addEventListener("focusin", function () { hovering = true; });
    root.addEventListener("focusout", function () { hovering = false; pauseBriefly(); });
    track.addEventListener("touchstart", function () { touching = true; }, { passive: true });
    track.addEventListener("touchend", function () { touching = false; pauseBriefly(); }, { passive: true });
    window.addEventListener("resize", update);

    // ---- swipe animation: drag with mouse/pen, depth effect while sliding, intro hint ----
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var drag = null, suppressClick = false;

    function applyDepth() {
        var mid = track.scrollLeft + track.clientWidth / 2;
        allCards.forEach(function (c) {
            var dist = Math.min(1, Math.abs((c.offsetLeft - track.offsetLeft + c.offsetWidth / 2) - mid) / (c.offsetWidth * 0.9));
            c.style.setProperty("--ts-s", (1 - dist * 0.07).toFixed(3));
            c.style.setProperty("--ts-o", (1 - dist * 0.45).toFixed(3));
        });
    }
    track.addEventListener("scroll", function () { window.requestAnimationFrame(applyDepth); }, { passive: true });
    window.addEventListener("resize", applyDepth);

    track.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "touch" || e.button !== 0) return; // touch already swipes natively
        drag = { x: e.clientX, left: track.scrollLeft, moved: false, id: e.pointerId, lastX: e.clientX, lastT: performance.now(), v: 0 };
    });
    track.addEventListener("pointermove", function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var dx = e.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) > 6) {
            drag.moved = true;
            track.classList.add("is-dragging");
            try { track.setPointerCapture(e.pointerId); } catch (_) {}
        }
        if (!drag.moved) return;
        var now = performance.now();
        drag.v = (e.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
        drag.lastX = e.clientX; drag.lastT = now;
        track.scrollLeft = drag.left - dx;
    });
    function endDrag(e) {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        var d = drag; drag = null;
        if (!d.moved) return;
        track.classList.remove("is-dragging");
        try { track.releasePointerCapture(d.id); } catch (_) {}
        suppressClick = true;
        window.setTimeout(function () { suppressClick = false; }, 0);
        var i = rawIndex();
        var dx = (e ? e.clientX : d.lastX) - d.x;
        if (d.v < -0.4 || dx < -50) i = Math.min(count, Math.floor(track.scrollLeft / Math.max(1, offsetOf(1))) + 1);
        else if (d.v > 0.4 || dx > 50) i = Math.max(0, Math.ceil(track.scrollLeft / Math.max(1, offsetOf(1))) - 1);
        pauseBriefly();
        goTo(i);
    }
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    track.addEventListener("click", function (e) { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

    // Hint: a hand swipes across the first card once, and the card gives a small nudge.
    function playHint() {
        if (reduceMotion || track.scrollLeft > 4 || maxScroll() <= 4) return;
        try { if (window.sessionStorage.getItem("tsHintSeen")) return; window.sessionStorage.setItem("tsHintSeen", "1"); } catch (_) {}
        var hint = document.createElement("div");
        hint.className = "ts-swipe-hint";
        hint.setAttribute("aria-hidden", "true");
        hint.innerHTML = '<i class="bi bi-hand-index-thumb-fill"></i>';
        track.parentNode.insertBefore(hint, track.nextSibling);
        pauseBriefly();
        track.classList.add("is-nudging");
        track.scrollTo({ left: Math.min(70, maxScroll()), behavior: "smooth" });
        window.setTimeout(function () { track.scrollTo({ left: 0, behavior: "smooth" }); }, 650);
        window.setTimeout(function () { track.classList.remove("is-nudging"); }, 1300);
        window.setTimeout(function () { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 1800);
    }
    if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
            if (entries[0].isIntersecting) { io.disconnect(); window.setTimeout(playHint, 500); }
        }, { threshold: 0.6 });
        io.observe(track);
    }
    applyDepth();

    // ---- steps popup ----
    if (modalEl) {
        var titleEl = modalEl.querySelector("[data-ts-modal-title]");
        var bodyEl = modalEl.querySelector("[data-ts-modal-body]");
        var reportBtn = modalEl.querySelector("[data-ts-report]");

        modalEl.addEventListener("show.bs.modal", function () { modalOpen = true; });
        modalEl.addEventListener("hidden.bs.modal", function () { modalOpen = false; pauseBriefly(); });

        function getModal() {
            return window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(modalEl) : null;
        }

        allCards.forEach(function (card) {
            card.addEventListener("click", function () {
                var key = card.getAttribute("data-ts-open");
                var tpl = root.querySelector('template[data-ts-steps="' + key + '"]');
                if (!tpl) return;
                titleEl.textContent = card.getAttribute("data-ts-title");
                bodyEl.innerHTML = tpl.innerHTML;
                var m = getModal();
                if (m) m.show();
            });
        });

        reportBtn.addEventListener("click", function () {
            var m = getModal();
            if (modalEl.getAttribute("data-has-open-issue") === "1" && document.getElementById("openIssueModal") && window.bootstrap) {
                // Only one open report allowed: swap to the existing "already reported" popup.
                modalEl.addEventListener("hidden.bs.modal", function once() {
                    modalEl.removeEventListener("hidden.bs.modal", once);
                    window.bootstrap.Modal.getOrCreateInstance(document.getElementById("openIssueModal")).show();
                });
                if (m) m.hide();
            } else {
                window.location.href = modalEl.getAttribute("data-report-url");
            }
        });
    }

    update();
    startAuto();
})();
