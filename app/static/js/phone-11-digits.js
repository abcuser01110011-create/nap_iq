/*
 * Contact / phone number fields: digits only, exactly 11 digits.
 *
 * Applies site-wide to every input named contact_number / phone_number (and
 * the ticket-form / landing-page phone inputs). Non-digits are stripped as
 * you type, the field is capped at 11 digits, and while the value is not
 * exactly 11 digits a message is shown right beneath the field. A form
 * can't be submitted while a filled-in phone field is not 11 digits.
 * (The server still validates too -- see phone_11_digits() in app/forms.py.)
 *
 * Delegated, so it also covers forms loaded into popups.
 */
(function () {
    var SELECTOR = 'input[name="contact_number"], input[name="phone_number"], ' +
                   '#ticketFormContactNumber, #loginPhone, #applyPhone';
    var MESSAGE = 'You should input an exact 11-digit number.';

    function isPhone(el) { return el && el.matches && el.matches(SELECTOR); }

    function messageEl(input) {
        var anchor = input.closest('.input-group') || input;
        var next = anchor.nextElementSibling;
        if (next && next.classList.contains('phone-11-msg')) return next;
        var el = document.createElement('div');
        el.className = 'invalid-feedback d-block phone-11-msg';
        el.textContent = MESSAGE;
        anchor.parentNode.insertBefore(el, anchor.nextSibling);
        return el;
    }

    // Returns true when the field is fine (empty is left to the form's own
    // required/optional handling).
    function check(input, showEmpty) {
        var v = input.value;
        var bad = v.length > 0 ? v.length !== 11 : !!showEmpty;
        var anchor = input.closest('.input-group') || input;
        var existing = anchor.nextElementSibling;
        existing = existing && existing.classList.contains('phone-11-msg') ? existing : null;
        if (bad) {
            messageEl(input);
            input.classList.add('is-invalid');
        } else {
            if (existing) existing.remove();
            input.classList.remove('is-invalid');
        }
        return !bad;
    }

    document.addEventListener('input', function (e) {
        var input = e.target;
        if (!isPhone(input)) return;
        var cleaned = input.value.replace(/\D/g, '').slice(0, 11);
        if (cleaned !== input.value) input.value = cleaned;
        check(input, false);
    });

    document.addEventListener('focusout', function (e) {
        if (isPhone(e.target)) check(e.target, false);
    });

    // Block submitting while a filled-in phone field isn't exactly 11 digits.
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || !form.querySelectorAll) return;
        var firstBad = null;
        form.querySelectorAll(SELECTOR).forEach(function (input) {
            if (input.offsetParent === null && !input.value) return; // hidden + empty
            if (!check(input, false) && !firstBad) firstBad = input;
        });
        if (firstBad) {
            e.preventDefault();
            e.stopImmediatePropagation();
            firstBad.focus();
        }
    }, true);
})();
