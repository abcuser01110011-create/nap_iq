// Troubleshooting guide carousel: arrows, dots, keyboard + swipe (native scroll-snap).
(function () {
    var root = document.getElementById("tsGuide");
    if (!root) return;
    var track = root.querySelector(".ts-track");
    var cards = Array.prototype.slice.call(track.querySelectorAll(".ts-card"));
    var dotsWrap = root.querySelector(".ts-dots");
    var prev = root.querySelector("[data-ts-prev]");
    var next = root.querySelector("[data-ts-next]");
    var dots = [];

    cards.forEach(function (card, i) {
        var d = document.createElement("button");
        d.type = "button";
        d.className = "ts-dot";
        d.setAttribute("aria-label", "Go to tip " + (i + 1));
        d.addEventListener("click", function () { goTo(i); });
        dotsWrap.appendChild(d);
        dots.push(d);
    });

    function goTo(i) {
        i = Math.max(0, Math.min(cards.length - 1, i));
        track.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft, behavior: "smooth" });
    }

    function currentIndex() {
        var x = track.scrollLeft + cards[0].offsetLeft;
        var best = 0, bestDist = Infinity;
        cards.forEach(function (c, i) {
            var dist = Math.abs(c.offsetLeft - x);
            if (dist < bestDist) { best = i; bestDist = dist; }
        });
        // At the very end the last card may not reach the start edge.
        if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 4) best = cards.length - 1;
        return best;
    }

    function update() {
        var i = currentIndex();
        dots.forEach(function (d, n) { d.classList.toggle("is-active", n === i); });
        prev.disabled = track.scrollLeft <= 4;
        next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    }

    prev.addEventListener("click", function () { goTo(currentIndex() - 1); });
    next.addEventListener("click", function () { goTo(currentIndex() + 1); });
    track.addEventListener("scroll", function () { window.requestAnimationFrame(update); }, { passive: true });
    track.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight") { e.preventDefault(); goTo(currentIndex() + 1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); goTo(currentIndex() - 1); }
    });
    window.addEventListener("resize", update);
    update();
})();
