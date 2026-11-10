// chat-code.js — Code Mode. The model gets one tool, run_code; its Python or JavaScript
// runs on this device in a sandboxed frame from a separate origin (see
// sandbox/runner.js), never in this page. Code reaches the outside world only through
// `tools.*`, which comes back here over a MessagePort: web search, and paid tools billed
// to the account balance within fixed budgets.
//
// A Code Mode reply is an agent loop: stream a completion; if it asks to run code, run
// it, send the result back, and repeat until the model answers in words. The whole loop
// is stored as one assistant message (`trace` holds the tool turns for replay).

const CODE_MAX_STEPS = 100;           // model calls per reply
const CODE_RUN_TIMEOUT_MS = 30 * 60 * 1000;  // one run; time in tool calls doesn't count
const CODE_RATE_WAIT_MS = 5 * 60 * 1000;  // how long a model rate limit is waited out (a per-minute one clears in a minute); a lost connection has no limit
const CODE_TOOL_BUSY_MS = 2 * 60 * 1000;  // how long a busy paid tool (a 429) is waited out
const CODE_MAX_FED_BACK = 2;  // times one reply tells the model its request failed
const CODE_MAX_REPAIRS = 3;  // times one reply asks the model to redo a tool call it wrote unreadably
const CODE_MAX_TOOL_CALLS = 200;      // per run

// Compaction, kept the same in the Android app. Everything already sent stays byte for byte until
// the context is 70% full, because rewriting it would lose the provider's prefix cache.
const CODE_COMPACT_AT = 0.7;          // of the model's context
const CODE_COMPACT_KEEP = 0.15;       // of the context: verbatim tail, and the largest user message kept
const CODE_DEFAULT_CONTEXT = 128000;
const CODE_COMPACT_MIN_CHARS = 200;
const CODE_COMPACT_MAX_FAILURES = 3;
const CODE_COMPACT_PROMPT = "Summarize this conversation so the work can continue from your summary alone: everything above will be replaced by it. Reply with text only and do not call any tools. Keep all of the following: the user's goals, and their latest request quoted verbatim; the decisions made and why; what was tried and the results, including failures; exact values, IDs, URLs and file names; what paid tools returned; what Python state exists (variables, imports, functions); and what is left to do. If there is an earlier summary above, carry over everything in it that still matters.";

// The most one reply may spend, on the model and on paid tools. Set by the user, kept on this device.
const codeConfig = (() => {
    const b = document.body ? document.body.dataset : {};
    return {
        // `self`: the sandbox pages are served from this host (their CSP still gives them
        // an opaque origin of their own).
        sandboxOrigin: b.codeSandbox === 'self' ? window.location.origin : (b.codeSandbox || '').replace(/\/+$/, ''),
    };
})();

// The server's Code Mode settings for this visitor: tools, budgets, the run_code tool and
// the system prompt (GET /code_mode, shared with the Android app).
let codeServer = null;
if (codeConfig.sandboxOrigin) {
    fetch('/code_mode', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => { if (c && c.enabled) codeServer = c; updateToolsStatus(); })
        .catch(() => {});
}

// Code and tools are how chat works wherever the server offers them, unless the visitor
// switches them off. The choice stays on this device.
const TOOLS_OFF_KEY = 'obscurify_tools_off';

function toolsSwitchedOff() {
    return localStorage.getItem(TOOLS_OFF_KEY) === 'true';
}

function codeModeAvailable() {
    return Boolean(codeConfig.sandboxOrigin);
}

function paidToolsAvailable() {
    return Boolean(codeServer && codeServer.paid_tools);
}

function selectedModelSupportsTools(model) {
    const info = typeof _allModels !== 'undefined' ? _allModels.find(m => m.id === model) : null;
    return !info || info.tools !== false;
}

function currentModelSupportsTools() {
    return selectedModelSupportsTools(typeof modelSelect !== 'undefined' && modelSelect ? modelSelect.value : '');
}

// Local models, models that can't call tools, a server without Code Mode and a visitor who
// switched tools off get plain chat.
function codeModeActive() {
    const local = typeof isLocalMode !== 'undefined' && isLocalMode;
    return codeModeAvailable() && Boolean(codeServer) && !local && !toolsSwitchedOff() && currentModelSupportsTools();
}

// The Tools button in the message box: whether tools work right now, and the switch for them.
function updateToolsStatus() {
    const on = codeModeActive();
    const local = typeof isLocalMode !== 'undefined' && isLocalMode;
    const switchedOff = toolsSwitchedOff();
    // Switched on, but this model can't call tools: struck out, and tapping it does nothing.
    const unable = !switchedOff && !on;
    document.querySelectorAll('[data-tools-switch]').forEach((toggle) => {
        toggle.hidden = !codeServer || local;
        toggle.setAttribute('aria-checked', String(on));
        toggle.setAttribute('aria-disabled', String(unable));
        toggle.title = unable ? 'This model can\'t use tools' : on ? 'Tools enabled: tap to turn them off' : 'Tools disabled: tap to turn them on';
    });
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof modelSelect !== 'undefined' && modelSelect) modelSelect.addEventListener('change', updateToolsStatus);
    const modeToggle = document.getElementById('mode-toggle');
    if (modeToggle) modeToggle.addEventListener('click', () => setTimeout(updateToolsStatus));
    document.querySelectorAll('[data-tools-switch]').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            if (toggle.getAttribute('aria-disabled') === 'true') return;
            localStorage.setItem(TOOLS_OFF_KEY, String(!toolsSwitchedOff()));
            updateToolsStatus();
        });
    });
    updateToolsStatus();
});

// ---- the sandbox ----------------------------------------------------------------------

class CodeSandbox {
    constructor(origin) {
        this.origin = origin;
        this.ready = null;
        this.port = null;
        this.frame = null;
        this.current = null;
        this.seq = 0;
    }

    ensure() {
        if (this.ready) return this.ready;
        this.ready = new Promise((resolve, reject) => {
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.setAttribute('aria-hidden', 'true');
            frame.setAttribute('title', 'Code sandbox');
            frame.tabIndex = -1;
            frame.className = 'code-sandbox-frame';
            const timer = setTimeout(() => reject(new Error('The code sandbox did not start.')), 20000);
            this.onReady = () => { clearTimeout(timer); resolve(); };
            frame.addEventListener('load', () => {
                const channel = new MessageChannel();
                this.port = channel.port1;
                this.port.onmessage = (e) => this.onMessage(e.data || {});
                // The frame's origin is opaque, so it can't be named here; frame-src
                // guarantees what is loaded in it.
                frame.contentWindow.postMessage({ type: 'init' }, '*', [channel.port2]);
            }, { once: true });
            frame.src = this.origin + '/sandbox/runner.html';
            document.body.appendChild(frame);
            this.frame = frame;
        });
        this.ready.catch(() => this.destroy());
        return this.ready;
    }

    destroy() {
        if (this.frame) this.frame.remove();
        this.frame = null;
        this.port = null;
        this.ready = null;
        this.current = null;
    }

    onMessage(msg) {
        if (msg.type === 'ready') {
            if (this.onReady) this.onReady();
            return;
        }
        if (msg.type === 'reset_done') return;
        const run = this.current;
        if (!run) return;
        if (msg.type === 'fatal') {
            run.finish({ ok: false, error: msg.message || 'The sandbox crashed.' });
            return;
        }
        if (msg.runId !== run.runId) return;
        run.handle(msg);
    }

    reset() {
        this.current = null;
        if (this.port) this.port.postMessage({ type: 'reset' });
    }

    async run(language, code, hooks) {
        await this.ensure();
        const runId = ++this.seq;
        const started = performance.now();
        return new Promise((resolve) => {
            const result = { ok: false, value: null, error: null, stdout: '', stderr: '', images: 0, media: 0, pages: 0, timedOut: false, ms: 0 };
            let done = false;
            const finish = (patch) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
                if (this.current && this.current.runId === runId) this.current = null;
                Object.assign(result, patch, { ms: Math.round(performance.now() - started) });
                resolve(result);
            };
            const timeoutMs = hooks.timeoutMs || CODE_RUN_TIMEOUT_MS;
            // The limit is for the code itself: it's paused while a tool call is out, which can
            // take a while on a slow tool or a lost connection.
            let timer = null;
            let left = timeoutMs;
            let armed = 0;
            let toolsOut = 0;
            const arm = () => { armed = performance.now(); timer = setTimeout(expire, left); };
            const pause = () => { clearTimeout(timer); left -= performance.now() - armed; };
            const expire = () => {
                this.reset();
                finish({ ok: false, timedOut: true, error: 'Timed out after ' + Math.round(timeoutMs / 1000) + ' seconds. The sandbox was restarted, so Python state was lost.' });
            };
            arm();
            const onAbort = () => {
                this.reset();
                finish({ ok: false, error: 'Stopped by the user.' });
            };
            if (hooks.signal) {
                if (hooks.signal.aborted) return onAbort();
                hooks.signal.addEventListener('abort', onAbort);
            }
            this.current = {
                runId,
                finish,
                handle: (msg) => {
                    switch (msg.type) {
                        case 'stdout':
                        case 'stderr':
                            result[msg.type] += String(msg.text || '');
                            hooks.onOutput(String(msg.text || ''), msg.type);
                            break;
                        case 'status':
                            hooks.onStatus(String(msg.text || ''));
                            break;
                        case 'image':
                            if (typeof msg.dataUrl === 'string' && (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(msg.dataUrl) ? msg.dataUrl.length < 8 * 1024 * 1024 : /^https:\/\//i.test(msg.dataUrl))) {
                                result.images += 1;
                                hooks.onImage(msg.dataUrl);
                            }
                            break;
                        case 'media':
                            if (typeof msg.url === 'string' && /^https:\/\//i.test(msg.url) && msg.url.length < 2048) {
                                result.media += 1;
                                hooks.onMedia(msg.url, String(msg.title || ''));
                            }
                            break;
                        case 'html':
                            if (typeof msg.html === 'string') {
                                result.pages += 1;
                                hooks.onHtml(msg.html, String(msg.title || ''));
                            }
                            break;
                        case 'tool':
                            if (toolsOut++ === 0) pause();
                            Promise.resolve()
                                .then(() => hooks.onTool(String(msg.name || ''), msg.args || {}))
                                .finally(() => { if (--toolsOut === 0 && !done) arm(); })
                                .then(
                                    (value) => this.port && this.port.postMessage({ type: 'tool_result', callId: msg.callId, ok: true, value: value === undefined ? null : value }),
                                    (err) => this.port && this.port.postMessage({ type: 'tool_result', callId: msg.callId, ok: false, error: String((err && err.message) || err) }),
                                );
                            break;
                        case 'done':
                            finish(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: String(msg.error || 'The run failed.') });
                            break;
                    }
                },
            };
            this.port.postMessage({ type: 'run', runId, language, code });
        });
    }
}

let codeSandbox = null;

function getCodeSandbox() {
    if (!codeSandbox) codeSandbox = new CodeSandbox(codeConfig.sandboxOrigin);
    return codeSandbox;
}

// Artifact frames report their height; only frames we created are listened to.
const artifactFrames = new Map();
window.addEventListener('message', (e) => {
    const entry = artifactFrames.get(e.source);
    if (!entry || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'artifact_ready') {
        // Every time: a frame that reloads (the page called location.reload(), the
        // browser dropped it) would otherwise stay blank. It can only ever be our
        // artifact page again (frame-src), so sending the same HTML again is safe.
        entry.renders = (entry.renders || 0) + 1;
        if (entry.renders > 5) return;   // a page that reloads itself forever
        entry.sent = true;
        e.source.postMessage({ type: 'render', html: entry.html }, '*');
    } else if (e.data.type === 'artifact_height') {
        // A page sized to its viewport keeps asking for more; stop following it.
        if (entry.growths > 8) return;
        const h = Math.min(Math.max(Number(e.data.height) || 0, 120), 1600);
        if (h > (parseFloat(entry.frame.style.height) || 0)) entry.growths = (entry.growths || 0) + 1;
        entry.frame.style.height = h + 'px';
    }
});

// A sandboxed frame showing `html` (opaque origin, no network), appended to `container`,
// which must already be in the page.
function mountArtifact(container, html, title) {
    const wrap = el('div', 'code-run-artifact');
    if (title) wrap.appendChild(el('div', 'code-run-artifact-title', title));
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', title || 'Interactive result');
    frame.style.height = '360px';
    wrap.appendChild(frame);
    container.appendChild(wrap);
    frame.src = codeConfig.sandboxOrigin + '/sandbox/artifact.html';
    artifactFrames.set(frame.contentWindow, { frame, html, sent: false });
    return wrap;
}

// A tool's answer, or code, can name a video, an image or an audio file. Those are shown as a
// real player or picture with a way to keep the file, because the links expire (MiniMax, Alibaba
// and most others hand back a CDN URL valid for a day) and a bare URL is no use on a phone.
const MEDIA_EXT = /(mp4|webm|mov|m4v|mp3|wav|m4a|ogg|png|jpe?g|webp|gif)$/i;
const MEDIA_URL = /https?:\/\/[^\s"'<>]+/gi;   // http:// is upgraded when shown
const MEDIA_MAX_PER_CALL = 4;
// Generated media links are a day long at most (MiniMax, Alibaba, Replicate).
const EXPIRING_NOTE = 'temporary link, save it now';

function mediaKind(url) {
    let path = String(url);
    try { path = new URL(path).pathname; } catch (_) { return null; }
    const m = MEDIA_EXT.exec(path);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
    return 'image';
}

/** Media URLs named anywhere in a value (a tool's answer, usually), the first few only. */
function mediaIn(value) {
    const found = [];
    const seen = new Set();
    const walk = (v, depth) => {
        if (v === null || v === undefined || depth > 6 || found.length >= MEDIA_MAX_PER_CALL) return;
        if (typeof v === 'string') {
            for (const url of v.match(MEDIA_URL) || []) {
                const clean = url.replace(/[),.;]+$/, '');
                const kind = mediaKind(clean);
                if (kind && !seen.has(clean)) { seen.add(clean); found.push({ url: clean, kind }); }
            }
        } else if (typeof v === 'object') {
            for (const k of Object.keys(v)) walk(v[k], depth + 1);
        }
    };
    walk(value, 0);
    return found;
}

// One video/image/audio player with a save link. `seen` stops the same file being shown twice
// in a reply, which happens when the model prints the URL it just got.
function mountMedia(container, rawUrl, title, opts) {
    const seen = (opts && opts.seen) || null;
    // Alibaba and MiniMax hand out http:// CDN links; the chat page's CSP allows https only, and
    // the same host serves both, so upgrade instead of dropping the file.
    const url = String(rawUrl).replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(url)) return null;
    if (seen) { if (seen.has(url)) return null; seen.add(url); }
    const kind = mediaKind(url) || 'file';
    const wrap = el('div', 'code-run-media-item');
    if (title) wrap.appendChild(el('div', 'code-run-media-title', title));

    if (kind === 'video' || kind === 'audio') {
        const player = document.createElement(kind);
        player.setAttribute('controls', '');
        player.setAttribute('playsinline', '');
        player.setAttribute('preload', 'metadata');
        player.className = kind === 'video' ? 'code-run-video' : 'code-run-audio';
        player.src = url;
        wrap.appendChild(player);
    } else if (kind === 'image') {
        const img = el('img', 'code-run-image');
        img.alt = title || 'Image from the tool';
        img.loading = 'lazy';
        img.src = url;
        wrap.appendChild(img);
    }

    const bar = el('div', 'code-run-media-bar');
    const name = (() => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (_) { return ''; } })();
    const save = el('a', 'code-run-media-save', kind === 'file' ? 'Open the link' : 'Save ' + (name || kind));
    save.href = url;
    save.target = '_blank';
    save.rel = 'noopener noreferrer nofollow';
    save.setAttribute('download', name || 'download');
    bar.appendChild(save);
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { /* keep it blank */ }
    if (host) bar.appendChild(el('span', 'code-run-media-host', host));
    if (opts && opts.note) bar.appendChild(el('span', 'code-run-media-note', opts.note));
    wrap.appendChild(bar);
    container.appendChild(wrap);
    return wrap;
}

const HTML_PREVIEW_MAX = 3;          // per replyconst HTML_PREVIEW_MAX_CHARS = 2 * 1024 * 1024;

// A reply with an ```html block gets a live preview under it, rendered in the sandbox
// like any artifact. Models often answer "make me a page" with HTML in the reply rather
// than through code, and this works whether Code Mode is on or not.
// Pages already shown by code in this reply: the model often pastes the same page into
// its answer afterwards, and it shouldn't appear twice.
function samePage(a, b) {
    const norm = (t) => String(t || '').replace(/\s+/g, '');
    const x = norm(a);
    const y = norm(b);
    if (x === y) return true;
    const longer = Math.max(x.length, y.length);
    return longer > 0 && Math.abs(x.length - y.length) / longer < 0.1 && x.slice(0, 400) === y.slice(0, 400);
}

function attachHtmlPreviews(root, shownPages) {
    if (!codeModeAvailable() || !root) return;
    const shown = shownPages || [];
    let count = root.querySelectorAll('.html-preview').length;
    root.querySelectorAll('pre > code').forEach((code) => {
        if (count >= HTML_PREVIEW_MAX || code.closest('.code-run')) return;
        const text = code.textContent || '';
        const labelled = /(^|\s)(language-)?html(\s|$)/.test(code.className || '');
        const looksLikePage = /^\s*(<!doctype html|<html[\s>])/i.test(text);
        if (!(labelled || looksLikePage) || text.trim().length < 20 || text.length > HTML_PREVIEW_MAX_CHARS) return;
        if (shown.some((page) => samePage(page, text))) return;
        const pre = code.parentElement;
        if (pre.nextElementSibling && pre.nextElementSibling.classList.contains('html-preview')) return;
        count += 1;
        const box = el('div', 'html-preview');
        const bar = el('div', 'html-preview-bar');
        bar.appendChild(el('span', 'html-preview-label', 'Preview'));
        const toggle = el('button', 'html-preview-toggle', 'Hide');
        toggle.type = 'button';
        bar.appendChild(toggle);
        const body = el('div', 'html-preview-body');
        box.append(bar, body);
        pre.after(box);
        mountArtifact(body, text, '');
        toggle.addEventListener('click', () => {
            body.hidden = !body.hidden;
            toggle.textContent = body.hidden ? 'Show' : 'Hide';
        });
    });
}

// ---- talking to the server ------------------------------------------------------------

// A short line under the reply while a request waits for the connection to come back.
function setCodeWaiting(on) {
    let note = document.getElementById('code-waiting');
    if (!on) {
        if (note) note.remove();
        return;
    }
    if (note) return;
    const replies = document.querySelectorAll('.message.assistant-message');
    const reply = replies[replies.length - 1];
    if (!reply) return;
    note = el('p', 'code-turn-waiting', 'Waiting for Obscurify. This picks up by itself.');
    note.id = 'code-waiting';
    reply.append(note);
}

// Waits before asking again, growing up to 15 seconds. Stop ends it.
async function waitForConnection(attempt, signal) {
    setCodeWaiting(true);
    const ms = Math.min(1000 * 2 ** attempt, 15000);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
    });
}

// Every "Waiting for Obscurify" loop asks this before waiting again. Offline, the wait lasts as
// long as it takes. Online, a request the server keeps failing (a 502/503/504, a stream that
// ends early, a sandbox that won't start) is waited on CODE_MAX_LOST_WAITS times (~45 s) and
// then reported, so nothing can sit on the note forever: a web search that kept answering 503
// used to hold a run (whose timeout pauses during tool calls) and its chat for good.
async function waitAgain(waited, signal) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!offline && waited >= CODE_MAX_LOST_WAITS) {
        setCodeWaiting(false);
        return false;
    }
    await waitForConnection(offline ? Math.min(waited, 4) : waited, signal);
    return true;
}

// A tool call to the server. A lost connection doesn't fail it: it waits and asks again until the
// answer comes (offline, or for ~45 s while the server keeps failing; see waitAgain). A paid call carries a request_id, so the server runs it once however many times
// it's asked. Its 503 means the tool itself timed out and may have charged, so that one isn't repeated.
async function codeToolRequest(path, body) {
    const signal = currentAbortController ? currentAbortController.signal : undefined;
    const base = (codeServer && codeServer.tool_base) || '/web/tools';
    let limitedSince = 0;
    let lostWaits = 0;
    for (let attempt = 0; ; attempt++) {
        let response;
        try {
            const headers = { 'Content-Type': 'application/json' };
            const token = await getCSRFToken();
            if (token) headers['X-CSRF-Token'] = token;
            response = await fetch(getConfig().api.baseUrl + base + path, {
                method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body), signal,
            });
            // Busy: nothing ran. It's waited out for two minutes, not longer: the model is better
            // off hearing it and trying something else than the chat sitting on "Waiting".
            if (response.status === 429) {
                limitedSince = limitedSince || Date.now();
                if (Date.now() - limitedSince > CODE_TOOL_BUSY_MS) throw new Error('Tools are busy right now (asked for 2 minutes). Use another way, or carry on without it.');
            }
            if ([408, 429, 502, 504, 524].includes(response.status) || (response.status === 503 && path !== '/call')) {
                throw new TypeError('Request failed (' + response.status + ')');
            }
            let data = null;
            try { data = await response.clone().json(); } catch (_) { await response.text(); /* not JSON */ }
            setCodeWaiting(false);
            if (!response.ok) {
                const message = data && (data.error || data.detail || data.message);
                throw new Error(typeof message === 'string' ? message : 'Request failed (' + response.status + ')');
            }
            return data;
        } catch (err) {
            if (err.name === 'AbortError' || !(err instanceof TypeError)) {
                setCodeWaiting(false);
                throw err;
            }
            // A busy tool has its own limit above (CODE_TOOL_BUSY_MS); anything else counts.
            if (response && response.status === 429) {
                await waitForConnection(Math.min(attempt, 4), signal);
                continue;
            }
            if (!(await waitAgain(lostWaits++, signal))) {
                throw new Error('The tool request kept failing (' + err.message + '). Try again later, or carry on without it.');
            }
        }
    }
}

// One streamed completion. Returns the text, reasoning and any tool calls it made.
// `resumable`: a step of the run itself (not a summary), picked up again if the page closes.
async function streamCodeCompletion(body, signal, onUpdate, resumable) {
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    const config = getConfig();
    const endpoint = config.api.baseUrl + (loggedIn ? config.api.chatEndpoint : config.api.anonChatEndpoint);
    const started = Date.now();
    // The page closed while this step ran: its answer was finished on the server (chat-reply.js).
    if (resumable && typeof codeStepResume !== 'undefined' && codeStepResume) {
        const pending = codeStepResume;
        codeStepResume = null;
        const held = await followReply(pending, signal);
        if (held.ok) return readCodeStream(held, onUpdate);
        clearPendingReply(pending.convId, pending.replyId);
    }
    const verify = typeof teeVerifyActive === 'function' && teeVerifyActive();
    for (;;) {
        const headers = { 'Content-Type': 'application/json' };
        if (loggedIn) {
            const token = await getCSRFToken();
            if (token) headers['X-CSRF-Token'] = token;
        }
        const response = await sendChatStream(endpoint, {
            method: 'POST', headers, credentials: 'same-origin', signal,
        }, body, 'code', { kind: resumable ? 'code' : null, verify });
        // A long run can outpace the per-minute limit, and that's no reason to stop. A limit that
        // lasts longer than a couple of minutes is reported instead.
        const retryAfter = parseInt(response.headers.get('Retry-After') || '10', 10) || 10;
        if (response.status === 429 && retryAfter <= 120 && Date.now() - started < CODE_RATE_WAIT_MS) {
            onUpdate(null, null, 'Waiting ' + retryAfter + 's for the rate limit…');
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, retryAfter * 1000);
                if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
            });
            continue;
        }
        if (!response.ok) {
            if (loggedIn && (response.status === 401 || response.status === 403)) {
                handleSessionExpiryRedirect();
            }
            let message = 'Request failed (' + response.status + ')';
            try {
                const err = await response.json();
                message = (err && (err.error || err.detail)) || message;
            } catch (_) { /* keep the status */ }
            throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
        }
        return readCodeStream(response, onUpdate);
    }
}

// Where a tool call in DeepSeek's own markup starts: <｜DSML｜invoke name="run_code">.
function dsmlStart(text) {
    const at = String(text || '').indexOf('DSML');
    if (at < 0) return null;
    const open = text.lastIndexOf('<', at);
    return open >= 0 && at - open <= 4 ? open : null;
}

// The arguments of a tool call in that markup. Each parameter runs to its closing tag; code can
// have </ in it, but not this bar.
function dsmlCall(content) {
    const start = dsmlStart(content);
    if (start === null) return null;
    const t = content.slice(start);
    if (!t.includes('invoke name="run_code"')) return null;
    const param = (name) => {
        const at = t.indexOf('parameter name="' + name + '"');
        if (at < 0) return null;
        const body = t.slice(t.indexOf('>', at) + 1);
        const end = body.search(/<\/[｜|]/);
        return (end < 0 ? body : body.slice(0, end)).replace(/^\n+|\n+$/g, '');
    };
    const code = param('code');
    return code === null ? null : { language: param('language') || 'python', code };
}

// Text that is a tool call, or an attempt at one, and not an answer.
function writtenCall(content) {
    const t = String(content || '').trimStart();
    return dsmlStart(content) !== null || t.startsWith('<function') || t.startsWith('<tool_call') || t.startsWith('<invoke');
}

// Some models (Llama 3.3 among them) often write a tool call as text instead of making it:
// <function=run_code>{"code": ...}</function>, <function-run_code{...}}, with no braces, or the
// bare JSON. Read as an answer it runs nothing and shows gibberish, so it becomes the call it meant.
function textToolCall(content) {
    const dsml = dsmlCall(content);
    if (dsml) return { id: 'text_call_' + Date.now().toString(36), type: 'function', function: { name: 'run_code', arguments: JSON.stringify(dsml) } };
    const t = String(content || '').trim();
    const tagged = t.startsWith('<function') || t.startsWith('<tool_call');
    if (!tagged && !t.startsWith('{')) return null;
    if (tagged && !t.slice(0, 60).includes('run_code')) return null;
    const parse = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
    let v = null;
    const open = t.indexOf('{');
    if (open >= 0) {
        for (let end = t.lastIndexOf('}'); end > open && !v; end = t.lastIndexOf('}', end - 1)) {
            v = parse(t.slice(open, end + 1));
        }
    }
    if (!v) {
        const start = Math.max(t.indexOf('"code"'), 0) || t.indexOf('"language"');
        const close = t.lastIndexOf('</');
        if (start > 0) v = parse('{' + t.slice(start, close > start ? close : t.length).trim().replace(/,$/, '') + '}');
    }
    if (!v) return null;
    const args = [v.parameters, v.arguments].find((a) => a && typeof a === 'object') || v;
    if (typeof args.code !== 'string') return null;
    if (!tagged && v.name !== 'run_code' && typeof v.language !== 'string') return null;
    return { id: 'text_call_' + Date.now().toString(36), type: 'function', function: { name: 'run_code', arguments: JSON.stringify(args) } };
}

async function readCodeStream(response, onUpdate) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const out = { content: '', reasoning: '', reasoningDetails: [], toolCalls: [], finishReason: null, usage: null, capture: response.capture || null };
    const calls = [];
    let buffer = '';
    let finished = false;

    const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.substring(5).trim();
        if (data === '[DONE]') { finished = true; return; }
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) { return; }
        if (parsed.error) throw new Error(parsed.error.message || 'Unknown error');
        if (parsed.usage) out.usage = parsed.usage;   // the closing chunk has no choices
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) out.content = mergeStreamingText(out.content, delta.content);
        const reasoning = typeof streamedReasoning === 'function' ? streamedReasoning(delta) : delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) out.reasoning = mergeStreamingText(out.reasoning, reasoning);
        out.reasoningDetails = mergeReasoningDetails(out.reasoningDetails, delta.reasoning_details);
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const i = Number.isInteger(tc.index) ? tc.index : calls.length;
                const call = calls[i] || (calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
                if (tc.id) call.id = tc.id;
                if (tc.function && tc.function.name) call.function.name = tc.function.name;
                if (tc.function && typeof tc.function.arguments === 'string') call.function.arguments += tc.function.arguments;
            }
        }
        if (choice.finish_reason) out.finishReason = choice.finish_reason;
        onUpdate(out.content, out.reasoning, null);
    };

    while (!finished) {
        const { value, done } = await readOrStall(reader);
        if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                handle(line);
                if (finished) break;
            }
        }
        if (done) break;
    }
    if (!finished && buffer) handle(buffer);
    // The stream ended without saying it was done: the text is partial and any tool calls unusable.
    out.cut = !finished && !out.finishReason;
    if (out.cut) calls.length = 0;
    out.toolCalls = calls.filter(Boolean).map((c, i) => Object.assign(c, { id: c.id || ('call_' + Date.now().toString(36) + '_' + i) }));
    if (!out.toolCalls.length) {
        const recovered = textToolCall(out.content);
        if (recovered) {
            out.toolCalls = [recovered];
            out.content = out.content.slice(0, dsmlStart(out.content) ?? 0);
        }
    }
    return out;
}

// ---- rendering ------------------------------------------------------------------------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatUsd(v) {
    const n = Number(v) || 0;
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4).replace(/0+$/, '');
    return '$' + n.toFixed(2);
}

class CodeTurnView {
    // `keep`: continuing an answer, so what it already shows stays.
    constructor(root, keep) {
        this.root = root;
        if (!keep) this.root.textContent = '';
        this.root.classList.add('code-turn');
        this.parts = [];   // for the saved markdown
        this.pages = [];   // HTML shown by code in this reply
        this.mediaSeen = new Set();   // media URLs already shown, so one file appears once
    }

    textSegment() {
        const node = el('div', 'code-turn-text');
        const pending = el('div', 'code-turn-pending');
        pending.setAttribute('aria-label', 'Thinking');
        this.root.append(node, pending);
        this.keepSpendLast();
        const part = { kind: 'text', content: '' };
        this.parts.push(part);
        return {
            render: (content, reasoning, note) => {
                pending.remove();
                if (note) { node.textContent = note; return; }
                part.content = content || '';
                const markdown = buildAssistantResponseMarkdown(content || '', reasoning || '', Boolean(content), []);
                if (markdown.trim()) renderMarkdownIntoElement(node, markdown);
                else node.textContent = '';
            },
            // The step is being asked again from a new history.
            drop: () => {
                node.remove();
                pending.remove();
                this.parts.splice(this.parts.indexOf(part), 1);
            },
        };
    }

    // A muted line among the runs. `keep()` also puts it in the saved reply.
    note(text) {
        const node = el('p', 'code-turn-note', text);
        this.root.appendChild(node);
        this.keepSpendLast();
        return {
            keep: (final) => {
                node.textContent = final;
                this.parts.push({ kind: 'note', content: final });
            },
            drop: () => node.remove(),
        };
    }

    // "Spent $x": stays the last thing under the reply as it grows.
    showSpend(spent, promptTokens, cachedTokens) {
        if (!(typeof isLoggedIn !== 'undefined' && isLoggedIn)) return;
        this.spend = renderSpendLine(this.root, spent);
        if (cachedTokens > 0) this.spend.title = cachedTokens.toLocaleString('en-US') + ' of ' + promptTokens.toLocaleString('en-US') + ' prompt tokens read from cache';
    }

    keepSpendLast() {
        if (this.spend) this.root.appendChild(this.spend);
    }

    runBlock(language, code) {
        const label = language === 'javascript' || language === 'js' ? 'JavaScript' : 'Python';
        const part = { kind: 'run', label, code, output: '', cost: 0, images: 0, media: 0, pages: 0, error: null, tools: [] };
        this.parts.push(part);

        const box = el('div', 'code-run running');
        const head = el('div', 'code-run-head');
        const lang = el('span', 'code-run-lang', label);
        const status = el('span', 'code-run-status', 'Running…');
        const cost = el('span', 'code-run-cost');
        head.append(lang, status, cost);

        const codeDetails = el('details', 'code-run-code');
        const lines = code.split('\n').length;
        codeDetails.appendChild(el('summary', null, 'Code · ' + lines + (lines === 1 ? ' line' : ' lines')));
        const pre = el('pre');
        pre.appendChild(el('code', 'language-' + label.toLowerCase(), code));
        codeDetails.appendChild(pre);
        if (lines <= 12) codeDetails.open = true;

        const toolsList = el('div', 'code-run-tools');
        const output = el('pre', 'code-run-output');
        output.hidden = true;
        const media = el('div', 'code-run-media');
        box.append(head, codeDetails, toolsList, output, media);
        this.root.appendChild(box);
        this.keepSpendLast();
        box.scrollIntoView({ block: 'nearest' });

        return {
            status: (text) => { status.textContent = text; },
            output: (text, stream) => {
                part.output += text;
                output.hidden = false;
                const span = el('span', stream === 'stderr' ? 'code-run-stderr' : null, text);
                output.appendChild(span);
                if (output.textContent.length > 200000) output.firstChild && output.firstChild.remove();
            },
            image: (dataUrl) => {
                part.images += 1;
                const img = el('img', 'code-run-image');
                img.alt = 'Chart from the code run';
                img.src = dataUrl;
                media.appendChild(img);
            },
            // Video, audio or a remote image the code asked to show: handed over as a URL, so
            // the browser loads it and the user gets a real player and a way to keep the file.
            media: (url, title, opts) => {
                const node = mountMedia(media, url, title, { ...(opts || {}), seen: this.mediaSeen });
                if (node) part.media = (part.media || 0) + 1;
                return node;
            },
            page: (html, title) => {
                part.pages += 1;
                this.pages.push(html);
                mountArtifact(media, html, title);
            },
            tool: (name, detail) => {
                const chip = el('div', 'code-tool-chip pending');
                const icon = { web_search: '🔍', search: '🧰', inspect: '📋', call: '💳', budget: '💰' }[name] || '•';
                chip.appendChild(el('span', 'code-tool-icon', icon));
                chip.appendChild(el('span', 'code-tool-name', name));
                chip.appendChild(el('span', 'code-tool-detail', detail));
                const price = el('span', 'code-tool-price');
                chip.appendChild(price);
                toolsList.appendChild(chip);
                const entry = { name, detail, cost: 0, ok: null };
                part.tools.push(entry);
                return {
                    done: (ok, costUsd, note) => {
                        entry.ok = ok;
                        entry.cost = costUsd || 0;
                        chip.classList.remove('pending');
                        chip.classList.add(ok ? 'ok' : 'failed');
                        if (costUsd) price.textContent = formatUsd(costUsd);
                        if (note) chip.title = note;
                        if (costUsd) {
                            part.cost += costUsd;
                            cost.textContent = formatUsd(part.cost);
                        }
                    },
                };
            },
            finish: (run) => {
                box.classList.remove('running');
                box.classList.add(run.ok ? 'ok' : 'error');
                const secs = (run.ms / 1000).toFixed(1) + 's';
                status.textContent = run.ok ? 'Done · ' + secs : (run.timedOut ? 'Timed out' : 'Error · ' + secs);
                if (!run.ok && run.error) {
                    part.error = run.error;
                    output.hidden = false;
                    output.appendChild(el('span', 'code-run-stderr', (output.textContent ? '\n' : '') + run.error));
                } else if (run.ok && run.value !== null && run.value !== undefined && run.value !== '') {
                    output.hidden = false;
                    output.appendChild(el('span', 'code-run-value', (output.textContent ? '\n' : '') + '→ ' + String(run.value)));
                    part.output += (part.output ? '\n' : '') + '→ ' + String(run.value);
                }
            },
        };
    }

    // The stored version of the reply, rendered as markdown when the chat is reopened.
    markdown() {
        const out = [];
        for (const p of this.parts) {
            if (p.kind === 'text') {
                if (p.content.trim()) out.push(p.content.trim());
                continue;
            }
            if (p.kind === 'note') {
                out.push('_' + p.content + '_');
                continue;
            }
            const head = ['**Ran ' + p.label + '**'];
            if (p.cost) head.push(formatUsd(p.cost) + ' in tools');
            out.push(head.join(' · '));
            out.push('```' + p.label.toLowerCase() + '\n' + p.code.replace(/```/g, '``​`') + '\n```');
            if (p.tools.length) {
                out.push(p.tools.map(t => '- ' + t.name + ' ' + t.detail + (t.cost ? ' (' + formatUsd(t.cost) + ')' : '') + (t.ok === false ? ' (failed)' : '')).join('\n'));
            }
            const text = (p.output + (p.error ? '\n' + p.error : '')).trim();
            if (text) out.push('```\n' + clipMiddle(text, 3000).replace(/```/g, '``​`') + '\n```');
            const shown = [];
            if (p.images) shown.push(p.images + (p.images === 1 ? ' chart' : ' charts'));
            if (p.pages) shown.push(p.pages + (p.pages === 1 ? ' interactive page' : ' interactive pages'));
            if (shown.length) out.push('_' + shown.join(' and ') + ' shown during the run._');
        }
        return out.join('\n\n');
    }
}

function renderSpendLine(root, spent) {
    let line = root.querySelector(':scope > .code-turn-spend');
    if (!line) line = el('p', 'code-turn-spend');
    line.textContent = 'Spent ' + formatUsd(spent);
    root.appendChild(line);
    return line;
}

function clipMiddle(text, max) {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    return text.slice(0, head) + '\n… [' + (text.length - max).toLocaleString('en-US') + ' characters cut] …\n' + text.slice(-tail);
}

function summarizeToolArgs(name, args) {
    const q = (s) => '"' + String(s || '').slice(0, 80) + '"';
    if (name === 'web_search' || name === 'search') return q(args.query);
    if (name === 'inspect') return String(args.id || '');
    if (name === 'call') return String(args.id || '');
    return '';
}

// What the model gets back from one run.
function formatRunForModel(run, toolLog, resultChars) {
    const parts = [];
    parts.push(run.ok ? 'Run finished in ' + (run.ms / 1000).toFixed(1) + 's.' : (run.timedOut ? 'Run timed out.' : 'Run failed.'));
    if (run.stdout) parts.push('stdout:\n' + run.stdout);
    if (run.stderr) parts.push('stderr:\n' + run.stderr);
    if (run.ok && run.value !== null && run.value !== undefined && run.value !== '') parts.push('result:\n' + run.value);
    if (!run.ok && run.error) parts.push('error:\n' + run.error);
    if (run.images) parts.push(run.images + ' chart(s) were shown to the user.');
    if (run.pages) parts.push(run.pages + ' HTML page(s) were shown to the user.');
    if (toolLog.length) {
        parts.push('tool calls:\n' + toolLog.map(t => '- ' + t.name + ' ' + t.detail + ' -> ' + (t.ok ? 'ok' : 'failed') + (t.cost ? ', cost $' + t.cost : '')).join('\n'));
    }
    if (!run.stdout && !run.stderr && run.ok && (run.value === null || run.value === '') && !run.images && !run.pages) {
        parts.push('(no output: print what you need to see)');
    }
    return clipMiddle(parts.join('\n\n'), resultChars);
}

// ---- tools for the sandbox ------------------------------------------------------------

async function handleSandboxTool(name, args, turn, block, toolLog) {
    if (toolLog.length >= CODE_MAX_TOOL_CALLS) throw new Error('Too many tool calls in one run (' + CODE_MAX_TOOL_CALLS + ').');
    const detail = summarizeToolArgs(name, args);
    if (name === 'budget') {
        return {
            spent_usd: Number(turn.spent.toFixed(6)),
            per_call_max_usd: turn.paidTools ? turn.perCall : 0,
            suggested_max_usd: turn.paidTools ? turn.perCall : 0,
        };
    }
    const chip = block.tool(name, detail);
    const log = { name, detail, ok: false, cost: 0 };
    toolLog.push(log);
    try {
        let value;
        if (name === 'web_search') {
            if (!turn.webSearch) throw new Error('Web search is not available.');
            value = await codeToolRequest('/web_search', { query: String(args.query || '') });
        } else if (name === 'search' || name === 'inspect' || name === 'call') {
            if (name !== 'call' && !turn.toolCatalog) throw new Error('Tools are not available right now.');
            if (name === 'call' && !turn.paidTools) {
                throw new Error(paidToolsAvailable()
                    ? 'This tool is not available right now.'
                    : 'Running this tool needs a signed-in Obscurify account.');
            }
            if (name === 'search') {
                value = (await codeToolRequest('/search', { query: String(args.query || ''), limit: args.limit || 8 })).tools;
            } else if (name === 'inspect') {
                value = await codeToolRequest('/inspect', { id: String(args.id || '') });
            } else {
                // No ceiling on the server: the balance is the limit, so a video render is not
                // blocked by whatever number this client was built with. Only what the model
                // asked for is sent.
                const asked = Number(args.max_cost_usd);
                value = await codeToolRequest('/call', { request_id: crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()) + Math.random().toString(36).slice(2), id: String(args.id || ''), input: args.input || {}, max_cost_usd: asked > 0 ? Number(asked.toFixed(6)) : null });
                log.cost = Number(value.cost_usd) || 0;
                turn.addSpend(log.cost);
                // A generated video or picture comes back as a URL that expires. Show it right
                // away, with a way to keep it, instead of leaving the user a link in JSON.
                if (value.ok) {
                    for (const item of mediaIn(value.output)) {
                        block.media(item.url, '', { kind: item.kind, note: EXPIRING_NOTE });
                    }
                }
                if (!value.ok) {
                    log.ok = false;
                    chip.done(false, log.cost, 'The tool answered ' + value.status);
                    return value;
                }
            }
        } else {
            throw new Error('Unknown tool: ' + name);
        }
        log.ok = true;
        chip.done(true, log.cost);
        return value;
    } catch (err) {
        chip.done(false, log.cost, String(err.message || err));
        throw err;
    }
}

async function executeCodeRun(args, block, turn, signal) {
    const toolLog = [];
    // The sandbox's pages come from the server, so with no connection it keeps trying.
    const sandbox = getCodeSandbox();
    for (let attempt = 0; ; attempt++) {
        try {
            await sandbox.ensure();
            setCodeWaiting(false);
            break;
        } catch (err) {
            sandbox.ready = null;
            if (sandbox.frame) { sandbox.frame.remove(); sandbox.frame = null; }
            if (!(await waitAgain(attempt, signal))) {
                throw new Error('The code sandbox would not start (' + ((err && err.message) || 'no answer') + '). Reloading the page restarts it.');
            }
        }
    }
    const run = await getCodeSandbox().run(args.language, args.code, {
        signal,
        onOutput: (text, stream) => block.output(text, stream),
        onStatus: (text) => block.status(text),
        onImage: (url) => block.image(url),
        onMedia: (url, title) => block.media(url, title),
        onHtml: (html, title) => block.page(html, title),
        onTool: (name, toolArgs) => handleSandboxTool(name, toolArgs, turn, block, toolLog),
    });
    block.finish(run);
    return formatRunForModel(run, toolLog, turn.resultChars);
}

// ---- the agent loop -------------------------------------------------------------------

// ---- failures keep what was done ------------------------------------------------------
const CODE_MAX_RETRIES = 2;
// Tries over about 45 s (1, 2, 4, 8, 15, 15 s) before a request the server keeps failing
// stops waiting (offline still waits for as long as it takes).
const CODE_MAX_LOST_WAITS = 6;

// Asking again can't help with these.
function worthRetrying(message) {
    return !contextTooLong(message) && !/balance|credit|insufficient|rate limit|not support|needs|not available|too long|context/i.test(String(message || ''));
}

// The model's context can't hold the request. Compacting can help, asking again can't.
function contextTooLong(message) {
    return /context.{0,40}(length|limit|window|size|too|exceed)|(too long|too large|too many tokens|exceed\w*).{0,60}(context|token|prompt|input)|prompt is too long|maximum.{0,30}(context|token)|Request failed \(413\)/i.test(String(message || ''));
}

// Every tool call in a trace with its result: a trace saved in the middle of a run can have a call
// with none, and the API refuses that.
function soundTrace(trace) {
    const missing = (id) => ({ role: 'tool', content: 'This run was cut off before it finished. Its result is unknown.', tool_call_id: id });
    const out = [];
    let open = [];
    for (const t of trace || []) {
        if (t.role === 'tool') {
            open = open.filter((id) => id !== t.tool_call_id);
        } else {
            open.forEach((id) => out.push(missing(id)));
            open = (t.tool_calls || []).map((c) => c.id);
        }
        out.push(t);
    }
    open.forEach((id) => out.push(missing(id)));
    return out;
}

// A stored trace as it goes on the wire. The key order is the one a live step sends, because a
// later request must repeat earlier messages byte for byte. Signed reasoning only replays to its own model.
function traceForApi(trace, sameModel) {
    return soundTrace(trace).map((t) => {
        const m = { role: t.role, content: t.content };
        if (t.tool_calls) m.tool_calls = t.tool_calls;
        if (t.tool_call_id) m.tool_call_id = t.tool_call_id;
        if (t.reasoning_details && sameModel) m.reasoning_details = t.reasoning_details;
        return m;
    });
}

// Rough size in tokens: characters / 4, with each image counted as 1,000 tokens instead of its data.
function estimateTokens(list) {
    let images = 0;
    const chars = JSON.stringify(list, (key, value) => {
        if (key === 'image_url') { images++; return undefined; }
        return value;
    }).length;
    return Math.ceil(chars / 4) + images * 1000;
}

function modelContext(model) {
    const info = typeof _allModels !== 'undefined' ? _allModels.find((m) => m.id === model) : null;
    const n = info && Number(info.context_length);
    return n > 0 ? n : CODE_DEFAULT_CONTEXT;
}

// The most recent whole steps (a call and all its results), up to `maxTokens`, at least the latest.
function compactionTail(trace, maxTokens) {
    const groups = [];
    for (const t of trace) {
        if (t.role === 'assistant' || !groups.length) groups.push([]);
        groups[groups.length - 1].push(t);
    }
    const kept = [];
    let used = 0;
    for (let i = groups.length - 1; i >= 0; i--) {
        used += estimateTokens(groups[i]);
        if (kept.length && used > maxTokens) break;
        kept.unshift(groups[i]);
    }
    return kept.flat();
}

// One step of the model, retried with the tool results it has: nothing runs or is paid for again.
async function completeStep(body, signal, segment, resumable) {
    let waited = 0;
    for (let attempt = 0; ; ) {
        try {
            const res = await streamCodeCompletion(body, signal, (content, reasoning, note) => {
                if (content || reasoning || note) segment.render(content && content.slice(0, dsmlStart(content) ?? undefined), reasoning, note);
            }, resumable);
            if (res.cut) {
                const err = new Error('The connection dropped.');
                err.partial = res.content;
                throw err;
            }
            setCodeWaiting(false);
            return res;
        } catch (err) {
            if (err.name === 'AbortError' || (signal && signal.aborted)) { setCodeWaiting(false); throw err; }
            // Offline: wait for the connection for as long as it takes. But when the server is
            // reachable and the same request keeps failing (a 502/503/504, a stream that ends
            // early), waiting forever left a chat stuck on "Waiting for Obscurify" with nothing to
            // do about it; after CODE_MAX_LOST_WAITS it stops and says so, with Continue.
            const lost = err instanceof TypeError || /connection dropped|Request failed \(50[234]\)/.test(err.message);
            if (lost) {
                if (await waitAgain(waited++, signal)) continue;
                throw new Error('Obscurify kept failing to answer this chat (' + (err.message || 'no answer') + '). Your chat is kept: press Continue to try again, or switch models.');
            }
            setCodeWaiting(false);
            if (attempt >= CODE_MAX_RETRIES || !worthRetrying(err.message)) throw err;
            attempt++;
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
}

// The note under an answer that stopped short, and its Continue button.
function showInterrupted(responseElement, reason) {
    responseElement.querySelectorAll('.code-turn-interrupted').forEach((n) => n.remove());
    const box = el('div', 'code-turn-interrupted');
    box.append(el('p', '', 'Stopped early: ' + reason + ' Everything so far is kept.'));
    const go = el('button', 'code-turn-continue', 'Continue');
    go.type = 'button';
    go.addEventListener('click', () => continueCodeTurn(responseElement));
    box.append(go);
    responseElement.append(box);
}

// Picks up the last answer from what it got done, instead of asking again from the start.
async function continueCodeTurn(responseElement) {
    const from = messages[messages.length - 1];
    if (isGeneratingResponse || !from || !from.interrupted) return;
    if (!codeModeActive()) {
        const note = responseElement.querySelector('.code-turn-interrupted p');
        if (note) note.textContent = 'Turn tools on and pick a model with tools to continue.';
        return;
    }
    messages.pop();
    responseElement.querySelectorAll('.code-turn-interrupted').forEach((n) => n.remove());
    isGeneratingResponse = true;
    currentAbortController = new AbortController();
    updateActionButton(true);
    submitButton.classList.add('loading');
    try {
        await runCodeTurn({ model: modelSelect.value, uniqueId: responseElement.id, responseElement, from });
    } finally {
        isGeneratingResponse = false;
        submitButton.classList.remove('loading');
        currentAbortController = null;
        updateActionButton(false);
        saveCurrentConversation();
        renderConversationsList();
    }
}

async function runCodeTurn({ model, uniqueId, responseElement, from }) {
    const signal = currentAbortController ? currentAbortController.signal : undefined;
    // The loading dots write into the reply element; the turn view owns it from here.
    clearInterval(loadInterval);
    responseElement.style.color = '';
    const previous = messages[messages.length - 2];
    const turn = {
        paidTools: Boolean(codeServer.paid_tools),
        webSearch: Boolean(codeServer.web_search),
        toolCatalog: Boolean(codeServer.tool_catalog),
        perCall: Number(codeServer.per_call_usd) || 0,
        resultChars: Number(codeServer.result_chars) || 12000,
        spent: (from && Number(from.spent)) || 0,
        addSpend(usd) { this.spent += usd; this.onSpend(); },
        onSpend() { view.showSpend(this.spent, this.promptTokens, this.cachedTokens); },
        // Tokens in the last step, for deciding when to compact; null means estimate from the text.
        used: (from ? from.used : (previous && previous.role === 'assistant' ? previous.used : null)) ?? null,
        compactFailures: 0,
        fedBack: 0,
        repairs: 0,
        promptTokens: 0,
        cachedTokens: 0,
        // Verify: each model request's check, started as its reply ends (chat-tee.js).
        teeChecks: [],
        teeDone: (from && from.tee && Array.isArray(from.tee.steps)) ? from.tee.steps.slice() : [],
    };
    // The person's own instructions follow ours, in the one system message.
    const userSystem = userSystemPrompt();
    const system = userSystem ? codeServer.system_prompt + '\n\nThe user\'s instructions:\n' + userSystem : codeServer.system_prompt;
    let history = [{ role: 'system', content: system }].concat(toApiMessages(messages, model, { tools: true }));
    let trace = from ? traceForApi(from.trace, from.model === model) : [];
    const view = new CodeTurnView(responseElement, Boolean(from));
    turn.onSpend();
    let finalContent = '';
    let finalReasoningDetails = [];
    const display = () => [from && from.display, view.markdown()].filter(Boolean).join('\n\n');
    const label = model.includes('/') ? model.split('/').pop() : model;
    let steps = from
        ? (Number.isInteger(from.steps) ? from.steps : trace.filter((m) => m.tool_calls).length)
        : 0;
    const progress = () => ({ spent: turn.spent, steps, used: turn.used });
    const teeSoFar = () => (turn.teeChecks.length || turn.teeDone.length
        ? { tee: { status: 'partial', steps: turn.teeDone.slice() } } : {});
    const stoppedMessage = (reason, partial) => ({
        role: 'assistant', content: partial || '', display: display(), trace: trace.slice(), model, modelLabel: label, interrupted: reason, ...progress(), ...teeSoFar(),
    });
    // On disk after every step: a closed page comes back to this, with Continue.
    const checkpoint = () => {
        messages.push(stoppedMessage('The page closed before this finished.'));
        saveCurrentConversation();
        messages.pop();
    };
    // Every Code Mode request, summaries too, reports its usage. The cost is what was charged, cache discount included.
    const recordCost = (res) => {
        const u = res.usage || {};
        turn.promptTokens += Number(u.prompt_tokens) || 0;
        turn.cachedTokens += Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
        // A verified TEE reply is the enclave's own: its usage cost is the host's, not ours.
        const cost = res.capture ? teeReplyCost(model, u) : Number(u.cost);
        if (cost > 0) turn.addSpend(cost);
        if (res.capture && typeof verifyTeeCapture === 'function') {
            const check = verifyTeeCapture(res.capture).then((result) => { turn.teeDone.push(result); return result; });
            turn.teeChecks.push(check);
        }
    };
    const baseBody = () => Object.assign({
        model,
        stream: true,
        stream_options: { include_usage: true },
        tools: [codeServer.run_code_tool],
    }, samplingParams());

    // Asks for a summary and restarts the history from it. False if that didn't work: the caller
    // carries on appending. `overflow`: the model already refused this history as too long.
    const compact = async (overflow) => {
        const note = view.note('Compacting earlier work…');
        const prefix = history.concat(trace);
        let summary;
        // Too big for one summary request (or already refused as too long): summarize it in
        // chunks that each fit (chat-compact.js), so a history of any length compacts.
        const big = overflow || (typeof compactTokens === 'function' && compactTokens(prefix) > modelContext(model) * 0.5);
        if (big && typeof summarizeForCompaction === 'function') {
            try {
                summary = await summarizeForCompaction(model, prefix, signal);
            } catch (err) {
                note.drop();
                if (err.name === 'AbortError') throw err;
                turn.compactFailures++;
                return false;
            }
        } else {
            const body = baseBody();
            body.messages = prefix.concat([{ role: 'user', content: CODE_COMPACT_PROMPT }]);
            let res;
            try {
                res = await completeStep(body, signal, { render: () => {} });
            } catch (err) {
                note.drop();
                if (err.name === 'AbortError' || err instanceof TypeError || /connection dropped/.test(err.message)) throw err;
                turn.compactFailures++;
                return false;
            }
            recordCost(res);
            summary = String(res.content || '').trim();
        }
        if (summary.length < CODE_COMPACT_MIN_CHARS) {
            note.drop();
            turn.compactFailures++;
            return false;
        }
        const context = modelContext(model);
        // The latest real user message stays verbatim, images and all, unless it's too big to keep.
        const lastIndex = messages.length - 1;
        const last = messages[lastIndex];
        const keepsUser = last && last.role === 'user' && estimateTokens([last]) < context * CODE_COMPACT_KEEP;
        conversationCompaction = { summary, through: keepsUser ? lastIndex : messages.length };
        history = [history[0]].concat(toApiMessages(messages, model, { tools: true }));
        trace = compactionTail(trace, context * CODE_COMPACT_KEEP);
        turn.used = null;
        note.keep('Compacted earlier work to save context');
        checkpoint();
        return true;
    };

    // Saved before the first step too, so a page closed during it comes back to this chat.
    if (!from) checkpoint();

    try {
    for (let step = Math.min(steps, CODE_MAX_STEPS - 1); step < CODE_MAX_STEPS; step++) {
        const used = turn.used ?? estimateTokens(history.concat(trace));
        if (used >= modelContext(model) * CODE_COMPACT_AT && turn.compactFailures < CODE_COMPACT_MAX_FAILURES) {
            await compact(false);
        }
        const lastStep = step === CODE_MAX_STEPS - 1;
        let segment = view.textSegment();
        let res;
        for (;;) {
            const body = baseBody();
            body.messages = history.concat(trace);
            if (lastStep) body.tool_choice = 'none';
            try {
                res = await completeStep(body, signal, segment, true);
                break;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                // Once: compact, then ask again.
                if (!turn.overflowTried && contextTooLong(err.message)) {
                    turn.overflowTried = true;
                    segment.drop();
                    if (!(await compact(true))) throw err;
                    segment = view.textSegment();
                    continue;
                }
                // Still failing: the model hears about it and can do something different.
                if (trace.length === 0 || turn.fedBack >= CODE_MAX_FED_BACK || !worthRetrying(err.message)) throw err;
                turn.fedBack++;
                segment.drop();
                trace.push({ role: 'user', content: 'The last request to the model failed with this error:\n\n' + sanitizeErrorMessage(err.message) + '\n\nIf something you sent caused it, change that, and carry on.' });
                checkpoint();
                segment = view.textSegment();
            }
        }
        recordCost(res);
        const u = res.usage;
        turn.used = u && Number.isFinite(Number(u.prompt_tokens)) ? Number(u.prompt_tokens) + (Number(u.completion_tokens) || 0) : null;
        const runs = res.toolCalls.filter(Boolean);
        // A tool call it wrote out but nobody can read: back to the model to make it properly.
        if (runs.length === 0 && writtenCall(res.content) && turn.repairs < CODE_MAX_REPAIRS && !lastStep) {
            turn.repairs++;
            steps += 1;
            segment.drop();
            trace.push({ role: 'assistant', content: res.content });
            trace.push({ role: 'user', content: 'That tool call was written out as text, so it did not run. Call the run_code tool itself, with JSON arguments {"language": "python" | "javascript", "code": "..."}.' });
            checkpoint();
            continue;
        }
        segment.render(res.content, res.reasoning);
        if (runs.length === 0) {
            finalContent = res.content || res.reasoning.trim();
            finalReasoningDetails = res.reasoningDetails;
            break;
        }
        steps += 1;
        const assistantTurn = { role: 'assistant', content: res.content || null, tool_calls: runs };
        if (res.reasoningDetails.length) assistantTurn.reasoning_details = res.reasoningDetails;
        trace.push(assistantTurn);
        checkpoint();

        for (const call of runs) {
            let result;
            if (call.function.name !== 'run_code') {
                result = 'There is no tool named "' + call.function.name + '". The only tool is run_code.';
            } else {
                let args;
                try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { args = null; }
                if (!args || typeof args.code !== 'string') {
                    result = 'run_code needs JSON arguments {"language": "python" | "javascript", "code": "..."}.';
                } else {
                    const language = String(args.language || 'python').toLowerCase();
                    const block = view.runBlock(language, args.code);
                    result = await executeCodeRun({ language, code: args.code }, block, turn, signal);
                }
            }
            trace.push({ role: 'tool', content: result, tool_call_id: call.id });
            checkpoint();
            if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
        }
    }
    } catch (err) {
        // With nothing done yet, this is an ordinary error. Otherwise the work stays.
        const partial = err.partial || '';
        if (!from && trace.length === 0 && !partial) throw err;
        clearInterval(loadInterval);
        responseElement.querySelectorAll('.code-turn-pending').forEach((n) => n.remove());
        const reason = err.name === 'AbortError' ? 'you stopped it.' : sanitizeErrorMessage(err.message);
        const stopped = stoppedMessage(reason, partial);
        messages.push(stopped);
        rawContentStore[uniqueId] = messages[messages.length - 1].display;
        showInterrupted(responseElement, reason);
        saveCurrentConversation();
        return;
    }

    attachHtmlPreviews(responseElement, view.pages);
    rawContentStore[uniqueId] = display();
    const assistantMessage = {
        role: 'assistant',
        content: finalContent || '(no answer)',
        display: display(),
        trace,
        model,
        modelLabel: label,
        ...progress(),
    };
    if (finalReasoningDetails.length) assistantMessage.reasoning_details = finalReasoningDetails;
    messages.push(assistantMessage);
    // Verified only if every model request of the answer is.
    if (turn.teeChecks.length && typeof verifyReplyInBackground === 'function') {
        const fromSteps = (from && from.tee && Array.isArray(from.tee.steps)) ? from.tee.steps : [];
        verifyReplyInBackground(assistantMessage, responseElement, turn.teeChecks, fromSteps);
    }
}

// What a verified reply costs here: our prices for its tokens (its own usage names the host's).
function teeReplyCost(model, usage) {
    const info = typeof _allModels !== 'undefined' ? _allModels.find((m) => m.id === model) : null;
    if (!info || !info.pricing || !usage) return 0;
    return (Number(usage.prompt_tokens) || 0) * Number(info.pricing.prompt || 0)
        + (Number(usage.completion_tokens) || 0) * Number(info.pricing.completion || 0);
}
