/*
 * "Generate password" for the Add / Edit Technician form.
 *
 * The password is built ONLY from the technician's full name and contact
 * number, and always satisfies the site's complexity rules (see
 * validate_password_complexity() in app/forms.py): 8+ characters, an
 * uppercase letter, a lowercase letter, a digit and a special character.
 *
 *   Full name "Roberto Cruz" + contact "09171234567"  ->  RobertoC@4567
 *
 * Delegated click handler, so it also works for forms loaded into a popup.
 */
(function () {
    function build(fullName, contact) {
        var words = String(fullName || '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .split(/\s+/)
            .map(function (w) { return w.replace(/[^A-Za-z]/g, ''); })
            .filter(Boolean);
        var digits = String(contact || '').replace(/\D/g, '');
        if (!words.length || digits.length < 7) return null;

        var first = words[0].slice(0, 12);
        var namePart = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
        if (words.length > 1) {
            namePart += words[words.length - 1].charAt(0).toUpperCase();
        }
        // Guarantee a lowercase letter even for very short names ("Al" is fine, "J" is not).
        if (!/[a-z]/.test(namePart)) namePart += namePart.charAt(0).toLowerCase();

        // Last 4 digits of the contact number; pad with earlier digits to reach 8+ characters.
        var tail = digits.slice(-4);
        var cursor = digits.length - 4;
        while ((namePart + '@' + tail).length < 8 && cursor > 0) {
            cursor -= 1;
            tail = digits.charAt(cursor) + tail;
        }
        return namePart + '@' + tail;
    }

    document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-generate-password]');
        if (!btn) return;
        e.preventDefault();
        var form = btn.closest('form');
        if (!form) return;

        var name = form.querySelector('[name="full_name"]');
        var contact = form.querySelector('[name="contact_number"], [name="phone_number"]');
        var pw = form.querySelector('[name="password"]');
        var confirm = form.querySelector('[name="confirm_password"]');
        var msg = form.querySelector('[data-generate-msg]');
        if (!pw || !confirm) return;

        var result = build(name && name.value, contact && contact.value);
        if (!result) {
            if (msg) {
                msg.textContent = 'Enter the full name and a contact number (at least 7 digits) first.';
                msg.className = 'form-text text-danger';
            }
            (name && !name.value.trim() ? name : contact).focus();
            return;
        }
        pw.value = result;
        confirm.value = result;
        // Show it so the admin can hand it to the technician.
        pw.type = 'text';
        confirm.type = 'text';
        pw.classList.remove('is-invalid');
        confirm.classList.remove('is-invalid');
        if (msg) {
            msg.textContent = 'Generated from the name and contact number. Share it with the technician.';
            msg.className = 'form-text text-success';
        }
    });
})();
