// P2P sharing worker: this tab serves a p2p model over WebGPU and earns
// credit for the signed-in account. Protocol: src/services/p2p.rs (ToWorker /
// FromWorker). One job at a time; the server never sends a second while busy.

const $ = (id) => document.getElementById(id);
const ui = {
    gpu: $('xc-gpu'), account: $('xc-account'), model: $('xc-model'),
    progress: $('xc-progress'), jobs: $('xc-jobs'), pending: $('xc-pending'),
    vested: $('xc-vested'), log: $('xc-log'), state: $('xc-state'),
    toggle: $('xc-toggle'), status: $('xc-status'),
};

let webllm = null;      // the engine module, loaded on first Start
let engine = null;      // MLCEngine with the chosen model loaded
let loadedModel = null; // p2p id of what `engine` holds
let socket = null;
let serving = false;
let current = null;     // id of the job being written
let jobs = 0;
let retry = 0;
let hasAccount = false;
let hasGpu = false;

function log(line) {
    const t = new Date().toLocaleTimeString();
    ui.log.textContent = `${t} ${line}\n` + ui.log.textContent.slice(0, 4000);
}

function setState(text) { ui.state.textContent = text; }

function usd(v) {
    const n = Number(v || 0);
    return n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}

function refreshButton() {
    ui.toggle.disabled = !(hasAccount && hasGpu);
    ui.toggle.textContent = serving ? 'Stop sharing' : 'Start sharing';
    ui.toggle.classList.toggle('stop', serving);
}

async function checkGpu() {
    if (!navigator.gpu) {
        ui.gpu.textContent = 'no WebGPU: this browser cannot serve';
        return;
    }
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) { ui.gpu.textContent = 'WebGPU is on, but no GPU was found'; return; }
        const info = adapter.info || {};
        ui.gpu.textContent = [info.vendor, info.architecture || info.description].filter(Boolean).join(' ') || 'WebGPU ready';
        hasGpu = true;
    } catch (e) {
        ui.gpu.textContent = 'WebGPU error: ' + e.message;
    }
}

async function refreshEarnings() {
    try {
        const r = await fetch('/sharing/earnings', { credentials: 'same-origin' });
        if (r.status === 401 || r.status === 403) {
            hasAccount = false;
            ui.account.innerHTML = '<a href="/signup">get an account number</a> to earn';
            return;
        }
        if (!r.ok) return;
        const e = await r.json();
        hasAccount = true;
        ui.account.textContent = `signed in, balance ${usd(e.balance)}`;
        ui.pending.textContent = usd(e.pending);
        ui.vested.textContent = usd(e.vested);
    } catch (_) { /* offline: keep what is shown */ }
}

async function refreshStatus() {
    try {
        const r = await fetch('/sharing/status');
        if (!r.ok) return;
        const s = await r.json();
        for (const m of s.per_model) {
            const row = ui.status.querySelector(`tr[data-model="${CSS.escape(m.id)}"] td:nth-child(2)`);
            if (row) row.textContent = String(m.workers);
        }
    } catch (_) { /* ignore */ }
}

function selected() {
    const opt = ui.model.selectedOptions[0];
    return { id: opt.value, engine: opt.dataset.engine };
}

async function loadModel() {
    const { id, engine: engineId } = selected();
    if (engine && loadedModel === id) return;
    setState('loading engine');
    webllm = webllm || await import('/static/vendor/web-llm/web-llm.js');
    if (engine) { await engine.unload(); engine = null; loadedModel = null; }
    setState('downloading');
    engine = await webllm.CreateMLCEngine(engineId, {
        initProgressCallback: (p) => {
            ui.progress.style.width = `${Math.round((p.progress || 0) * 100)}%`;
            setState(p.progress >= 1 ? 'warming up' : `loading ${Math.round((p.progress || 0) * 100)}%`);
        },
    });
    loadedModel = id;
    log(`${id} loaded`);
}

function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

async function runJob(job) {
    current = job.id;
    setState('serving a request');
    try {
        const chunks = await engine.chat.completions.create({
            messages: job.messages,
            stream: true,
            max_tokens: job.max_tokens,
            temperature: job.temperature,
            top_p: job.top_p ?? undefined,
            seed: job.seed ?? undefined,
            extra_body: { enable_thinking: false },
        });
        let finish = 'stop';
        // Qwen3.5 opens with a <think> block even with thinking off; the
        // caller asked for an answer, so hold back the start until it's past.
        let head = '';
        let inHead = true;
        for await (const c of chunks) {
            if (current !== job.id) break; // cancelled
            const choice = c.choices && c.choices[0];
            let text = choice && choice.delta && choice.delta.content;
            if (choice && choice.finish_reason) finish = choice.finish_reason;
            if (!text) continue;
            if (inHead) {
                head += text;
                const lead = head.trimStart();
                if ('<think>'.startsWith(lead)) continue;
                if (lead.startsWith('<think>')) {
                    const end = lead.indexOf('</think>');
                    if (end < 0) continue;
                    text = lead.slice(end + '</think>'.length).trimStart();
                } else {
                    text = lead;
                }
                inHead = false;
                if (!text) continue;
            }
            send({ type: 'delta', id: job.id, text });
        }
        if (current === job.id) {
            send({ type: 'done', id: job.id, finish_reason: finish });
            jobs += 1;
            ui.jobs.textContent = String(jobs);
        }
    } catch (e) {
        // The server stops sending jobs until this tab says it's ready again.
        send({ type: 'error', id: job.id, message: String(e && e.message || e) });
        log('a request failed: ' + (e && e.message || e));
        if (current === job.id) current = null;
        await recover();
        return;
    } finally {
        if (current === job.id) current = null;
    }
    if (serving) setState('waiting for requests');
}

// After a failed job, reload the model (a lost GPU device or out-of-memory leaves
// the engine unusable), then rejoin. If the model won't load, stop serving.
async function recover() {
    if (!serving) return;
    setState('reloading the model');
    const id = loadedModel;
    try {
        if (engine) { try { await engine.unload(); } catch (_) { /* already gone */ } }
        engine = null;
        loadedModel = null;
        await loadModel();
        send({ type: 'ready', models: [loadedModel] });
        setState('waiting for requests');
        log(`${id} reloaded`);
    } catch (e) {
        log('could not reload the model, so this tab stopped. The GPU may be short of memory: close other GPU apps or pick a smaller model. ' + (e && e.message || e));
        stop('reload failed');
    }
}

function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sharing/ws`;
    socket = new WebSocket(url);
    socket.onopen = () => {
        retry = 0;
        send({ type: 'ready', models: [loadedModel] });
        setState('waiting for requests');
        log('connected to P2P sharing');
    };
    socket.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        switch (msg.type) {
            case 'job':
                if (msg.model !== loadedModel || current) {
                    send({ type: 'error', id: msg.id, message: 'tab busy or model not loaded' });
                } else {
                    runJob(msg);
                }
                break;
            case 'cancel':
                if (current === msg.id) { current = null; engine.interruptGenerate(); }
                break;
            case 'earned':
                log(`earned ${usd(msg.amount)}`);
                refreshEarnings();
                break;
            case 'rejected':
                log(msg.reason);
                stop(msg.reason);
                break;
        }
    };
    socket.onclose = () => {
        socket = null;
        if (!serving) return;
        retry = Math.min(retry + 1, 6);
        const wait = 2 ** retry;
        setState(`reconnecting in ${wait}s`);
        setTimeout(() => { if (serving) connect(); }, wait * 1000);
    };
}

async function start() {
    serving = true;
    refreshButton();
    localStorage.setItem('obscurify_sharing_model', selected().id);
    try {
        await loadModel();
    } catch (e) {
        log('could not load the model: ' + (e && e.message || e));
        stop('could not load the model');
        return;
    }
    if (serving) connect();
}

function stop(reason) {
    serving = false;
    if (current && engine) { current = null; engine.interruptGenerate(); }
    if (socket) { socket.close(); socket = null; }
    setState(reason ? 'stopped' : 'idle');
    refreshButton();
}

ui.toggle.addEventListener('click', () => (serving ? stop() : start()));
ui.model.addEventListener('change', () => { if (serving) { stop(); start(); } });

const saved = localStorage.getItem('obscurify_sharing_model');
if (saved && [...ui.model.options].some((o) => o.value === saved)) ui.model.value = saved;

await Promise.all([checkGpu(), refreshEarnings(), refreshStatus()]);
refreshButton();
setInterval(refreshStatus, 15000);
setInterval(refreshEarnings, 60000);
