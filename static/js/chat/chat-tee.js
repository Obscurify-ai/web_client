// chat-tee.js — Verify: TEE replies checked in this browser. With Verify on, the picker offers
// only TEE models whose replies the enclave's gateway signs (`tee_verifiable` in /v1/models),
// every request asks for a verifiable reply ("tee_verify": true), and each answer gets a chip:
// Verifying…, Verified or Not verified. The check runs here, in the open-source verifier
// (static/vendor/tee-verify, built from obscurify-tee-verify): the bytes received match the
// signed receipt, the receipt key is bound to an Intel TDX quote with our own fresh nonce, the
// quote is genuine, the gateway's measured code is an approved release, and the gateway checked
// the model host. Loaded only when Verify is used. Loads after chat-privacy.js.

const TEE_VERIFY_KEY = 'obscurify_tee_verify';
const TEE_VERIFIER_URL = '/static/vendor/tee-verify/tee_verify.js?v=1';
const TEE_RECEIPT_WAIT_MS = 20 * 1000;
// Evidence for "Download evidence", by receipt id, for as long as this page is open.
const teeEvidence = new Map();
let teeVerifierPromise = null;

function teeVerifyOn() {
    return localStorage.getItem(TEE_VERIFY_KEY) === 'true';
}

// Verify applies to signed-in cloud chats only.
function teeVerifyActive() {
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    const local = typeof isLocalMode !== 'undefined' && isLocalMode;
    return teeVerifyOn() && loggedIn && !local;
}

function loadTeeVerifier() {
    if (!teeVerifierPromise) {
        teeVerifierPromise = import(TEE_VERIFIER_URL).then(async (mod) => {
            await mod.default({ module_or_path: '/static/vendor/tee-verify/tee_verify_bg.wasm?v=1' });
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

// The result of one reply's check: never throws. `checks` are the verifier's, in its order.
async function verifyTeeCapture(capture) {
    const failed = (label) => ({ receipt: capture.receipt || '', model: capture.model, verified: false, failed: label, checks: [] });
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
        const nonce = verifier.newNonce();
        const att = await teeGet('/web/tee/attestation?model=' + model + '&nonce=' + nonce, capture.route, 120000);
        if (!att.ok) return failed('Couldn’t get the attestation (' + att.status + ')');
        const attestation = await att.text();
        const report = await verifier.verifyTeeReply(body, receipt, attestation, nonce, location.origin + '/tee/pccs');
        teeEvidence.set(capture.receipt, {
            model: capture.model, receipt_id: capture.receipt, nonce,
            body_base64: teeBase64(body), receipt: JSON.parse(receipt), attestation: JSON.parse(attestation), report,
        });
        const checks = (report.checks || []).map((c) => ({ id: c.id, status: c.status, label: c.label, detail: c.detail }));
        const bad = checks.find((c) => c.status === 'fail');
        return {
            receipt: capture.receipt,
            model: capture.model,
            verified: Boolean(report.verified),
            failed: bad ? bad.label : (report.verified ? '' : 'Not every check passed'),
            checks,
        };
    } catch (err) {
        return failed('Couldn’t run the check: ' + (err && err.message ? err.message : err));
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
    message.tee = { status: 'pending', steps };
    renderTeeChip(element, message.tee);
    const pending = captures.map((c) => (c && typeof c.then === 'function' ? c : verifyTeeCapture(c)));
    Promise.all(pending).then((results) => {
        message.tee = { status: teeStatus(steps.concat(results), false), steps: steps.concat(results) };
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

function teeChipText(tee) {
    if (tee.status === 'pending') return 'Verifying…';
    if (tee.status === 'verified') return 'Verified';
    return 'Not verified';
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

// ---- the Verify control -----------------------------------------------------------------

// With Verify on the picker lists only models whose replies can be verified.
const filterModelsForPickerBeforeTee = filterModelsForPicker;
filterModelsForPicker = function (models, options) {
    const list = filterModelsForPickerBeforeTee(models, options);
    return teeVerifyActive() ? list.filter((m) => m.tee_verifiable) : list;
};

function currentModelVerifiable() {
    const info = _allModels.find((m) => m.id === modelSelect.value);
    return Boolean(info && info.tee_verifiable);
}

// A verifiable model the person can use, for when Verify comes on with another selected.
function pickVerifiableModel() {
    if (!_allModels.length || currentModelVerifiable()) return;
    const choice = _allModels.find((m) => m.tee_verifiable && isModelAvailable(m)
        && modelSelect.querySelector(`option[value="${CSS.escape(m.id)}"]:not(:disabled)`));
    if (choice) {
        modelSelect.value = choice.id;
        modelSelect.dispatchEvent(new Event('change'));
    }
}

function setTeeVerify(on) {
    if (on) localStorage.setItem(TEE_VERIFY_KEY, 'true');
    else localStorage.removeItem(TEE_VERIFY_KEY);
    syncTeeVerifyButton();
    if (on) {
        pickVerifiableModel();
        loadTeeVerifier().catch(() => {});
    }
    if (typeof renderModelPicker === 'function') renderModelPicker();
    updateModelDisplayName();
}

function syncTeeVerifyButton() {
    const btn = document.getElementById('tee-verify-btn');
    if (!btn) return;
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    btn.setAttribute('aria-pressed', String(teeVerifyOn() && loggedIn));
    btn.disabled = !loggedIn;
    btn.title = loggedIn ? 'Verify: TEE models only, each answer checked against the enclave’s signed receipt' : 'Sign in to verify TEE answers';
}

// The catalogue can load more than once, choosing its default model each time.
const fetchAndPopulateModelsBeforeTee = fetchAndPopulateModels;
fetchAndPopulateModels = async function (...args) {
    const result = await fetchAndPopulateModelsBeforeTee.apply(this, args);
    if (teeVerifyActive()) {
        pickVerifiableModel();
        updateModelDisplayName();
    }
    return result;
};

// "Chatting anonymously with X" becomes "Verified chat with X".
const updateModelDisplayNameBeforeTee = updateModelDisplayName;
updateModelDisplayName = function () {
    updateModelDisplayNameBeforeTee();
    if (!teeVerifyActive()) return;
    for (const id of ['prompt-input', 'chat-prompt-input']) {
        const input = document.getElementById(id);
        const text = input && input.getAttribute('data-placeholder');
        if (text) input.setAttribute('data-placeholder', text.replace(/^Chatting anonymously/, 'Verified chat'));
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
    const btn = document.getElementById('tee-verify-btn');
    btn?.addEventListener('click', () => setTeeVerify(!teeVerifyOn()));
    // chat-models.js names the model on its own change listener; say "Verified" again after it.
    modelSelect.addEventListener('change', () => updateModelDisplayName());
    syncTeeVerifyButton();
    // The models may already be here (they're asked for as the page loads).
    if (teeVerifyActive() && _allModels.length) {
        pickVerifiableModel();
        updateModelDisplayName();
    }
});
