// chat-tee.js — Encrypted: end-to-end encrypted chat with TEE models, checked in this browser.
// With Encrypted on, the picker offers only models that take encrypted requests (`e2ee` in
// /v1/models), tools, web search and compaction are off, and every request is sealed here
// (sealChatRequest): the TEE gateway's attestation is fetched with a fresh nonce and checked
// first, then every message is encrypted to the key that attestation vouches for. The server
// passes it to the enclave unread; each piece of the answer comes back encrypted to this
// browser's key and is decrypted as it streams (chat-reply.js). Each answer then gets a chip:
// Checking…, then Encrypted (every check passed) or Check failed, from the receipt checks: the bytes received
// match the signed receipt, the enclave received exactly the conversation we encrypted, the
// receipt key is bound to the Intel TDX quote that answered our nonce, the quote is genuine, the
// gateway's measured code is an approved release, and the gateway checked the model host. All of
// it runs in the open-source verifier (static/vendor/tee-verify, built from obscurify-tee-verify).
// Loads after chat-privacy.js and chat-code.js.

const ENCRYPTED_KEY = 'obscurify_encrypted';
// Before Encrypted mode this was Verify (signed receipts, text in the clear to our server).
const LEGACY_VERIFY_KEY = 'obscurify_tee_verify';
const E2EE_ROUTE = 'e2ee';
const ENCRYPTED_DEFAULTS = ['tee/glm-5.3', 'tee/glm-5.3-flash'];
const TEE_VERIFIER_URL = '/static/vendor/tee-verify/tee_verify.js?v=2';
const TEE_RECEIPT_WAIT_MS = 20 * 1000;
// Evidence for "Download evidence", by receipt id, for as long as this page is open.
const teeEvidence = new Map();
let teeVerifierPromise = null;

try {
    const legacy = localStorage.getItem(LEGACY_VERIFY_KEY);
    if (legacy !== null) {
        if (legacy === 'true') localStorage.setItem(ENCRYPTED_KEY, 'true');
        localStorage.removeItem(LEGACY_VERIFY_KEY);
    }
} catch (_) { /* storage off */ }

function encryptedOn() {
    return localStorage.getItem(ENCRYPTED_KEY) === 'true';
}

// Encrypted applies to signed-in cloud chats only.
function encryptedActive() {
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    const local = typeof isLocalMode !== 'undefined' && isLocalMode;
    return encryptedOn() && loggedIn && !local;
}

function loadTeeVerifier() {
    if (!teeVerifierPromise) {
        teeVerifierPromise = import(TEE_VERIFIER_URL).then(async (mod) => {
            await mod.default({ module_or_path: '/static/vendor/tee-verify/tee_verify_bg.wasm?v=2' });
            return mod;
        });
        teeVerifierPromise.catch(() => { teeVerifierPromise = null; });
    }
    return teeVerifierPromise;
}

function teeConcat(frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const f of frames) { out.set(f, at); at += f.length; }
    return out;
}

function teeBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

async function teeGet(path, route, signalMs) {
    const headers = {};
    if (route) headers['X-Obscurify-TEE-Route'] = route;
    return fetch(getConfig().api.baseUrl + path, { credentials: 'same-origin', headers, signal: AbortSignal.timeout(signalMs) });
}

function teeError(err) {
    return err && err.message ? err.message : String(err);
}

// ---- sealing a request ------------------------------------------------------------------

// A model's request for reasoning, as our server would add it on a plain request: the gateway
// gets an encrypted request exactly as sent, so it goes in here.
function encryptedReasoning(request) {
    if ('reasoning_effort' in request || 'reasoning' in request) return;
    const id = request.model || '';
    if (id.endsWith(':thinking')) request.reasoning_effort = 'medium';
    else if (_allModels.some((m) => m.id === id + ':thinking')) request.reasoning_effort = 'none';
}

// The body and headers for an encrypted request (chat-reply.js sendChatStream): the gateway's
// attestation checked with a fresh nonce, then every message encrypted to the key it vouches
// for. Throws, with nothing sent, when that can't be done. `saved` is what reading and checking
// the answer later needs (kept with a pending reply, so a reopened page can still read it).
async function sealChatRequest(body) {
    const verifier = await loadTeeVerifier();
    const nonce = verifier.newNonce();
    const res = await teeGet('/web/tee/attestation?model=' + encodeURIComponent(body.model) + '&nonce=' + nonce, E2EE_ROUTE, 120000);
    if (!res.ok) throw new Error('Not encrypted: couldn’t get the enclave’s attestation (' + res.status + '), so nothing was sent.');
    const attestation = await res.text();
    const attested = await verifier.verifyAttestation(attestation, nonce, location.origin + '/tee/pccs');
    if (!attested.verified || !attested.e2ee_public_key) {
        const bad = (attested.checks || []).find((c) => c.status === 'fail');
        throw new Error('Not encrypted: the enclave’s attestation didn’t verify' + (bad ? ' (failed: ' + bad.label + ')' : '') + ', so nothing was sent.');
    }
    const request = {};
    for (const [k, v] of Object.entries(body)) {
        if (!['web_search', 'thread', 'tee_verify', 'tools', 'tool_choice'].includes(k)) request[k] = v;
    }
    request.stream = true;
    request.stream_options = { include_usage: true };
    encryptedReasoning(request);
    const session = new verifier.E2eeSession();
    let sealed;
    try {
        sealed = session.encryptRequest(attested.e2ee_public_key, JSON.stringify(request));
    } catch (err) {
        throw new Error('Not encrypted: ' + teeError(err) + '. Nothing was sent.');
    }
    const saved = { secret: session.secret(), attestation, nonce, plain: sealed.plain };
    return {
        body: sealed.body,
        headers: {
            'X-Client-Pub-Key': session.publicKey(),
            'X-Model-Pub-Key': attested.e2ee_public_key,
            'X-Signing-Algo': 'ecdsa',
        },
        saved,
        decrypt: eventDecrypter(session),
    };
}

function eventDecrypter(session) {
    return (frame) => {
        try {
            return session.decryptEvent(frame);
        } catch (err) {
            throw new Error('Check failed: the answer couldn’t be decrypted (' + teeError(err) + '). Stopped reading it.');
        }
    };
}

// The decrypter for a reply picked up again (chat-reply.js followReply).
async function encryptedReader(saved) {
    const verifier = await loadTeeVerifier();
    return eventDecrypter(verifier.E2eeSession.fromSecret(saved.secret));
}

// The result of one reply's check: never throws. `checks` are the verifier's, in its order.
// An encrypted reply is checked against the attestation it was encrypted to, and against the
// plain request (the enclave must have received exactly that).
async function verifyTeeCapture(capture) {
    const encrypted = capture.encrypted || null;
    const failed = (label) => ({ receipt: capture.receipt || '', model: capture.model, encrypted: Boolean(encrypted), verified: false, failed: label, checks: [] });
    if (!capture.receipt) return failed('No receipt came with this reply');
    const body = teeConcat(capture.frames);
    const model = encodeURIComponent(capture.model);
    try {
        const verifier = await loadTeeVerifier();
        // A stream's receipt is ready a few seconds after it ends.
        let receipt = null;
        const deadline = Date.now() + TEE_RECEIPT_WAIT_MS;
        for (;;) {
            const res = await teeGet('/web/tee/receipts/' + encodeURIComponent(capture.receipt) + '?model=' + model, capture.route, 30000);
            if (res.ok) { receipt = await res.text(); break; }
            if (res.status !== 404 || Date.now() > deadline) return failed('Couldn’t get the receipt (' + res.status + ')');
            await new Promise((r) => setTimeout(r, 2000));
        }
        let nonce;
        let attestation;
        if (encrypted) {
            ({ nonce, attestation } = encrypted);
        } else {
            nonce = verifier.newNonce();
            const att = await teeGet('/web/tee/attestation?model=' + model + '&nonce=' + nonce, capture.route, 120000);
            if (!att.ok) return failed('Couldn’t get the attestation (' + att.status + ')');
            attestation = await att.text();
        }
        const request = encrypted ? new TextEncoder().encode(encrypted.plain) : undefined;
        const report = await verifier.verifyTeeReply(body, receipt, attestation, nonce, location.origin + '/tee/pccs', undefined, request);
        // The download holds what the server saw (ciphertext), never the plain request.
        teeEvidence.set(capture.receipt, {
            model: capture.model, receipt_id: capture.receipt, nonce, encrypted: Boolean(encrypted),
            body_base64: teeBase64(body), receipt: JSON.parse(receipt), attestation: JSON.parse(attestation), report,
        });
        const checks = (report.checks || []).map((c) => ({ id: c.id, status: c.status, label: c.label, detail: c.detail }));
        const bad = checks.find((c) => c.status === 'fail');
        return {
            receipt: capture.receipt,
            model: capture.model,
            encrypted: Boolean(encrypted),
            verified: Boolean(report.verified),
            failed: bad ? bad.label : (report.verified ? '' : 'Not every check passed'),
            checks,
        };
    } catch (err) {
        return failed('Couldn’t run the check: ' + teeError(err));
    }
}

function teeStatus(steps, pending) {
    if (pending) return 'pending';
    return steps.length && steps.every((s) => s.verified) ? 'verified' : 'failed';
}

// Checks every capture of an answer (a Code Mode answer has one per model step), then marks the
// answer and saves the result with its chat. `earlier`: steps already checked before a Continue.
function verifyReplyInBackground(message, element, captures, earlier) {
    const convId = typeof currentConversationId !== 'undefined' ? currentConversationId : null;
    message.teeId = message.teeId || ('tee-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const steps = (earlier || []).slice();
    const encrypted = captures.some((c) => c && c.encrypted);
    message.tee = { status: 'pending', steps, encrypted };
    renderTeeChip(element, message.tee);
    const pending = captures.map((c) => (c && typeof c.then === 'function' ? c : verifyTeeCapture(c)));
    Promise.all(pending).then((results) => {
        message.tee = { status: teeStatus(steps.concat(results), false), steps: steps.concat(results), encrypted };
        renderTeeChip(element, message.tee);
        saveTeeResult(convId, message);
    });
}

// Into the stored chat, wherever it is now (the person may have switched chats meanwhile).
function saveTeeResult(convId, message) {
    if (!convId || (typeof temporaryChat !== 'undefined' && temporaryChat)) return;
    if (convId === currentConversationId && messages.includes(message)) {
        saveCurrentConversation();
        return;
    }
    const conversations = getConversations();
    const conv = conversations.find((c) => c.id === convId);
    const stored = conv && conv.messages.find((m) => m.teeId === message.teeId);
    if (!stored) return;
    stored.tee = message.tee;
    saveConversations(conversations);
}

// An encrypted answer that passed every check is just "Encrypted"; one that didn't never says
// so. Answers from the old Verify mode (not encrypted) keep their own words.
function teeChipText(tee) {
    if (tee.encrypted) return tee.status === 'pending' ? 'Checking…' : tee.status === 'verified' ? 'Encrypted' : 'Check failed';
    return tee.status === 'pending' ? 'Verifying…' : tee.status === 'verified' ? 'Verified' : 'Not verified';
}

// The chip under an answer, and the list of checks it opens.
function renderTeeChip(element, tee) {
    const bubble = element && (element.closest('.message') || element);
    if (!bubble || !tee) return;
    let row = bubble.querySelector(':scope > .tee-row');
    if (!row) {
        row = document.createElement('div');
        row.className = 'tee-row';
        bubble.appendChild(row);
    }
    const open = row.querySelector('.tee-checks:not([hidden])') !== null;
    row.replaceChildren();
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tee-chip tee-chip-' + tee.status;
    chip.textContent = teeChipText(tee);
    chip.setAttribute('aria-expanded', String(open));
    row.appendChild(chip);
    if (tee.status === 'pending') {
        chip.disabled = true;
        return;
    }
    const steps = tee.steps || [];
    const worst = steps.find((s) => !s.verified) || steps[steps.length - 1];
    if (tee.status === 'failed' && worst && worst.failed) {
        const why = document.createElement('span');
        why.className = 'tee-why';
        why.textContent = (worst.checks && worst.checks.length ? 'Failed: ' : '') + worst.failed;
        row.appendChild(why);
    }
    const panel = document.createElement('div');
    panel.className = 'tee-checks';
    panel.hidden = !open;
    if (steps.length > 1) {
        const count = document.createElement('p');
        count.className = 'tee-count';
        count.textContent = steps.filter((s) => s.verified).length + ' of ' + steps.length + ' requests verified';
        panel.appendChild(count);
    }
    if (worst) {
        const list = document.createElement('ul');
        for (const check of worst.checks || []) {
            const item = document.createElement('li');
            item.className = 'tee-check tee-check-' + check.status;
            item.dataset.check = check.id;
            item.title = check.detail || '';
            const mark = document.createElement('span');
            mark.className = 'tee-mark';
            mark.textContent = check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '–';
            item.append(mark, document.createTextNode(check.label));
            list.appendChild(item);
        }
        panel.appendChild(list);
        const receipt = document.createElement('p');
        receipt.className = 'tee-receipt';
        receipt.textContent = worst.receipt ? 'Receipt ' + worst.receipt : '';
        panel.appendChild(receipt);
        const evidence = steps.map((s) => teeEvidence.get(s.receipt)).filter(Boolean);
        if (evidence.length) {
            const download = document.createElement('button');
            download.type = 'button';
            download.className = 'tee-download';
            download.textContent = 'Download evidence';
            download.addEventListener('click', () => {
                const blob = new Blob([JSON.stringify(evidence.length === 1 ? evidence[0] : evidence, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'obscurify-tee-' + (worst.receipt || 'evidence') + '.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            });
            panel.appendChild(download);
        }
    }
    row.appendChild(panel);
    chip.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        chip.setAttribute('aria-expanded', String(!panel.hidden));
    });
}

// ---- the Encrypted control --------------------------------------------------------------

// With Encrypted on the picker lists only models that take encrypted requests.
const filterModelsForPickerBeforeTee = filterModelsForPicker;
filterModelsForPicker = function (models, options) {
    const list = filterModelsForPickerBeforeTee(models, options);
    return encryptedActive() ? list.filter((m) => m.e2ee) : list;
};

function currentModelEncryptable() {
    const info = _allModels.find((m) => m.id === modelSelect.value);
    return Boolean(info && info.e2ee);
}

// A model that takes encrypted requests, for when Encrypted comes on with another selected.
function pickEncryptedModel() {
    if (!_allModels.length || currentModelEncryptable()) return;
    const usable = (m) => m.e2ee && isModelAvailable(m)
        && modelSelect.querySelector(`option[value="${CSS.escape(m.id)}"]:not(:disabled)`);
    // A strong, inexpensive one first, rather than whichever the catalogue lists first.
    const choice = ENCRYPTED_DEFAULTS.map((id) => _allModels.find((m) => m.id === id)).find((m) => m && usable(m))
        || _allModels.find(usable);
    if (choice) {
        modelSelect.value = choice.id;
        modelSelect.dispatchEvent(new Event('change'));
    }
}

// Tools, web search and Code Mode need to read the text: none of them in an encrypted chat.
const currentModelSupportsToolsBeforeTee = currentModelSupportsTools;
currentModelSupportsTools = function () {
    return !encryptedActive() && currentModelSupportsToolsBeforeTee();
};
const updateToolsStatusBeforeTee = updateToolsStatus;
updateToolsStatus = function () {
    updateToolsStatusBeforeTee();
    if (!encryptedActive()) return;
    document.querySelectorAll('[data-tools-switch], [data-code-switch]').forEach((toggle) => {
        toggle.title = 'Encrypted chats can’t use tools';
    });
};
// Nor summarizing a long chat: the server would have to read it.
const compactIfNeededBeforeTee = compactIfNeeded;
compactIfNeeded = async function (...args) {
    if (encryptedActive()) return;
    return compactIfNeededBeforeTee.apply(this, args);
};

function setEncrypted(on) {
    if (on) localStorage.setItem(ENCRYPTED_KEY, 'true');
    else localStorage.removeItem(ENCRYPTED_KEY);
    syncEncryptedButton();
    if (on) {
        pickEncryptedModel();
        loadTeeVerifier().catch(() => {});
    }
    if (typeof renderModelPicker === 'function') renderModelPicker();
    updateModelDisplayName();
    updateToolsStatus();
}

function syncEncryptedButton() {
    const btn = document.getElementById('encrypted-btn');
    if (!btn) return;
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    btn.setAttribute('aria-pressed', String(encryptedOn() && loggedIn));
    btn.disabled = !loggedIn;
    btn.title = loggedIn ? 'Encrypted: end-to-end encrypted chat with TEE models (no tools)' : 'Sign in for encrypted chat';
}

// The catalogue can load more than once, choosing its default model each time.
const fetchAndPopulateModelsBeforeTee = fetchAndPopulateModels;
fetchAndPopulateModels = async function (...args) {
    const result = await fetchAndPopulateModelsBeforeTee.apply(this, args);
    if (encryptedActive()) {
        pickEncryptedModel();
        updateModelDisplayName();
    }
    return result;
};

// "Chatting anonymously with X" becomes "Encrypted chat with X".
const updateModelDisplayNameBeforeTee = updateModelDisplayName;
updateModelDisplayName = function () {
    updateModelDisplayNameBeforeTee();
    if (!encryptedActive()) return;
    for (const id of ['prompt-input', 'chat-prompt-input']) {
        const input = document.getElementById(id);
        const text = input && input.getAttribute('data-placeholder');
        if (text) input.setAttribute('data-placeholder', text.replace(/^Chatting anonymously/, 'Encrypted chat'));
    }
};

// A saved chat's chips, drawn again when it's opened.
function renderSavedTeeChips() {
    const bubbles = document.querySelectorAll('#response-list .message.assistant-message');
    const assistants = messages.filter((m) => m.role === 'assistant');
    assistants.forEach((m, i) => {
        if (!m.tee || !bubbles[i]) return;
        // A check that never finished (the page closed) can't be finished now.
        if (m.tee.status === 'pending' || m.tee.status === 'partial') {
            m.tee = { status: m.tee.steps && m.tee.steps.length ? teeStatus(m.tee.steps, false) : 'failed', steps: m.tee.steps || [] };
        }
        renderTeeChip(bubbles[i].querySelector('.prompt-content'), m.tee);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('encrypted-btn');
    btn?.addEventListener('click', () => setEncrypted(!encryptedOn()));
    // chat-models.js names the model on its own change listener; say "Encrypted" again after it.
    modelSelect.addEventListener('change', () => updateModelDisplayName());
    syncEncryptedButton();
    updateToolsStatus();
    // The models may already be here (they're asked for as the page loads).
    if (encryptedActive() && _allModels.length) {
        pickEncryptedModel();
        updateModelDisplayName();
    }
});
