// A browser signed in before private sessions never got the wallet seed that
// comes from the account number, so its chats are still tied to the account.
// The server says whether this sign-in is that old (GET /private_setup); only
// then is the number asked for, once per browser; "Not now" is remembered. Entering the number is a
// sign-in with it (only a key derived from it is sent), which gives this
// browser its private-session wallet; the page then reloads with it on.
(function () {
    'use strict';
    const LATER = 'obscurify_private_setup_later';
    // Whether this page asks (code-upgrade.js waits, so two dialogs never stack).
    let settle;
    window.PrivateSetup = { asking: new Promise((resolve) => { settle = resolve; }) };

    async function ask() {
        const dialog = document.getElementById('private-setup');
        if (!dialog || typeof isLoggedIn === 'undefined' || !isLoggedIn) return;
        if (!window.PrivateSessions || !PrivateSessions.needsNumber() || localStorage.getItem(LATER)) return;
        // Without WebAssembly (Tor Browser at Safer) no wallet can be made here: don't ask for the code.
        if (!PrivateSessions.wasmWorks()) return;
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
            const number = input.value.trim();
            if (!(await PrivateSessions.kind(number))) {
                return fail(/[a-z]/i.test(number) ? 'That isn\'t a valid account code: check each character.' : 'That is not 16 digits or an account code.');
            }
            error.hidden = true;
            go.disabled = true;
            go.textContent = 'Turning on…';
            try {
                const key = await PrivateSessions.keys(number);
                // An account from before account keys signs in with its number once, which moves it over.
                // A code never leaves this browser; only an old 16-digit number goes as it is, once.
                const kind = await PrivateSessions.kind(number);
                if (kind === 'number' && window.CodeUpgrade) CodeUpgrade.offerAfterSignIn();
                if (await signIn({ account_key: key }) || (kind === 'number' && await signIn({ account_number: number }))) {
                    location.reload();
                    return;
                }
                PrivateSessions.forget();
                fail('That did not sign in. Check it and try again.');
            } catch (e) {
                PrivateSessions.forget();
                fail('Could not turn it on: ' + e.message);
            }
        });
        dialog.showModal();
        input.focus();
        return true;
    }

    const run = () => ask().then((shown) => settle(!!shown), () => settle(false));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
})();
