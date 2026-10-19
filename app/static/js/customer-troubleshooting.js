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
    var timer = null, hovering = false, touching = false, modalOpen = false, resumeAt = 0;

    cards.forEach(function (card, i) {
        var d = document.createElement("span");
        d.className = "ts-dot";
        dotsWrap.appendChild(d);
        dots.push(d);
    });

    function offsetOf(i) { return cards[i].offsetLeft - cards[0].offsetLeft; }
    function maxScroll() { return track.scrollWidth - track.clientWidth; }
    function goTo(i) {
        i = Math.max(0, Math.min(cards.length - 1, i));
        track.scrollTo({ left: Math.min(offsetOf(i), maxScroll()), behavior: "smooth" });
    }
    function currentIndex() {
        var x = track.scrollLeft, best = 0, bestDist = Infinity;
        cards.forEach(function (c, i) {
            var dist = Math.abs(offsetOf(i) - x);
            if (dist < bestDist) { best = i; bestDist = dist; }
        });
        if (track.scrollLeft >= maxScroll() - 4 && maxScroll() > 4) best = cards.length - 1;
        return best;
    }
    function update() {
        var i = currentIndex();
        dots.forEach(function (d, n) { d.classList.toggle("is-active", n === i); });
        prev.disabled = track.scrollLeft <= 4;
        next.disabled = track.scrollLeft >= maxScroll() - 4;
    }

    // ---- auto slide every 3s; loops back to the first card ----
    function tick() {
        if (hovering || touching || modalOpen || document.hidden || Date.now() < resumeAt) return;
        if (maxScroll() <= 4) return; // everything already visible
        if (track.scrollLeft >= maxScroll() - 4) goTo(0); else goTo(currentIndex() + 1);
    }
    function startAuto() { if (!timer) timer = window.setInterval(tick, AUTOPLAY_MS); }
    function pauseBriefly() { resumeAt = Date.now() + AUTOPLAY_MS; }

    prev.addEventListener("click", function () { pauseBriefly(); goTo(currentIndex() - 1); });
    next.addEventListener("click", function () { pauseBriefly(); goTo(currentIndex() + 1); });
    track.addEventListener("scroll", function () { window.requestAnimationFrame(update); }, { passive: true });
    root.addEventListener("mouseenter", function () { hovering = true; });
    root.addEventListener("mouseleave", function () { hovering = false; pauseBriefly(); });
    root.addEventListener("focusin", function () { hovering = true; });
    root.addEventListener("focusout", function () { hovering = false; pauseBriefly(); });
    track.addEventListener("touchstart", function () { touching = true; }, { passive: true });
    track.addEventListener("touchend", function () { touching = false; pauseBriefly(); }, { passive: true });
    window.addEventListener("resize", update);

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

        cards.forEach(function (card) {
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
