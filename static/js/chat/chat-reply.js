// chat-reply.js — Background replies. A signed-in chat request asks the server to finish the
// answer whatever happens to this page ("background": true): it keeps generating when the tab
// closes, the phone sleeps or the connection drops, and holds the answer in memory for up to an
// hour. Here: the stream is passed on one whole event at a time and counted, so a dropped or
// silent connection is picked up again from the next event (GET /web/replies/{id}?after=N); the
// reply in progress is remembered per chat, so a page opened again finishes it from the start
// (resumePendingReply); and Stop tells the server to stop, since leaving no longer does.

const PENDING_REPLIES_KEY = 'obscurify_pending_replies';
const REPLY_HEADER = 'x-obscurify-reply';
const REPLY_HELD_MS = 60 * 60 * 1000;
// The server sends a keepalive every 15 s; this long without a byte is a dead connection.
const REPLY_STALL_MS = 45 * 1000;
// Online, a reply the server can't hand back for this long is given up on (offline: no limit).
const REPLY_RECONNECT_MS = 60 * 1000;
const REPLY_EXPIRED_TEXT = 'This answer is no longer held (answers are kept for up to an hour). Send the message again.';

function pendingReplies() {
    try {
        const all = JSON.parse(localStorage.getItem(PENDING_REPLIES_KEY) || '{}');
        return all && typeof all === 'object' ? all : {};
    } catch (_) {
        return {};
    }
}

function savePendingReplies(all) {
    try {
        if (Object.keys(all).length) localStorage.setItem(PENDING_REPLIES_KEY, JSON.stringify(all));
        else localStorage.removeItem(PENDING_REPLIES_KEY);
    } catch (_) { /* storage full or off: the reply just isn't resumable */ }
}

function setPendingReply(convId, entry) {
    if (!convId || (typeof temporaryChat !== 'undefined' && temporaryChat)) return;
    const all = pendingReplies();
    all[convId] = entry;
    savePendingReplies(all);
}

function clearPendingReply(convId, replyId) {
    const all = pendingReplies();
    if (all[convId] && (!replyId || all[convId].replyId === replyId)) {
        delete all[convId];
        savePendingReplies(all);
    }
}

// The reply still running in chat `convId`, if one is (and could still be held).
function pendingReplyFor(convId) {
    const entry = pendingReplies()[convId];
    if (!entry) return null;
    if (!entry.at || Date.now() - entry.at > REPLY_HELD_MS) {
        clearPendingReply(convId);
        return null;
    }
    return entry;
}

async function cancelReply(replyId) {
    try {
        const headers = {};
        const token = await getCSRFToken();
        if (token) headers['X-CSRF-Token'] = token;
        await fetch(getConfig().api.baseUrl + '/web/replies/' + encodeURIComponent(replyId) + '/cancel', {
            method: 'POST', headers, credentials: 'same-origin', keepalive: true,
        });
    } catch (_) { /* it stops by itself within the hour */ }
}

function replySleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
    });
}

// Index just past the "\n\n" ending the first whole event in `buf`, or -1.
function sseFrameEnd(buf) {
    for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === 10 && buf[i + 1] === 10) return i + 2;
    }
    return -1;
}

function concatBytes(a, b) {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

const DONE_PREFIX = new TextEncoder().encode('data: [DONE]');
function isDoneFrame(frame) {
    if (frame.length < DONE_PREFIX.length) return false;
    for (let i = 0; i < DONE_PREFIX.length; i++) if (frame[i] !== DONE_PREFIX[i]) return false;
    return true;
}

// A stream of whole SSE events read from `first`, picked up again on the server when the
// connection drops. `capture.frames` gets every event's bytes as received (TEE verification);
// `transform` turns each event into what's passed on (Encrypted mode decrypts it here).
function replyStream(first, { replyId, signal, capture, transform, onFinish }) {
    let reader = first.body.getReader();
    let buf = new Uint8Array(0);
    let events = 0;
    let sawDone = false;
    let final = false;       // the server says the reply is over: its end is the end
    let lostSince = 0;

    const readChunk = () => {
        let timer;
        const stalled = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new TypeError('The connection went quiet.')), REPLY_STALL_MS);
        });
        return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
    };

    // Ask the server for the rest. Throws when that can't work (no id, stopped, expired, given up).
    const reconnect = async (err) => {
        if (!replyId || final || (signal && signal.aborted)) throw err;
        reader.cancel().catch(() => {});
        buf = new Uint8Array(0);  // a cut event comes again, whole
        lostSince = lostSince || Date.now();
        for (let attempt = 0; ; attempt++) {
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            if (!offline && Date.now() - lostSince > REPLY_RECONNECT_MS) throw err;
            await replySleep(Math.min(500 * 2 ** attempt, 8000), signal);
            let res;
            try {
                res = await fetch(getConfig().api.baseUrl + '/web/replies/' + encodeURIComponent(replyId) + '?after=' + events, {
                    credentials: 'same-origin', signal,
                });
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                continue;
            }
            if (res.status === 404) throw new Error(REPLY_EXPIRED_TEXT);
            if (!res.ok || !res.body) continue;
            final = res.headers.get('x-obscurify-reply-running') === 'false';
            reader = res.body.getReader();
            lostSince = 0;
            return;
        }
    };

    const body = new ReadableStream({
        async pull(controller) {
            for (;;) {
                let result;
                try {
                    result = await readChunk();
                } catch (err) {
                    if (err.name === 'AbortError') { controller.error(err); return; }
                    try { await reconnect(err); } catch (e) { controller.error(e); return; }
                    continue;
                }
                if (result.done) {
                    // Closed before the end of the answer (a proxy, a network change): ask for the rest.
                    if (!sawDone && replyId && !final) {
                        try { await reconnect(new TypeError('The connection closed early.')); continue; } catch (_) { /* fall through: what came is what there is */ }
                    }
                    if (buf.length) {
                        if (capture) capture.frames.push(buf);
                        try { controller.enqueue(transform ? transform(buf) : buf); } catch (e) { controller.error(e); return; }
                        buf = new Uint8Array(0);
                    }
                    controller.close();
                    if (onFinish) onFinish(sawDone);
                    return;
                }
                buf = concatBytes(buf, result.value);
                let sent = false;
                for (let end = sseFrameEnd(buf); end >= 0; end = sseFrameEnd(buf)) {
                    const frame = buf.slice(0, end);
                    buf = buf.slice(end);
                    if (frame[0] !== 58 /* ':' comment */) events++;
                    if (isDoneFrame(frame)) sawDone = true;
                    if (capture) capture.frames.push(frame);
                    try { controller.enqueue(transform ? transform(frame) : frame); } catch (e) { controller.error(e); return; }
                    sent = true;
                }
                if (sent) return;
            }
        },
        cancel() {
            reader.cancel().catch(() => {});
        },
    });
    const wrapped = new Response(body, { status: first.status, headers: first.headers });
    wrapped.replyId = replyId;
    wrapped.capture = capture;
    return wrapped;
}

// What checking a TEE reply needs. `encrypted`: an Encrypted-mode reply's session, attestation,
// nonce and plain request (sealChatRequest), checked against the same attestation it was sent to.
function teeCaptureFor(response, model, encrypted) {
    return {
        frames: [],
        model,
        receipt: response.headers.get('x-obscurify-tee-receipt'),
        route: response.headers.get('x-obscurify-tee-route'),
        encrypted: encrypted || null,
    };
}

// POST a streamed chat request (chat-thread.js) as a background reply when signed in.
// `meta.kind` ('chat' | 'code') makes it resumable after the page closes; `meta.verify` asks for
// a verifiable TEE reply; `meta.encrypted` sends it end-to-end encrypted instead (chat-tee.js:
// whole, never as a held thread, and decrypted here as it streams). Returns the response, its
// body as a stream of whole events; `.capture` holds what verification needs.
async function sendChatStream(endpoint, init, body, threadKey, meta) {
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    const out = Object.assign({}, body);
    if (loggedIn && body.stream) out.background = true;
    const encrypted = Boolean(loggedIn && meta && meta.encrypted);
    const verify = Boolean(loggedIn && meta && (meta.verify || encrypted));
    let sealed = null;
    let response;
    if (encrypted) {
        // Throws, before anything is sent, if the enclave's attestation doesn't verify.
        sealed = await sealChatRequest(out);
        response = await fetch(endpoint, Object.assign({}, init, {
            headers: Object.assign({}, init.headers, sealed.headers),
            body: sealed.body,
        }));
    } else {
        if (verify) out.tee_verify = true;
        response = await postChatThread(endpoint, init, out, threadKey);
    }
    if (!response.ok || !response.body) return response;
    const replyId = response.headers.get(REPLY_HEADER);
    const convId = typeof currentConversationId !== 'undefined' ? currentConversationId : null;
    const capture = verify ? teeCaptureFor(response, body.model, sealed && sealed.saved) : null;
    if (replyId) {
        if (meta && meta.kind && convId) {
            setPendingReply(convId, { replyId, kind: meta.kind, model: body.model, verify, encrypted: sealed ? sealed.saved : undefined, at: Date.now() });
        }
        if (init.signal) {
            init.signal.addEventListener('abort', () => {
                cancelReply(replyId);
                if (convId) clearPendingReply(convId, replyId);
            }, { once: true });
        }
    }
    return replyStream(response, {
        replyId,
        signal: init.signal,
        capture,
        transform: sealed ? sealed.decrypt : null,
        onFinish: () => { if (convId && replyId) clearPendingReply(convId, replyId); },
    });
}

// The whole of a held reply, from its first event, as sendChatStream would return it.
// A response that isn't ok (404: no longer held) is returned as it is.
async function followReply(pending, signal) {
    const res = await fetch(getConfig().api.baseUrl + '/web/replies/' + encodeURIComponent(pending.replyId) + '?after=0', {
        credentials: 'same-origin', signal,
    });
    if (!res.ok || !res.body) return res;
    const capture = pending.verify ? teeCaptureFor(res, pending.model, pending.encrypted) : null;
    // An encrypted reply is read with the key this browser kept for it.
    const transform = pending.encrypted ? await encryptedReader(pending.encrypted) : null;
    if (signal) {
        signal.addEventListener('abort', () => {
            cancelReply(pending.replyId);
            clearPendingReply(pending.convId, pending.replyId);
        }, { once: true });
    }
    return replyStream(res, {
        replyId: pending.replyId,
        signal,
        capture,
        transform,
        onFinish: () => clearPendingReply(pending.convId, pending.replyId),
    });
}

// ---- picking a reply up again after the page closed --------------------------------------

// Set while a Code Mode step is being taken from a held reply instead of asked for again.
let codeStepResume = null;

async function waitFor(test, ms) {
    const deadline = Date.now() + ms;
    while (!test() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return test();
}

// The open chat had an answer running when the page last closed: finish it.
async function resumePendingReply() {
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    if (!loggedIn || isGeneratingResponse || !currentConversationId) return;
    const convId = currentConversationId;
    const pending = pendingReplyFor(convId);
    if (!pending) return;
    pending.convId = convId;
    const last = messages[messages.length - 1];
    // The models list decides what can be chosen; Code Mode needs its settings too.
    await waitFor(() => typeof _allModels !== 'undefined' && _allModels.length > 0, 10000);
    if (currentConversationId !== convId || isGeneratingResponse) return;
    if (modelSelect.querySelector(`option[value="${CSS.escape(pending.model)}"]:not(:disabled)`)) {
        modelSelect.value = pending.model;
        modelSelect.dispatchEvent(new Event('change'));
    }
    if (pending.kind === 'code') {
        await waitFor(() => typeof codeServer !== 'undefined' && codeServer, 10000);
        if (currentConversationId !== convId || isGeneratingResponse) return;
        const responseElement = last && last.role === 'assistant' && last.interrupted
            ? lastAssistantElement()
            : null;
        if (!responseElement || !codeModeActive()) {
            clearPendingReply(convId, pending.replyId);
            return;
        }
        codeStepResume = pending;
        await continueCodeTurn(responseElement);
        codeStepResume = null;
        return;
    }
    if (pending.kind === 'chat' && last && last.role === 'user') {
        await resumeChatReply(pending);
        return;
    }
    clearPendingReply(convId, pending.replyId);
}

function lastAssistantElement() {
    const bubbles = document.querySelectorAll('#response-list .message');
    const bubble = bubbles[bubbles.length - 1];
    if (!bubble || !bubble.classList.contains('assistant-message')) return null;
    return bubble.querySelector('.prompt-content');
}

window.addEventListener('online', () => {
    if (typeof resumePendingReply === 'function') resumePendingReply();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && typeof resumePendingReply === 'function') resumePendingReply();
});
