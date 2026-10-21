// chat-local.js — Local mode (BrowserAgentKit WASM). Lazily imports the
// bak_wasm + wasm-adapter modules on first use; manages the enabled-models
// list, active local model selection, cloud↔local mode toggle, local model
// UI wiring (modal, dropdown, add/remove buttons, progress UI), and
// runLocalChatCompletion which streams chunks from the WASM engine through
// the same markdown pipeline as cloud responses.

// BrowserAgentKit is loaded as an ES module from the vendor submodule.
// We lazily import it on first use to avoid blocking page load.
let _bakModule = null;
async function getBak() {
    if (_bakModule) return _bakModule;
    const wasm = await import('/static/vendor/BrowserAgentKit/pkg/bak_wasm.js');
    await wasm.default(); // init Rust WASM (catalog + GPU detection)
    const adapter = await import('/static/vendor/BrowserAgentKit/src/wasm-adapter.js');
    await adapter.init(wasm); // also initializes Emscripten llama.cpp WASM
    _bakModule = adapter;
    return _bakModule;
}

// Thin wrappers that delegate to BrowserAgentKit while preserving the
// function signatures the rest of chat.js relies on.

async function fetchAvailableLocalModels() {
    try {
        const bak = await getBak();
        return await bak.fetchModelCatalog({ cacheKey: 'obscurify_webllm_models_cache' });
    } catch (err) {
        console.warn('Failed to fetch local models:', err.message);
        return { categories: [], allModels: [], totalCount: 0, fetchedAt: Date.now() };
    }
}

function getAvailableLocalModels() {
    // Synchronous access to cached catalog — returns null if not yet fetched
    if (!_bakModule) return null;
    return _bakModule.getCachedCatalog();
}

function findLocalModel(modelId) {
    if (!_bakModule) return null;
    return _bakModule.findModel(modelId);
}

function getLocalModelDisplayName(modelId) {
    if (_bakModule) return _bakModule.getModelDisplayName(modelId);
    // Fallback before library is loaded
    return modelId.replace(/-MLC$/, '').replace(/-q[0-4]f(16|32)_?\d?/gi, '').replace(/-Instruct/gi, '').replace(/[-_]/g, ' ').trim();
}

// Populate the local model select dropdown
async function populateLocalModelSelect(selectEl) {
    if (!selectEl) return;

    selectEl.innerHTML = '<option value="" disabled selected>Loading available models...</option>';

    const modelData = await fetchAvailableLocalModels();

    if (!modelData || modelData.totalCount === 0) {
        selectEl.innerHTML = '<option value="" disabled selected>No models available</option>';
        return;
    }

    let html = '';
    for (const category of modelData.categories) {
        html += `<optgroup label="${escapeAttr(category.label)}">`;
        for (const model of category.models) {
            html += `<option value="${escapeAttr(model.id)}">${escapeHtml(model.name)} (${escapeHtml(model.vram)})</option>`;
        }
        html += '</optgroup>';
    }

    selectEl.innerHTML = html;
    console.log(`Populated local model dropdown with ${modelData.totalCount} models in ${modelData.categories.length} categories`);
}

// Local mode state — WASM engine tracks loaded models internally
function isModelLoaded(modelId) {
    if (!_bakModule) return false;
    const loaded = _bakModule.listLoadedModels();
    return Array.isArray(loaded) && loaded.includes(modelId);
}
let enabledLocalModels = [];  // Array of enabled model IDs
let activeLocalModel = null;  // Currently selected local model
let isLocalMode = false;  // Whether local mode is active
const LOCAL_MODELS_KEY = 'obscurify_enabled_local_models';
const LOCAL_MODE_KEY = 'obscurify_local_mode';

// Load a local model with progress tracking (UI orchestration stays here)
async function loadLocalModel(modelId) {
    if (!modelId || typeof modelId !== 'string') {
        return { success: false, error: 'Invalid model ID' };
    }

    const progressEl = document.getElementById('local-progress');
    const addBtn = document.getElementById('add-local-model-btn');

    if (!progressEl || !addBtn) return { success: false, error: 'UI elements not found' };

    addBtn.disabled = true;
    addBtn.textContent = 'Downloading...';
    progressEl.style.display = 'block';
    progressEl.textContent = 'Initializing...';

    try {
        const bak = await getBak();

        await bak.loadModel(modelId, {
            onProgress: (progress) => {
                const pct = Math.round((progress.progress || 0) * 100);
                progressEl.textContent = progress.text || `Loading: ${pct}%`;
            }
        });

        if (!enabledLocalModels.includes(modelId)) {
            enabledLocalModels.push(modelId);
            localStorage.setItem(LOCAL_MODELS_KEY, JSON.stringify(enabledLocalModels));
        }

        updateLocalModelDropdown();
        updateEnabledModelsList();
        showModeToggle();

        if (enabledLocalModels.length === 1) {
            setMode('local');
        }

        progressEl.textContent = 'Model ready!';
        progressEl.classList.add('status-ok');
        setTimeout(() => {
            progressEl.style.display = 'none';
            progressEl.classList.remove('status-ok');
        }, 2000);

        addBtn.textContent = 'Download & Enable';
        addBtn.disabled = false;

        return { success: true };
    } catch (error) {
        console.error('Local model load error:', error.message);

        progressEl.textContent = sanitizeErrorMessage(error.message);
        progressEl.classList.add('status-error');

        addBtn.textContent = 'Download & Enable';
        addBtn.disabled = false;

        return { success: false, error: error.message };
    }
}

// Update the local model dropdown in sidebar
function updateLocalModelDropdown() {
    const localSelect = document.getElementById('local-model-select');
    if (!localSelect) return;

    localSelect.innerHTML = '<option value="">Use cloud model</option>';

    enabledLocalModels.forEach(modelId => {
        const option = document.createElement('option');
        option.value = modelId;
        const displayName = getLocalModelDisplayName(modelId);
        const isLoaded = isModelLoaded(modelId) ? '' : ' (cached)';
        option.textContent = displayName + isLoaded;
        localSelect.appendChild(option);
    });

    // Restore selection
    if (activeLocalModel && enabledLocalModels.includes(activeLocalModel)) {
        localSelect.value = activeLocalModel;
    }
}

// Update the enabled models list in the modal
function updateEnabledModelsList() {
    const listEl = document.getElementById('local-models-list');
    if (!listEl) return;

    if (enabledLocalModels.length === 0) {
        listEl.innerHTML = '<p class="local-models-empty">No local models enabled yet</p>';
        return;
    }

    listEl.innerHTML = enabledLocalModels.map(modelId => {
        const displayName = getLocalModelDisplayName(modelId);
        const isLoaded = isModelLoaded(modelId) ? '<span class="status-ok">loaded</span>' : '<span class="status-cached">cached</span>';
        return `
            <div class="local-model-item" data-model-id="${escapeAttr(modelId)}">
                <span class="local-model-name">${escapeHtml(displayName)}</span>
                <span class="local-model-info">${isLoaded}</span>
                <button class="local-model-remove" data-model-id="${escapeAttr(modelId)}" title="Remove model">&times;</button>
            </div>
        `;
    }).join('');

    // Add remove handlers
    listEl.querySelectorAll('.local-model-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeLocalModel(btn.dataset.modelId);
        });
    });
}

// Remove a local model
function removeLocalModel(modelId) {
    // Unload from WASM engine and delete the cached download
    if (_bakModule && isModelLoaded(modelId)) {
        _bakModule.unloadModel(modelId);
    }
    getBak()
        .then(bak => bak.deleteCachedModel(modelId))
        .catch(err => console.warn('Failed to delete cached model:', err.message));

    // Remove from enabled list
    enabledLocalModels = enabledLocalModels.filter(id => id !== modelId);
    localStorage.setItem(LOCAL_MODELS_KEY, JSON.stringify(enabledLocalModels));

    // Clear active if it was this model
    if (activeLocalModel === modelId) {
        activeLocalModel = null;
    }

    updateLocalModelDropdown();
    updateEnabledModelsList();

    // Hide toggle and switch to cloud if no models left
    if (enabledLocalModels.length === 0) {
        hideModeToggle();
        setMode('cloud');
    }
}

// Show the mode toggle (called when first local model is enabled)
function showModeToggle() {
    const toggle = document.getElementById('mode-toggle');
    if (toggle) {
        toggle.style.display = 'flex';
    }
}

// Hide the mode toggle
function hideModeToggle() {
    const toggle = document.getElementById('mode-toggle');
    if (toggle) {
        toggle.style.display = 'none';
    }
}

// Switch between local and cloud mode
function setMode(mode) {
    isLocalMode = mode === 'local';
    localStorage.setItem(LOCAL_MODE_KEY, isLocalMode ? 'true' : 'false');

    const cloudSection = document.getElementById('cloud-model-section');
    const localSection = document.getElementById('local-model-section');
    const cloudBtn = document.getElementById('cloud-mode-btn');
    const localBtn = document.getElementById('local-mode-toggle-btn');

    if (isLocalMode) {
        cloudSection.style.display = 'none';
        localSection.style.display = 'block';
        cloudBtn.classList.remove('active');
        localBtn.classList.add('active');

        // Set active local model to first available if none selected
        if (!activeLocalModel && enabledLocalModels.length > 0) {
            const localSelect = document.getElementById('local-model-select');
            if (localSelect && localSelect.options.length > 0) {
                activeLocalModel = localSelect.value || enabledLocalModels[0];
                localSelect.value = activeLocalModel;
            }
        }
    } else {
        cloudSection.style.display = 'block';
        localSection.style.display = 'none';
        cloudBtn.classList.add('active');
        localBtn.classList.remove('active');
        activeLocalModel = null;
    }

    // Save conversation state when switching modes to preserve context
    if (messages.length > 0) {
        saveCurrentConversation();
    }

    updateModelDisplayName();
}

// Update placeholder text to reflect selected model
const originalUpdateModelDisplayName = updateModelDisplayName;
updateModelDisplayName = function() {
    let modelName;
    if (isLocalMode && activeLocalModel) {
        modelName = getLocalModelDisplayName(activeLocalModel) + ' (Local)';
    } else if (modelSelect.selectedIndex >= 0) {
        modelName = modelSelect.options[modelSelect.selectedIndex].textContent;
        if (modelName.includes('Loading')) {
            promptInput.setAttribute('data-placeholder', 'Chatting anonymously');
            return;
        }
        // Remove provider prefix (e.g., "Anthropic: Claude Opus 4.5" -> "Claude Opus 4.5")
        if (modelName.includes(': ')) {
            modelName = modelName.split(': ').slice(1).join(': ');
        }
    }
    if (modelName) {
        promptInput.setAttribute('data-placeholder', `Chatting anonymously with ${modelName}`);
    }
};

// Open the Local Mode setup modal: load the kit, then list the models that fit.
async function openLocalModeSetup() {
    document.getElementById('local-mode-modal').classList.add('open');

    const statusEl = document.getElementById('local-requirements-status');
    const setupEl = document.getElementById('local-model-setup');

    statusEl.textContent = 'Loading local engine...';
    statusEl.className = 'local-requirements-status';

    try {
        await getBak();
        await populateLocalModelSelect(document.getElementById('add-local-model-select'));
        // llama.cpp runs as WebAssembly on the CPU; there is no GPU offload.
        const ok = document.createElement('span');
        ok.className = 'status-ok';
        ok.textContent = '✓ Models run on your CPU, inside this tab. No GPU needed.';
        statusEl.replaceChildren(ok);
        setupEl.style.display = 'block';
    } catch (err) {
        const loadErr = document.createElement('span');
        loadErr.className = 'status-error';
        loadErr.textContent = '✗ ' + sanitizeErrorMessage(err.message);
        statusEl.replaceChildren(loadErr);
        setupEl.style.display = 'none';
    }

    updateEnabledModelsList();
}

// Initialize local mode UI
function initLocalModeUI() {
    const localModeBtn = document.getElementById('local-mode-btn');
    const localModeModal = document.getElementById('local-mode-modal');
    const localModalClose = document.getElementById('local-modal-close');
    const modalOverlay = localModeModal?.querySelector('.modal-overlay');
    const addModelSelect = document.getElementById('add-local-model-select');
    const addLocalModelBtn = document.getElementById('add-local-model-btn');
    const localModelSelect = document.getElementById('local-model-select');
    const cloudModeBtn = document.getElementById('cloud-mode-btn');
    const localModeToggleBtn = document.getElementById('local-mode-toggle-btn');

    // Load saved enabled models
    try {
        const saved = localStorage.getItem(LOCAL_MODELS_KEY);
        if (saved) {
            enabledLocalModels = JSON.parse(saved);
            if (enabledLocalModels.length > 0) {
                showModeToggle();
                updateLocalModelDropdown();
                updateEnabledModelsList();

                // Restore mode preference
                const savedMode = localStorage.getItem(LOCAL_MODE_KEY);
                if (savedMode === 'true') {
                    setMode('local');
                }
            }
        }
    } catch (e) {
        console.error('Failed to load local models:', e);
    }

    // Mode toggle buttons
    cloudModeBtn?.addEventListener('click', () => setMode('cloud'));
    localModeToggleBtn?.addEventListener('click', () => setMode('local'));

    // Open modal
    localModeBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        openLocalModeSetup();
    });

    // Close modal
    const closeModal = () => {
        localModeModal?.classList.remove('open');
    };

    localModalClose?.addEventListener('click', closeModal);
    modalOverlay?.addEventListener('click', closeModal);

    // Add model button
    addLocalModelBtn?.addEventListener('click', () => {
        const modelId = addModelSelect?.value;
        if (modelId) {
            loadLocalModel(modelId);
        }
    });

    // Local model dropdown selection
    localModelSelect?.addEventListener('change', async (e) => {
        const selectedModelId = e.target.value || null;

        if (!selectedModelId) {
            activeLocalModel = null;
            updateModelDisplayName();
            return;
        }

        if (!isModelLoaded(selectedModelId)) {
            // Model is cached but not loaded - reload it
            const statusEl = document.getElementById('local-model-status');
            if (statusEl) {
                statusEl.textContent = 'Loading model...';
                statusEl.className = 'local-model-status';
            }

            try {
                const bak = await getBak();

                await bak.loadModel(selectedModelId, {
                    onProgress: (p) => {
                        if (statusEl) {
                            statusEl.textContent = p.text || `Loading: ${Math.round((p.progress || 0) * 100)}%`;
                        }
                    }
                });

                activeLocalModel = selectedModelId;

                if (statusEl) {
                    statusEl.textContent = 'Ready';
                    statusEl.classList.add('status-ok');
                    setTimeout(() => {
                        statusEl.textContent = '';
                        statusEl.classList.remove('status-ok');
                    }, 2000);
                }

                updateLocalModelDropdown();
                updateModelDisplayName();
            } catch (err) {
                if (statusEl) {
                    statusEl.textContent = sanitizeErrorMessage(err.message);
                    statusEl.classList.add('status-error');
                }
                // Reset selection
                e.target.value = activeLocalModel || '';
            }
        } else {
            activeLocalModel = selectedModelId;
            updateModelDisplayName();
        }
    });
}

// Run local chat completion via BrowserAgentKit
async function runLocalChatCompletion(messages, uniqueId, responseElement) {
    if (!activeLocalModel || !isModelLoaded(activeLocalModel)) {
        throw new Error('No local model loaded');
    }

    const bak = await getBak();
    let assistantResponse = '';

    for await (const chunk of bak.streamComplete(activeLocalModel, {
        messages: messages,
        signal: currentAbortController?.signal
    })) {
        if (chunk.done) break;
        assistantResponse += chunk.content;
        rawContentStore[uniqueId] = assistantResponse;
        renderMarkdownIntoElement(responseElement, assistantResponse);
    }

    return assistantResponse;
}

// Initialize local mode on DOM ready
document.addEventListener('DOMContentLoaded', initLocalModeUI);
