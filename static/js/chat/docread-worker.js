// docread-worker.js — Reads one attached document off the page's thread with the Android app's
// parser built to wasm (static/vendor/docread, see scripts/vendor-docread.sh). Gets
// {name, bytes}, posts back {ok: Doc} or {err: "a sentence for the person"}.
importScripts('/static/vendor/docread/docread.js?v=1');
const ready = wasm_bindgen({ module_or_path: '/static/vendor/docread/docread_bg.wasm?v=1' });

self.onmessage = async (e) => {
    const { name, bytes } = e.data;
    try {
        await ready;
        self.postMessage(JSON.parse(wasm_bindgen.read(name, new Uint8Array(bytes))));
    } catch (_err) {
        // A parser panic aborts the wasm instance; the page starts a fresh worker for each file.
        self.postMessage({ err: `Couldn't read ${name}: the file looks damaged.` });
    }
};
