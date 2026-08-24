// Generic show/hide toggle for password fields.
//
// Usage: wrap a password <input id="foo"> and a toggle <button> in the same
// input-group, and give the button data-toggle-password="foo" plus a
// bootstrap-icons <i> child (bi-eye). Works for any number of password
// fields on a page — no per-field script needed.
(function () {
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
