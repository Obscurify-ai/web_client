/**
 * Behaviour tests for multi-turn reasoning in the real static/js/chat/chat-stream.js:
 * what the next request sends back after a reasoning model replies.
 * Run with: node --test static/js/test/chat-stream.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (name) => fs.readFileSync(path.join(__dirname, '../chat', name), 'utf8');
const MARKDOWN_SOURCE = read('chat-markdown.js');
const STREAM_SOURCE = read('chat-stream.js');

function fakeElement(id) {
    return {
        id,
        textContent: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        replaceChildren() {},
        appendChild() {},
        addEventListener() {},
        closest() { return null; },
        scrollIntoView() {},
    };
}

function sse(chunks) {
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return {
        ok: true,
        body: {
            getReader: () => ({
                read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
            }),
        },
    };
}

function delta(d) {
    return { choices: [{ index: 0, delta: d }] };
}

function loadChat(replies) {
    const elements = {};
    const requests = [];
    const context = vm.createContext({
        console,
        TextDecoder,
        AbortController,
        setInterval,
        clearInterval,
        document: {
            getElementById: (id) => (elements[id] ??= fakeElement(id)),
            createElement: (tag) => fakeElement(tag),
            addEventListener() {},
        },
        localStorage: { getItem: () => null, setItem() {} },
        showdown: { Converter: class { makeHtml(t) { return t; } } },
        fetch: async (_url, init) => {
            requests.push(JSON.parse(init.body));
            return sse(replies.shift());
        },
    });
    // Globals chat-stream.js borrows from the other chat modules.
    vm.runInContext(`
        let promptInput = { textContent: '' };
        let modelSelect = { value: '' };
        let submitButton = document.getElementById('submit-button');
        let isGeneratingResponse = false;
        let currentAbortController = null;
        let loadInterval = null;
        let base64Images = null;
        let imageByteSizes = null;
        let isLocalMode = false;
        let isLoggedIn = false;
        const rawContentStore = {};
        let responseCounter = 0;
        function addResponse() { return 'r' + (responseCounter++); }
        function loader() {}
        function updateActionButton() {}
        function updateImagePreviews() {}
        function setErrorForResponse(_el, message) { throw new Error(message); }
        function getConfig() { return { api: { baseUrl: '', chatEndpoint: '/web/chat', anonChatEndpoint: '/anon/chat' } }; }
    `, context);
    vm.runInContext(MARKDOWN_SOURCE, context);
    // Rendering needs a real DOM; these tests only look at history and requests.
    context.renderMarkdownIntoElement = () => {};
    vm.runInContext(STREAM_SOURCE, context);

    const send = async (prompt, model) => {
        vm.runInContext(`modelSelect.value = ${JSON.stringify(model)}`, context);
        await context.getGPTResult(prompt);
    };
    return { context, requests, send };
}

const claudeTurn = [
    delta({ reasoning: 'Let me think', reasoning_details: [{ type: 'reasoning.text', text: 'Let me ', index: 0, format: 'anthropic-claude-v1' }] }),
    delta({ reasoning: ' about it', reasoning_details: [{ type: 'reasoning.text', text: 'think', index: 0 }] }),
    delta({ reasoning_details: [{ type: 'reasoning.text', text: ' about it', index: 0, signature: 'sig-123' }] }),
    delta({ content: 'The answer is 4.' }),
];

const secondTurn = [delta({ content: 'Sure.' })];

test('the next turn replays the model\'s signed reasoning as reasoning_details, not as answer text', async () => {
    const { requests, send } = loadChat([claudeTurn, secondTurn]);

    await send('What is 2+2?', 'anthropic/claude-sonnet-5');
    await send('Thanks', 'anthropic/claude-sonnet-5');

    const assistant = requests[1].messages[1];
    assert.deepEqual(assistant, {
        role: 'assistant',
        content: 'The answer is 4.',
        reasoning_details: [{
            type: 'reasoning.text',
            text: 'Let me think about it',
            index: 0,
            format: 'anthropic-claude-v1',
            signature: 'sig-123',
        }],
    });
});

test('switching models drops the previous model\'s reasoning but keeps its answer', async () => {
    const { requests, send } = loadChat([claudeTurn, secondTurn]);

    await send('What is 2+2?', 'anthropic/claude-sonnet-5');
    await send('Thanks', 'google/gemini-3-pro');

    assert.deepEqual(requests[1].messages[1], { role: 'assistant', content: 'The answer is 4.' });
});

test('conversations saved before this change no longer send <think> text or UI tokens back', async () => {
    const { context, requests, send } = loadChat([secondTurn]);
    vm.runInContext(`messages = [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', content: '@@OBSCURIFYWEBSEARCH0@@\\n\\n<think>\\nold reasoning\\n</think>\\n\\nHello!', modelLabel: 'claude-sonnet-5' },
    ]`, context);

    await send('Again', 'anthropic/claude-sonnet-5');

    assert.deepEqual(requests[0].messages[1], { role: 'assistant', content: 'Hello!' });
});

test('the conversation keeps the rendered thinking block for display', async () => {
    const { context, send } = loadChat([claudeTurn]);

    await send('What is 2+2?', 'anthropic/claude-sonnet-5');

    const saved = vm.runInContext('messages[1]', context);
    assert.match(saved.display, /<think>\nLet me think about it\n<\/think>/);
    assert.match(saved.display, /The answer is 4\.$/);
    assert.equal(saved.modelLabel, 'claude-sonnet-5');
});
