// A browser signed in before private sessions never got the wallet seed that
// comes from the account number, so its chats are still tied to the account.
// The server says whether this sign-in is that old (GET /private_setup); only
// then is the number asked for, once per browser; "Not now" is remembered. Entering the number is a
// sign-in with it (only a key derived from it is sent), which gives this
// browser its private-session wallet; the page then reloads with it on.
(function () {
    'use strict';
    const LATER = 'obscurify_private_setup_later';

    async function ask() {
        const dialog = document.getElementById('private-setup');
        if (!dialog || typeof isLoggedIn === 'undefined' || !isLoggedIn) return;
        if (!window.PrivateSessions || !PrivateSessions.needsNumber() || localStorage.getItem(LATER)) return;
        try {
            const r = await fetch('/private_setup', { credentials: 'same-origin' });
            if (!r.ok || !(await r.json()).ask) return;
        } catch (_) { return; }
        const input = document.getElementById('private-setup-number');
        const error = document.getElementById('private-setup-error');
        const go = document.getElementById('private-setup-go');
        const fail = (text) => { error.textContent = text; error.hidden = false; go.disabled = false; go.textContent = 'Turn on'; };
        const signIn = (body) => fetch('/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then((r) => r.json().then((d) => r.ok && d.success));

        document.getElementById('private-setup-later').addEventListener('click', () => {
            localStorage.setItem(LATER, '1');
            dialog.close();
        });
        dialog.querySelector('form').addEventListener('submit', async () => {
            const number = input.value.replace(/\D/g, '');
            if (number.length !== 16) return fail('That is not 16 digits.');
            error.hidden = true;
            go.disabled = true;
            go.textContent = 'Turning on…';
            try {
                const key = await PrivateSessions.keys(number);
                // An account from before login keys signs in with its number once, which moves it over.
                if (await signIn({ account_key: key }) || await signIn({ account_number: number })) {
                    location.reload();
                    return;
                }
                PrivateSessions.forget();
                fail('That number did not sign in. Check it and try again.');
            } catch (e) {
                PrivateSessions.forget();
                fail('Could not turn it on: ' + e.message);
            }
        });
        dialog.showModal();
        input.focus();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ask);
    else ask();
})();
