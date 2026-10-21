/**
 * llama-worker.js — Web Worker that runs llama.cpp inference off the main thread.
 *
 * Messages IN:
 *   { type: 'init' }
 *   { type: 'loadModel', id, ggufData: ArrayBuffer, nGpuLayers }
 *   { type: 'unloadModel', id, handle }
 *   { type: 'complete', id, handle, prompt, opts }
 *
 * Messages OUT:
 *   { type: 'init:done' }
 *   { type: 'init:error', error }
 *   { type: 'loadModel:done', id, handle }
 *   { type: 'loadModel:error', id, error }
 *   { type: 'unloadModel:done', id }
 *   { type: 'token', id, content, done }
 *   { type: 'complete:done', id }
 *   { type: 'complete:error', id, error }
 */

let _module = null;

async function initLlama() {
    if (_module) return _module;

    // Import the Emscripten glue — importScripts won't work for ES modules,
    // but Emscripten factory functions are typically UMD/IIFE compatible.
    // We use dynamic import which works in module workers.
    const glue = await import('/static/vendor/BrowserAgentKit/pkg/llama-cpp/llama_bridge.js');
    const factory = glue.default;
    if (typeof factory !== 'function') {
        throw new Error('llama_bridge.js did not export a factory function');
    }
    const mod = await factory();
    if (!mod || typeof mod.ccall !== 'function') {
        throw new Error('Emscripten module missing ccall — WASM init failed');
    }
    mod.ccall('llama_bridge_init', null, [], []);
    _module = mod;
    return mod;
}

self.onmessage = async (e) => {
    const msg = e.data;

    switch (msg.type) {
        case 'init': {
            try {
                await initLlama();
                self.postMessage({ type: 'init:done' });
            } catch (err) {
                self.postMessage({ type: 'init:error', error: err.message });
            }
            break;
        }

        case 'loadModel': {
            try {
                await initLlama();
                const bytes = new Uint8Array(msg.ggufData);
                const memfsPath = '/tmp/model_upload.gguf';
                _module.FS.writeFile(memfsPath, bytes);

                const handle = _module.ccall(
                    'llama_bridge_load_model_from_path',
                    'number',
                    ['string', 'number'],
                    [memfsPath, msg.nGpuLayers || 0]
                );

                if (handle < 0) {
                    try { _module.FS.unlink(memfsPath); } catch (_) {}
                    throw new Error('Failed to load GGUF model — file may be corrupt or unsupported');
                }

                self.postMessage({ type: 'loadModel:done', id: msg.id, handle });
            } catch (err) {
                self.postMessage({ type: 'loadModel:error', id: msg.id, error: err.message });
            }
            break;
        }

        case 'unloadModel': {
            if (_module) {
                _module.ccall('llama_bridge_unload_model', null, ['number'], [msg.handle]);
            }
            self.postMessage({ type: 'unloadModel:done', id: msg.id });
            break;
        }

        case 'complete': {
            try {
                if (!_module) throw new Error('llama-bridge not initialized');

                const maxTokens = msg.opts?.maxTokens || 512;
                const temperature = msg.opts?.temperature || 0.7;
                const topP = msg.opts?.topP || 0.9;

                const callbackPtr = _module.addFunction((textPtr, done) => {
                    const text = _module.UTF8ToString(textPtr);
                    self.postMessage({ type: 'token', id: msg.id, content: text, done: !!done });
                }, 'vii');

                _module.ccall(
                    'llama_bridge_complete',
                    'number',
                    ['number', 'string', 'number', 'number', 'number', 'number'],
                    [msg.handle, msg.prompt, maxTokens, temperature, topP, callbackPtr]
                );

                _module.removeFunction(callbackPtr);
                self.postMessage({ type: 'complete:done', id: msg.id });
            } catch (err) {
                self.postMessage({ type: 'complete:error', id: msg.id, error: err.message });
            }
            break;
        }
    }
};
