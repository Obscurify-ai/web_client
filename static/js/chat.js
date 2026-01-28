// Markdown converter using showdown
const converter = new showdown.Converter({
    tables: true,
    strikethrough: true,
    tasklists: true
});
let promptToRetry = null;
let uniqueIdToRetry = null;

const submitButton = document.getElementById('submit-button');
const regenerateResponseButton = document.getElementById('regenerate-response-button');
const promptInput = document.getElementById('prompt-input');
const imageInput = document.getElementById('image-input');
const modelSelect = document.getElementById('model-select');
const responseList = document.getElementById('response-list');
const actionToggle = document.getElementById('action-toggle');
const newConvIcon = document.getElementById('new-conv-icon');
const stopIcon = document.getElementById('stop-icon');
let isGeneratingResponse = false;
let currentAbortController = null;

let loadInterval = null;

// Update action button state (stop vs new conversation)
function updateActionButton(streaming) {
    if (streaming) {
        actionToggle.classList.add('streaming');
        actionToggle.title = 'Stop generating';
        newConvIcon.style.display = 'none';
        stopIcon.style.display = 'block';
    } else {
        actionToggle.classList.remove('streaming');
        actionToggle.title = 'New conversation';
        newConvIcon.style.display = 'block';
        stopIcon.style.display = 'none';
    }
}

// Action button click handler
actionToggle.addEventListener('click', () => {
    if (isGeneratingResponse && currentAbortController) {
        // Stop the current stream
        currentAbortController.abort();
    } else {
        // Start a new conversation
        startNewConversation();
    }
});

function showResponseList() {
    document.getElementById('response-list').style.display = 'block';
}

promptInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.shiftKey) {
            document.execCommand('insertHTML', false, '<br/><br/>');
        } else {
            showResponseList();
            getGPTResult();
        }
    }
});

submitButton.addEventListener("click", () => {
    showResponseList();
    getGPTResult();
});

function generateUniqueId() {
    const timestamp = Date.now();
    const randomNumber = Math.random();
    const hexadecimalString = randomNumber.toString(16);
    return 'id-' + timestamp + '-' + hexadecimalString;
}

// Store raw content for each response (for raw toggle)
const rawContentStore = {};

function addResponse(selfFlag, prompt, images, modelLabel) {
    const uniqueId = generateUniqueId();
    const role = selfFlag ? 'user-message' : 'assistant-message';
    let label;
    if (selfFlag) {
        // Use username if logged in, otherwise "User"
        label = (typeof currentUsername !== 'undefined' && currentUsername) ? currentUsername : 'User';
    } else if (modelLabel) {
        // Use provided model label (e.g., when loading saved conversations)
        label = modelLabel;
    } else {
        // Use local model name if in local mode, otherwise cloud model name
        if (typeof isLocalMode !== 'undefined' && isLocalMode && typeof activeLocalModel !== 'undefined' && activeLocalModel && typeof getLocalModelDisplayName === 'function') {
            label = getLocalModelDisplayName(activeLocalModel) + ' (Local)';
        } else {
            // Use model name (after the /) for assistant
            const modelId = modelSelect?.value || 'Assistant';
            label = modelId && modelId.includes('/') ? modelId.split('/').pop() : modelId;
        }
    }

    // Add raw toggle button for assistant messages
    const rawToggle = selfFlag ? '' :
        '<button class="raw-toggle-btn" data-target="' + uniqueId + '" title="Toggle raw markdown">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M16 18l6-6-6-6"></path><path d="M8 6l-6 6 6 6"></path>' +
        '</svg></button>';

    // Build image HTML for user messages with attached images
    let imagesHtml = '';
    if (selfFlag && images && images.length > 0) {
        imagesHtml = '<div class="message-images">' +
            images.map(img => '<img src="' + img + '" class="message-image" alt="Attached image">').join('') +
            '</div>';
    }

    const html = '<div class="message ' + role + '" style="border: 1px solid purple;">' +
        '<div class="message-header"><strong>' + label + ':</strong>' + rawToggle + '</div>' +
        '<div class="prompt-content" id="' + uniqueId + '">' + (prompt || '') + '</div>' +
        imagesHtml +
        '</div>';
    responseList.insertAdjacentHTML('beforeend', html);

    // Add event listener for raw toggle if assistant message
    if (!selfFlag) {
        const toggleBtn = responseList.querySelector('.raw-toggle-btn[data-target="' + uniqueId + '"]');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function() {
                toggleRawContent(uniqueId);
            });
        }
    }

    responseList.scrollTop = responseList.scrollHeight;
    return uniqueId;
}

function toggleRawContent(uniqueId) {
    const element = document.getElementById(uniqueId);
    const toggleBtn = document.querySelector('.raw-toggle-btn[data-target="' + uniqueId + '"]');
    if (!element || !rawContentStore[uniqueId]) return;

    const isRaw = element.classList.toggle('raw-mode');
    if (isRaw) {
        // Show raw markdown
        element.textContent = rawContentStore[uniqueId];
        toggleBtn.classList.add('active');
        toggleBtn.title = 'Show rendered';
    } else {
        // Show rendered HTML
        element.innerHTML = converter.makeHtml(rawContentStore[uniqueId]);
        toggleBtn.classList.remove('active');
        toggleBtn.title = 'Show raw markdown';
    }
}

function loader(element) {
    element.textContent = '.';
    element.style.color = '#ffffff';  // White loading dots
    loadInterval = setInterval(() => {
        if (element.textContent === '.') {
            element.textContent = '..';
        } else if (element.textContent === '..') {
            element.textContent = '...';
        } else {
            element.textContent = '.';
        }
    }, 300);
}

function setErrorForResponse(element, message) {
    element.innerText = message;
    element.style.color = 'rgb(255, 84, 84)';
    // Change the label from "Assistant" to "Error"
    const messageDiv = element.closest('.message');
    if (messageDiv) {
        const label = messageDiv.querySelector('strong');
        if (label) {
            label.textContent = 'Error:';
            label.style.color = 'rgb(255, 84, 84)';
        }
    }
}

function setRetryResponse(prompt, uniqueId) {
    promptToRetry = prompt;
    uniqueIdToRetry = uniqueId;
    if (regenerateResponseButton) {
        regenerateResponseButton.style.display = 'flex';
    }
}

async function regenerateGPTResult() {
    try {
        await getGPTResult(promptToRetry, uniqueIdToRetry);
        regenerateResponseButton.classList.add("loading");
    } finally {
        regenerateResponseButton.classList.remove("loading");
    }
}

// Helper to get config values with defaults
function getConfig() {
    const defaults = {
        api: {
            baseUrl: "",
            modelsEndpoint: "/models",
            chatEndpoint: "/web/chat/completions",
            anonChatEndpoint: "/anon/chat/completions",
            frontierModelsEndpoint: "/frontier_models",
        },
        features: {
            enableLocalMode: true,
            enableTorLink: true,
        }
    };
    if (typeof window.CHAT_CONFIG === 'undefined') {
        return defaults;
    }
    return {
        api: { ...defaults.api, ...window.CHAT_CONFIG.api },
        features: { ...defaults.features, ...window.CHAT_CONFIG.features }
    };
}

async function fetchAndPopulateModels() {
    try {
        const config = getConfig();
        const response = await fetch(config.api.baseUrl + config.api.modelsEndpoint);
        if (!response.ok) {
            throw new Error('HTTP error! status: ' + response.status);
        }
        const data = await response.json();

        // Also fetch frontier models to know which require login
        let frontierModels = [];
        if (config.api.frontierModelsEndpoint) {
            try {
                const frontierResponse = await fetch(config.api.baseUrl + config.api.frontierModelsEndpoint);
                const frontierData = await frontierResponse.json();
                frontierModels = frontierData.frontier_models || [];
            } catch (e) {
                console.error('Failed to fetch frontier models:', e);
            }
        }

        // Clear the loading placeholder
        modelSelect.innerHTML = '';

        // Sort the models alphabetically by name
        data.data.sort((a, b) => a.name.localeCompare(b.name));

        // Check if user is logged in (using global variable from template)
        const loggedIn = typeof isLoggedIn !== 'undefined' ? isLoggedIn : false;
        const configDefaultFreeModel = typeof defaultFreeModel !== 'undefined' ? defaultFreeModel : '';
        const configDefaultPaidModel = typeof defaultPaidModel !== 'undefined' ? defaultPaidModel : 'anthropic/claude-opus-4.5';

        // Check if user can access frontier models (Casual tier+)
        const canAccessFrontierModels = typeof canAccessFrontier !== 'undefined' ? canAccessFrontier : false;

        data.data.forEach(model => {
            // For guests without frontier access, only show free models (skip paid ones entirely)
            if (!canAccessFrontierModels) {
                const isPaid = model.pricing && (model.pricing.prompt > 0 || model.pricing.completion > 0);
                if (isPaid) {
                    return; // Skip paid models for guests
                }
            }

            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            modelSelect.appendChild(option);
        });

        // Set default model based on tier access
        if (canAccessFrontierModels) {
            // For users with frontier access (Casual+), use the configured default paid model
            if (modelSelect.querySelector(`option[value="${configDefaultPaidModel}"]`)) {
                modelSelect.value = configDefaultPaidModel;
            }
        } else {
            // For users without frontier access, use the default free model or first available
            if (configDefaultFreeModel && modelSelect.querySelector(`option[value="${configDefaultFreeModel}"]`)) {
                modelSelect.value = configDefaultFreeModel;
            } else {
                // Find first available option
                const firstOption = modelSelect.querySelector('option');
                if (firstOption) {
                    modelSelect.value = firstOption.value;
                }
            }
        }

        // Update the model display name in welcome message
        updateModelDisplayName();
    } catch (error) {
        console.error("Failed to fetch models:", error);
    }
}

function updateModelDisplayName() {
    if (modelSelect.selectedIndex >= 0) {
        const selectedOption = modelSelect.options[modelSelect.selectedIndex];
        const modelName = selectedOption.textContent;
        promptInput.setAttribute('data-placeholder', `Chatting anonymously with ${modelName}`);
    }
}

// Update model display name when user changes model
modelSelect.addEventListener('change', updateModelDisplayName);

document.addEventListener("DOMContentLoaded", function () {
    promptInput.focus();
    fetchAndPopulateModels();
});

let base64Images = null;

// Create image preview container
const imagePreviewContainer = document.createElement('div');
imagePreviewContainer.id = 'image-preview-container';
imagePreviewContainer.className = 'image-preview-container';
document.getElementById('input-container').insertBefore(imagePreviewContainer, document.getElementById('prompt-input'));

function updateImagePreviews() {
    imagePreviewContainer.innerHTML = '';
    if (base64Images && base64Images.length > 0) {
        base64Images.forEach((imgData, index) => {
            const previewWrapper = document.createElement('div');
            previewWrapper.className = 'image-preview-wrapper';

            const img = document.createElement('img');
            img.src = imgData;
            img.className = 'image-preview';
            img.alt = 'Attached image ' + (index + 1);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'image-preview-remove';
            removeBtn.innerHTML = '&times;';
            removeBtn.type = 'button';
            removeBtn.onclick = function() {
                base64Images.splice(index, 1);
                updateImagePreviews();
            };

            previewWrapper.appendChild(img);
            previewWrapper.appendChild(removeBtn);
            imagePreviewContainer.appendChild(previewWrapper);
        });
        imagePreviewContainer.style.display = 'flex';
    } else {
        imagePreviewContainer.style.display = 'none';
    }
}

// Base64 encode images
imageInput.addEventListener('change', function () {
    const files = this.files;
    if (!base64Images) base64Images = [];

    let loadedCount = 0;
    const totalFiles = files.length;

    Array.from(files).forEach(file => {
        if (file) {
            const reader = new FileReader();
            reader.onload = function (event) {
                base64Images.push(event.target.result);
                loadedCount++;
                if (loadedCount === totalFiles) {
                    updateImagePreviews();
                }
            };
            reader.readAsDataURL(file);
        }
    });

    // Reset the input so the same file can be selected again
    this.value = '';
});

let messages = [];

async function getGPTResult(_promptToRetry, _uniqueIdToRetry) {
    const prompt = _promptToRetry || promptInput.textContent;
    const model = modelSelect.value;

    if (isGeneratingResponse || !prompt) {
        return;
    }
    submitButton.classList.add("loading");
    promptInput.textContent = '';

    if (!_uniqueIdToRetry) {
        addResponse(true, prompt, base64Images);
    }

    const uniqueId = _uniqueIdToRetry || addResponse(false);
    const responseElement = document.getElementById(uniqueId);
    loader(responseElement);
    isGeneratingResponse = true;

    const messageContent = [{ type: "text", text: prompt }];

    if (base64Images && base64Images.length > 0) {
        base64Images.forEach(imgData => {
            messageContent.push({
                type: "image_url",
                image_url: {
                    url: imgData
                }
            });
        });
    }

    messages.push({
        role: "user",
        content: messageContent
    });

    // Create abort controller for this request
    currentAbortController = new AbortController();
    updateActionButton(true);

    // Check if using local model
    if (typeof isLocalMode !== 'undefined' && isLocalMode && typeof activeLocalModel !== 'undefined' && activeLocalModel && typeof localEngines !== 'undefined' && localEngines[activeLocalModel]) {
        try {
            // Warn about images not being supported in local mode
            if (base64Images && base64Images.length > 0) {
                clearInterval(loadInterval);
                responseElement.innerHTML = '<p style="color: #fc885a; margin-bottom: 12px;">Note: Local models do not support image input. Processing text only.</p>';
            }

            clearInterval(loadInterval);
            responseElement.textContent = '';
            responseElement.style.color = '';

            const assistantResponse = await runLocalChatCompletion(messages, uniqueId, responseElement);

            // Add the assistant's response to the messages list (with model label for history)
            const localModelLabel = getLocalModelDisplayName(activeLocalModel) + ' (Local)';
            messages.push({ role: "assistant", content: assistantResponse, modelLabel: localModelLabel });

            // Clear image previews after successful send
            base64Images = null;
            updateImagePreviews();

            promptToRetry = null;
            uniqueIdToRetry = null;
            if (regenerateResponseButton) {
                regenerateResponseButton.style.display = 'none';
            }
            setTimeout(() => {
                responseList.scrollTop = responseList.scrollHeight;
            }, 10);
        } catch (err) {
            if (err.name === 'AbortError') {
                clearInterval(loadInterval);
                if (!responseElement.textContent || responseElement.textContent === '.' || responseElement.textContent === '..' || responseElement.textContent === '...') {
                    responseElement.textContent = 'Stopped';
                    responseElement.style.color = '#888';
                }
            } else {
                setRetryResponse(prompt, uniqueId);
                setErrorForResponse(responseElement, 'Local model error: ' + err.message);
            }
        } finally {
            isGeneratingResponse = false;
            clearInterval(loadInterval);
            submitButton.classList.remove("loading");
            currentAbortController = null;
            updateActionButton(false);
        }
        return;
    }

    // Cloud API path
    const formData = JSON.stringify({
        messages: messages,
        model: model,
        stream: true
    });

    // Determine which endpoint to use based on auth state
    const config = getConfig();
    const loggedIn = typeof isLoggedIn !== 'undefined' ? isLoggedIn : false;
    const endpoint = config.api.baseUrl + (loggedIn ? config.api.chatEndpoint : config.api.anonChatEndpoint);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: formData,
            signal: currentAbortController.signal
        });

        if (!response.ok) {
            setRetryResponse(prompt, uniqueId);
            const errorText = await response.json();
            const errorMessage = errorText && typeof errorText === 'object'
                ? (errorText.error || errorText.detail || JSON.stringify(errorText))
                : JSON.stringify(errorText);
            setErrorForResponse(responseElement, errorMessage);

            if (base64Images && base64Images.length > 0) {
                responseElement.innerHTML += '<p>Error. Ensure you are using a vision capable model if you are inputting an image.</p>';
            }
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;
        let firstContentReceived = false;

        let assistantResponse = '';

        while (!done) {
            const result = await reader.read();
            const value = result.value;
            const readerDone = result.done;
            if (value) {
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (data === '[DONE]') {
                            done = true;
                            break;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            // Check for error response
                            if (parsed.error) {
                                clearInterval(loadInterval);
                                setErrorForResponse(responseElement, parsed.error.message || 'Unknown error');
                                done = true;
                                break;
                            }
                            const content = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
                            if (content) {
                                if (!firstContentReceived) {
                                    firstContentReceived = true;
                                    clearInterval(loadInterval);
                                    responseElement.textContent = '';
                                    responseElement.style.color = '';  // Reset color from loader
                                }
                                assistantResponse += content;
                                // Store raw content for toggle
                                rawContentStore[uniqueId] = assistantResponse;
                                const htmlContent = converter.makeHtml(assistantResponse);
                                responseElement.innerHTML = htmlContent;
                            }
                        } catch (parseError) {
                            // Ignore parse errors for incomplete chunks
                        }
                    }
                }
            }
            done = readerDone;
        }

        // Add the assistant's response to the messages list (with model label for history)
        const cloudModelLabel = model.includes('/') ? model.split('/').pop() : model;
        messages.push({ role: "assistant", content: assistantResponse, modelLabel: cloudModelLabel });

        // Clear image previews after successful send
        base64Images = null;
        updateImagePreviews();

        promptToRetry = null;
        uniqueIdToRetry = null;
        if (regenerateResponseButton) {
            regenerateResponseButton.style.display = 'none';
        }
        setTimeout(() => {
            responseList.scrollTop = responseList.scrollHeight;
        }, 10);
    } catch (err) {
        // Handle abort separately - don't show as error
        if (err.name === 'AbortError') {
            clearInterval(loadInterval);
            // If we got some content, keep it; otherwise show "Stopped"
            if (!responseElement.textContent || responseElement.textContent === '.' || responseElement.textContent === '..' || responseElement.textContent === '...') {
                responseElement.textContent = 'Stopped';
                responseElement.style.color = '#888';
            }
        } else {
            setRetryResponse(prompt, uniqueId);
            setErrorForResponse(responseElement, 'Error: ' + err.message);
        }
    } finally {
        isGeneratingResponse = false;
        clearInterval(loadInterval);
        submitButton.classList.remove("loading");
        currentAbortController = null;
        updateActionButton(false);
    }
}

if (regenerateResponseButton) {
    regenerateResponseButton.addEventListener("click", () => {
        regenerateGPTResult();
    });
}

// ==================== Local Conversation Storage ====================

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
        } else if (modelSelect.querySelector(`option[value="${conversation.model}"]`)) {
            modelSelect.value = conversation.model;
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
    messages.forEach(msg => {
        const isUser = msg.role === 'user';
        let content = '';
        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            const textPart = msg.content.find(p => p.type === 'text');
            content = textPart ? textPart.text : '';
        }

        if (isUser) {
            addResponse(true, content);
        } else {
            // Use per-message modelLabel if available, otherwise fall back to conversation-level
            const modelLabel = msg.modelLabel || fallbackModelLabel;
            const uniqueId = addResponse(false, null, null, modelLabel);
            const responseElement = document.getElementById(uniqueId);
            // Store raw content for toggle
            rawContentStore[uniqueId] = content;
            responseElement.innerHTML = converter.makeHtml(content);
        }
    });

    // Show response list, hide welcome
    if (messages.length > 0) {
        document.getElementById('response-list').style.display = 'block';
        document.getElementById('welcome-message').style.display = 'none';
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
    document.getElementById('response-list').style.display = 'none';
    document.getElementById('welcome-message').style.display = 'flex';
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
                data-id="${conv.id}">
            <span class="conversation-item-title">${escapeHtml(conv.title)}</span>
            <span class="conversation-item-meta">${formatTimeAgo(conv.updatedAt)}</span>
        </button>
    `).join('');

    // Add click handlers
    listEl.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => loadConversation(item.dataset.id));
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
document.addEventListener('DOMContentLoaded', function() {
    renderConversationsList();

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

// ==================== Local Mode (WebLLM) ====================

// Dynamic model loading from WebLLM
const LOCAL_MODELS_CACHE_KEY = 'obscurify_webllm_models_cache';
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedLocalModels = null;

// Categorize models by VRAM requirements
function categorizeByVram(vramMB) {
    if (vramMB < 1000) return { category: 'Tiny', label: 'Tiny (<1GB VRAM)' };
    if (vramMB < 2000) return { category: 'Small', label: 'Small (1-2GB VRAM)' };
    if (vramMB < 4000) return { category: 'Medium', label: 'Medium (2-4GB VRAM)' };
    if (vramMB < 6000) return { category: 'Large', label: 'Large (4-6GB VRAM)' };
    if (vramMB < 10000) return { category: 'XLarge', label: 'Extra Large (6-10GB VRAM)' };
    return { category: 'Huge', label: 'Huge (10GB+ VRAM)' };
}

// Detect special model types from model ID
function detectModelType(modelId) {
    const id = modelId.toLowerCase();
    if (id.includes('coder') || id.includes('codellama')) return 'Code';
    if (id.includes('math') || id.includes('wizard')) return 'Math';
    if (id.includes('vision')) return 'Vision';
    if (id.includes('deepseek-r1') || id.includes('thinking')) return 'Reasoning';
    if (id.includes('function') || id.includes('gorilla')) return 'Function Calling';
    return null;
}

// Generate a friendly display name from model ID
function generateDisplayName(modelId) {
    // Remove -MLC suffix and quantization info for cleaner display
    let name = modelId.replace(/-MLC$/, '');

    // Extract size info (e.g., "1B", "7B", "0.5B")
    const sizeMatch = name.match(/[-_](\d+\.?\d*[BMK])/i);
    const size = sizeMatch ? sizeMatch[1].toUpperCase() : '';

    // Clean up common patterns
    name = name
        .replace(/-q[0-4]f(16|32)_?\d?/gi, '') // Remove quantization
        .replace(/-Instruct/gi, '')
        .replace(/-Chat/gi, '')
        .replace(/-it/gi, '')
        .replace(/-v\d+\.?\d*/gi, match => ` ${match.slice(1)}`) // Keep version but space it
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return name;
}

// Fetch and categorize models from WebLLM
async function fetchAvailableLocalModels() {
    // Check cache first
    try {
        const cached = localStorage.getItem(LOCAL_MODELS_CACHE_KEY);
        if (cached) {
            const { models, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < CACHE_DURATION_MS) {
                console.log('Using cached local models list');
                cachedLocalModels = models;
                return models;
            }
        }
    } catch (e) {
        console.warn('Failed to read models cache:', e);
    }

    // Wait for WebLLM to load
    if (!window.webllm?.prebuiltAppConfig?.model_list) {
        console.warn('WebLLM not loaded, cannot fetch models');
        return [];
    }

    const rawModels = window.webllm.prebuiltAppConfig.model_list;

    // Process and categorize models
    const categorized = {
        'Tiny': [],
        'Small': [],
        'Medium': [],
        'Large': [],
        'XLarge': [],
        'Huge': [],
        'Code': [],
        'Math': [],
        'Vision': [],
        'Reasoning': [],
        'Function Calling': []
    };

    const processedModels = rawModels.map(m => {
        const vramMB = m.vram_required_MB || 2000;
        const { category } = categorizeByVram(vramMB);
        const specialType = detectModelType(m.model_id);

        return {
            id: m.model_id,
            name: generateDisplayName(m.model_id),
            vram: `~${(vramMB / 1000).toFixed(1)}GB`,
            vramMB: vramMB,
            category: specialType || category,
            lowResource: m.low_resource_required || false
        };
    });

    // Sort by VRAM within each category
    processedModels.sort((a, b) => a.vramMB - b.vramMB);

    // Group into categories
    processedModels.forEach(model => {
        if (categorized[model.category]) {
            categorized[model.category].push(model);
        } else {
            // Fall back to VRAM-based category
            const { category } = categorizeByVram(model.vramMB);
            categorized[category].push(model);
        }
    });

    // Build final structure with category labels
    const result = {
        categories: [
            { key: 'Tiny', label: 'Tiny (<1GB VRAM)', models: categorized['Tiny'] },
            { key: 'Small', label: 'Small (1-2GB VRAM)', models: categorized['Small'] },
            { key: 'Medium', label: 'Medium (2-4GB VRAM)', models: categorized['Medium'] },
            { key: 'Large', label: 'Large (4-6GB VRAM)', models: categorized['Large'] },
            { key: 'XLarge', label: 'Extra Large (6-10GB VRAM)', models: categorized['XLarge'] },
            { key: 'Huge', label: 'Huge (10GB+ VRAM)', models: categorized['Huge'] },
            { key: 'Code', label: 'Code Specialists', models: categorized['Code'] },
            { key: 'Math', label: 'Math Specialists', models: categorized['Math'] },
            { key: 'Reasoning', label: 'Reasoning (Chain-of-Thought)', models: categorized['Reasoning'] },
            { key: 'Vision', label: 'Vision Models', models: categorized['Vision'] },
            { key: 'Function Calling', label: 'Function Calling', models: categorized['Function Calling'] },
        ].filter(c => c.models.length > 0),
        allModels: processedModels,
        totalCount: processedModels.length,
        fetchedAt: Date.now()
    };

    // Cache the result
    try {
        localStorage.setItem(LOCAL_MODELS_CACHE_KEY, JSON.stringify({
            models: result,
            timestamp: Date.now()
        }));
    } catch (e) {
        console.warn('Failed to cache models list:', e);
    }

    cachedLocalModels = result;
    return result;
}

// Get models (from cache or fetch)
function getAvailableLocalModels() {
    return cachedLocalModels;
}

// Find a model by ID
function findLocalModel(modelId) {
    const models = getAvailableLocalModels();
    if (!models) return null;
    return models.allModels.find(m => m.id === modelId);
}

// Populate the local model select dropdown
async function populateLocalModelSelect(selectEl) {
    if (!selectEl) return;

    // Show loading state
    selectEl.innerHTML = '<option value="" disabled selected>Loading available models...</option>';

    // Fetch models
    const modelData = await fetchAvailableLocalModels();

    if (!modelData || modelData.totalCount === 0) {
        selectEl.innerHTML = `
            <option value="" disabled selected>No models available</option>
            <optgroup label="Other">
                <option value="custom">Custom Model ID...</option>
            </optgroup>
        `;
        return;
    }

    // Build the dropdown HTML
    let html = '';

    // Add each category as an optgroup
    for (const category of modelData.categories) {
        html += `<optgroup label="${category.label}">`;
        for (const model of category.models) {
            html += `<option value="${model.id}">${model.name} (${model.vram})</option>`;
        }
        html += '</optgroup>';
    }

    // Add custom model option
    html += `
        <optgroup label="Other">
            <option value="custom">Custom Model ID...</option>
        </optgroup>
    `;

    selectEl.innerHTML = html;
    console.log(`Populated local model dropdown with ${modelData.totalCount} models in ${modelData.categories.length} categories`);
}

// Local mode state
const localEngines = {};  // Map: modelId -> engine instance
let enabledLocalModels = [];  // Array of enabled model IDs
let activeLocalModel = null;  // Currently selected local model
let isLocalMode = false;  // Whether local mode is active
const LOCAL_MODELS_KEY = 'obscurify_enabled_local_models';
const LOCAL_MODE_KEY = 'obscurify_local_mode';

// Get display name for a local model
function getLocalModelDisplayName(modelId) {
    const model = findLocalModel(modelId);
    return model ? model.name : generateDisplayName(modelId);
}

// Check WebGPU requirements
async function checkLocalModeRequirements() {
    if (!navigator.gpu) {
        return {
            supported: false,
            reason: "WebGPU not supported. Use Chrome 113+, Edge 113+, or Opera 99+."
        };
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return {
                supported: false,
                reason: "No WebGPU adapter found. Your GPU may not be supported or is disabled."
            };
        }

        // adapter.info is the modern API, requestAdapterInfo() is deprecated
        const adapterInfo = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
        const gpuName = adapterInfo.description || adapterInfo.device || adapterInfo.vendor || 'Unknown GPU';
        return {
            supported: true,
            gpu: gpuName,
            info: `GPU: ${gpuName}`
        };
    } catch (err) {
        return { supported: false, reason: `WebGPU error: ${err.message}` };
    }
}

// WebLLM binary library base URL and version
const MODEL_LIB_URL_PREFIX = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/';
const MODEL_LIB_VERSION = 'v0_2_80';

// Known compatible WASM libraries from WebLLM's prebuilt models
// Maps model_type to library name patterns that work for that architecture
const MODEL_TYPE_LIB_PATTERNS = {
    'gemma': 'gemma-2-2b-it-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    'gemma2': 'gemma-2-2b-it-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    'llama': 'Llama-3.2-1B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    'qwen2': 'Qwen2.5-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    'phi3': 'Phi-3.5-mini-instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    'phi': 'Phi-3.5-mini-instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm',
    'mistral': 'Mistral-7B-Instruct-v0.3-q4f16_1-ctx4k_cs1k-webgpu.wasm',
};

// Try to infer the WASM library URL from model config
async function inferModelLib(mlcConfig, modelId, baseUrl) {
    console.log('inferModelLib called with:', { mlcConfig, modelId, baseUrl });

    if (!mlcConfig || typeof mlcConfig !== 'object') {
        console.error('Invalid mlcConfig:', mlcConfig);
        return null;
    }

    const modelType = mlcConfig.model_type; // e.g., "gemma", "llama", "qwen2"
    const quant = mlcConfig.quantization; // e.g., "q4f16_1"
    const ctxSize = mlcConfig.context_window_size || 4096;
    const chunkSize = mlcConfig.prefill_chunk_size || 1024;

    // Convert sizes to k notation (4096 -> 4k, 8192 -> 8k)
    const ctxK = Math.floor(ctxSize / 1024);
    const csK = Math.floor(chunkSize / 1024);

    // Try model name from ID
    const modelName = modelId ? modelId.split('/').pop().replace(/-MLC$/, '') : '';

    // Build possible library names based on model architecture
    const possibleLibNames = [];

    // WebLLM library naming pattern: {model-name}-{quant}-ctx{N}k_cs{M}k-webgpu.wasm
    possibleLibNames.push(`${modelName}-ctx${ctxK}k_cs${csK}k-webgpu.wasm`);
    possibleLibNames.push(`${modelName}-ctx4k_cs1k-webgpu.wasm`);

    if (modelType && quant) {
        possibleLibNames.push(`${modelType}-${quant}-ctx${ctxK}k_cs${csK}k-webgpu.wasm`);
        possibleLibNames.push(`${modelType}-${quant}-ctx4k_cs1k-webgpu.wasm`);
    }

    // Locations to search for WASM libraries (in priority order)
    const libSources = [
        baseUrl, // Model's own HuggingFace repo
        `${MODEL_LIB_URL_PREFIX}${MODEL_LIB_VERSION}/`, // WebLLM's official binary repo
    ];

    console.log('Searching for WASM library, trying:', possibleLibNames);

    for (const source of libSources) {
        for (const libName of possibleLibNames) {
            const url = `${source}${libName}`;
            try {
                const check = await fetch(url, { method: 'HEAD' });
                if (check.ok) {
                    console.log('Found WASM library at:', url);
                    return url;
                }
            } catch {
                // Continue
            }
        }
    }

    // Fallback: try using a known compatible library for this model type
    // This allows running custom models using a compatible architecture's library
    if (modelType && MODEL_TYPE_LIB_PATTERNS[modelType]) {
        const libName = MODEL_TYPE_LIB_PATTERNS[modelType];
        const fallbackLib = `${MODEL_LIB_URL_PREFIX}${MODEL_LIB_VERSION}/${libName}`;
        console.log(`Trying fallback ${modelType} library:`, fallbackLib);
        try {
            const check = await fetch(fallbackLib, { method: 'HEAD' });
            if (check.ok) {
                console.log(`Using compatible ${modelType} library for custom model`);
                return fallbackLib;
            }
        } catch {
            // Continue
        }
    }

    return null;
}

// Build appConfig for a custom HuggingFace model
async function buildCustomModelConfig(modelId) {
    console.log('buildCustomModelConfig called with:', modelId);

    if (!modelId || typeof modelId !== 'string') {
        throw new Error('Invalid model ID provided');
    }

    // modelId format: "username/model-name" (HuggingFace path)
    const baseUrl = `https://huggingface.co/${modelId}/resolve/main/`;
    console.log('Fetching config from:', baseUrl);

    // Fetch the mlc-chat-config.json to get model configuration
    const configUrl = `${baseUrl}mlc-chat-config.json`;
    const response = await fetch(configUrl);

    if (!response.ok) {
        throw new Error(`Could not fetch model config from ${configUrl}. Ensure this is a valid MLC-formatted model.`);
    }

    const mlcConfig = await response.json();
    console.log('MLC config for', modelId, ':', mlcConfig);

    // The model_lib field tells us which WASM library to use
    let modelLib = mlcConfig.model_lib || mlcConfig.model_lib_url || mlcConfig.lib;

    // If model_lib is specified but not a full URL, resolve it
    if (modelLib && !modelLib.startsWith('http')) {
        const possibleUrls = [
            `${baseUrl}${modelLib}`,
            `${MODEL_LIB_URL_PREFIX}${MODEL_LIB_VERSION}/${modelLib}`,
        ];

        let resolved = false;
        for (const url of possibleUrls) {
            try {
                const check = await fetch(url, { method: 'HEAD' });
                if (check.ok) {
                    modelLib = url;
                    console.log('Resolved model_lib to:', url);
                    resolved = true;
                    break;
                }
            } catch {
                // Continue
            }
        }

        // If we couldn't resolve the relative path, set to null to trigger inference
        if (!resolved) {
            console.log('Could not resolve model_lib path:', modelLib);
            modelLib = null;
        }
    }

    // If no model_lib in config, try to infer from model architecture
    if (!modelLib) {
        console.log('No model_lib in config, attempting to infer...');
        modelLib = await inferModelLib(mlcConfig, modelId, baseUrl);
    }

    // Check if model uses old ndarray-cache.json format (incompatible with current WebLLM)
    try {
        const tensorCacheCheck = await fetch(`${baseUrl}tensor-cache.json`, { method: 'HEAD' });
        if (!tensorCacheCheck.ok) {
            const ndarrayCacheCheck = await fetch(`${baseUrl}ndarray-cache.json`, { method: 'HEAD' });
            if (ndarrayCacheCheck.ok) {
                console.error(
                    `Model ${modelId} uses older MLC format (ndarray-cache.json). ` +
                    `Current WebLLM requires tensor-cache.json format.`
                );
                throw new Error('Model format not supported');
            }
        }
    } catch (cacheCheckErr) {
        if (cacheCheckErr.message === 'Model format not supported') {
            throw cacheCheckErr;
        }
        // Ignore other fetch errors, let WebLLM handle them
    }

    if (!modelLib) {
        const modelType = mlcConfig.model_type || 'unknown';
        throw new Error(
            `Could not find WASM library for ${modelId} (${modelType} architecture).\n\n` +
            `Custom models need a pre-compiled WASM library. Options:\n` +
            `1. Add "model_lib" URL to the model's mlc-chat-config.json\n` +
            `2. Include the .wasm file in the HuggingFace repo\n` +
            `3. Use a model from the predefined list (these have pre-compiled libraries)\n\n` +
            `See: https://llm.mlc.ai/docs/compilation/compile_models.html`
        );
    }

    // Build the model record with all fields WebLLM might need
    const modelRecord = {
        model_id: modelId,
        model: baseUrl,
        model_lib: modelLib,
        vram_required_MB: mlcConfig.vram_required_MB || 2000,
        low_resource_required: mlcConfig.low_resource_required || false,
        // Overrides get merged into the chat config that WebLLM fetches
        // This is critical for models that don't have tokenizer_files in their config
        overrides: {
            tokenizer_files: mlcConfig.tokenizer_files || ['tokenizer.json', 'tokenizer_config.json'],
            context_window_size: mlcConfig.context_window_size || 4096,
            prefill_chunk_size: mlcConfig.prefill_chunk_size || 1024,
        },
    };

    console.log('Built model record:', modelRecord);

    return {
        model_list: [modelRecord]
    };
}

// Load a local model with progress tracking
async function loadLocalModel(modelId) {
    console.log('loadLocalModel called with:', modelId, typeof modelId);

    if (!modelId || typeof modelId !== 'string') {
        console.error('Invalid modelId:', modelId);
        return { success: false, error: 'Invalid model ID' };
    }

    const progressEl = document.getElementById('local-progress');
    const addBtn = document.getElementById('add-local-model-btn');

    if (!progressEl || !addBtn) return { success: false, error: 'UI elements not found' };

    addBtn.disabled = true;
    addBtn.textContent = 'Downloading...';
    progressEl.style.display = 'block';
    progressEl.textContent = 'Initializing...';

    const initProgressCallback = (progress) => {
        const pct = Math.round((progress.progress || 0) * 100);
        const text = progress.text || `Loading: ${pct}%`;
        progressEl.textContent = text;
    };

    try {
        // Check if webllm is loaded
        if (!window.webllm) {
            throw new Error('WebLLM not loaded. Please refresh the page.');
        }

        // Check if CreateMLCEngine exists
        if (typeof window.webllm.CreateMLCEngine !== 'function') {
            throw new Error('WebLLM not fully loaded. Please refresh the page.');
        }

        // Check if this is a custom HuggingFace model (contains /)
        const isCustomModel = modelId.includes('/');
        let engineConfig = { initProgressCallback };

        if (isCustomModel) {
            progressEl.textContent = 'Fetching model configuration...';
            try {
                const appConfig = await buildCustomModelConfig(modelId);
                console.log('Passing appConfig to WebLLM:', JSON.stringify(appConfig, null, 2));
                engineConfig.appConfig = appConfig;
            } catch (configErr) {
                console.error('Config build error:', configErr);
                throw new Error(`Failed to load custom model: ${configErr.message}`);
            }
        }

        console.log('Calling CreateMLCEngine with:', modelId, engineConfig);
        let engine;
        try {
            engine = await window.webllm.CreateMLCEngine(modelId, engineConfig);
        } catch (webllmErr) {
            console.error('WebLLM CreateMLCEngine error:', webllmErr);
            console.error('Stack:', webllmErr.stack);
            throw webllmErr;
        }

        localEngines[modelId] = engine;

        // Add to enabled models if not already there
        if (!enabledLocalModels.includes(modelId)) {
            enabledLocalModels.push(modelId);
            localStorage.setItem(LOCAL_MODELS_KEY, JSON.stringify(enabledLocalModels));
        }

        updateLocalModelDropdown();
        updateEnabledModelsList();
        showModeToggle();

        // Auto-switch to local mode when first model is downloaded
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
        // Log detailed error for debugging
        console.error('Local model load error:', error.message);

        // Show generic error to user, with specific hints only for actionable issues
        let userMessage = 'Could not load model';
        if (error.message.includes('GPUDeviceLostInfo') || error.message.includes('device was lost')) {
            userMessage = 'Insufficient GPU memory. Try a smaller model.';
        }

        progressEl.textContent = userMessage;
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
        const isLoaded = localEngines[modelId] ? '' : ' (cached)';
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
        const isLoaded = localEngines[modelId] ? '<span class="status-ok">loaded</span>' : '<span class="status-cached">cached</span>';
        return `
            <div class="local-model-item" data-model-id="${modelId}">
                <span class="local-model-name">${displayName}</span>
                <span class="local-model-info">${isLoaded}</span>
                <button class="local-model-remove" data-model-id="${modelId}" title="Remove model">&times;</button>
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
    // Remove from engines
    if (localEngines[modelId]) {
        delete localEngines[modelId];
    }

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
    }
    if (modelName) {
        promptInput.setAttribute('data-placeholder', `Chatting anonymously with ${modelName}`);
    }
};

// Initialize local mode UI
function initLocalModeUI() {
    const localModeBtn = document.getElementById('local-mode-btn');
    const localModeModal = document.getElementById('local-mode-modal');
    const localModalClose = document.getElementById('local-modal-close');
    const modalOverlay = localModeModal?.querySelector('.modal-overlay');
    const addModelSelect = document.getElementById('add-local-model-select');
    const customModelInput = document.getElementById('custom-model-input');
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
    localModeBtn?.addEventListener('click', async (e) => {
        e.preventDefault();
        localModeModal.classList.add('open');

        const statusEl = document.getElementById('local-requirements-status');
        const setupEl = document.getElementById('local-model-setup');

        statusEl.textContent = 'Checking WebGPU support...';
        statusEl.className = 'local-requirements-status';

        const status = await checkLocalModeRequirements();

        if (status.supported) {
            statusEl.innerHTML = `<span class="status-ok">&#10003; WebGPU supported</span><br><span class="gpu-info">${status.info}</span>`;
            setupEl.style.display = 'block';
            // Populate the model dropdown dynamically
            await populateLocalModelSelect(addModelSelect);
        } else {
            statusEl.innerHTML = `<span class="status-error">&#10007; ${status.reason}</span>`;
            setupEl.style.display = 'none';
        }

        updateEnabledModelsList();
    });

    // Close modal
    const closeModal = () => {
        localModeModal?.classList.remove('open');
    };

    localModalClose?.addEventListener('click', closeModal);
    modalOverlay?.addEventListener('click', closeModal);

    // Custom model input toggle
    addModelSelect?.addEventListener('change', (e) => {
        const isCustom = e.target.value === 'custom';
        if (customModelInput) {
            customModelInput.style.display = isCustom ? 'block' : 'none';
        }
        const customHint = document.getElementById('custom-model-hint');
        if (customHint) {
            customHint.style.display = isCustom ? 'block' : 'none';
        }
    });

    // Add model button
    addLocalModelBtn?.addEventListener('click', () => {
        const selectValue = addModelSelect?.value;
        const modelId = selectValue === 'custom'
            ? customModelInput?.value.trim()
            : selectValue;

        if (modelId && modelId !== 'custom') {
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

        if (!localEngines[selectedModelId]) {
            // Model is cached but not loaded - reload it
            const statusEl = document.getElementById('local-model-status');
            if (statusEl) {
                statusEl.textContent = 'Loading model...';
                statusEl.className = 'local-model-status';
            }

            try {
                if (!window.webllm) {
                    throw new Error('WebLLM not loaded');
                }

                // Check if this is a custom HuggingFace model
                const isCustomModel = selectedModelId.includes('/');
                let engineConfig = {
                    initProgressCallback: (p) => {
                        if (statusEl) {
                            statusEl.textContent = p.text || `Loading: ${Math.round((p.progress || 0) * 100)}%`;
                        }
                    }
                };

                if (isCustomModel) {
                    if (statusEl) {
                        statusEl.textContent = 'Fetching model configuration...';
                    }
                    const appConfig = await buildCustomModelConfig(selectedModelId);
                    engineConfig.appConfig = appConfig;
                }

                const engine = await window.webllm.CreateMLCEngine(selectedModelId, engineConfig);

                localEngines[selectedModelId] = engine;
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
                    statusEl.textContent = `Error: ${err.message}`;
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

// Run local chat completion
async function runLocalChatCompletion(messages, uniqueId, responseElement) {
    if (!activeLocalModel || !localEngines[activeLocalModel]) {
        throw new Error('No local model loaded');
    }

    const engine = localEngines[activeLocalModel];

    // Convert messages to format expected by WebLLM
    const formattedMessages = messages.map(msg => {
        if (typeof msg.content === 'string') {
            return { role: msg.role, content: msg.content };
        } else if (Array.isArray(msg.content)) {
            // Extract text from multimodal content (local models don't support images)
            const textPart = msg.content.find(p => p.type === 'text');
            return { role: msg.role, content: textPart?.text || '' };
        }
        return msg;
    });

    const response = await engine.chat.completions.create({
        messages: formattedMessages,
        stream: true
    });

    let assistantResponse = '';

    for await (const chunk of response) {
        if (currentAbortController?.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
            assistantResponse += content;
            rawContentStore[uniqueId] = assistantResponse;
            responseElement.innerHTML = converter.makeHtml(assistantResponse);
            responseList.scrollTop = responseList.scrollHeight;
        }
    }

    return assistantResponse;
}

// Initialize local mode on DOM ready
document.addEventListener('DOMContentLoaded', initLocalModeUI);
