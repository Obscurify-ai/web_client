// Code Mode runner. This page lives in an opaque-origin frame on the sandbox host: no
// cookies, no storage, and a CSP with no network beyond the vendored runtime. It starts
// the Worker that runs the model's code and relays messages between that Worker and the
// chat page over the one MessagePort the chat page hands it. "reset" kills the Worker
// (a runaway loop, a timeout) and starts a fresh one.
//
// In the Android app the page is the top level of a WebView of its own, and the port comes
// from the app (a native message, with no source window); messages then travel as JSON text.
'use strict';
(function () {
    const base = new URL('./', location.href).href;
    const native = window.parent === window;
    const parse = (d) => (typeof d === 'string' ? JSON.parse(d) : d);
    const out = (d) => (native ? JSON.stringify(d) : d);
    let port = null;
    let worker = null;

    function startWorker() {
        if (worker) worker.terminate();
        // An opaque origin can only start a Worker from a blob: URL; it pulls in the real
        // script from this host.
        const src = 'self.SANDBOX_BASE = ' + JSON.stringify(base) + ';\n' +
            'importScripts(' + JSON.stringify(base + 'worker.js') + ');\n';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = (e) => { if (port) port.postMessage(out(e.data)); };
        worker.onerror = (e) => {
            if (port) port.postMessage(out({ type: 'fatal', message: (e && e.message) || 'The sandbox worker crashed.' }));
        };
    }

    window.addEventListener('message', (e) => {
        if (port) return;
        // In a frame, only the page that embeds us; at the top level, only the app.
        if (native ? e.source !== null : e.source !== window.parent) return;
        let d;
        try { d = parse(e.data); } catch (_) { return; }
        if (!d || d.type !== 'init' || !e.ports || !e.ports[0]) return;
        port = e.ports[0];
        port.onmessage = (m) => {
            let msg;
            try { msg = parse(m.data) || {}; } catch (_) { return; }
            if (msg.type === 'reset') {
                startWorker();
                port.postMessage(out({ type: 'reset_done' }));
                return;
            }
            if (worker) worker.postMessage(msg);
        };
        startWorker();
        port.postMessage(out({ type: 'ready' }));
    });
})();
