/**
 * Mock DOM elements and browser globals.
 * Must be required before any test modules.
 */

const mockElements = {
    'submit-button': { classList: { add: () => {}, remove: () => {} } },
    'prompt-input': { textContent: '', setAttribute: () => {}, focus: () => {} },
    'image-input': { files: [], value: '', addEventListener: () => {} },
    'model-select': {
        value: 'anthropic/claude-opus-4.5',
        selectedIndex: 0,
        options: [{ textContent: 'Claude Opus 4.5' }],
        innerHTML: '',
        addEventListener: () => {},
        querySelector: () => null
    },
    'response-list': {
        insertAdjacentHTML: () => {},
        scrollTop: 0,
        scrollHeight: 100,
        innerHTML: '',
        style: { display: '' },
        querySelector: () => null,
        querySelectorAll: () => []
    },
    'action-toggle': { classList: { add: () => {}, remove: () => {} }, title: '' },
    'new-conv-icon': { style: { display: '' } },
    'stop-icon': { style: { display: '' } },
    'input-container': { insertBefore: () => {} },
    'welcome-message': { style: { display: '' } },
    'conversations-list': null
};

global.document = {
    getElementById: (id) => mockElements[id] || null,
    createElement: (tag) => ({
        id: '',
        className: '',
        innerHTML: '',
        style: { display: '' },
        appendChild: () => {},
        addEventListener: () => {}
    }),
    addEventListener: () => {},
    execCommand: () => {}
};

global.localStorage = {
    data: {},
    getItem: (key) => global.localStorage.data[key] || null,
    setItem: (key, value) => { global.localStorage.data[key] = value; },
    removeItem: (key) => { delete global.localStorage.data[key]; }
};

global.window = { location: { reload: () => {} } };
// chat-dom.js declares this global in the browser; tests that load chat-models.js
// directly need it to exist.
global.modelSelect = mockElements['model-select'];
global.fetch = async () => ({ ok: true, json: async () => ({}), body: { getReader: () => ({}) } });
global.AbortController = class { signal = {}; abort() {} };

// Mock showdown
global.showdown = {
    Converter: class {
        makeHtml(text) { return `<p>${text}</p>`; }
    }
};
