// Generic show/hide toggle for password fields.
//
// Usage: wrap a password <input id="foo"> and a toggle <button> in the same
// input-group, and give the button data-toggle-password="foo" plus a
// bootstrap-icons <i> child (bi-eye). Works for any number of password
// fields on a page — no per-field script needed.
(function () {
    // On mobile, tapping the button first blurs the focused password input,
    // which closes the on-screen keyboard and reflows the page *before* the
    // click event fires — so the tap lands on the wrong spot (or nothing).
    // Prevent the default mousedown behavior so the input never loses focus
    // and the layout stays put; the click handler below still runs normally.
    document.addEventListener('mousedown', function (event) {
        var btn = event.target.closest('[data-toggle-password]');
        if (btn) event.preventDefault();
    });

    document.addEventListener('click', function (event) {
        var btn = event.target.closest('[data-toggle-password]');
        if (!btn) return;

        var targetId = btn.getAttribute('data-toggle-password');
        var input = document.getElementById(targetId);
        if (!input) return;

        var icon = btn.querySelector('i');
        var isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';

        if (icon) {
            icon.classList.toggle('bi-eye', !isHidden);
            icon.classList.toggle('bi-eye-slash', isHidden);
        }

        btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
        btn.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
    });
})();
