// chat-dom.js — DOM element references, showdown setup, input-mode switching,
// action button (stop / new conversation), and keydown/click handlers for the
// landing + chat-mode inputs. All later modules assume this file has run and
// populated the globals declared here.

// Markdown converter using showdown
const converter = new showdown.Converter({
    tables: true,
    strikethrough: true,
    tasklists: true
});
// Landing page elements
const landingSubmitButton = document.getElementById('submit-button');
const landingPromptInput = document.getElementById('prompt-input');
const landingImageInput = document.getElementById('image-input');

// Chat mode elements
const chatSubmitButton = document.getElementById('chat-submit-button');
const chatPromptInput = document.getElementById('chat-prompt-input');
const chatImageInput = document.getElementById('chat-image-input');

// Active input references (switch from landing to chat after first message)
let submitButton = landingSubmitButton;
let promptInput = landingPromptInput;
let imageInput = landingImageInput;

const modelSelect = document.getElementById('model-select');
const responseList = document.getElementById('response-list');
const actionToggle = document.getElementById('action-toggle');
const newConvIcon = document.getElementById('new-conv-icon');
const stopIcon = document.getElementById('stop-icon');
let isGeneratingResponse = false;
let currentAbortController = null;

let loadInterval = null;

// Switch active input references to chat mode
function switchToChatInputs() {
    submitButton = chatSubmitButton;
    promptInput = chatPromptInput;
    imageInput = chatImageInput;

    // Re-attach image preview container to chat input
    const chatInputContainer = document.getElementById('chat-input-container');
    if (chatInputContainer && imagePreviewContainer) {
        chatInputContainer.insertBefore(imagePreviewContainer, chatPromptInput);
    }
}

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

function submitFromLanding() {
    const text = landingPromptInput.textContent;
    if (!text) return;
    landingPromptInput.textContent = '';
    if (typeof enterChatMode === 'function') enterChatMode();
    switchToChatInputs();
    showResponseList();
    getGPTResult(text);
}

// Landing input handlers
landingPromptInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.shiftKey) {
            document.execCommand('insertHTML', false, '<br/><br/>');
        } else {
            submitFromLanding();
        }
    }
});

landingSubmitButton.addEventListener("click", submitFromLanding);

// Chat mode input handlers
chatPromptInput.addEventListener('keydown', function (event) {
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

chatSubmitButton.addEventListener("click", () => {
    showResponseList();
    getGPTResult();
});
