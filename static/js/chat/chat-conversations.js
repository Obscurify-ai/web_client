// chat-conversations.js — Local conversation storage (localStorage only).
// Manages the conversations list, load/save/delete/startNew flows, the
// sidebar list rendering, and the getGPTResult wrapper that auto-saves after
// each message exchange. Also restores the last-active conversation on load.

const CONVERSATIONS_KEY = 'obscurify_conversations';
const CURRENT_CONV_KEY = 'obscurify_current_conversation';
// Temporary chat (chat-privacy.js): while on, nothing about the chat is written to this browser.
let temporaryChat = false;
let currentConversationId = null;

function generateConversationId() {
    return 'conv-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
}

function getConversations() {
    try {
        const data = localStorage.getItem(CONVERSATIONS_KEY);
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error('Failed to load conversations:', e);
        return [];
    }
}

function saveConversations(conversations) {
    try {
        localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
    } catch (e) {
        console.error('Failed to save conversations:', e);
    }
}

function getConversationTitle(messages) {
    if (messages.length === 0) return 'New conversation';
    const firstMessage = messages[0];
    let text = '';
    if (typeof firstMessage.content === 'string') {
        text = firstMessage.content;
    } else if (Array.isArray(firstMessage.content)) {
        const textPart = firstMessage.content.find(p => p.type === 'text');
        text = textPart ? textPart.text : '';
    }
    // A message with only files is named after the first.
    if (!text && Array.isArray(firstMessage.files) && firstMessage.files.length > 0) text = firstMessage.files[0].name;
    // Truncate to ~40 chars
    return text.length > 40 ? text.slice(0, 40) + '...' : text || 'New conversation';
}

function saveCurrentConversation() {
    if (messages.length === 0 || temporaryChat) return;

    const conversations = getConversations();
    const now = Date.now();

    // Deep copy messages to avoid reference issues
    const messagesCopy = JSON.parse(JSON.stringify(messages));

    if (currentConversationId) {
        // Update existing conversation
        const index = conversations.findIndex(c => c.id === currentConversationId);
        if (index !== -1) {
            conversations[index].messages = messagesCopy;
            conversations[index].compaction = conversationCompaction || undefined;
            if (!conversations[index].titleSet) conversations[index].title = getConversationTitle(messages);
            conversations[index].model = isLocalMode && activeLocalModel ? `local:${activeLocalModel}` : modelSelect.value;
            conversations[index].settings = Object.keys(chatSettings).length ? Object.assign({}, chatSettings) : undefined;
            conversations[index].updatedAt = now;
        }
    } else {
        // Create new conversation
        currentConversationId = generateConversationId();
        conversations.unshift({
            id: currentConversationId,
            title: getConversationTitle(messages),
            model: isLocalMode && activeLocalModel ? `local:${activeLocalModel}` : modelSelect.value,
            messages: messagesCopy,
            compaction: conversationCompaction || undefined,
            settings: Object.keys(chatSettings).length ? Object.assign({}, chatSettings) : undefined,
            createdAt: now,
            updatedAt: now
        });
    }

    saveConversations(conversations);
    localStorage.setItem(CURRENT_CONV_KEY, currentConversationId);
    renderConversationsList();
}

// An answer that is still streaming appends to the global `messages` and is saved under
// whichever chat is current when it ends. Switching chats meanwhile put it into the chat
// switched to and marked that one active. So a switch stops the answer first and saves it,
// partial, to its own chat (where it keeps its Continue button), then switches.
async function finishAnswerBeforeSwitch() {
    if (!isGeneratingResponse) return;
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch (_e) { /* noop */ }
    }
    const deadline = Date.now() + 3000;
    while (isGeneratingResponse && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    saveCurrentConversation();
    // Aborted: whatever is left of it no longer counts as running, so the switch goes ahead.
    isGeneratingResponse = false;
}

function loadConversation(conversationId) {
    if (isGeneratingResponse) {
        finishAnswerBeforeSwitch().then(() => loadConversation(conversationId));
        return;
    }
    // Opening a saved chat leaves the temporary one, which is dropped.
    if (temporaryChat && typeof setTemporaryChat === 'function') setTemporaryChat(false, false);
    const conversations = getConversations();
    const conversation = conversations.find(c => c.id === conversationId);

    if (!conversation) return;

    // Clear current UI
    responseList.innerHTML = '';
    messages = [];
    conversationCompaction = conversation.compaction || null;
    setChatSettings(conversation.settings || {});
    currentConversationId = conversationId;
    localStorage.setItem(CURRENT_CONV_KEY, conversationId);

    // Set the model if available
    if (conversation.model) {
        if (conversation.model.startsWith('local:')) {
            // Was a local model - don't change mode, just note it
            // The messages will work with whatever mode user is in now
        } else {
            // Sync provider dropdown to show the conversation's provider
            const providerSelect = document.getElementById('provider-select');
            const modelData = _allModels.find(m => m.id === conversation.model);
            if (modelData) {
                const provider = extractProvider(modelData.name);
                providerSelect.value = provider || '';
                populateModelDropdown(providerSelect.value);
            }
            if (modelSelect.querySelector(`option[value="${conversation.model}"]:not(:disabled)`)) {
                modelSelect.value = conversation.model;
            }
        }
        updateModelDisplayName();
    }

    // Restore messages (deep copy to avoid reference issues)
    messages = JSON.parse(JSON.stringify(conversation.messages));

    // Fallback model label for older conversations without per-message labels
    let fallbackModelLabel = null;
    if (conversation.model) {
        if (conversation.model.startsWith('local:')) {
            const localModelId = conversation.model.replace('local:', '');
            fallbackModelLabel = getLocalModelDisplayName(localModelId) + ' (Local)';
        } else {
            fallbackModelLabel = conversation.model.includes('/')
                ? conversation.model.split('/').pop()
                : conversation.model;
        }
    }

    // Render messages in UI
    messages.forEach((msg, idx) => {
        const isUser = msg.role === 'user';
        let content = '';
        if (typeof msg.display === 'string') {
            content = msg.display;
        } else if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(p => p.type === 'text');
            content = textPart ? textPart.text : '';
        }

        if (isUser) {
            const userId = addResponse(true, content, null, undefined, msg.files);
            // Tag with messages-array index so delete-and-retry can locate it.
            const userBubble = document.getElementById(userId)?.closest('.message');
            if (userBubble) userBubble.dataset.msgIdx = String(idx);
        } else {
            // Use per-message modelLabel if available, otherwise fall back to conversation-level
            const modelLabel = msg.modelLabel || fallbackModelLabel;
            const uniqueId = addResponse(false, null, null, modelLabel);
            const responseElement = document.getElementById(uniqueId);
            // Store raw content for toggle
            rawContentStore[uniqueId] = content;
            renderMarkdownIntoElement(responseElement, content);
            if (typeof attachHtmlPreviews === 'function') attachHtmlPreviews(responseElement);
            if (msg.interrupted && idx === messages.length - 1 && typeof showInterrupted === 'function') {
                responseElement.classList.add('code-turn');
                showInterrupted(responseElement, msg.interrupted);
            }
        }
    });

    // Show response list, hide welcome, enter chat mode (instant, no animation)
    if (messages.length > 0) {
        if (typeof enterChatMode === 'function') {
            enterChatMode(true);
        } else {
            document.getElementById('response-list').style.display = 'block';
            document.getElementById('welcome-message').style.display = 'none';
        }
        switchToChatInputs();
    }

    renderConversationsList();
    closeSidebar();
    if (typeof renderSavedTeeChips === 'function') renderSavedTeeChips();
    if (typeof teeVerifyActive === 'function' && teeVerifyActive() && typeof pickVerifiableModel === 'function') pickVerifiableModel();
    // An answer still running when this chat was last open is finished now (chat-reply.js).
    if (typeof resumePendingReply === 'function') setTimeout(resumePendingReply, 0);
}

function deleteConversation(conversationId, event) {
    if (event) event.stopPropagation();

    const conversations = getConversations();
    const filtered = conversations.filter(c => c.id !== conversationId);
    saveConversations(filtered);

    // If deleting current conversation, start fresh
    if (conversationId === currentConversationId) {
        startNewConversation();
    }

    renderConversationsList();
}

function startNewConversation() {
    if (isGeneratingResponse) {
        finishAnswerBeforeSwitch().then(() => startNewConversation());
        return;
    }
    currentConversationId = null;
    localStorage.removeItem(CURRENT_CONV_KEY);
    messages = [];
    conversationCompaction = null;
    setChatSettings(newChatSettings());
    responseList.innerHTML = '';
    if (typeof enterLandingMode === 'function') {
        enterLandingMode();
    } else {
        document.getElementById('response-list').style.display = 'none';
        document.getElementById('welcome-message').style.display = 'flex';
    }
    // Switch back to landing inputs
    submitButton = landingSubmitButton;
    promptInput = landingPromptInput;
    imageInput = landingImageInput;
    renderConversationsList();
}

function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(timestamp).toLocaleDateString();
}

// The sidebar list: a search box over every chat's words, pinned chats first, then folders
// (folded or open, kept per browser), then the rest. Each chat and folder has a ⋯ menu.
const FOLDERS_CLOSED_KEY = 'obscurify_folders_closed';
let conversationQuery = '';

function closedFolders() {
    try { return JSON.parse(localStorage.getItem(FOLDERS_CLOSED_KEY) || '[]'); } catch (_e) { return []; }
}

// What search looks through: the title, every message's text and the names of attached files.
function conversationText(conv) {
    const parts = [conv.title || ''];
    for (const m of conv.messages || []) {
        if (typeof m.display === 'string') parts.push(m.display);
        else if (typeof m.content === 'string') parts.push(m.content);
        else if (Array.isArray(m.content)) m.content.forEach((p) => { if (p.type === 'text') parts.push(p.text || ''); });
        if (Array.isArray(m.files)) m.files.forEach((f) => parts.push(f.name || ''));
    }
    return parts.join('\n');
}

// A line of text around the first match, unless the title already shows it.
function searchSnippet(conv, text, word) {
    if ((conv.title || '').toLowerCase().includes(word)) return '';
    const i = text.toLowerCase().indexOf(word);
    if (i < 0) return '';
    const start = Math.max(0, i - 30);
    const line = text.slice(start, i + word.length + 60).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + line + '…';
}

const MORE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>';
const PIN_ICON = '<svg class="conversation-item-pin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"></path><path d="M9 10.76V4h6v6.76l3 3.24v2H6v-2z"></path></svg>';

function conversationItemHtml(conv, snippet) {
    return `
        <div class="conversation-row">
            <button class="conversation-item ${conv.id === currentConversationId ? 'active' : ''}" data-id="${escapeAttr(conv.id)}">
                ${conv.pinned ? PIN_ICON : ''}
                <span class="conversation-item-text">
                    <span class="conversation-item-title">${escapeHtml(conv.title)}</span>
                    ${snippet ? `<span class="conversation-item-snippet">${escapeHtml(snippet)}</span>` : ''}
                </span>
                <span class="conversation-item-meta">${formatTimeAgo(conv.updatedAt)}</span>
            </button>
            <button class="conversation-item-more" data-id="${escapeAttr(conv.id)}" title="More" aria-label="More for this chat">${MORE_ICON}</button>
        </div>`;
}

function renderConversationsList() {
    const listEl = document.getElementById('conversations-list');
    if (!listEl) return;

    const conversations = getConversations();
    const searchEl = document.getElementById('conversation-search');
    if (searchEl) searchEl.hidden = conversations.length === 0;

    if (conversations.length === 0) {
        listEl.innerHTML = '<p class="conversations-empty">No locally saved conversations</p>';
        return;
    }

    // Sort by updatedAt descending
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);

    const words = conversationQuery.toLowerCase().split(/\s+/).filter(Boolean);
    let html = '';
    if (words.length > 0) {
        const found = [];
        for (const conv of conversations) {
            const text = conversationText(conv);
            const lower = text.toLowerCase();
            if (words.every((w) => lower.includes(w))) found.push(conversationItemHtml(conv, searchSnippet(conv, text, words[0])));
        }
        html = found.length ? found.join('') : '<p class="conversations-empty">No chats match</p>';
    } else {
        const pinned = conversations.filter((c) => c.pinned);
        const filed = conversations.filter((c) => !c.pinned && c.folder);
        const rest = conversations.filter((c) => !c.pinned && !c.folder);
        const folders = [...new Set(filed.map((c) => c.folder))].sort((a, b) => a.localeCompare(b));
        const closed = closedFolders();
        if (pinned.length) html += '<p class="conversations-group">Pinned</p>' + pinned.map((c) => conversationItemHtml(c)).join('');
        for (const name of folders) {
            const inside = filed.filter((c) => c.folder === name);
            const open = !closed.includes(name);
            html += `
                <div class="conversation-row conversation-folder-row">
                    <button class="conversation-folder ${open ? 'open' : ''}" data-folder="${escapeAttr(name)}" aria-expanded="${open}">
                        <svg class="conversation-folder-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"></polyline></svg>
                        <span class="conversation-item-title">${escapeHtml(name)}</span>
                        <span class="conversation-item-meta">${inside.length}</span>
                    </button>
                    <button class="conversation-folder-more" data-folder="${escapeAttr(name)}" title="More" aria-label="More for this folder">${MORE_ICON}</button>
                </div>`;
            if (open) html += '<div class="conversation-folder-items">' + inside.map((c) => conversationItemHtml(c)).join('') + '</div>';
        }
        if (rest.length && (pinned.length || folders.length)) html += '<p class="conversations-group">Chats</p>';
        html += rest.map((c) => conversationItemHtml(c)).join('');
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('.conversation-item').forEach((item) => {
        item.addEventListener('click', () => loadConversation(item.dataset.id));
    });
    listEl.querySelectorAll('.conversation-item-more').forEach((btn) => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openConversationMenu(btn, chatMenuItems(btn.dataset.id)); });
    });
    listEl.querySelectorAll('.conversation-folder').forEach((btn) => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.folder;
            const closedNow = closedFolders();
            const next = closedNow.includes(name) ? closedNow.filter((n) => n !== name) : closedNow.concat([name]);
            localStorage.setItem(FOLDERS_CLOSED_KEY, JSON.stringify(next));
            renderConversationsList();
        });
    });
    listEl.querySelectorAll('.conversation-folder-more').forEach((btn) => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openConversationMenu(btn, folderMenuItems(btn.dataset.folder)); });
    });
}

// Changes one stored conversation and redraws the list.
function updateConversation(id, change) {
    const conversations = getConversations();
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    change(conv);
    saveConversations(conversations);
    renderConversationsList();
}

function folderNames() {
    return [...new Set(getConversations().map((c) => c.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function askFolderName(current) {
    const name = (prompt('Folder name', current || '') || '').trim().slice(0, 60);
    return name || null;
}

function chatMenuItems(id) {
    const conv = getConversations().find((c) => c.id === id);
    if (!conv) return [];
    const items = [
        [conv.pinned ? 'Unpin' : 'Pin', () => updateConversation(id, (c) => { c.pinned = !c.pinned || undefined; })],
        ['Move to folder', () => moveMenuItems(id)],
    ];
    if (conv.folder) items.push(['Remove from folder', () => updateConversation(id, (c) => { delete c.folder; })]);
    items.push(['Rename', () => {
        const title = (prompt('Rename chat', conv.title || '') || '').trim().slice(0, 120);
        if (title) updateConversation(id, (c) => { c.title = title; c.titleSet = true; });
    }]);
    items.push(['Delete', () => deleteConversation(id), 'danger']);
    return items;
}

// The second step of "Move to folder": the folders there are, or a new one.
function moveMenuItems(id) {
    const conv = getConversations().find((c) => c.id === id);
    const items = folderNames().filter((n) => !conv || n !== conv.folder)
        .map((name) => [name, () => updateConversation(id, (c) => { c.folder = name; })]);
    items.push(['New folder…', () => {
        const name = askFolderName();
        if (name) updateConversation(id, (c) => { c.folder = name; });
    }]);
    return items;
}

function folderMenuItems(name) {
    return [
        ['Rename folder', () => {
            const next = askFolderName(name);
            if (!next || next === name) return;
            const conversations = getConversations();
            conversations.forEach((c) => { if (c.folder === name) c.folder = next; });
            saveConversations(conversations);
            renderConversationsList();
        }],
        ['Remove folder (keeps its chats)', () => {
            const conversations = getConversations();
            conversations.forEach((c) => { if (c.folder === name) delete c.folder; });
            saveConversations(conversations);
            renderConversationsList();
        }],
    ];
}

// One small menu at a time, next to the ⋯ that opened it. An item returning a list shows that
// list in its place (Move to folder).
function openConversationMenu(anchor, items) {
    closeConversationMenu();
    const menu = document.createElement('div');
    menu.id = 'conversation-menu';
    menu.className = 'conversation-menu';
    menu.setAttribute('role', 'menu');
    const fill = (list) => {
        menu.replaceChildren();
        for (const [label, run, kind] of list) {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'menuitem');
            b.className = 'conversation-menu-item' + (kind === 'danger' ? ' danger' : '');
            b.textContent = label;
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const next = run();
                if (Array.isArray(next)) fill(next);
                else closeConversationMenu();
            });
            menu.appendChild(b);
        }
    };
    fill(items);
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.top = (r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - 4 - h) : r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    setTimeout(() => document.addEventListener('click', closeConversationMenu, { once: true }), 0);
}

function closeConversationMenu() {
    const menu = document.getElementById('conversation-menu');
    if (menu) menu.remove();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConversationMenu(); });

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/`/g, '&#96;');
}

// Hook into message sending to auto-save conversations
const originalGetGPTResult = getGPTResult;
getGPTResult = async function(...args) {
    const result = await originalGetGPTResult.apply(this, args);
    // Save after each message exchange
    setTimeout(() => saveCurrentConversation(), 100);
    return result;
};

// Initialize conversations list on load
// A prompt handed over in the address (?q=), e.g. by Firefox's AI chatbot
// sidebar for "Ask AI Chatbot" / "Summarize page". Taken out of the address
// so a reload or a shared link doesn't bring it back. Never sent on its own:
// a link must not spend anyone's balance or quota.
function takeHandoffPrompt() {
    try {
        const params = new URLSearchParams(location.search);
        if (!params.has('q')) return '';
        const prompt = (params.get('q') || '').slice(0, 20000);
        params.delete('q');
        const rest = params.toString();
        history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
        return prompt.trim() ? prompt : '';
    } catch (_e) {
        return '';
    }
}

function prefillPrompt(text) {
    startNewConversation();
    landingPromptInput.textContent = text; // plain text, never parsed as HTML
    landingPromptInput.focus();
    try {
        const range = document.createRange();
        range.selectNodeContents(landingPromptInput);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    } catch (_e) { /* caret stays at the start */ }
    landingPromptInput.scrollTop = landingPromptInput.scrollHeight;
}

document.addEventListener('DOMContentLoaded', function() {
    renderConversationsList();
    const searchEl = document.getElementById('conversation-search');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            conversationQuery = searchEl.value;
            renderConversationsList();
        });
    }

    const handoff = takeHandoffPrompt();
    if (handoff) {
        prefillPrompt(handoff);
        return; // the user reviews it and presses Enter
    }

    // Restore last conversation if any
    const lastConvId = localStorage.getItem(CURRENT_CONV_KEY);
    if (lastConvId) {
        const conversations = getConversations();
        if (conversations.find(c => c.id === lastConvId)) {
            loadConversation(lastConvId);
        }
    }
});

// New conversation button
const newConvBtn = document.getElementById('new-conversation-btn');
if (newConvBtn) {
    newConvBtn.addEventListener('click', () => {
        startNewConversation();
        closeSidebar();
    });
}
