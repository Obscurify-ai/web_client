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
    const LIB_VERSION = '0.3.1';
    const LIB = '/static/vendor/unlinkable-inference/' + LIB_VERSION + '/';
    const PKG = LIB + 'index.js';

    let lib = null;
    let ready = null;
    let startFailed = '';

    async function load() {
        if (!lib) {
            lib = await import(PKG);
            await lib.load(LIB + 'unlinkable_inference_wasm_bg.wasm');
        }
        return lib;
    }

    // A chat that can't go privately is not sent at all: never through the account instead.
    const refuse = (status, text) => new Response(JSON.stringify({ error: text }), { status, headers: { 'Content-Type': 'application/json' } });

    // Nothing here asks the account because a chat needs something: a request with the
    // account's cookie or key a second before or after a private session's ties the two
    // together by timing. The package asks the account at random times; a chat the wallet can't
    // pay waits for it (onWait, below), and what it says when refused comes from this device.

    // "Your private wallet is refilling": shown above the composer while a message waits.
    function waiting(at) {
        let el = document.getElementById('private-wait');
        if (at === null) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = 'private-wait';
            el.className = 'private-wait';
            el.setAttribute('role', 'status');
            document.body.appendChild(el);
        }
        const minutes = Math.max(1, Math.ceil((at * 1000 - Date.now()) / 60000));
        el.textContent = 'Your private wallet is refilling. Your message will be sent in about ' +
            (minutes === 1 ? 'a minute' : minutes + ' minutes') + '.';
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
                console.warn('private sessions: could not start', e);
                ready = null; // tried again with the next message
                startFailed = String((e && e.message) || e);
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
            if (!u) {
                return / \(401\)/.test(startFailed)
                    ? refuse(401, 'Your sign-in has ended. Sign in again.')
                    : refuse(503, 'A private session could not be started, so nothing was sent. Check your connection and try again.');
            }
            // The CSRF token belongs to the cookie session: it must not go with a private request.
            const headers = new Headers((init && init.headers) || {});
            headers.delete('X-CSRF-Token');
            const m = String(url).match(/\/web\/replies\/([^/?]+)/);
            const chat = (typeof currentConversationId !== 'undefined' && currentConversationId) || 'default';
            let res;
            try {
                res = await u.fetch(url, Object.assign({}, init, { headers }), { chat, reply: m ? decodeURIComponent(m[1]) : undefined, onWait: waiting });
            } catch (e) {
                // No session could be opened: no money, and no free-model pass left.
                if (m || !/no paid vouchers|withdraw/i.test(String(e && (e.message || e)))) throw e;
            }
            if (res && (res.status !== 402 || m)) return res;
            // Refused for want of money with nothing to wait for: the account had nothing to give
            // when last asked, so what is left is what this device holds. What the account said
            // then (a plan's weekly or 5-hour usage used up, and when it starts over) says why.
            const note = u.accountNote();
            const noteText = note && /usage is used up/.test(note) ? note : null;
            if (!res) return refuse(402, noteText || 'Your balance and this month\'s free usage are used up, so nothing was sent. Add funds to keep chatting.');
            const held = await u.spending().then((s) => s.prepaid_millicents / 100000, () => 0);
            const cents = Math.floor(held * 100);
            return refuse(402, cents < 1
                ? noteText || 'Your balance is used up, so nothing was sent. Add funds, or pick a free model.'
                : 'This needs more than the ' + (cents < 100 ? cents + '¢' : '$' + (cents / 100).toFixed(2)) + ' you have left, so nothing was sent. Pick a cheaper model, or add funds.');
        },
        start,
        on,
        // Signed in on this device without the account number (before private
        // sessions, or another way): the wallet needs it once (private-setup.js).
        needsNumber: () => !localStorage.getItem(SEED),
        setOn(v) { if (v) localStorage.removeItem(OFF); else localStorage.setItem(OFF, '1'); },
        async summary() { const u = await start(); return u ? u.summary() : null; },
        // Money was added, or the plan changed, in this page (a moment of the account's own):
        // the wallet asks the account now.
        async moneyAdded() {
            if (!on() || !ready) return;
            const u = await ready;
            if (u) await u.moneyAdded().catch(() => {});
        },
        // A reply in the current chat said it cost `usd`: the balance takes it off at once.
        async noteCost(usd) {
            if (!(usd > 0) || !on() || !ready) return;
            const u = await ready;
            const chat = (typeof currentConversationId !== 'undefined' && currentConversationId) || 'default';
            if (u) await u.noteCost(usd, { chat });
        },
        // What the wallet on this device holds and has spent, from what it keeps (no request
        // names a session): { spent: [{ at, millicents }], prepaid_millicents }, or null when
        // this device has no wallet. Read-only; starts nothing.
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
        // Whether this page can run WebAssembly, which makes the account code and its key. Tor Browser
        // blocks it at Safer and Safest (through NoScript since 15.0, so the object can exist and
        // still refuse to compile); the sign-up and sign-in pages then post their plain forms.
        wasmWorks() {
            try {
                return typeof WebAssembly === 'object'
                    && new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) instanceof WebAssembly.Module;
            } catch (_) { return false; }
        },
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
