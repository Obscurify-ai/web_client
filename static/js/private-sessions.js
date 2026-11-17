// Private sessions (Unlinkable inference) in the web chat, the default once signed in
// with an account number on this device. The work is done by the open-source
// package unlinkable-inference (github.com/Obscurify-ai/unlinkable-inference), vendored
// in /static/vendor/unlinkable-inference by scripts/vendor-unlinkable-inference.sh: chat requests
// go out with the conversation's session secret and no cookie, and the wallet
// comes back from the number when the browser forgets it.
//
// Kept here: the seed (`obscurify_private_seed`; it cannot sign in) and the
// package's state (`obscurify_private_state`).
(function () {
    'use strict';
    const SEED = 'obscurify_private_seed';
    const STATE = 'obscurify_private_state';
    const OFF = 'obscurify_private_off'; // "1": the person switched it off
    const PKG = '/static/vendor/unlinkable-inference/index.js?v=8';

    let lib = null;
    let ready = null;

    async function load() {
        if (!lib) {
            lib = await import(PKG);
            await lib.load('/static/vendor/unlinkable-inference/unlinkable_inference_wasm_bg.wasm?v=7');
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
                if (!on()) return null;
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
            return u.fetch(url, Object.assign({}, init, { headers }), { chat, reply: m ? decodeURIComponent(m[1]) : undefined });
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

        // Sign-in and sign-up: the number never leaves this device. Returns
        // the login key to send, and keeps the seed for the wallet.
        async keys(number) {
            const k = await (await load()).keys(number);
            localStorage.setItem(SEED, k.seed);
            return k.loginKey;
        },
        newNumber: async () => (await load()).newNumber(),
        // Signing out: the wallet comes back from the number next time.
        forget() {
            localStorage.removeItem(SEED);
            localStorage.removeItem(STATE);
        },
    };
})();
