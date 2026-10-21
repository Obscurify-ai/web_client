/**
 * Behaviour tests for the real static/js/chat/chat-local.js, loaded into a
 * sandbox with a fake DOM and a fake BrowserAgentKit.
 * Run with: node --test static/js/test/chat-local.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../chat/chat-local.js'), 'utf8');

function fakeElement(id) {
    return {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        value: '',
        style: {},
        dataset: {},
        children: [],
        classList: { add() {}, remove() {} },
        replaceChildren(...nodes) {
            this.children = nodes;
            this.textContent = nodes.map(n => n.textContent).join('');
        },
        appendChild(node) {
            this.children.push(node);
            this.textContent += node.textContent || '';
        },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
}

function fakeKit() {
    const model = { id: 'qwen-0.5b', name: 'Qwen 2.5 0.5B', vram: '~0.6GB' };
    return {
        deleted: [],
        async fetchModelCatalog() {
            return {
                categories: [{ key: 'tiny', label: 'Tiny', models: [model] }],
                allModels: [model],
                totalCount: 1,
            };
        },
        async checkGPUSupport() {
            return { supported: true, gpu: 'Test GPU', info: 'GPU: Test GPU' };
        },
        async deleteCachedModel(modelId) { this.deleted.push(modelId); },
        listLoadedModels() { return []; },
        async unloadModel() {},
    };
}

function loadChatLocal(kit) {
    const elements = {};
    const storage = new Map();
    const context = vm.createContext({
        console,
        setTimeout,
        document: {
            getElementById: (id) => (elements[id] ??= fakeElement(id)),
            createElement: (tag) => fakeElement(tag),
            addEventListener() {},
        },
        localStorage: {
            getItem: (k) => storage.get(k) ?? null,
            setItem: (k, v) => storage.set(k, String(v)),
        },
        // Globals chat-local.js borrows from the other chat modules.
        updateModelDisplayName() {},
        modelSelect: { selectedIndex: -1, options: [] },
        promptInput: { setAttribute() {} },
        messages: [],
        saveCurrentConversation() {},
        escapeAttr: (s) => String(s),
        escapeHtml: (s) => String(s),
        sanitizeErrorMessage: (s) => String(s),
    });
    vm.runInContext(SOURCE, context);
    // Stand in for the dynamic import of the vendored BrowserAgentKit.
    context.getBak = async () => kit;
    return { context, elements };
}

test('local mode setup says models run on the CPU, even when a GPU is present', async () => {
    const { context, elements } = loadChatLocal(fakeKit());

    await context.openLocalModeSetup();

    const status = elements['local-requirements-status'].textContent;
    assert.match(status, /CPU/);
    assert.doesNotMatch(status, /GPU accelerated/);
});

test('the model picker offers catalog models only, with their memory needs', async () => {
    const { context, elements } = loadChatLocal(fakeKit());

    await context.openLocalModeSetup();

    const options = elements['add-local-model-select'].innerHTML;
    assert.match(options, /value="qwen-0\.5b"/);
    assert.match(options, /~0\.6GB/);
    assert.doesNotMatch(options, /custom/i);
});

test('removing a local model also deletes its cached download', async () => {
    const kit = fakeKit();
    const { context } = loadChatLocal(kit);

    context.removeLocalModel('qwen-0.5b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(kit.deleted, ['qwen-0.5b']);
});
