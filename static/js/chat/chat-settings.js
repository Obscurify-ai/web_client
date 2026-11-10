// chat-settings.js — Chat settings, kept in this browser only. Custom instructions apply to every
// chat; each chat has its own system prompt, temperature, top-p, length limit and reasoning effort,
// stored on the conversation. Presets save those per-chat settings under a name, and one preset can
// start every new chat. Owns chatSettings (the open chat's) and the settings dialog.
// toApiMessages' callers add the system prompt (withSystemPrompt) and the parameters
// (samplingParams); Code Mode appends the system prompt to its own (userSystemPrompt).

const SETTINGS_KEY = 'obscurify_chat_settings';
const REASONING_EFFORTS = ['low', 'medium', 'high'];

// What a chat can set; an empty field means the model's default and isn't sent.
const CHAT_FIELDS = ['system', 'temperature', 'top_p', 'max_tokens', 'reasoning'];

let chatSettings = {};

function loadSettingsStore() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return { instructions: s.instructions || '', presets: Array.isArray(s.presets) ? s.presets : [], newChatPreset: s.newChatPreset || null };
    } catch (_e) {
        return { instructions: '', presets: [], newChatPreset: null };
    }
}

function saveSettingsStore(store) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(store));
}

// Only the fields that are set, so an untouched chat stores nothing.
function cleanChatSettings(s) {
    const out = {};
    for (const k of CHAT_FIELDS.concat(['preset'])) {
        const v = s && s[k];
        if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
}

// A new chat starts from the chosen preset, or from nothing.
function newChatSettings() {
    const store = loadSettingsStore();
    const preset = store.presets.find((p) => p.id === store.newChatPreset);
    return preset ? cleanChatSettings(Object.assign({}, preset, { preset: preset.id })) : {};
}

function setChatSettings(s) {
    chatSettings = cleanChatSettings(s);
    updateSettingsIndicator();
}

// Custom instructions, then this chat's system prompt.
function userSystemPrompt() {
    return [loadSettingsStore().instructions, chatSettings.system]
        .map((t) => (t || '').trim()).filter(Boolean).join('\n\n');
}

function withSystemPrompt(apiMessages) {
    const text = userSystemPrompt();
    return text ? [{ role: 'system', content: text }].concat(apiMessages) : apiMessages;
}

// The request fields this chat changes from the model's defaults.
function samplingParams() {
    const out = {};
    const num = (v) => (v === undefined || v === '' ? null : Number(v));
    const t = num(chatSettings.temperature);
    if (t !== null && Number.isFinite(t)) out.temperature = t;
    const p = num(chatSettings.top_p);
    if (p !== null && Number.isFinite(p)) out.top_p = p;
    const m = num(chatSettings.max_tokens);
    if (m !== null && Number.isInteger(m) && m > 0) out.max_tokens = m;
    if (REASONING_EFFORTS.includes(chatSettings.reasoning)) out.reasoning = { effort: chatSettings.reasoning };
    return out;
}

function chatHasSettings() {
    return Boolean(userSystemPrompt()) || Object.keys(samplingParams()).length > 0;
}

// The sidebar link shows when something is set.
function updateSettingsIndicator() {
    const has = chatHasSettings();
    document.querySelectorAll('[data-settings-dot]').forEach((dot) => { dot.hidden = !has; });
}

// --- The dialog ---

function settingsField(id) {
    return document.getElementById(id);
}

function fillSettingsDialog() {
    const store = loadSettingsStore();
    settingsField('settings-instructions').value = store.instructions;
    settingsField('settings-system').value = chatSettings.system || '';
    settingsField('settings-temperature').value = chatSettings.temperature ?? '';
    settingsField('settings-top-p').value = chatSettings.top_p ?? '';
    settingsField('settings-max-tokens').value = chatSettings.max_tokens ?? '';
    settingsField('settings-reasoning').value = chatSettings.reasoning || '';
    const select = settingsField('settings-preset');
    select.replaceChildren(new Option('None', ''));
    store.presets.forEach((p) => select.appendChild(new Option(p.name, p.id)));
    select.value = store.presets.some((p) => p.id === chatSettings.preset) ? chatSettings.preset : '';
    const preset = store.presets.find((p) => p.id === select.value);
    settingsField('settings-preset-delete').hidden = !preset;
    settingsField('settings-new-chats-row').hidden = !preset;
    settingsField('settings-new-chats').checked = Boolean(preset) && store.newChatPreset === preset.id;
}

// The dialog's per-chat fields, as stored.
function readChatFields() {
    return {
        system: settingsField('settings-system').value,
        temperature: settingsField('settings-temperature').value === '' ? '' : Number(settingsField('settings-temperature').value),
        top_p: settingsField('settings-top-p').value === '' ? '' : Number(settingsField('settings-top-p').value),
        max_tokens: settingsField('settings-max-tokens').value === '' ? '' : Number(settingsField('settings-max-tokens').value),
        reasoning: settingsField('settings-reasoning').value,
    };
}

// Every change is kept at once: the store for instructions, the conversation for the rest.
function chatSettingsChanged() {
    const store = loadSettingsStore();
    store.instructions = settingsField('settings-instructions').value;
    saveSettingsStore(store);
    setChatSettings(Object.assign(readChatFields(), { preset: chatSettings.preset }));
    if (messages.length > 0 && typeof saveCurrentConversation === 'function') saveCurrentConversation();
}

function applyPreset(id) {
    const preset = loadSettingsStore().presets.find((p) => p.id === id);
    setChatSettings(preset ? Object.assign({}, preset, { preset: preset.id }) : Object.assign({}, chatSettings, { preset: '' }));
    if (messages.length > 0 && typeof saveCurrentConversation === 'function') saveCurrentConversation();
    fillSettingsDialog();
}

function savePreset() {
    const store = loadSettingsStore();
    const current = store.presets.find((p) => p.id === chatSettings.preset);
    const name = (prompt('Name this preset', current ? current.name : '') || '').trim();
    if (!name) return;
    let preset = store.presets.find((p) => p.name === name);
    if (!preset) {
        preset = { id: 'preset-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name };
        store.presets.push(preset);
    }
    for (const k of CHAT_FIELDS) delete preset[k];
    Object.assign(preset, cleanChatSettings(readChatFields()), { name });
    saveSettingsStore(store);
    setChatSettings(Object.assign(readChatFields(), { preset: preset.id }));
    if (messages.length > 0 && typeof saveCurrentConversation === 'function') saveCurrentConversation();
    fillSettingsDialog();
}

function deletePreset() {
    const store = loadSettingsStore();
    const preset = store.presets.find((p) => p.id === chatSettings.preset);
    if (!preset || !confirm(`Delete the preset "${preset.name}"? Chats keep their settings.`)) return;
    store.presets = store.presets.filter((p) => p.id !== preset.id);
    if (store.newChatPreset === preset.id) store.newChatPreset = null;
    saveSettingsStore(store);
    setChatSettings(Object.assign({}, chatSettings, { preset: '' }));
    fillSettingsDialog();
}

function openChatSettings() {
    fillSettingsDialog();
    const dialog = settingsField('chat-settings-dialog');
    if (typeof closeSidebar === 'function') closeSidebar();
    dialog.showModal();
}

document.addEventListener('DOMContentLoaded', () => {
    const dialog = settingsField('chat-settings-dialog');
    if (!dialog) return;
    for (const id of ['settings-instructions', 'settings-system', 'settings-temperature', 'settings-top-p', 'settings-max-tokens', 'settings-reasoning']) {
        settingsField(id).addEventListener('input', chatSettingsChanged);
    }
    settingsField('settings-preset').addEventListener('change', (e) => applyPreset(e.target.value));
    settingsField('settings-preset-save').addEventListener('click', savePreset);
    settingsField('settings-preset-delete').addEventListener('click', deletePreset);
    settingsField('settings-new-chats').addEventListener('change', (e) => {
        const store = loadSettingsStore();
        store.newChatPreset = e.target.checked ? chatSettings.preset || null : null;
        saveSettingsStore(store);
    });
    settingsField('settings-done').addEventListener('click', () => dialog.close());
    // A tap outside the panel closes it.
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    if (!currentConversationId && messages.length === 0) setChatSettings(newChatSettings());
    updateSettingsIndicator();
});
