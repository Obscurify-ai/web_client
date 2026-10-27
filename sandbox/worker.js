// Code Mode worker: runs the model's Python (Pyodide, in WebAssembly) or JavaScript.
//
// It has no DOM, and the runner page's CSP leaves it no network except the vendored
// runtime on this host. Everything else goes through `tools`, which asks the chat page;
// the chat page decides what is allowed and what it may cost.
//
// Protocol (the chat page talks to this worker through the runner's MessagePort):
//   in:  {type:'run', runId, language:'python'|'javascript', code}
//        {type:'tool_result', callId, ok, value, error}
//   out: {type:'stdout'|'stderr', runId, text}
//        {type:'tool', runId, callId, name, args}
//        {type:'image', runId, dataUrl}            (PNG)
//        {type:'html', runId, html, title}          (an artifact to render)
//        {type:'status', runId, text}               (e.g. "Loading Python…")
//        {type:'done', runId, ok, value, error}
'use strict';

const BASE = self.SANDBOX_BASE;
const PYODIDE_URL = BASE + 'vendor/pyodide-314.0.7/';
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// ---- no network but the runtime -------------------------------------------------------
// The CSP is what enforces this; these just turn a blocked request into a clear message.
const realFetch = self.fetch.bind(self);
const NETWORK_BLOCKED = 'Network access is blocked in the sandbox. Use tools.web_search() or tools.call() instead.';
self.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    let url;
    try { url = new URL(raw, PYODIDE_URL).href; } catch (_) { url = ''; }
    if (!url.startsWith(PYODIDE_URL)) return Promise.reject(new TypeError(NETWORK_BLOCKED));
    return realFetch(input, init);
};
for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport']) {
    try {
        Object.defineProperty(self, name, {
            value: function () { throw new TypeError(NETWORK_BLOCKED); },
            configurable: false, writable: false,
        });
    } catch (_) { /* not present in this browser */ }
}

// ---- talking to the chat page ---------------------------------------------------------
let currentRun = null;
let nextCallId = 1;
const pendingCalls = new Map();

function post(msg) { self.postMessage(msg); }

function toPlain(value) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function callHost(name, args) {
    if (currentRun === null) return Promise.reject(new Error('tools can only be used while code is running'));
    const callId = nextCallId++;
    return new Promise((resolve, reject) => {
        pendingCalls.set(callId, { resolve, reject });
        post({ type: 'tool', runId: currentRun, callId, name, args: toPlain(args || {}) });
    });
}

function displayHtml(html, title) {
    const text = String(html == null ? '' : html);
    if (text.length > MAX_HTML_BYTES) throw new Error('display_html: the page is larger than 2 MB');
    post({ type: 'html', runId: currentRun, html: text, title: title ? String(title) : '' });
}

function displayImage(dataUrl) {
    const s = String(dataUrl || '');
    if (!/^data:image\/(png|jpeg);base64,/.test(s)) throw new Error('display_image needs a PNG or JPEG data URL');
    post({ type: 'image', runId: currentRun, dataUrl: s });
}

const tools = Object.freeze({
    web_search: (query) => callHost('web_search', { query }),
    search: (query, limit) => callHost('search', { query, limit }),
    inspect: (id) => callHost('inspect', { id }),
    call: (id, input, options) => callHost('call', {
        id, input: input || {}, max_cost_usd: options && options.max_cost_usd,
    }),
    budget: () => callHost('budget', {}),
});

function format(value) {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

function makeConsole(runId) {
    const write = (stream) => (...args) => post({
        type: stream, runId,
        text: args.map((a) => (typeof a === 'string' ? a : format(a))).join(' ') + '\n',
    });
    return Object.freeze({
        log: write('stdout'), info: write('stdout'), debug: write('stdout'),
        warn: write('stderr'), error: write('stderr'),
        table: (rows) => write('stdout')(rows),
    });
}

// ---- JavaScript -----------------------------------------------------------------------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runJavaScript(runId, code) {
    const fn = new AsyncFunction('tools', 'console', 'display_html', 'display_image', code);
    return format(await fn(tools, makeConsole(runId), displayHtml, displayImage));
}

// ---- Python ---------------------------------------------------------------------------
const PY_PRELUDE = `
import json as _json, sys as _sys, warnings as _warnings
import _obscurify
_warnings.filterwarnings("ignore", message=".*non-interactive.*")

class ToolError(Exception):
    pass

class _Tools:
    async def _call(self, name, **kw):
        out = _json.loads(await _obscurify.call(name, _json.dumps(kw, default=str)))
        if isinstance(out, dict) and "__tool_error__" in out:
            raise ToolError(out["__tool_error__"])
        return out
    async def web_search(self, query):
        return await self._call("web_search", query=query)
    async def search(self, query, limit=8):
        return await self._call("search", query=query, limit=limit)
    async def inspect(self, id):
        return await self._call("inspect", id=id)
    async def call(self, id, input=None, max_cost_usd=None):
        return await self._call("call", id=id, input=input or {}, max_cost_usd=max_cost_usd)
    async def budget(self):
        return await self._call("budget")

tools = _Tools()

def display_html(html, title=None):
    _obscurify.html(str(html), title or "")

def _flush_figures():
    if "matplotlib.pyplot" not in _sys.modules:
        return
    import base64, io
    import matplotlib.pyplot as plt
    with _warnings.catch_warnings():
        # Saving can warn about things in the user's plot; they saw their own warnings already.
        _warnings.simplefilter("ignore")
        for num in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
            _obscurify.image(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
`;

let pyodidePromise = null;

function getPyodide(runId) {
    if (!pyodidePromise) {
        post({ type: 'status', runId, text: 'Loading Python…' });
        pyodidePromise = (async () => {
            importScripts(PYODIDE_URL + 'pyodide.js');
            const py = await self.loadPyodide({ indexURL: PYODIDE_URL, env: { MPLBACKEND: 'Agg' } });
            py.setStdout({ batched: (text) => post({ type: 'stdout', runId: currentRun, text: text + '\n' }) });
            py.setStderr({ batched: (text) => post({ type: 'stderr', runId: currentRun, text: text + '\n' }) });
            py.registerJsModule('_obscurify', {
                call: async (name, argsJson) => {
                    try {
                        return JSON.stringify(toPlain(await callHost(String(name), JSON.parse(String(argsJson)))));
                    } catch (err) {
                        return JSON.stringify({ __tool_error__: String((err && err.message) || err) });
                    }
                },
                html: (html, title) => displayHtml(html, title),
                image: (b64) => displayImage('data:image/png;base64,' + String(b64)),
            });
            await py.runPythonAsync(PY_PRELUDE);
            return py;
        })();
        pyodidePromise.catch(() => { pyodidePromise = null; });
    }
    return pyodidePromise;
}

async function runPython(runId, code) {
    const py = await getPyodide(runId);
    await py.loadPackagesFromImports(code, {
        messageCallback: () => {},
        errorCallback: (m) => post({ type: 'stderr', runId, text: String(m) + '\n' }),
    });
    let result;
    try {
        result = await py.runPythonAsync(code);
    } finally {
        try { await py.runPythonAsync('_flush_figures()'); } catch (_) { /* figures are best effort */ }
    }
    if (result === undefined || result === null) return undefined;
    if (typeof result === 'object' && typeof result.toJs === 'function') {
        const text = py.globals.get('repr')(result);
        result.destroy();
        return text;
    }
    return format(result);
}

// ---- messages -------------------------------------------------------------------------
self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.type === 'tool_result') {
        const pending = pendingCalls.get(msg.callId);
        if (!pending) return;
        pendingCalls.delete(msg.callId);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error || 'tool call failed'));
        return;
    }
    if (msg.type !== 'run') return;
    if (currentRun !== null) {
        post({ type: 'done', runId: msg.runId, ok: false, error: 'Another run is still in progress.' });
        return;
    }
    currentRun = msg.runId;
    try {
        const language = String(msg.language || '').toLowerCase();
        let value;
        if (language === 'python' || language === 'py') value = await runPython(msg.runId, String(msg.code || ''));
        else if (language === 'javascript' || language === 'js') value = await runJavaScript(msg.runId, String(msg.code || ''));
        else throw new Error('language must be "python" or "javascript"');
        post({ type: 'done', runId: msg.runId, ok: true, value: value === undefined ? null : value });
    } catch (err) {
        const text = err && (err.type === 'PythonError' || err.constructor?.name === 'PythonError')
            ? String(err.message)
            : String((err && err.stack) || err);
        post({ type: 'done', runId: msg.runId, ok: false, error: text });
    } finally {
        currentRun = null;
        for (const [, p] of pendingCalls) p.reject(new Error('the run ended'));
        pendingCalls.clear();
    }
};
