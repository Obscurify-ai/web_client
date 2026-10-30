// chat-code.js — Code Mode. The model gets one tool, run_code; its Python or JavaScript
// runs on this device in a sandboxed frame from a separate origin (see
// sandbox/runner.js), never in this page. Code reaches the outside world only through
// `tools.*`, which comes back here over a MessagePort: web search, and paid tools billed
// to the account balance within fixed budgets.
//
// A Code Mode reply is an agent loop: stream a completion; if it asks to run code, run
// it, send the result back, and repeat until the model answers in words. The whole loop
// is stored as one assistant message (`trace` holds the tool turns for replay).

const CODE_MAX_STEPS = 10;            // model calls per reply
const CODE_RUN_TIMEOUT_MS = 180000;   // one run, tool calls included
const CODE_MAX_TOOL_CALLS = 40;       // per run

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
        .then((c) => { if (c && c.enabled) codeServer = c; })
        .catch(() => {});
}

// Code and tools are simply how chat works wherever the server offers them: no switches.
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

// Local models, models that can't call tools, and a server without Code Mode get plain chat.
function codeModeActive() {
    const local = typeof isLocalMode !== 'undefined' && isLocalMode;
    const model = typeof modelSelect !== 'undefined' && modelSelect ? modelSelect.value : '';
    return codeModeAvailable() && Boolean(codeServer) && !local && selectedModelSupportsTools(model);
}

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
            const result = { ok: false, value: null, error: null, stdout: '', stderr: '', images: 0, pages: 0, timedOut: false, ms: 0 };
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
            const timer = setTimeout(() => {
                this.reset();
                finish({ ok: false, timedOut: true, error: 'Timed out after ' + Math.round(timeoutMs / 1000) + ' seconds. The sandbox was restarted, so Python state was lost.' });
            }, timeoutMs);
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
                            if (typeof msg.dataUrl === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(msg.dataUrl) && msg.dataUrl.length < 8 * 1024 * 1024) {
                                result.images += 1;
                                hooks.onImage(msg.dataUrl);
                            }
                            break;
                        case 'html':
                            if (typeof msg.html === 'string') {
                                result.pages += 1;
                                hooks.onHtml(msg.html, String(msg.title || ''));
                            }
                            break;
                        case 'tool':
                            Promise.resolve()
                                .then(() => hooks.onTool(String(msg.name || ''), msg.args || {}))
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

const HTML_PREVIEW_MAX = 3;          // per reply
const HTML_PREVIEW_MAX_CHARS = 2 * 1024 * 1024;

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

async function codeToolRequest(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = await getCSRFToken();
    if (token) headers['X-CSRF-Token'] = token;
    const response = await fetch(getConfig().api.baseUrl + path, {
        method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch (_) { /* not JSON */ }
    if (!response.ok) {
        const message = data && (data.error || data.detail || data.message);
        throw new Error(typeof message === 'string' ? message : 'Request failed (' + response.status + ')');
    }
    return data;
}

// One streamed completion. Returns the text, reasoning and any tool calls it made.
async function streamCodeCompletion(body, signal, onUpdate) {
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    const config = getConfig();
    const endpoint = config.api.baseUrl + (loggedIn ? config.api.chatEndpoint : config.api.anonChatEndpoint);
    for (let attempt = 0; ; attempt++) {
        const headers = { 'Content-Type': 'application/json' };
        if (loggedIn) {
            const token = await getCSRFToken();
            if (token) headers['X-CSRF-Token'] = token;
        }
        const response = await fetch(endpoint, {
            method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body), signal,
        });
        if (response.status === 429 && attempt === 0) {
            const wait = Math.min(parseInt(response.headers.get('Retry-After') || '10', 10) || 10, 30);
            onUpdate(null, null, 'Waiting ' + wait + 's for the rate limit…');
            await new Promise((r) => setTimeout(r, wait * 1000));
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

async function readCodeStream(response, onUpdate) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const out = { content: '', reasoning: '', reasoningDetails: [], toolCalls: [], finishReason: null };
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
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) out.content = mergeStreamingText(out.content, delta.content);
        if (typeof delta.reasoning === 'string' && delta.reasoning) out.reasoning = mergeStreamingText(out.reasoning, delta.reasoning);
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
        const { value, done } = await reader.read();
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
    out.toolCalls = calls.filter(Boolean).map((c, i) => Object.assign(c, { id: c.id || ('call_' + Date.now().toString(36) + '_' + i) }));
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
    constructor(root) {
        this.root = root;
        this.root.textContent = '';
        this.root.classList.add('code-turn');
        this.parts = [];   // for the saved markdown
        this.pages = [];   // HTML shown by code in this reply
    }

    textSegment() {
        const node = el('div', 'code-turn-text');
        const pending = el('div', 'code-turn-pending');
        pending.setAttribute('aria-label', 'Thinking');
        this.root.append(node, pending);
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
        };
    }

    runBlock(language, code) {
        const label = language === 'javascript' || language === 'js' ? 'JavaScript' : 'Python';
        const part = { kind: 'run', label, code, output: '', cost: 0, images: 0, pages: 0, error: null, tools: [] };
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
            const head = ['**Ran ' + p.label + '**'];
            if (p.cost) head.push(formatUsd(p.cost) + ' in paid tools');
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
            remaining_usd: turn.paidTools ? Number(Math.max(turn.budget - turn.spent, 0).toFixed(6)) : 0,
            per_call_max_usd: turn.paidTools ? turn.perCall : 0,
        };
    }
    const chip = block.tool(name, detail);
    const log = { name, detail, ok: false, cost: 0 };
    toolLog.push(log);
    try {
        let value;
        if (name === 'web_search') {
            if (!turn.webSearch) throw new Error('Web search is not available.');
            value = await codeToolRequest('/web/tools/web_search', { query: String(args.query || '') });
        } else if (name === 'search' || name === 'inspect' || name === 'call') {
            if (!turn.paidTools) {
                throw new Error(paidToolsAvailable()
                    ? 'Paid tools are not available right now.'
                    : 'Paid tools need a signed-in Obscurify account.');
            }
            if (name === 'search') {
                value = (await codeToolRequest('/web/tools/search', { query: String(args.query || ''), limit: args.limit || 8 })).tools;
            } else if (name === 'inspect') {
                value = await codeToolRequest('/web/tools/inspect', { id: String(args.id || '') });
            } else {
                const remaining = turn.budget - turn.spent;
                if (remaining < 0.000001) throw new Error('The paid-tool budget for this reply ($' + turn.budget.toFixed(2) + ') is used up.');
                const asked = Number(args.max_cost_usd);
                const max = Math.min(turn.perCall, remaining, asked > 0 ? asked : turn.perCall);
                value = await codeToolRequest('/web/tools/call', { id: String(args.id || ''), input: args.input || {}, max_cost_usd: Number(max.toFixed(6)) });
                log.cost = Number(value.cost_usd) || 0;
                turn.spent += log.cost;
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
    const run = await getCodeSandbox().run(args.language, args.code, {
        signal,
        onOutput: (text, stream) => block.output(text, stream),
        onStatus: (text) => block.status(text),
        onImage: (url) => block.image(url),
        onHtml: (html, title) => block.page(html, title),
        onTool: (name, toolArgs) => handleSandboxTool(name, toolArgs, turn, block, toolLog),
    });
    block.finish(run);
    return formatRunForModel(run, toolLog, turn.resultChars);
}

// ---- the agent loop -------------------------------------------------------------------

async function runCodeTurn({ model, uniqueId, responseElement }) {
    const signal = currentAbortController ? currentAbortController.signal : undefined;
    // The loading dots write into the reply element; the turn view owns it from here.
    clearInterval(loadInterval);
    responseElement.style.color = '';
    const turn = {
        paidTools: Boolean(codeServer.paid_tools),
        webSearch: Boolean(codeServer.web_search),
        budget: Number(codeServer.reply_budget_usd) || 0,
        perCall: Math.min(Number(codeServer.per_call_usd) || 0, Number(codeServer.reply_budget_usd) || 0),
        resultChars: Number(codeServer.result_chars) || 12000,
        spent: 0,
    };
    const history = [{ role: 'system', content: codeServer.system_prompt }].concat(toApiMessages(messages, model, { tools: true }));
    const trace = [];
    const view = new CodeTurnView(responseElement);
    let finalContent = '';
    let finalReasoningDetails = [];

    for (let step = 0; step < CODE_MAX_STEPS; step++) {
        const segment = view.textSegment();
        const lastStep = step === CODE_MAX_STEPS - 1;
        const body = {
            model,
            messages: history.concat(trace),
            stream: true,
            tools: [codeServer.run_code_tool],
            ...(lastStep && { tool_choice: 'none' }),
        };
        const res = await streamCodeCompletion(body, signal, (content, reasoning, note) => {
            if (content || reasoning || note) segment.render(content, reasoning, note);
        });
        const runs = res.toolCalls.filter(Boolean);
        segment.render(res.content, res.reasoning);
        if (runs.length === 0) {
            finalContent = res.content || res.reasoning.trim();
            finalReasoningDetails = res.reasoningDetails;
            break;
        }
        const assistantTurn = { role: 'assistant', content: res.content || null, tool_calls: runs };
        if (res.reasoningDetails.length) assistantTurn.reasoning_details = res.reasoningDetails;
        trace.push(assistantTurn);

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
            trace.push({ role: 'tool', tool_call_id: call.id, content: result });
            if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
        }
    }

    attachHtmlPreviews(responseElement, view.pages);
    const display = view.markdown();
    rawContentStore[uniqueId] = display;
    const assistantMessage = {
        role: 'assistant',
        content: finalContent || '(no answer)',
        display,
        trace,
        model,
        modelLabel: model.includes('/') ? model.split('/').pop() : model,
    };
    if (finalReasoningDetails.length) assistantMessage.reasoning_details = finalReasoningDetails;
    messages.push(assistantMessage);
}
