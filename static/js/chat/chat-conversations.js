// chat-conversations.js — Local conversation storage (localStorage only).
// Manages the conversations list, load/save/delete/startNew flows, the
// sidebar list rendering, and the getGPTResult wrapper that auto-saves after
// each message exchange. Also restores the last-active conversation on load.

const CONVERSATIONS_KEY = 'obscurify_conversations';
const CURRENT_CONV_KEY = 'obscurify_current_conversation';
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
    // Truncate to ~40 chars
    return text.length > 40 ? text.slice(0, 40) + '...' : text || 'New conversation';
}

function saveCurrentConversation() {
    if (messages.length === 0) return;

    const conversations = getConversations();
    const now = Date.now();

    // Deep copy messages to avoid reference issues
    const messagesCopy = JSON.parse(JSON.stringify(messages));

    if (currentConversationId) {
        // Update existing conversation
        const index = conversations.findIndex(c => c.id === currentConversationId);
        if (index !== -1) {
            conversations[index].messages = messagesCopy;
            conversations[index].title = getConversationTitle(messages);
            conversations[index].model = isLocalMode && activeLocalModel ? `local:${activeLocalModel}` : modelSelect.value;
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
            createdAt: now,
            updatedAt: now
        });
    }

    saveConversations(conversations);
    localStorage.setItem(CURRENT_CONV_KEY, currentConversationId);
    renderConversationsList();
}

function loadConversation(conversationId) {
    const conversations = getConversations();
    const conversation = conversations.find(c => c.id === conversationId);

    if (!conversation) return;

    // Clear current UI
    responseList.innerHTML = '';
    messages = [];
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
            const userId = addResponse(true, content);
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
}

function deleteConversation(conversationId, event) {
    event.stopPropagation();

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
    currentConversationId = null;
    localStorage.removeItem(CURRENT_CONV_KEY);
    messages = [];
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

function renderConversationsList() {
    const listEl = document.getElementById('conversations-list');
    if (!listEl) return;

    const conversations = getConversations();

    if (conversations.length === 0) {
        listEl.innerHTML = '<p class="conversations-empty">No locally saved conversations</p>';
        return;
    }

    // Sort by updatedAt descending
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);

    listEl.innerHTML = conversations.map(conv => `
        <button class="conversation-item ${conv.id === currentConversationId ? 'active' : ''}"
                data-id="${escapeAttr(conv.id)}">
            <span class="conversation-item-title">${escapeHtml(conv.title)}</span>
            <span class="conversation-item-meta">${formatTimeAgo(conv.updatedAt)}</span>
            <span class="conversation-item-delete" data-id="${escapeAttr(conv.id)}" title="Delete conversation">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            </span>
        </button>
    `).join('');

    // Add click handlers
    listEl.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => loadConversation(item.dataset.id));
    });

    // Add delete handlers
    listEl.querySelectorAll('.conversation-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => deleteConversation(btn.dataset.id, e));
    });
}

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
