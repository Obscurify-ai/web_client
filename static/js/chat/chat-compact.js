// chat-compact.js — Lets a chat go on past the model's context window.
//
// The earlier conversation is replaced, in what's sent only, by a summary
// (`conversationCompaction`, see toApiMessages); nothing leaves the screen and the
// latest user message always goes verbatim. The summary is built in chunks that each
// fit well inside the context, carrying the summary so far into the next, so a chat of
// any length compacts: a single summary request over the whole history overflows the
// same way the chat did.
//
// Plain chat compacts before sending once the history is near the context, and once more
// if the model still refuses it as too long (getGPTResult). Code Mode keeps its own
// trigger and uses `summarizeForCompaction` when its history is too big for one request.

const COMPACT_AT = 0.75;              // of the context, estimated: compact before sending
const COMPACT_CHUNK = 0.4;            // of the context per summary request
const COMPACT_CHARS_PER_TOKEN = 3;    // a cautious estimate; real text runs 3.3 to 4
const COMPACT_SUMMARY_MAX_TOKENS = 8000;
const COMPACT_TOOL_CHARS = 4000;      // tool output kept per result, in the transcript
const COMPACT_MIN_SUMMARY_CHARS = 100;
const COMPACT_DEFAULT_CONTEXT = 32000;

const COMPACT_CHUNK_PROMPT = 'You are compacting a long conversation so it can continue from your summary alone: the conversation will be replaced by it. '
    + 'Below is the summary so far (it may be empty) and the next part of the conversation. Write the updated summary. '
    + 'Keep: who the user is and what they want; every request and its outcome; decisions and why; facts, names, numbers, IDs, URLs, file names and code that matter; '
    + 'the tone and any instructions the user gave about style or format; and what is still open. Drop small talk and repetition. '
    + 'Write it as notes in the same language as the conversation, at most about 1,500 words. Reply with the summary only.';

function compactTokens(apiMessages) {
    let chars = 0;
    for (const m of apiMessages) chars += JSON.stringify(m).length;
    return Math.ceil(chars / COMPACT_CHARS_PER_TOKEN);
}

function compactContext(model) {
    if (typeof modelContext === 'function') return modelContext(model);
    const info = typeof _allModels !== 'undefined' ? _allModels.find((m) => m.id === model) : null;
    const n = info && Number(info.context_length);
    return n > 0 ? n : COMPACT_DEFAULT_CONTEXT;
}

function clipText(text, max) {
    const t = String(text || '');
    return t.length <= max ? t : t.slice(0, max / 2) + '\n[…]\n' + t.slice(-max / 2);
}

// The conversation as readable lines, roles named, images and files noted, tool output clipped.
function compactTranscript(apiMessages) {
    const lines = [];
    for (const m of apiMessages) {
        if (m.role === 'system') continue;
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) {
            text = m.content.map((p) => (p.type === 'text' ? p.text || '' : p.type === 'image_url' ? '[image]' : '[' + (p.type || 'attachment') + ']')).join('\n');
        }
        if (m.role === 'tool') {
            lines.push('Tool output: ' + clipText(text, COMPACT_TOOL_CHARS));
            continue;
        }
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const calls = m.tool_calls.map((c) => clipText((c.function && c.function.arguments) || '', COMPACT_TOOL_CHARS)).join('\n');
            text = (text ? text + '\n' : '') + 'Ran code:\n' + calls;
        }
        if (!text.trim()) continue;
        lines.push((m.role === 'user' ? 'User: ' : 'Assistant: ') + text);
    }
    return lines;
}

// Lines grouped into chunks of at most `maxChars`; a line longer than that is split.
function compactChunks(lines, maxChars) {
    const chunks = [];
    let current = '';
    const push = () => { if (current) chunks.push(current); current = ''; };
    for (const line of lines) {
        for (let i = 0; i < line.length; i += maxChars) {
            const piece = line.slice(i, i + maxChars);
            if (current.length + piece.length + 2 > maxChars) push();
            current += (current ? '\n\n' : '') + piece;
        }
    }
    push();
    return chunks;
}

// One summary request. A burst of them meets the chat's per-minute limit, so a 429 is waited
// out (its Retry-After, for up to about two minutes) and a 502/503/504 tried again, like the
// chat's own requests; anything else is an error.
async function compactRequest(model, prompt, signal) {
    const config = getConfig();
    const loggedIn = typeof isLoggedIn !== 'undefined' && isLoggedIn;
    const endpoint = config.api.baseUrl + (loggedIn ? config.api.chatEndpoint : config.api.anonChatEndpoint);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
        const headers = { 'Content-Type': 'application/json' };
        if (loggedIn) {
            const token = await getCSRFToken();
            if (token) headers['X-CSRF-Token'] = token;
        }
        const response = await fetch(endpoint, {
            method: 'POST', headers, credentials: 'same-origin', signal,
            body: JSON.stringify({ model, stream: false, max_tokens: COMPACT_SUMMARY_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
        });
        const retryAfter = Math.min(parseInt(response.headers.get('Retry-After') || '10', 10) || 10, 60);
        const busy = response.status === 429 && Date.now() - started < 120000;
        const flaky = [502, 503, 504].includes(response.status) && attempt < 2;
        if (busy || flaky) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, busy ? retryAfter * 1000 : 2000 * (attempt + 1));
                if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
            });
            continue;
        }
        let data = null;
        try { data = await response.json(); } catch (_) { /* not JSON */ }
        if (!response.ok) {
            const e = data && (data.error && (data.error.message || data.error)) || data && data.detail;
            throw new Error(typeof e === 'string' ? e : 'Summarizing failed (' + response.status + ')');
        }
        const text = String((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
        if (text.length < COMPACT_MIN_SUMMARY_CHARS) throw new Error('The summary came back empty.');
        return text;
    }
}

// A summary of `apiMessages`, built chunk by chunk so no request is near the context.
// `onProgress(done, total)` is called before each chunk.
async function summarizeForCompaction(model, apiMessages, signal, onProgress) {
    const context = compactContext(model);
    const chunks = compactChunks(compactTranscript(apiMessages), Math.max(4000, Math.floor(context * COMPACT_CHUNK * COMPACT_CHARS_PER_TOKEN)));
    let summary = '';
    for (let i = 0; i < chunks.length; i++) {
        if (onProgress) onProgress(i, chunks.length);
        const prompt = COMPACT_CHUNK_PROMPT + '\n\n<summary_so_far>\n' + summary + '\n</summary_so_far>\n\n<next_part>\n' + chunks[i] + '\n</next_part>';
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                summary = await compactRequest(model, prompt, signal);
                lastErr = null;
                break;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastErr = err;
            }
        }
        if (lastErr) throw lastErr;
    }
    return summary;
}

// Compact the current chat: everything before the latest user message becomes a summary.
async function compactConversation(model, signal, onProgress) {
    const lastIndex = messages.length - 1;
    const through = messages[lastIndex] && messages[lastIndex].role === 'user' ? lastIndex : messages.length;
    if (through < 1) return false;
    const prefix = toApiMessages(messages.slice(0, through), model);
    const summary = await summarizeForCompaction(model, prefix, signal, onProgress);
    conversationCompaction = { summary, through };
    return true;
}

// A muted line above the answer while it compacts, kept afterwards as a marker.
function compactionNote(responseElement) {
    const note = document.createElement('p');
    note.className = 'compaction-note';
    const host = responseElement && responseElement.parentElement;
    if (host) host.insertBefore(note, responseElement);
    return note;
}

// Plain chat, before sending: compact when the history is near the context (`force`: the
// model already refused it as too long). Returns whether it compacted.
async function compactIfNeeded(model, responseElement, signal, force) {
    const apiMessages = withSystemPrompt(toApiMessages(messages, model));
    if (!force && compactTokens(apiMessages) < compactContext(model) * COMPACT_AT) return false;
    if (messages.length < 2) return false;
    const note = compactionNote(responseElement);
    note.textContent = 'Summarizing earlier messages to fit the model’s context…';
    try {
        await compactConversation(model, signal, (done, total) => {
            if (total > 1) note.textContent = 'Summarizing earlier messages to fit the model’s context… (' + (done + 1) + ' of ' + total + ')';
        });
    } catch (err) {
        note.remove();
        throw err;
    }
    note.textContent = 'Earlier messages were summarized to fit this model’s context.';
    if (typeof saveCurrentConversation === 'function') saveCurrentConversation();
    return true;
}
