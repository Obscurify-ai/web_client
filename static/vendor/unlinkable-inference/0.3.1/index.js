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

// How many times a request's session is topped up (each time by more: 10¢, 20¢ ... $3.20) and the
// request sent again. With the 10¢ it opens with, up to $6.40: a pricey model's reply ($1 held) to
// a prompt that fills its context. The money comes from the wallet: keep it full enough.
const TOP_UPS = 6;

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
 * closes quiet conversations' sessions every `tickMs`, and asks the account for what the wallet
 * lacks at random times. Never because a conversation needs it: a withdrawal a second before a
 * session opens or tops up ties the two together by timing. A request the wallet can't pay
 * waits ("the private wallet is refilling", `onWait`) until a random while after the next
 * contact, then goes.
 *
 *   seed         hex, from keys()
 *   apiKey       the account's API key (or an async function for it), used only
 *                to top the wallet up; without it the wallet spends what it holds
 *   server       the API's origin (default: this page's)
 *   storage      where the wallet is kept (default localStorage), under `name`
 *   replyHeader  a response header naming a reply the server holds for later
 *   hasFunds     unused since 0.3 (asking the account after a request ran out would tie the
 *                two together); call `moneyAdded()` when money is added in the app instead
 */
export async function connect({ seed, apiKey, server = location.origin, storage = localStorage, name = 'unlinkable-inference', replyHeader, hasFunds, tickMs = 30000 }) {
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
    // m.refilling(), waiting out a call that holds the wallet (it says undefined then).
    const refilling = async () => {
        let at;
        while ((at = m.refilling()) === undefined) await new Promise((r) => setTimeout(r, 50));
        return at;
    };
    await run(m.start());
    const timer = setInterval(() => run(m.tick()).catch(() => {}), tickMs);

    return {
        /** fetch() for conversation `chat` (or held reply `reply`), with its
         *  session secret and no cookie. Tops the session up when it runs out, and
         *  presents a pass when the server asks for one. */
        async fetch(url, init = {}, { chat = 'default', reply, onWait } = {}) {
            const held = reply ? await m.reply(reply) : null;
            // The wallet is refilling for this conversation: hold the request (onWait(at) says so,
            // onWait(null) when it goes on) and keep the clock running until it may go. False:
            // nothing to wait for (the account has nothing to give).
            // A request cancelled meanwhile (init.signal) is never sent.
            const hold = async () => {
                let at = await refilling();
                if (at === null) return false;
                let told = null;
                try {
                    while (at !== null) {
                        if (init.signal?.aborted) throw new DOMException('The request was cancelled while it waited', 'AbortError');
                        if (onWait && at !== told) onWait((told = at));
                        await new Promise((r) => setTimeout(r, 2000));
                        await run(m.tick()).catch(() => {});
                        at = await refilling();
                    }
                } finally {
                    if (onWait && told !== null) onWait(null);
                }
                return true;
            };
            const open = async () => {
                for (;;) {
                    try {
                        return await run(m.session(chat));
                    } catch (e) {
                        if (!(await hold())) throw e;
                    }
                }
            };
            let secret = held || (await open());
            let passes = 0;
            let rest = false; // nothing more to add: spend what the session has
            const none = new Set();
            for (let attempt = 0; ; attempt++) {
                const headers = new Headers(init.headers || {});
                headers.set('Authorization', 'Bearer ' + secret);
                if (rest) headers.set('X-Session-Rest', '1');
                const res = await fetch(url, { ...init, headers, credentials: 'omit' });
                if (attempt < TOP_UPS && !held && !rest && res.status === 402) {
                    const add = () => run(m.ranOut(secret, attempt)).then(() => true, () => false);
                    let added = await add();
                    while (!added && (await hold())) added = await add();
                    rest = !added;
                    continue;
                }
                // The server wants a pass for this request (it names the label): present one
                // from the wallet and send the request again. With none to present, send it
                // once more as it was (a server may serve it another way, at another price).
                const label = res.status === 403 && !held && passes < 8 && (await passRequired(res));
                const shown = async () => {
                    for (;;) {
                        try {
                            return await run(m.needsPass(secret, label));
                        } catch (e) {
                            if (!(await hold())) return false;
                        }
                    }
                };
                if (label && (await shown())) {
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
                    secret = await open();
                    continue;
                }
                const id = replyHeader && res.headers.get(replyHeader);
                if (id) await run(m.noteReply(id, secret));
                return res;
            }
        },
        /** Money was added to the account, or its plan changed, in this app (a moment of the
         *  account's own): ask it now. */
        moneyAdded: () => run(m.moneyAdded()),
        /** null, or the Unix time a waiting conversation may go on about. */
        refilling,
        /** What the account said when it last refused to fill the wallet (a plan's limit used
         *  up, and when it starts over), or null: for wording a refusal without asking it. */
        accountNote: () => m.accountNote() ?? null,
        /** `{ paid_cents, passes }`, or null while busy. */
        summary: () => m.summary(),
        /** A reply in conversation `chat` said it cost `usd`: the balance shown while its
         *  session is open takes it off. Closing the session says exactly. */
        noteCost: (usd, { chat = 'default' } = {}) => run(m.noteCost(chat, usd)),
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
 * their replies said, `noteCost`) and `prepaid_millicents` the money still here
 * (the wallet plus what open sessions hold). From what this device keeps: no
 * request names a session. Opens, closes and saves nothing, so it is safe next
 * to a running `connect` in another tab.
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
