/**
 * llama-bridge.js — JavaScript wrapper around the Emscripten llama.cpp WASM module.
 *
 * Provides async model loading, streaming completion, and lifecycle management.
 * The Emscripten module is loaded once; GGUF model bytes are written to MEMFS
 * then loaded by llama.cpp's native file-based API.
 */

let _module = null;
let _initPromise = null;

/**
 * Initialize the Emscripten llama.cpp module.
 * Safe to call multiple times — returns the same promise.
 *
 * @returns {Promise<object>} The initialized Emscripten module
 */
export async function initLlama() {
    if (_module) return _module;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        // Dynamic import of the Emscripten glue JS
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
    })();

    const result = await _initPromise;
    return result;
}

/**
 * Load a GGUF model from an ArrayBuffer.
 *
 * Writes the bytes to Emscripten's MEMFS virtual filesystem, then calls
 * the C function that loads from file path. This avoids stackAlloc limits
 * that prevent passing large buffers (300MB+) through ccall's 'array' type.
 *
 * @param {ArrayBuffer} ggufData - The raw GGUF file bytes
 * @param {number} [nGpuLayers=0] - Number of layers to offload to GPU (0 for CPU-only)
 * @returns {number} Model handle (0-7), or throws on failure
 */
export function loadModelFromBuffer(ggufData, nGpuLayers = 0) {
    if (!_module) throw new Error('llama-bridge not initialized');

    const bytes = new Uint8Array(ggufData);
    const memfsPath = '/tmp/model_upload.gguf';

    // Write GGUF bytes directly to MEMFS via Emscripten's FS API
    _module.FS.writeFile(memfsPath, bytes);

    // Load from MEMFS path — C side calls llama_model_load_from_file then removes the file
    const handle = _module.ccall(
        'llama_bridge_load_model_from_path',
        'number',
        ['string', 'number'],
        [memfsPath, nGpuLayers]
    );

    if (handle < 0) {
        // Clean up file if C side didn't
        try { _module.FS.unlink(memfsPath); } catch (_) {}
        throw new Error('Failed to load GGUF model — file may be corrupt or unsupported');
    }

    return handle;
}

/**
 * Unload a model by handle.
 *
 * @param {number} handle - Model handle from loadModelFromBuffer
 */
export function unloadModel(handle) {
    if (!_module) return;
    _module.ccall('llama_bridge_unload_model', null, ['number'], [handle]);
}

/**
 * Run streaming completion. Calls onToken for each generated token.
 *
 * @param {number} handle - Model handle
 * @param {string} prompt - The formatted prompt string
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=512]
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.topP=0.9]
 * @param {function} onToken - Called with (text: string, done: boolean)
 * @returns {number} 0 on success, -1 on failure
 */
export function complete(handle, prompt, opts = {}, onToken) {
    if (!_module) throw new Error('llama-bridge not initialized');

    const maxTokens = opts.maxTokens || 512;
    const temperature = opts.temperature || 0.7;
    const topP = opts.topP || 0.9;

    // Create a C function pointer for the token callback
    const callbackPtr = _module.addFunction((textPtr, done) => {
        const text = _module.UTF8ToString(textPtr);
        onToken(text, !!done);
    }, 'vii');

    const result = _module.ccall(
        'llama_bridge_complete',
        'number',
        ['number', 'string', 'number', 'number', 'number', 'number'],
        [handle, prompt, maxTokens, temperature, topP, callbackPtr]
    );

    _module.removeFunction(callbackPtr);

    return result;
}

// GGUF downloads are kept in Cache Storage so a model is only fetched once,
// not every time the page loads.
const MODEL_CACHE = 'bak-gguf-v1';

async function openModelCache() {
    if (typeof caches === 'undefined') return null;
    try {
        return await caches.open(MODEL_CACHE);
    } catch {
        return null; // e.g. storage disabled in private browsing
    }
}

/**
 * Download a GGUF file from a URL with progress reporting, reading it from
 * the browser cache when it has been downloaded before.
 *
 * @param {string} url - URL to the GGUF file
 * @param {function} [onProgress] - Called with {downloaded, total, progress, cached}
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<ArrayBuffer>} The downloaded GGUF bytes
 */
export async function downloadGguf(url, onProgress, signal) {
    const cache = await openModelCache();
    const cachedResponse = cache ? await cache.match(url) : undefined;
    const cached = Boolean(cachedResponse);

    let response = cachedResponse;
    let cacheWrite = null;
    if (!response) {
        response = await fetch(url, { signal });
        if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        if (cache) {
            // Stream to the cache while reading; a failed or aborted download
            // errors the cache write too, so partial files are never stored.
            const [toCache, toRead] = response.body.tee();
            cacheWrite = cache
                .put(url, new Response(toCache, { headers: response.headers }))
                .catch(() => {}); // quota exceeded etc. — just don't cache
            response = new Response(toRead, { headers: response.headers });
        }
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let downloaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        downloaded += value.length;

        if (onProgress) {
            onProgress({
                downloaded,
                total: contentLength || null,
                progress: contentLength > 0 ? downloaded / contentLength : 0,
                cached,
            });
        }
    }

    // Concatenate chunks into a single ArrayBuffer
    const result = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    await cacheWrite;
    return result.buffer;
}

/**
 * Remove a previously downloaded GGUF file from the browser cache.
 *
 * @param {string} url - URL the file was downloaded from
 */
export async function deleteCachedGguf(url) {
    const cache = await openModelCache();
    if (cache) await cache.delete(url);
}
