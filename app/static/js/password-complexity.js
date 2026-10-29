// Live password-complexity check for the Change Password form.
// Shows the unmet requirements in red as soon as the user starts typing in
// the new-password field; each line disappears once satisfied. Mirrors
// validate_password_complexity() in app/forms.py (server stays authoritative).
(function () {
    var input = document.getElementById('password');
    var list = document.getElementById('password-requirements');
    if (!input || !list) return;

    var rules = [
        { label: 'At least 8 characters', test: function (v) { return v.length >= 8; } },
        { label: 'At least one uppercase letter (A-Z)', test: function (v) { return /[A-Z]/.test(v); } },
        { label: 'At least one lowercase letter (a-z)', test: function (v) { return /[a-z]/.test(v); } },
        { label: 'At least one number (0-9)', test: function (v) { return /\d/.test(v); } },
        { label: 'At least one special character (e.g. !@#$%^&*)', test: function (v) { return /[^A-Za-z0-9]/.test(v); } }
    ];

    function render() {
        var value = input.value;
        list.innerHTML = '';
        if (!value) { list.hidden = true; input.classList.remove('is-invalid'); return; }

        var unmet = rules.filter(function (r) { return !r.test(value); });
        unmet.forEach(function (r) {
            var li = document.createElement('li');
            li.innerHTML = '<i class="bi bi-x-circle-fill me-1"></i>';
            li.appendChild(document.createTextNode(r.label));
            list.appendChild(li);
        });
        list.hidden = unmet.length === 0;
        input.classList.toggle('is-invalid', unmet.length > 0);
    }

    input.addEventListener('input', render);

    var form = input.form;
    if (form) {
        form.addEventListener('submit', function (e) {
            render();
            if (!list.hidden) { e.preventDefault(); input.focus(); }
        });
    }
})();
