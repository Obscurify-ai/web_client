// unlinkable-inference: Unlinkable inference in a web page.
//
// The page's chat requests go out with a session secret paid from a wallet of
// blind vouchers, and with no cookie, so the server cannot tell which account
// a conversation belongs to, or which conversations go together. Everything
// comes from the account number, so when the browser forgets (Tor Browser
// closing), the next sign-in brings the wallet back. Nothing is lost.
//
//   import * as sessions from 'unlinkable-inference';
//   const { loginKey, seed } = await sessions.keys(number); // send loginKey to sign in
//   const u = await sessions.connect({ seed, apiKey });
//   const res = await u.fetch('/v1/chat/completions', { method: 'POST', body }, { chat: conversationId });
import init, { accountKeys, newAccountNumber, newAccountCode, credentialKind, Manager } from './unlinkable_inference_wasm.js';

let loaded;

/** Load the WebAssembly module (once). Pass `wasmUrl` if it is not next to this file. */
export function load(wasmUrl) {
    loaded ||= init(wasmUrl ? { module_or_path: wasmUrl } : undefined);
    return loaded;
}

/** `{ loginKey, seed }` for an account code or a 16-digit account number. Send
 *  `loginKey` to sign in instead of it; keep `seed` (hex) for `connect`. Slow on purpose (~1 s). */
export async function keys(number) {
    await load();
    const k = accountKeys(number);
    return { loginKey: k.login_key, seed: k.seed };
}

/** A new random account number, made here: the server never learns it. */
export async function newNumber() {
    await load();
    return newAccountNumber();
}

/** A new account code (20 characters, 96 random bits), made here: the server never learns it. */
export async function newCode() {
    await load();
    return newAccountCode();
}

/** "code", "number" or "" for what was typed. */
export async function kind(input) {
    await load();
    return credentialKind(input);
}

/**
 * Start private sessions. Closes sessions left from last time, brings back
 * whatever a lost browser left behind, tops the wallet up, and from then on
 * closes quiet conversations' sessions and tops up every `tickMs`.
 *
 *   seed         hex, from keys()
 *   apiKey       the account's API key (or an async function for it), used only
 *                to top the wallet up; without it the wallet spends what it holds
 *   server       the API's origin (default: this page's)
 *   storage      where the wallet is kept (default localStorage), under `name`
 *   replyHeader  a response header naming a reply the server holds for later
 */
export async function connect({ seed, apiKey, server = location.origin, storage = localStorage, name = 'unlinkable-inference', replyHeader, tickMs = 30000 }) {
    await load();
    const key = typeof apiKey === 'function' ? await apiKey() : apiKey;
    const m = await Manager.connect(server, seed, storage.getItem(name), key ?? null);
    const save = () => {
        const s = m.state();
        if (s) storage.setItem(name, s);
    };
    const run = async (p) => {
        try { return await p; } finally { save(); }
    };
    await run(m.start());
    const timer = setInterval(() => run(m.tick()).catch(() => {}), tickMs);

    return {
        /** fetch() for conversation `chat` (or held reply `reply`), with its
         *  session secret and no cookie. Tops the session up when it runs out, and
         *  presents a pass when the server asks for one. */
        async fetch(url, init = {}, { chat = 'default', reply } = {}) {
            const held = reply ? await m.reply(reply) : null;
            let secret = held || (await run(m.session(chat)));
            let passes = 0;
            const none = new Set();
            for (let attempt = 0; ; attempt++) {
                const headers = new Headers(init.headers || {});
                headers.set('Authorization', 'Bearer ' + secret);
                const res = await fetch(url, { ...init, headers, credentials: 'omit' });
                if (attempt < 4 && !held && res.status === 402) {
                    await run(m.ranOut(secret, attempt)).catch(() => {});
                    continue;
                }
                // The server wants a pass for this request (it names the label): present one
                // from the wallet and send the request again. With none to present, send it
                // once more as it was (a server may serve it another way, at another price).
                const label = res.status === 403 && !held && passes < 8 && (await passRequired(res));
                if (label && (await run(m.needsPass(secret, label)).catch(() => false))) {
                    passes++;
                    attempt--;
                    continue;
                }
                if (label && !none.has(label)) {
                    none.add(label);
                    attempt--;
                    continue;
                }
                if (attempt < 4 && !held && res.status === 401) {
                    await m.expired(secret);
                    secret = await run(m.session(chat));
                    continue;
                }
                const id = replyHeader && res.headers.get(replyHeader);
                if (id) await run(m.noteReply(id, secret));
                return res;
            }
        },
        /** `{ paid_cents, passes }`, or null while busy. */
        summary: () => m.summary(),
        /** What private use cost: see `spending()` below. */
        spending: () => m.spending(),
        stop: () => clearInterval(timer),
    };
}

/** The label of the pass a 403 asks for: the `x-pass-required` header, or (where another
 *  origin's headers are hidden) `error.pass` of a `pass_required` JSON error. */
async function passRequired(res) {
    const label = res.headers.get('x-pass-required');
    if (label) return label;
    if (!(res.headers.get('content-type') || '').includes('json')) return null;
    const error = (await res.clone().json().catch(() => null))?.error;
    return error?.type === 'pass_required' && typeof error.pass === 'string' ? error.pass : null;
}

/**
 * What private use cost on this device, for an account page's history:
 * `{ spent: [{ at, millicents }], prepaid_millicents }`, `spent` oldest first
 * (`at` Unix seconds, 100000 millicents = $1; sessions still open count what
 * they have used so far) and `prepaid_millicents` the money still here (the
 * wallet plus what open sessions hold). Read-only: opens, closes and saves
 * nothing, so it is safe next to a running `connect` in another tab.
 */
export async function spending({ seed, server = location.origin, storage = localStorage, name = 'unlinkable-inference' }) {
    await load();
    const state = storage.getItem(name);
    if (!state) return { spent: [], prepaid_millicents: 0 };
    const m = await Manager.connect(server, seed, state, null);
    return m.spending();
}

/** Signing out: drop the saved wallet (it comes back from the number). */
export function forget({ storage = localStorage, name = 'unlinkable-inference' } = {}) {
    storage.removeItem(name);
}
