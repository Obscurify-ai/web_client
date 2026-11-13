// chat-privacy.js — the sidebar's quick controls: Temp (temporary chat), Tor and Wipe.
// Local lives in chat-local.js. Loads after chat-conversations.js and chat-local.js.

// What Wipe deletes: chats and how the chat page is set up, nothing else. Vouchers,
// voucher orders and affiliate codes also sit in localStorage and are money, so they stay.
const WIPE_LOCAL_KEYS = [
    'obscurify_conversations',
    'obscurify_current_conversation',
    'obscurify_folders_closed',
    'obscurify_chat_settings',
    'obscurify_enabled_local_models',
    'obscurify_local_mode',
    'obscurify_favorite_models',
    'obscurify_tools_off',
    'obscurify_sharing_model',
    'obscurify_tee_verify',
    'obscurify_encrypted',
    'obscurify_pending_replies',
];
const WIPE_SESSION_KEYS = ['obscurify_requested_model'];
// Local Mode's downloaded GGUF files (BrowserAgentKit llama-bridge.js MODEL_CACHE).
const WIPE_CACHES = ['bak-gguf-v1'];

// Turn temporary chat on or off. Either way the open chat is left for a fresh one,
// unless `fresh` is false (opening a saved chat does its own switching).
function setTemporaryChat(on, fresh = true) {
    // A streaming answer is saved (or, in a temporary chat, dropped) before the switch.
    if (fresh && isGeneratingResponse) {
        finishAnswerBeforeSwitch().then(() => setTemporaryChat(on, fresh));
        return;
    }
    if (fresh) startNewConversation();
    temporaryChat = on;
    document.getElementById('temp-chat-btn')?.setAttribute('aria-pressed', String(on));
    updateModelDisplayName();
}

// "Chatting anonymously with X" becomes "Temporary chat with X", on both inputs.
const updateModelDisplayNameBeforeTemp = updateModelDisplayName;
updateModelDisplayName = function() {
    updateModelDisplayNameBeforeTemp();
    const base = (promptInput.getAttribute('data-placeholder') || 'Chatting anonymously')
        .replace(/^Temporary chat/, 'Chatting anonymously');
    const text = temporaryChat ? base.replace(/^Chatting anonymously/, 'Temporary chat') : base;
    for (const id of ['prompt-input', 'chat-prompt-input']) {
        document.getElementById(id)?.setAttribute('data-placeholder', text);
    }
};

async function wipeBrowser() {
    // Nothing may be saved again on the way out.
    temporaryChat = true;
    messages = [];
    for (const key of WIPE_LOCAL_KEYS) localStorage.removeItem(key);
    for (const key of WIPE_SESSION_KEYS) sessionStorage.removeItem(key);
    if (window.caches) {
        await Promise.all(WIPE_CACHES.map((name) => caches.delete(name).catch(() => false)));
    }
    location.replace('/');
}

document.addEventListener('DOMContentLoaded', () => {
    const tempBtn = document.getElementById('temp-chat-btn');
    tempBtn?.addEventListener('click', () => setTemporaryChat(!temporaryChat));

    if (location.hostname.endsWith('.onion')) {
        document.getElementById('tor-btn')?.setAttribute('aria-pressed', 'true');
    }

    const dialog = document.getElementById('wipe-dialog');
    document.getElementById('wipe-btn')?.addEventListener('click', () => dialog.showModal());
    document.getElementById('wipe-cancel')?.addEventListener('click', () => dialog.close());
    dialog?.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.getElementById('wipe-confirm')?.addEventListener('click', wipeBrowser);
});
