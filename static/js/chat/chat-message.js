// chat-message.js — Message bubble lifecycle: addResponse creates a message
// DOM node, toggleRawContent flips between rendered markdown and raw source,
// loader animates the dots placeholder, and setErrorForResponse renders an
// inline error with a retry button. Also owns rawContentStore (shared cache
// of raw markdown per message, keyed by unique id).

function generateUniqueId() {
    const timestamp = Date.now();
    const randomNumber = Math.random();
    const hexadecimalString = randomNumber.toString(16);
    return 'id-' + timestamp + '-' + hexadecimalString;
}

// Store raw content for each response (for raw toggle)
const rawContentStore = {};

function isSafeImageDataUrl(url) {
    return /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(String(url || ''));
}

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

    const messageEl = document.createElement('div');
    messageEl.className = 'message ' + role;
    const headerEl = document.createElement('div');
    headerEl.className = 'message-header';
    const labelEl = document.createElement('strong');
    labelEl.textContent = label + ':';
    headerEl.appendChild(labelEl);

    if (!selfFlag) {
        const headerActions = document.createElement('div');
        headerActions.className = 'message-header-actions';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'raw-toggle-btn';
        toggleBtn.dataset.target = uniqueId;
        toggleBtn.title = 'Toggle raw markdown';
        toggleBtn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M16 18l6-6-6-6"></path><path d="M8 6l-6 6 6 6"></path>' +
            '</svg>';
        toggleBtn.addEventListener('click', () => toggleRawContent(uniqueId));
        headerActions.appendChild(toggleBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-retry-btn';
        deleteBtn.title = 'Delete this response and edit your prompt';
        deleteBtn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
            '</svg>';
        deleteBtn.addEventListener('click', () => {
            const msgEl = deleteBtn.closest('.message');
            if (msgEl) deleteAssistantAndRestorePrompt(msgEl);
        });
        headerActions.appendChild(deleteBtn);

        headerEl.appendChild(headerActions);
    }

    const promptEl = document.createElement('div');
    promptEl.className = 'prompt-content';
    promptEl.id = uniqueId;
    promptEl.textContent = prompt || '';

    messageEl.appendChild(headerEl);
    messageEl.appendChild(promptEl);

    if (selfFlag && images && images.length > 0) {
        const imagesEl = document.createElement('div');
        imagesEl.className = 'message-images';
        images.forEach((img) => {
            if (!isSafeImageDataUrl(img)) return;
            const imageEl = document.createElement('img');
            imageEl.src = img;
            imageEl.className = 'message-image';
            imageEl.alt = 'Attached image';
            imagesEl.appendChild(imageEl);
        });
        if (imagesEl.childNodes.length > 0) {
            messageEl.appendChild(imagesEl);
        }
    }

    responseList.appendChild(messageEl);
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
        renderMarkdownIntoElement(element, rawContentStore[uniqueId]);
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

// Sanitize error messages before displaying to users
function sanitizeErrorMessage(rawMessage) {
    if (!rawMessage || typeof rawMessage !== 'string') return 'An unexpected error occurred. Please try again.';
    const msg = rawMessage.toLowerCase();
    if (msg.includes('llmchatpipeline') || msg.includes('pipeline')) {
        return 'This model is not compatible with chat. Please select a different model.';
    }
    if (msg.includes('gpudevicelostinfo') || msg.includes('device was lost') || msg.includes('out of memory')) {
        return 'Insufficient GPU memory. Try a smaller model.';
    }
    if (msg.includes('webgpu') || msg.includes('navigator.gpu')) {
        return 'GPU acceleration is not available on this device. Models will run on CPU.';
    }
    if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('networkerror')) {
        return 'Network error while loading model. Please check your connection and try again.';
    }
    if (msg.includes('aborted') || msg.includes('abort')) {
        return 'Request was cancelled.';
    }
    if (msg.includes('not loaded') || msg.includes('not fully loaded')) {
        return rawMessage; // These are already user-friendly
    }
    // Generic fallback - don't expose raw internals
    if (msg.includes('error') || msg.length > 200) {
        return 'An error occurred. Please try a different model or refresh the page.';
    }
    return rawMessage;
}

function setErrorForResponse(element, message, prompt, uniqueId) {
    const errorText = document.createElement('span');
    errorText.textContent = sanitizeErrorMessage(message);
    errorText.style.color = 'rgb(255, 84, 84)';
    element.replaceChildren(errorText);

    // Add inline retry icon button if prompt context is available
    if (prompt && uniqueId) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn';
        retryBtn.title = 'Retry';
        retryBtn.innerHTML =
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path>' +
            '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>' +
            '</svg>';
        retryBtn.addEventListener('click', async () => {
            retryBtn.disabled = true;
            retryBtn.style.opacity = '0.4';
            try {
                await getGPTResult(prompt, uniqueId);
            } finally {
                retryBtn.disabled = false;
                retryBtn.style.opacity = '';
            }
        });
        element.appendChild(retryBtn);
    }
}

// Delete an assistant message + the user prompt that produced it + every
// message below, then load the user's prompt back into the input box so
// they can edit and resend it.
async function deleteAssistantAndRestorePrompt(assistantMessageEl) {
    if (!assistantMessageEl || !assistantMessageEl.classList.contains('assistant-message')) {
        return;
    }

    // Find the user message that prompted this assistant response.
    let userEl = assistantMessageEl.previousElementSibling;
    while (userEl && !userEl.classList.contains('user-message')) {
        userEl = userEl.previousElementSibling;
    }
    if (!userEl) return;

    const promptDiv = userEl.querySelector('.prompt-content');
    const prompt = promptDiv ? promptDiv.textContent : '';
    if (!prompt) return;

    // The msgIdx dataset attribute is set when the user message is pushed to
    // the messages array. It survives DOM reordering and abort/error cases
    // where the messages array and DOM can diverge.
    const msgIdxRaw = userEl.dataset.msgIdx;
    const msgIdx = msgIdxRaw !== undefined ? parseInt(msgIdxRaw, 10) : NaN;

    // If a stream is in progress, abort it before mutating state out from under it.
    if (typeof isGeneratingResponse !== 'undefined' && isGeneratingResponse &&
        typeof currentAbortController !== 'undefined' && currentAbortController) {
        try { currentAbortController.abort(); } catch (_e) { /* noop */ }
        const start = Date.now();
        while (typeof isGeneratingResponse !== 'undefined' && isGeneratingResponse && Date.now() - start < 2000) {
            await new Promise(r => setTimeout(r, 20));
        }
    }

    // Trim the messages array using the stored index. If the index is not
    // available (older saved conversations), fall back to counting user
    // bubbles before this one — works because each fresh getGPTResult pushes
    // exactly one user entry.
    if (typeof messages !== 'undefined' && Array.isArray(messages)) {
        if (Number.isFinite(msgIdx) && msgIdx >= 0 && msgIdx <= messages.length) {
            messages.length = msgIdx;
        } else {
            let userCount = 0;
            let sib = userEl.previousElementSibling;
            while (sib) {
                if (sib.classList.contains('user-message')) userCount++;
                sib = sib.previousElementSibling;
            }
            const maxLen = Math.min(messages.length, userCount * 2);
            messages.length = maxLen;
        }
    }

    // Remove the user message and every sibling after it from the DOM.
    let cur = userEl;
    while (cur) {
        const next = cur.nextElementSibling;
        cur.remove();
        cur = next;
    }

    // Persist the trimmed conversation now (the auto-save hook only fires
    // after getGPTResult; without it, the deletion would be lost on refresh).
    if (typeof saveCurrentConversation === 'function') {
        try { saveCurrentConversation(); } catch (_e) { /* noop */ }
    }

    // If we deleted everything, return to the landing UI.
    const remainingMessages = responseList.querySelectorAll('.message').length;
    if (remainingMessages === 0 && typeof startNewConversation === 'function') {
        startNewConversation();
    }

    // Load the prompt back into the active input box and focus it so the
    // user can edit and resubmit.
    if (typeof promptInput !== 'undefined' && promptInput) {
        promptInput.textContent = prompt;
        if (typeof promptInput.focus === 'function') {
            promptInput.focus();
        }
        // Place the caret at the end of the restored text for natural editing.
        try {
            const range = document.createRange();
            range.selectNodeContents(promptInput);
            range.collapse(false);
            const sel = window.getSelection && window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
        } catch (_e) { /* noop */ }
    }
}
