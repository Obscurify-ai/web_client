/**
 * WASM adapter — wraps llama.cpp WASM + bak-wasm catalog into the API surface
 * that chat.js (and other consumers) expect.
 *
 * Architecture:
 *   - bak-wasm (Rust→WASM): model catalog, hardware detection (main thread)
 *   - llama-bridge (Emscripten→WASM): GGUF model loading + inference (Web Worker)
 *
 * @module wasm-adapter
 */

import { downloadGguf, deleteCachedGguf } from './llama-bridge.js';

/**
 * Largest catalog model (by RAM estimate) offered in the browser. llama.cpp is
 * built for wasm32 with a 4GB memory ceiling (scripts/build-llama-wasm.sh),
 * and the weights, a 4096-token KV cache and compute buffers must all fit —
 * bigger models would fail only after a multi-GB download.
 */
export const MAX_BROWSER_MODEL_RAM_MB = 2500;

function fitsInBrowser(rawModel) {
    return rawModel.ram_mb <= MAX_BROWSER_MODEL_RAM_MB;
}

let _bakWasm = null;
let _catalogCache = null;
let _loadedModels = new Map(); // modelId → { handle, spec }
let _worker = null;
let _workerReady = false;
let _workerInitPromise = null;
let _pendingRequests = new Map(); // id → { resolve, reject }
let _nextRequestId = 1;

/**
 * Initialize the adapter with the bak-wasm Rust module.
 * Emscripten llama.cpp is initialized lazily on first model load.
 *
 * @param {object} bakWasmModule - The initialized bak_wasm module (Rust)
 */
export async function init(bakWasmModule) {
    _bakWasm = bakWasmModule;
}

/**
 * Launch and initialize the llama.cpp Web Worker.
 * Safe to call multiple times — returns the same promise.
 */
function ensureWorker() {
    if (_workerReady) return Promise.resolve(_worker);
    if (_workerInitPromise) return _workerInitPromise;

    _workerInitPromise = new Promise((resolve, reject) => {
        _worker = new Worker(
            '/static/vendor/BrowserAgentKit/src/llama-worker.js',
            { type: 'module' }
        );

        _worker.onmessage = handleWorkerMessage;
        _worker.onerror = (err) => {
            reject(new Error(`Worker error: ${err.message}`));
        };

        // Send init and wait for ready
        const initHandler = (e) => {
            if (e.data.type === 'init:done') {
                _workerReady = true;
                resolve(_worker);
            } else if (e.data.type === 'init:error') {
                reject(new Error(e.data.error));
            }
        };
        _worker.addEventListener('message', initHandler, { once: false });
        _worker.postMessage({ type: 'init' });

        // Replace with persistent handler once init completes
        const origOnMessage = _worker.onmessage;
        _worker.onmessage = (e) => {
            if (e.data.type === 'init:done' || e.data.type === 'init:error') {
                initHandler(e);
                _worker.onmessage = handleWorkerMessage;
                return;
            }
            handleWorkerMessage(e);
        };
    });

    return _workerInitPromise;
}

/**
 * Handle messages from the worker.
 */
function handleWorkerMessage(e) {
    const msg = e.data;
    const id = msg.id;

    if (msg.type === 'token') {
        // Streaming tokens are handled by the per-request token callback
        const req = _pendingRequests.get(id);
        if (req?.onToken) {
            req.onToken(msg.content, msg.done);
        }
        return;
    }

    if (msg.type === 'loadModel:done') {
        const req = _pendingRequests.get(id);
        _pendingRequests.delete(id);
        req?.resolve(msg.handle);
        return;
    }

    if (msg.type === 'loadModel:error') {
        const req = _pendingRequests.get(id);
        _pendingRequests.delete(id);
        req?.reject(new Error(msg.error));
        return;
    }

    if (msg.type === 'unloadModel:done') {
        const req = _pendingRequests.get(id);
        _pendingRequests.delete(id);
        req?.resolve();
        return;
    }

    if (msg.type === 'complete:done') {
        const req = _pendingRequests.get(id);
        _pendingRequests.delete(id);
        req?.resolve();
        return;
    }

    if (msg.type === 'complete:error') {
        const req = _pendingRequests.get(id);
        _pendingRequests.delete(id);
        req?.reject(new Error(msg.error));
        return;
    }
}

/**
 * Send a message to the worker and wait for the response.
 */
function workerRequest(msg, onToken) {
    const id = _nextRequestId++;
    return new Promise((resolve, reject) => {
        _pendingRequests.set(id, { resolve, reject, onToken });
        _worker.postMessage({ ...msg, id }, msg.transfer || []);
    });
}

function bak() {
    if (!_bakWasm) throw new Error('WASM adapter not initialized — call init() first');
    return _bakWasm;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function transformModel(m) {
    return {
        id: m.id,
        name: m.name,
        vram: `~${(m.ram_mb / 1000).toFixed(1)}GB`,
        vramMB: m.ram_mb,
        ramMb: m.ram_mb,
        sizeBytes: m.size_bytes ?? null,
        warning: m.warning ?? null,
        modelType: m.model_type ?? null,
    };
}

/**
 * Fetch the curated model catalog from the Rust WASM module.
 */
export async function fetchModelCatalog() {
    const raw = await bak().fetch_model_catalog();

    // Deduplicate models across categories (a model with model_type appears
    // in both its size category and a specialist category from the Rust catalog).
    const seen = new Set();
    const categories = (raw.categories || [])
        .map(cat => {
            const models = cat.models
                .filter(fitsInBrowser)
                .map(transformModel)
                .filter(m => {
                    if (seen.has(m.id)) return false;
                    seen.add(m.id);
                    return true;
                });
            return { key: cat.key, label: cat.label, models };
        })
        .filter(cat => cat.models.length > 0);

    const allModels = (raw.all_models || []).filter(fitsInBrowser).map(transformModel);

    const result = {
        categories,
        allModels,
        totalCount: allModels.length,
        fetchedAt: Date.now(),
    };

    _catalogCache = result;
    return result;
}

export function getCachedCatalog() {
    return _catalogCache;
}

export function findModel(modelId) {
    if (_catalogCache) {
        const found = _catalogCache.allModels.find(m => m.id === modelId);
        if (found) return found;
    }
    const raw = bak().find_model(modelId);
    return raw ? transformModel(raw) : null;
}

export function getModelDisplayName(modelId) {
    const model = findModel(modelId);
    if (model) return model.name;
    return modelId
        .replace(/-GGUF.*$/i, '')
        .replace(/-Q[0-4][_A-Z]*/gi, '')
        .replace(/-Instruct/gi, '')
        .replace(/[-_]/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// GPU support
// ---------------------------------------------------------------------------

export async function checkGPUSupport() {
    const caps = await bak().check_gpu_support();
    const supported = caps.gpu !== 'None';
    const result = { supported };
    if (supported) {
        result.gpu = caps.gpu_name || caps.gpu;
        result.info = `GPU: ${result.gpu}`;
    } else {
        result.reason = caps.message || 'No GPU detected — CPU inference only.';
    }
    return result;
}

// ---------------------------------------------------------------------------
// Model lifecycle (delegates to worker)
// ---------------------------------------------------------------------------

/**
 * Build a HuggingFace download URL for a GGUF file.
 */
function hfDownloadUrl(hfRepo, filename) {
    return `https://huggingface.co/${hfRepo}/resolve/main/${filename}`;
}

/**
 * Load a model by ID with progress reporting.
 * Downloads the GGUF file on the main thread, then transfers the buffer
 * to the worker for model loading (avoids blocking the UI).
 *
 * @param {string} modelId
 * @param {object} [options]
 * @param {function} [options.onProgress] - Called with {progress: 0-1, text: string}
 * @returns {Promise<void>}
 */
export async function loadModel(modelId, options = {}) {
    if (_loadedModels.has(modelId)) return;

    // Look up model spec from catalog
    const raw = bak().find_model(modelId);
    if (!raw) throw new Error(`Model not found in catalog: ${modelId}`);
    if (!fitsInBrowser(raw)) {
        throw new Error(`${raw.name} needs more memory than in-browser inference allows`);
    }

    const url = hfDownloadUrl(raw.hf_repo, raw.filename);

    // Download GGUF (main thread — needs progress UI)
    if (options.onProgress) {
        options.onProgress({ progress: 0, text: 'Downloading model...' });
    }

    const ggufData = await downloadGguf(url, (p) => {
        if (!options.onProgress) return;
        const pct = Math.round(p.progress * 100);
        const mb = (p.downloaded / (1024 * 1024)).toFixed(1);
        const totalMb = p.total ? (p.total / (1024 * 1024)).toFixed(1) : '?';
        const action = p.cached ? 'Loading from cache' : 'Downloading';
        options.onProgress({
            progress: p.progress * 0.9, // Reserve 10% for model loading
            text: `${action}: ${mb}MB / ${totalMb}MB (${pct}%)`,
        });
    });

    // Ensure worker is ready
    if (options.onProgress) {
        options.onProgress({ progress: 0.9, text: 'Initializing inference engine...' });
    }
    await ensureWorker();

    if (options.onProgress) {
        options.onProgress({ progress: 0.95, text: 'Loading model...' });
    }

    // Transfer the ArrayBuffer to the worker (zero-copy)
    const handle = await workerRequest({
        type: 'loadModel',
        ggufData,
        nGpuLayers: 0,
        transfer: [ggufData],
    });

    _loadedModels.set(modelId, { handle, spec: raw });

    if (options.onProgress) {
        options.onProgress({ progress: 1, text: 'Model loaded!' });
    }
}

export async function unloadModel(modelId) {
    const entry = _loadedModels.get(modelId);
    if (entry) {
        await ensureWorker();
        await workerRequest({ type: 'unloadModel', handle: entry.handle });
        _loadedModels.delete(modelId);
    }
}

/**
 * Delete a model's downloaded GGUF file from the browser cache.
 *
 * @param {string} modelId
 */
export async function deleteCachedModel(modelId) {
    const raw = bak().find_model(modelId);
    if (raw) await deleteCachedGguf(hfDownloadUrl(raw.hf_repo, raw.filename));
}

export function listLoadedModels() {
    return Array.from(_loadedModels.keys());
}

// ---------------------------------------------------------------------------
// Completion (delegates to worker)
// ---------------------------------------------------------------------------

/**
 * Normalize messages for local model consumption.
 */
export function formatMessages(messages) {
    return messages.map(msg => {
        if (typeof msg.content === 'string') {
            return { role: msg.role, content: msg.content };
        }
        if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(p => p.type === 'text');
            return { role: msg.role, content: textPart?.text || '' };
        }
        return { role: msg.role, content: '' };
    });
}

/**
 * Format messages into a ChatML prompt string.
 */
function formatChatPrompt(messages) {
    let prompt = '';
    for (const msg of messages) {
        if (['system', 'user', 'assistant'].includes(msg.role)) {
            prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
        }
    }
    prompt += '<|im_start|>assistant\n';
    return prompt;
}

/**
 * Run a single-shot completion (non-streaming, but off main thread).
 */
export async function complete(modelId, options = {}) {
    const entry = _loadedModels.get(modelId);
    if (!entry) throw new Error(`Model not loaded: ${modelId}`);
    await ensureWorker();

    const formatted = formatMessages(options.messages || []);
    const prompt = formatChatPrompt(formatted);

    let result = '';
    await workerRequest({
        type: 'complete',
        handle: entry.handle,
        prompt,
        opts: {
            maxTokens: options.maxTokens || 512,
            temperature: options.temperature || 0.7,
            topP: options.topP || 0.9,
        },
    }, (text, done) => {
        if (!done) result += text;
    });

    return result;
}

/**
 * Streaming completion as an async generator.
 * Inference runs in a Web Worker — tokens are yielded as they arrive
 * via postMessage, keeping the main thread responsive.
 *
 * @param {string} modelId
 * @param {object} options
 * @param {Array}       options.messages
 * @param {AbortSignal} [options.signal]
 * @yields {{content: string, done: boolean}}
 */
export async function* streamComplete(modelId, options = {}) {
    const entry = _loadedModels.get(modelId);
    if (!entry) throw new Error(`Model not loaded: ${modelId}`);
    await ensureWorker();

    const formatted = formatMessages(options.messages || []);
    const prompt = formatChatPrompt(formatted);
    const signal = options.signal;

    // Queue-based async iteration: worker pushes tokens, generator pulls them
    const tokenQueue = [];
    let queueResolve = null;
    let completionDone = false;
    let completionError = null;

    const id = _nextRequestId++;

    const onToken = (content, done) => {
        tokenQueue.push({ content, done });
        if (queueResolve) {
            queueResolve();
            queueResolve = null;
        }
    };

    _pendingRequests.set(id, {
        resolve: () => {
            completionDone = true;
            if (queueResolve) {
                queueResolve();
                queueResolve = null;
            }
        },
        reject: (err) => {
            completionError = err;
            if (queueResolve) {
                queueResolve();
                queueResolve = null;
            }
        },
        onToken,
    });

    _worker.postMessage({
        type: 'complete',
        id,
        handle: entry.handle,
        prompt,
        opts: {
            maxTokens: options.maxTokens || 512,
            temperature: options.temperature || 0.7,
            topP: options.topP || 0.9,
        },
    });

    try {
        while (true) {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            // Drain available tokens
            while (tokenQueue.length > 0) {
                const token = tokenQueue.shift();
                yield token;
                if (token.done) return;
            }

            if (completionError) throw completionError;
            if (completionDone) return;

            // Wait for more tokens
            await new Promise(r => { queueResolve = r; });
        }
    } finally {
        _pendingRequests.delete(id);
    }
}
