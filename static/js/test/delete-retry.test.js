/**
 * Tests for the delete-and-restore-prompt feature on assistant messages.
 *
 * The button on each assistant bubble removes the prompting user message,
 * the assistant response, and every message below — then loads the user's
 * original prompt text back into the input box for editing and resubmit.
 * The trim must work correctly even when DOM and the messages array have
 * drifted apart (an aborted/errored stream leaves a DOM bubble with no
 * entry in messages).
 */

const { assert, assertEqual, describe, it } = require('./harness');

// Minimal DOM mock for sibling traversal.
function makeMessage(role, opts = {}) {
    const classes = ['message', role + '-message'];
    const el = {
        _classes: classes,
        classList: {
            contains: (c) => classes.includes(c)
        },
        dataset: opts.msgIdx !== undefined ? { msgIdx: String(opts.msgIdx) } : {},
        promptText: opts.prompt || '',
        previousElementSibling: null,
        nextElementSibling: null,
        querySelector: (sel) => sel === '.prompt-content' ? { textContent: el.promptText } : null,
        remove() {
            if (this.previousElementSibling) this.previousElementSibling.nextElementSibling = this.nextElementSibling;
            if (this.nextElementSibling) this.nextElementSibling.previousElementSibling = this.previousElementSibling;
            this.previousElementSibling = null;
            this.nextElementSibling = null;
        }
    };
    return el;
}

function chainSiblings(messages) {
    for (let i = 0; i < messages.length; i++) {
        messages[i].previousElementSibling = messages[i - 1] || null;
        messages[i].nextElementSibling = messages[i + 1] || null;
    }
    return messages;
}

// Pure copy of the trim-and-remove behavior from chat-message.js, factored
// out so it's testable without globals. Returns { newMessagesLen, prompt,
// removedFrom }.
function computeTrim(assistantEl, messagesLen) {
    if (!assistantEl || !assistantEl.classList.contains('assistant-message')) return null;

    let userEl = assistantEl.previousElementSibling;
    while (userEl && !userEl.classList.contains('user-message')) {
        userEl = userEl.previousElementSibling;
    }
    if (!userEl) return null;

    const promptDiv = userEl.querySelector('.prompt-content');
    const prompt = promptDiv ? promptDiv.textContent : '';
    if (!prompt) return null;

    const msgIdxRaw = userEl.dataset.msgIdx;
    const msgIdx = msgIdxRaw !== undefined ? parseInt(msgIdxRaw, 10) : NaN;

    let newLen;
    if (Number.isFinite(msgIdx) && msgIdx >= 0 && msgIdx <= messagesLen) {
        newLen = msgIdx;
    } else {
        let userCount = 0;
        let sib = userEl.previousElementSibling;
        while (sib) {
            if (sib.classList.contains('user-message')) userCount++;
            sib = sib.previousElementSibling;
        }
        newLen = Math.min(messagesLen, userCount * 2);
    }

    return { newMessagesLen: newLen, prompt, userEl };
}

describe('Delete-and-Retry: locating the prompting user message', () => {
    it('finds the user message immediately above the assistant', () => {
        const u1 = makeMessage('user', { prompt: 'first', msgIdx: 0 });
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'second', msgIdx: 2 });
        const a2 = makeMessage('assistant');
        chainSiblings([u1, a1, u2, a2]);

        const result = computeTrim(a2, 4);
        assert(result !== null, 'should find a user message');
        assertEqual(result.prompt, 'second', 'extracts the most recent user prompt');
        assert(result.userEl === u2, 'returns the immediate user predecessor');
    });

    it('returns null when there is no user message above', () => {
        const a1 = makeMessage('assistant');
        chainSiblings([a1]);
        const result = computeTrim(a1, 0);
        assertEqual(result, null, 'no user message → no trim');
    });

    it('skips intermediate non-user siblings to find the user', () => {
        // Hypothetical separator/divider element.
        const u1 = makeMessage('user', { prompt: 'real', msgIdx: 0 });
        const sep = { classList: { contains: () => false }, previousElementSibling: null, nextElementSibling: null, dataset: {}, querySelector: () => null };
        const a1 = makeMessage('assistant');
        chainSiblings([u1, sep, a1]);

        const result = computeTrim(a1, 2);
        assertEqual(result.prompt, 'real', 'walks past unrelated siblings to find user');
    });
});

describe('Delete-and-Retry: trimming the messages array', () => {
    it('trims using stored msgIdx when DOM and messages are in sync', () => {
        // Two complete pairs in messages, two pairs in DOM.
        const u1 = makeMessage('user', { prompt: 'a', msgIdx: 0 });
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'b', msgIdx: 2 });
        const a2 = makeMessage('assistant');
        chainSiblings([u1, a1, u2, a2]);

        const result = computeTrim(a2, 4);
        assertEqual(result.newMessagesLen, 2, 'trims to keep the first pair');
    });

    it('trims to zero when deleting the very first response', () => {
        const u1 = makeMessage('user', { prompt: 'a', msgIdx: 0 });
        const a1 = makeMessage('assistant');
        chainSiblings([u1, a1]);

        const result = computeTrim(a1, 2);
        assertEqual(result.newMessagesLen, 0, 'first pair → empty messages array');
    });

    it('respects msgIdx after an aborted prior response (DOM > messages)', () => {
        // Scenario: u1/a1 completed (2 entries). u2 sent, a2 aborted before
        // streaming completed — only u2 is in messages (3 entries total),
        // but DOM still shows the stopped a2 bubble. User clicks delete on a2.
        const u1 = makeMessage('user', { prompt: 'a', msgIdx: 0 });
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'b', msgIdx: 2 });
        const a2 = makeMessage('assistant'); // no msgIdx on assistant
        chainSiblings([u1, a1, u2, a2]);

        const result = computeTrim(a2, 3);
        assertEqual(result.newMessagesLen, 2, 'msgIdx correctly trims away the orphaned u2');
        assertEqual(result.prompt, 'b', 'still retries with u2 prompt');
    });

    it('falls back to sibling counting when msgIdx is absent', () => {
        // Older saved conversations may not have msgIdx tagged. Two pairs.
        const u1 = makeMessage('user', { prompt: 'a' }); // no msgIdx
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'b' }); // no msgIdx
        const a2 = makeMessage('assistant');
        chainSiblings([u1, a1, u2, a2]);

        const result = computeTrim(a2, 4);
        // 1 user before u2 → keep 1*2 = 2 entries.
        assertEqual(result.newMessagesLen, 2, 'fallback counts prior user bubbles');
    });

    it('fallback never exceeds actual messages length', () => {
        const u1 = makeMessage('user', { prompt: 'a' });
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'b' });
        const a2 = makeMessage('assistant');
        chainSiblings([u1, a1, u2, a2]);

        // Only 1 entry in messages despite 4 DOM bubbles.
        const result = computeTrim(a2, 1);
        assertEqual(result.newMessagesLen, 1, 'capped at messages.length');
    });

    it('treats out-of-range msgIdx as missing and uses fallback', () => {
        const u1 = makeMessage('user', { prompt: 'a', msgIdx: 99 });
        const a1 = makeMessage('assistant');
        chainSiblings([u1, a1]);

        const result = computeTrim(a1, 2);
        // msgIdx 99 > messagesLen 2 → fallback. 0 prior user bubbles → 0.
        assertEqual(result.newMessagesLen, 0, 'invalid msgIdx falls back to sibling count');
    });
});

describe('Delete-and-Retry: DOM removal', () => {
    it('removes the user message and every following sibling', () => {
        const u1 = makeMessage('user', { prompt: 'a', msgIdx: 0 });
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'b', msgIdx: 2 });
        const a2 = makeMessage('assistant');
        chainSiblings([u1, a1, u2, a2]);

        const result = computeTrim(a2, 4);

        // Apply the same removal logic from deleteAssistantAndRetry.
        let cur = result.userEl;
        const removed = [];
        while (cur) {
            const next = cur.nextElementSibling;
            removed.push(cur);
            cur.remove();
            cur = next;
        }

        assertEqual(removed.length, 2, 'removes both u2 and a2');
        assert(removed.includes(u2), 'u2 was removed');
        assert(removed.includes(a2), 'a2 was removed');
        assert(u1.nextElementSibling === a1, 'remaining chain is intact');
        assert(a1.nextElementSibling === null, 'a1 is now the tail');
    });

    it('preserves all siblings before the deleted user message', () => {
        const u1 = makeMessage('user', { prompt: 'a', msgIdx: 0 });
        const a1 = makeMessage('assistant');
        const u2 = makeMessage('user', { prompt: 'b', msgIdx: 2 });
        const a2 = makeMessage('assistant');
        const u3 = makeMessage('user', { prompt: 'c', msgIdx: 4 });
        const a3 = makeMessage('assistant');
        chainSiblings([u1, a1, u2, a2, u3, a3]);

        // Delete from a2 — should preserve u1/a1, remove u2/a2/u3/a3.
        const result = computeTrim(a2, 6);
        let cur = result.userEl;
        const removed = [];
        while (cur) {
            const next = cur.nextElementSibling;
            removed.push(cur);
            cur.remove();
            cur = next;
        }

        assertEqual(removed.length, 4, 'removes 4 messages from u2 onward');
        assertEqual(result.newMessagesLen, 2, 'messages trimmed to keep only u1/a1');
    });
});
