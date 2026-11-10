// chat-thread.js — Send only what's new. The server holds a conversation in memory for up to an
// hour and names it with a rev; the next request carries that rev and the messages after it.
// Whatever we sent last is kept here, so an edit, a retry or a compaction that changes anything
// already sent goes out whole instead. A rev the server no longer holds gets a 409, and the whole
// conversation goes again.

const THREAD_HEADER = 'x-obscurify-thread';
const chatThreads = new Map(); // key -> { rev, sent: [JSON of each message sent] }

// The body to send for `body` on thread `key`, and what it stands for once sent.
function threadRequest(key, body) {
    const sent = body.messages.map((m) => JSON.stringify(m));
    const held = chatThreads.get(key);
    if (held && held.sent.length <= sent.length && held.sent.every((s, i) => s === sent[i])) {
        return { sent, body: Object.assign({}, body, { messages: body.messages.slice(held.sent.length), thread: { rev: held.rev } }) };
    }
    return { sent, body: Object.assign({}, body, { thread: {} }) };
}

async function threadExpired(response) {
    if (response.status !== 409) return false;
    try {
        const err = await response.clone().json();
        return !!err && err.code === 'thread_expired';
    } catch (_) {
        return false;
    }
}

// POST `body` (a chat completions request) on thread `key`. `init` holds the rest of the fetch
// options. Returns the response, as fetch does.
async function postChatThread(endpoint, init, body, key) {
    const request = threadRequest(key, body);
    if (window.ObscurifyFunnel) window.ObscurifyFunnel.step('chat');
    let response = await fetch(endpoint, Object.assign({}, init, { body: JSON.stringify(request.body) }));
    if (request.body.thread.rev && await threadExpired(response)) {
        chatThreads.delete(key);
        response = await fetch(endpoint, Object.assign({}, init, { body: JSON.stringify(Object.assign({}, body, { thread: {} })) }));
    }
    const rev = response.ok && response.headers.get(THREAD_HEADER);
    if (rev) chatThreads.set(key, { rev, sent: request.sent });
    else if (response.ok) chatThreads.delete(key);
    return response;
}
