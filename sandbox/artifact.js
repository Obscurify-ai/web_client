// Code Mode artifact frame: renders one page of model-written HTML. Its origin is
// opaque and its CSP allows inline script and data: images but no network, so a page
// can be interactive without being able to send anything anywhere. The chat page's
// frame-src blocks it from navigating itself to another site. In the Android app it is the
// top level of a WebView of its own and the page arrives from the app as JSON text.
'use strict';
(function () {
    let rendered = false;

    // The content's height, not the document's: scrollHeight never drops below the frame
    // itself, so a page sized to the viewport would grow the frame on every report.
    function contentHeight() {
        const body = document.body;
        if (!body) return 0;
        let bottom = 0;
        for (const child of body.children) {
            const r = child.getBoundingClientRect();
            const margin = parseFloat(getComputedStyle(child).marginBottom) || 0;
            bottom = Math.max(bottom, r.bottom + margin);
        }
        const style = getComputedStyle(body);
        return Math.ceil(bottom + window.scrollY + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.marginBottom) || 0));
    }

    function reportHeight() {
        if (window.parent === window) return;
        window.parent.postMessage({ type: 'artifact_height', height: contentHeight() }, '*');
    }

    const native = window.parent === window;
    window.addEventListener('message', (e) => {
        if (rendered || (native ? e.source !== null : e.source !== window.parent)) return;
        let d = e.data;
        if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch (_) { return; }
        }
        if (!d || d.type !== 'render' || typeof d.html !== 'string') return;
        rendered = true;
        document.open();
        document.write(d.html);
        document.close();
        if (typeof ResizeObserver === 'function' && document.documentElement) {
            const observer = new ResizeObserver(reportHeight);
            observer.observe(document.documentElement);
            if (document.body) observer.observe(document.body);
        }
        setTimeout(reportHeight, 50);
    });
    if (window.parent !== window) window.parent.postMessage({ type: 'artifact_ready' }, '*');
})();
