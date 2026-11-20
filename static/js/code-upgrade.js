// Signed in with a 16-digit account number (or from before account kinds were kept): offer the
// upgrade to an account code, which encrypted chat sync needs (a number can be guessed by someone
// holding the server; a code can't). Asked once per browser, whether the person just signed in or
// already was; after that the Account page's "Enable encrypted chat sync" box opens it.
//
// The whole switch happens in this dialog, on whatever page it opens on:
//   1. "Enable encrypted sync?"  Not now / Generate New Account Code
//   2. the new code, made here (never sent), to write down: Copy, "I've written it down", Convert
//   3. Convert: only the code's account key goes to POST /account_number/rotate; synced chats
//      move to the new code (chat-sync.js) and sync turns on
//   4. Done
//
// A browser that signed in before the account got its code on another device (GET /private_setup
// `new_code`) is asked for that code instead, once, to sync here; it is never offered another.
//
//   CodeUpgrade.open()             the Account page's button: convert, or enter the code made elsewhere
//   CodeUpgrade.status()           what GET /private_setup says ({ask, new_code}), fetched once
//   CodeUpgrade.offerAfterSignIn() kept for the sign-in forms; the check on every page covers it
// Fires `account-code-converted` on window once the account has its code. Every code shown here
// copies when tapped.
(function () {
    'use strict';
    const FLAG = 'obscurify_offer_code';
    const SEEN = 'obscurify_code_offer_seen';
    const ENTER_LATER = 'obscurify_new_code_later';
    let statusOnce = null;
    const status = () => statusOnce || (statusOnce = fetch('/private_setup', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})));

    function styles() {
        if (document.getElementById('code-upgrade-style')) return;
        const style = document.createElement('style');
        style.id = 'code-upgrade-style';
        style.textContent = '#code-upgrade{width:min(420px,calc(100vw - 24px));padding:20px;background:#15181d;color:#fff;border:1px solid #2c323b;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.6)}'
            + '#code-upgrade::backdrop{background:rgba(0,0,0,.72);backdrop-filter:blur(3px)}'
            + '#code-upgrade h2{margin:0 0 8px;font:700 1.05rem var(--mono,monospace);color:#fff}'
            + '#code-upgrade p{margin:0 0 16px;color:#c8ccd2;font-size:.9rem;line-height:1.45}'
            + '#code-upgrade a{color:var(--accent-color,#00d97e)}'
            + '#code-upgrade .row{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}'
            + '#code-upgrade button{padding:10px 18px;border-radius:20px;font:700 .85rem var(--mono,monospace);cursor:pointer}'
            + '#code-upgrade button:disabled{opacity:.45;cursor:default}'
            + '#code-upgrade .quiet{background:transparent;color:#fff;border:1px solid #3a414b}'
            + '#code-upgrade .go{background:var(--accent-color,#00d97e);color:#000;border:0}'
            + '#code-upgrade-code{margin:4px 0 4px;padding:14px 10px;background:#0b0d10;border:1px solid #2c323b;border-radius:10px;text-align:center;font:700 clamp(.95rem,4.6vw,1.3rem) var(--mono,monospace);letter-spacing:.04em;color:var(--accent-color,#00d97e);white-space:nowrap;user-select:all;cursor:pointer}'
            + '#code-upgrade .tap{margin:0 0 14px;text-align:center;font-size:.8rem;color:#9aa1aa}'
            + '#code-upgrade input[type=text]{width:100%;box-sizing:border-box;margin:0 0 12px;padding:12px;background:#0b0d10;color:#fff;border:1px solid #3a414b;border-radius:10px;font:600 1rem var(--mono,monospace)}'
            + '#code-upgrade label{display:flex;gap:8px;align-items:center;margin:0 0 16px;color:#e3e6ea;font-size:.9rem;cursor:pointer}'
            + '#code-upgrade-error{color:#f87171}';
        document.head.appendChild(style);
    }

    const el = (tag, props, ...kids) => {
        const e = Object.assign(document.createElement(tag), props || {});
        e.append(...kids);
        return e;
    };

    function dialog() {
        let d = document.getElementById('code-upgrade');
        if (d) return d;
        styles();
        d = el('dialog', { id: 'code-upgrade' });
        d.setAttribute('aria-labelledby', 'code-upgrade-title');
        document.body.appendChild(d);
        d.addEventListener('cancel', (e) => { if (d.dataset.busy) e.preventDefault(); });
        d.addEventListener('close', () => d.remove());
        return d;
    }

    // Closed and gone at once (the close event comes a moment later).
    const shut = (d) => { d.close(); d.remove(); };

    function step(d, title, ...body) {
        d.replaceChildren(el('h2', { id: 'code-upgrade-title', textContent: title }), ...body);
        if (!d.open) d.showModal();
    }

    function ask() {
        const d = dialog();
        const how = el('a', { href: '/blog/account_codes', target: '_blank', rel: 'noopener', textContent: 'How this works' });
        const later = el('button', { type: 'button', id: 'code-upgrade-later', className: 'quiet', textContent: 'Not now' });
        const go = el('button', { type: 'button', id: 'code-upgrade-go', className: 'go', textContent: 'Generate New Account Code' });
        later.addEventListener('click', () => shut(d));
        go.addEventListener('click', () => generate());
        step(d, 'Enable encrypted sync?', el('p', {}, 'Upgrading to account code enables encrypted sync. ', how), el('div', { className: 'row' }, later, go));
        go.focus();
    }

    async function generate() {
        const d = dialog();
        if (!window.PrivateSessions) {
            step(d, 'Couldn\'t make a code', el('p', { textContent: 'Your browser couldn\'t load what makes account codes. Reload the page and try again.' }),
                el('div', { className: 'row' }, closeButton(d)));
            return;
        }
        const code = await PrivateSessions.newCode();
        const saved = el('input', { type: 'checkbox', id: 'code-upgrade-saved' });
        const cancel = el('button', { type: 'button', id: 'code-upgrade-cancel', className: 'quiet', textContent: 'Cancel' });
        const convert = el('button', { type: 'button', id: 'code-upgrade-convert', className: 'go', textContent: 'Convert', disabled: true });
        const error = el('p', { id: 'code-upgrade-error', hidden: true });
        saved.addEventListener('change', () => { convert.disabled = !saved.checked; });
        cancel.addEventListener('click', () => shut(d));
        convert.addEventListener('click', () => switchTo(d, code, { convert, cancel, saved, error }));
        step(d, 'Your new account code',
            el('p', { textContent: 'Write it down. It replaces your account number when you press Convert, and we can\'t show it to you again.' }),
            codeBox(code),
            el('label', {}, saved, 'I\'ve written down my account code'),
            error,
            el('div', { className: 'row' }, cancel, convert));
    }

    async function switchTo(d, code, ui) {
        ui.convert.disabled = true;
        ui.cancel.disabled = true;
        ui.saved.disabled = true;
        ui.convert.textContent = 'Converting…';
        ui.error.hidden = true;
        d.dataset.busy = '1';
        try {
            const keys = await PrivateSessions.keysOf(code);
            const res = await fetch('/account_number/rotate', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_key: keys.loginKey }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                throw new Error(res.status === 401 ? 'You\'re signed out. Sign in again, then convert.' : (data.error || 'The server said no (' + res.status + ').'));
            }
            // Synced chats move to the new code first (devices on the old one stop), then sync is on.
            if (window.ChatSync) {
                await Promise.resolve(ChatSync.moveTo(keys.seed)).catch((e) => console.warn('chat sync: could not move to the new code', e));
            }
            PrivateSessions.setAccountKind('code');
            window.dispatchEvent(new Event('chatsync-available'));
            window.dispatchEvent(new Event('account-code-converted'));
            if (window.ChatSync && ChatSync.on()) ChatSync.syncNow();
            delete d.dataset.busy;
            const done = el('button', { type: 'button', id: 'code-upgrade-done', className: 'go', textContent: 'Done' });
            done.addEventListener('click', () => shut(d));
            step(d, 'Encrypted sync is on',
                el('p', { textContent: 'Sign in with this account code from now on; your old number no longer works. Devices already signed in stay signed in: enter the code there once to sync them. Your API keys keep working.' }),
                codeBox(code),
                el('div', { className: 'row' }, done));
            done.focus();
        } catch (e) {
            delete d.dataset.busy;
            ui.convert.textContent = 'Convert';
            ui.convert.disabled = false;
            ui.cancel.disabled = false;
            ui.saved.disabled = false;
            ui.error.textContent = e.message;
            ui.error.hidden = false;
        }
    }

    // The code, which copies when tapped.
    function codeBox(code) {
        const box = el('div', { id: 'code-upgrade-code', textContent: code, title: 'Tap to copy' });
        const hint = el('p', { className: 'tap', textContent: 'Tap the code to copy it.' });
        box.addEventListener('click', () => {
            navigator.clipboard.writeText(code).then(() => {
                hint.textContent = 'Copied';
                setTimeout(() => { hint.textContent = 'Tap the code to copy it.'; }, 1500);
            }, () => {});
        });
        const wrap = document.createDocumentFragment();
        wrap.append(box, hint);
        return wrap;
    }

    // The account got its code on another device: enter it here once (a sign-in with it) to sync.
    function enter() {
        const d = dialog();
        const input = el('input', { type: 'text', id: 'code-upgrade-enter', autocomplete: 'off', spellcheck: false, placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX' });
        input.setAttribute('autocapitalize', 'characters');
        const later = el('button', { type: 'button', id: 'code-upgrade-later', className: 'quiet', textContent: 'Not now' });
        const go = el('button', { type: 'button', id: 'code-upgrade-signin', className: 'go', textContent: 'Sign in' });
        const error = el('p', { id: 'code-upgrade-error', hidden: true });
        later.addEventListener('click', () => { localStorage.setItem(ENTER_LATER, '1'); shut(d); });
        const signIn = async () => {
            const typed = input.value.trim();
            error.hidden = true;
            if ((await PrivateSessions.kind(typed)) !== 'code') {
                error.textContent = 'That isn\'t a valid account code: check each character.';
                error.hidden = false;
                return;
            }
            go.disabled = true;
            go.textContent = 'Signing in…';
            try {
                const key = await PrivateSessions.keys(typed);
                const r = await fetch('/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_key: key }) });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.success !== false) { location.reload(); return; }
                PrivateSessions.forget();
                throw new Error(r.status === 429 ? 'Too many tries from here. Wait a minute, then try again.' : 'That didn\'t sign in. Check each character.');
            } catch (e) {
                go.disabled = false;
                go.textContent = 'Sign in';
                error.textContent = e.message;
                error.hidden = false;
            }
        };
        go.addEventListener('click', signIn);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
        step(d, 'This account has an account code',
            el('p', { textContent: 'It was made on another device. Enter it once here to sync your chats on this device too. You stay signed in either way.' }),
            input, error,
            el('div', { className: 'row' }, later, go));
        input.focus();
    }

    function closeButton(d) {
        const b = el('button', { type: 'button', className: 'quiet', textContent: 'Close' });
        b.addEventListener('click', () => shut(d));
        return b;
    }

    window.CodeUpgrade = {
        offerAfterSignIn() { sessionStorage.setItem(FLAG, '1'); },
        open() { status().then((st) => (st.new_code ? enter() : generate())); },
        status,
    };

    async function start() {
        const signedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
        sessionStorage.removeItem(FLAG);
        if (!signedIn || !window.PrivateSessions || PrivateSessions.accountKind() === 'code') return;
        const st = await status();
        // The private-sessions setup asks first (it signs in with the code or number and reloads).
        if (window.PrivateSetup && await PrivateSetup.asking) return;
        if (document.querySelector('dialog[open]')) return;
        if (st.new_code) {
            // Made on another device: ask for it here (once), never offer to make another.
            if (!localStorage.getItem(ENTER_LATER)) enter();
            return;
        }
        if (localStorage.getItem(SEEN)) return;
        localStorage.setItem(SEEN, '1');
        ask();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
