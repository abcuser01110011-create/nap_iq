// Live password-complexity guide for EVERY "set a password" field in the app
// (Change Password, Reset Password, Add User, Register, Add Technician,
// Add Collector, ...). A field counts as a new-password field when it is
// named password / new_password and is marked autocomplete="new-password"
// (or its form has a confirm_password field) -- so the sign-in form's
// password box is left alone.
//
// Shows the next unmet requirement (one at a time) in red as soon as you
// type; it moves on to the next one once fixed. Mirrors validate_password_complexity() in
// app/forms.py (the server stays authoritative). Delegated, so it also
// works for forms loaded into popups; a script that fills the field
// programmatically (the Generate button) just dispatches an "input" event.
(function () {
    if (window.__pwComplexityLoaded) return;
    window.__pwComplexityLoaded = true;

    var rules = [
        { label: 'At least 8 characters', test: function (v) { return v.length >= 8; } },
        { label: 'At least one uppercase letter (A-Z)', test: function (v) { return /[A-Z]/.test(v); } },
        { label: 'At least one lowercase letter (a-z)', test: function (v) { return /[a-z]/.test(v); } },
        { label: 'At least one number (0-9)', test: function (v) { return /\d/.test(v); } },
        { label: 'At least one special character (e.g. !@#$%^&*)', test: function (v) { return /[^A-Za-z0-9]/.test(v); } }
    ];

    function isNewPassword(el) {
        if (!el || el.tagName !== 'INPUT') return false;
        if (el.name !== 'password' && el.name !== 'new_password') return false;
        // Staff sign-in: show the guide while typing (opt-in attribute).
        if (el.hasAttribute('data-password-guide-only')) return true;
        var form = el.form;
        if (el.getAttribute('autocomplete') === 'new-password') return true;
        return !!(form && form.querySelector('[name="confirm_password"], [name="confirm_new_password"]'));
    }

    function listFor(input) {
        // Reuse a hand-placed list (Change Password page) if there is one.
        var form = input.form;
        var legacy = form && input.id === 'password' ? form.querySelector('#password-requirements') : null;
        if (legacy) return legacy;
        var anchor = input.closest('.input-group, .login-field__wrap') || input;
        var next = anchor.nextElementSibling;
        if (next && next.classList.contains('password-requirements')) return next;
        var ul = document.createElement('ul');
        ul.className = 'password-requirements list-unstyled small text-danger mt-2 mb-0';
        ul.setAttribute('aria-live', 'polite');
        ul.hidden = true;
        anchor.parentNode.insertBefore(ul, anchor.nextSibling);
        return ul;
    }

    function styleList(list, reserve) {
        list.style.listStyle = 'none';
        list.style.padding = '0';
        list.style.margin = '.35rem 0 0';
        list.style.fontSize = '.75rem';
        list.style.lineHeight = '1.2rem';
        list.style.color = '#dc3545';
        // Sign-in: always keep one line of space so the card never changes size.
        if (reserve) list.style.minHeight = '1.2rem';
    }

    // Shows ONE unmet rule at a time (the next one to fix). Returns true when
    // the value is empty or meets every rule.
    function render(input) {
        var list = listFor(input);
        var reserve = input.hasAttribute('data-password-guide-only');
        var value = input.value;
        styleList(list, reserve);
        list.innerHTML = '';

        var unmet = value ? rules.filter(function (r) { return !r.test(value); }) : [];
        if (unmet.length) {
            var li = document.createElement('li');
            li.innerHTML = '<i class="bi bi-x-circle-fill me-1" style="font-size:.7rem"></i>';
            li.appendChild(document.createTextNode(unmet[0].label));
            list.appendChild(li);
        }
        if (reserve) {
            list.hidden = false;
            list.style.visibility = unmet.length ? 'visible' : 'hidden';
        } else {
            list.hidden = unmet.length === 0;
        }
        input.classList.toggle('is-invalid', unmet.length > 0);
        return unmet.length === 0;
    }

    // Reserve the sign-in slot up front so the card is already its final size.
    function reserveSlots() {
        document.querySelectorAll('input[data-password-guide-only]').forEach(render);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reserveSlots);
    else reserveSlots();

    document.addEventListener('input', function (e) {
        if (isNewPassword(e.target)) render(e.target);
    });

    // Don't submit a filled-in password that breaks a rule.
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || !form.querySelectorAll) return;
        var bad = null;
        form.querySelectorAll('input[name="password"], input[name="new_password"]').forEach(function (input) {
            if (!isNewPassword(input)) return;
            // Sign-in only shows the guide; the server decides if the password is right.
            if (input.hasAttribute('data-password-guide-only')) return;
            if (!render(input) && !bad) bad = input;
        });
        if (bad) {
            e.preventDefault();
            e.stopImmediatePropagation();
            bad.focus();
        }
    }, true);
})();
