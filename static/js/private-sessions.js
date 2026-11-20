// Private sessions (Unlinkable inference) in the web chat, the default once signed in
// with an account number on this device. The work is done by the open-source
// package unlinkable-inference (github.com/Obscurify-ai/unlinkable-inference), vendored
// in /static/vendor/unlinkable-inference/<version>/ by scripts/vendor-unlinkable-inference.sh: chat requests
// go out with the conversation's session secret and no cookie, and the wallet
// comes back from the number when the browser forgets it.
//
// Kept here: the seed (`obscurify_private_seed`; it cannot sign in), the
// package's state (`obscurify_private_state`) and whether this browser signed in
// with an account code or a 16-digit number (`obscurify_account_kind`: chat
// sync needs a code, chat-sync.js).
(function () {
    'use strict';
    const SEED = 'obscurify_private_seed';
    const STATE = 'obscurify_private_state';
    const OFF = 'obscurify_private_off'; // "1": the person switched it off
    const KIND = 'obscurify_account_kind'; // "code" or "number"
    // The package sits in a folder named after its version (scripts/vendor-unlinkable-inference.sh
    // keeps LIB_VERSION in step). /static is cached as immutable for 30 days, so each version needs
    // its own URLs: otherwise a browser can pair old cached WebAssembly with new JavaScript and fail
    // to read account codes.
    const LIB_VERSION = '0.2.0';
    const LIB = '/static/vendor/unlinkable-inference/' + LIB_VERSION + '/';
    const PKG = LIB + 'index.js';

    // When the wallet last couldn't be funded: the account's wallet (shared by every device
    // signed in with the code) is empty and the account holds less than a session's 10¢. Chats
    // then go through the account for ten minutes instead of failing.
    const UNFUNDED = 'obscurify_private_unfunded';
    const unfunded = () => Date.now() - (Number(localStorage.getItem(UNFUNDED)) || 0) < 600 * 1000;
    let lib = null;
    let ready = null;

    async function load() {
        if (!lib) {
            lib = await import(PKG);
            await lib.load(LIB + 'unlinkable_inference_wasm_bg.wasm');
        }
        return lib;
    }

    const on = () => !!localStorage.getItem(SEED) && localStorage.getItem(OFF) !== '1';

    // The account's API key, used only to top the wallet up (from the cookie).
    async function apiKey() {
        const res = await fetch('/tokens', { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error('could not get the account key (' + res.status + ')');
        return (await res.json()).token;
    }

    function start() {
        if (!ready) {
            ready = (async () => {
                if (!on() || unfunded()) return null;
                const u = await load();
                return u.connect({ seed: localStorage.getItem(SEED), apiKey, name: STATE, replyHeader: 'x-obscurify-reply' });
            })().catch((e) => {
                console.warn('private sessions: off for this visit', e);
                return null;
            });
        }
        return ready;
    }

    window.PrivateSessions = {
        // Chat requests it takes over (when on): the /web/* chat endpoints.
        handles: (url) => on() && /\/web\/(chat|tools|replies|responses)\b/.test(String(url)),
        async fetch(url, init) {
            const u = await start();
            if (!u) return fetch(url, init);
            // The CSRF token belongs to the cookie session: it must not go with a private request.
            const headers = new Headers((init && init.headers) || {});
            headers.delete('X-CSRF-Token');
            const m = String(url).match(/\/web\/replies\/([^/?]+)/);
            const chat = (typeof currentConversationId !== 'undefined' && currentConversationId) || 'default';
            let res;
            try {
                res = await u.fetch(url, Object.assign({}, init, { headers }), { chat, reply: m ? decodeURIComponent(m[1]) : undefined });
            } catch (e) {
                // No session could be opened because the wallet couldn't be filled.
                if (m || !/no paid vouchers|withdraw/i.test(String(e && (e.message || e)))) throw e;
            }
            if (res && (res.status !== 402 || m)) return res;
            // The wallet couldn't be topped up: pay for this chat through the account.
            localStorage.setItem(UNFUNDED, String(Date.now()));
            u.stop();
            ready = Promise.resolve(null);
            return fetch(url, init);
        },
        start,
        on,
        // Signed in on this device without the account number (before private
        // sessions, or another way): the wallet needs it once (private-setup.js).
        needsNumber: () => !localStorage.getItem(SEED),
        setOn(v) { if (v) localStorage.removeItem(OFF); else localStorage.setItem(OFF, '1'); },
        async summary() { const u = await start(); return u ? u.summary() : null; },
        // What private chats on this device cost, for the account page's
        // history: { spent: [{ at, millicents }], prepaid_millicents }, or
        // null when this device has no wallet. Read-only; starts nothing.
        async spending() {
            const seed = localStorage.getItem(SEED);
            if (!seed || !localStorage.getItem(STATE)) return null;
            return (await load()).spending({ seed, name: STATE });
        },

        // Sign-in and sign-up: the code or number never leaves this device.
        // Returns the account key to send, and keeps the seed for the wallet.
        async keys(codeOrNumber) {
            const u = await load();
            const k = await u.keys(codeOrNumber);
            localStorage.setItem(SEED, k.seed);
            localStorage.setItem(KIND, (await u.kind(codeOrNumber)) || 'number');
            // A sign-in replaces whatever key chat sync moved to after a switch here (chat-sync.js), which
            // may belong to another account if that session ended without signing out.
            localStorage.removeItem('obscurify_sync_seed');
            return k.loginKey;
        },
        // The account key and seed for a code or number, kept nowhere (a new code on the account page).
        keysOf: async (codeOrNumber) => (await load()).keys(codeOrNumber),
        newNumber: async () => (await load()).newNumber(),
        // A new account code, made here: the server never learns it.
        newCode: async () => (await load()).newCode(),
        // "code", "number" or "" (neither: a typo, or not finished).
        kind: async (input) => (await load()).kind(input),
        // How this browser signed in: "code", "number", or null (before codes existed: a number).
        accountKind: () => localStorage.getItem(KIND),
        setAccountKind: (k) => localStorage.setItem(KIND, k),
        // Signing out: the wallet comes back from the number next time.
        // The seed for another number, stored nowhere (chat sync moves to it when the number changes).
        seedOf: async (number) => (await (await load()).keys(number)).seed,
        forget() {
            localStorage.removeItem(SEED);
            localStorage.removeItem('obscurify_sync_seed'); // chat-sync.js
            localStorage.removeItem(KIND);

            localStorage.removeItem(STATE);
        },
    };
})();
