/**
 * Conversation title generation, unique ID, and HTML escaping tests.
 */

const { assert, assertEqual, describe, it } = require('./harness');

describe('Conversation Title Generation', () => {
    it('should extract title from text content', () => {
        const messages = [{
            role: "user",
            content: [{ type: "text", text: "This is a long message that should be truncated for the title" }]
        }];

        function getConversationTitle(msgs) {
            if (msgs.length === 0) return 'New conversation';
            const firstMessage = msgs[0];
            let text = '';
            if (typeof firstMessage.content === 'string') {
                text = firstMessage.content;
            } else if (Array.isArray(firstMessage.content)) {
                const textPart = firstMessage.content.find(p => p.type === 'text');
                text = textPart ? textPart.text : '';
            }
            return text.length > 40 ? text.slice(0, 40) + '...' : text || 'New conversation';
        }

        const title = getConversationTitle(messages);
        assertEqual(title, 'This is a long message that should be tr...', 'Title should be truncated at 40 chars');
    });

    it('should handle messages with images', () => {
        const messages = [{
            role: "user",
            content: [
                { type: "text", text: "What is this?" },
                { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
            ]
        }];

        function getConversationTitle(msgs) {
            if (msgs.length === 0) return 'New conversation';
            const firstMessage = msgs[0];
            let text = '';
            if (typeof firstMessage.content === 'string') {
                text = firstMessage.content;
            } else if (Array.isArray(firstMessage.content)) {
                const textPart = firstMessage.content.find(p => p.type === 'text');
                text = textPart ? textPart.text : '';
            }
            return text.length > 40 ? text.slice(0, 40) + '...' : text || 'New conversation';
        }

        const title = getConversationTitle(messages);
        assertEqual(title, 'What is this?', 'Should extract text part even with images');
    });
});

describe('Unique ID Generation', () => {
    it('should generate unique IDs', () => {
        function generateUniqueId() {
            const timestamp = Date.now();
            const randomNumber = Math.random();
            const hexadecimalString = randomNumber.toString(16);
            return 'id-' + timestamp + '-' + hexadecimalString;
        }

        const id1 = generateUniqueId();
        const id2 = generateUniqueId();

        assert(id1.startsWith('id-'), 'ID should start with "id-"');
        assert(id1 !== id2, 'Generated IDs should be unique');
    });
});

describe('HTML Escaping', () => {
    it('should escape HTML entities', () => {
        function escapeHtml(text) {
            const div = { textContent: '', innerHTML: '' };
            div.textContent = text;
            // Simulate browser behavior
            div.innerHTML = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
            return div.innerHTML;
        }

        assertEqual(escapeHtml('<script>alert("xss")</script>'),
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
            'Should escape HTML tags and quotes');
        assertEqual(escapeHtml('Normal text'), 'Normal text', 'Should not change normal text');
    });
});
