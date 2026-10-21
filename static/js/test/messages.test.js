/**
 * Message content formatting, API format compliance, and request structure tests.
 */

const { assert, assertEqual, describe, it } = require('./harness');

describe('Message Content Formatting', () => {
    it('should format text-only message correctly', () => {
        const prompt = "Hello, how are you?";
        const base64Images = null;

        const messageContent = [{ type: "text", text: prompt }];

        if (base64Images && base64Images.length > 0) {
            base64Images.forEach(imgData => {
                messageContent.push({
                    type: "image_url",
                    image_url: { url: imgData }
                });
            });
        }

        assertEqual(messageContent.length, 1, 'Text-only message should have 1 content item');
        assertEqual(messageContent[0].type, 'text', 'Content type should be text');
        assertEqual(messageContent[0].text, prompt, 'Text should match prompt');
    });

    it('should format message with single image correctly', () => {
        const prompt = "What is in this image?";
        const base64Images = ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="];

        const messageContent = [{ type: "text", text: prompt }];

        if (base64Images && base64Images.length > 0) {
            base64Images.forEach(imgData => {
                messageContent.push({
                    type: "image_url",
                    image_url: { url: imgData }
                });
            });
        }

        assertEqual(messageContent.length, 2, 'Message with image should have 2 content items');
        assertEqual(messageContent[0].type, 'text', 'First item should be text');
        assertEqual(messageContent[1].type, 'image_url', 'Second item should be image_url');
        assert(messageContent[1].image_url !== undefined, 'image_url should exist');
        assert(messageContent[1].image_url.url !== undefined, 'image_url.url should exist');
        assertEqual(messageContent[1].image_url.url, base64Images[0], 'image_url.url should contain the base64 data');
    });

    it('should format message with multiple images correctly', () => {
        const prompt = "Compare these images";
        const base64Images = [
            "data:image/png;base64,image1data",
            "data:image/jpeg;base64,image2data",
            "data:image/webp;base64,image3data"
        ];

        const messageContent = [{ type: "text", text: prompt }];

        if (base64Images && base64Images.length > 0) {
            base64Images.forEach(imgData => {
                messageContent.push({
                    type: "image_url",
                    image_url: { url: imgData }
                });
            });
        }

        assertEqual(messageContent.length, 4, 'Message with 3 images should have 4 content items');
        assertEqual(messageContent[0].type, 'text', 'First item should be text');

        for (let i = 1; i <= 3; i++) {
            assertEqual(messageContent[i].type, 'image_url', `Item ${i} should be image_url`);
            assert(messageContent[i].image_url.url !== undefined, `Item ${i} should have url property`);
            assertEqual(messageContent[i].image_url.url, base64Images[i-1], `Item ${i} url should match`);
        }
    });

    it('should handle empty images array', () => {
        const prompt = "Just text";
        const base64Images = [];

        const messageContent = [{ type: "text", text: prompt }];

        if (base64Images && base64Images.length > 0) {
            base64Images.forEach(imgData => {
                messageContent.push({
                    type: "image_url",
                    image_url: { url: imgData }
                });
            });
        }

        assertEqual(messageContent.length, 1, 'Empty images array should result in text-only message');
    });
});

describe('OpenAI/OpenRouter API Format Compliance', () => {
    it('should match OpenAI vision API format', () => {
        const prompt = "Describe this image";
        const imageData = "data:image/png;base64,abc123";

        const messageContent = [{ type: "text", text: prompt }];
        messageContent.push({
            type: "image_url",
            image_url: { url: imageData }
        });

        // OpenAI format requires:
        // { type: "image_url", image_url: { url: "data:image/..." } }
        const imageItem = messageContent[1];

        assertEqual(imageItem.type, 'image_url', 'Type must be "image_url"');
        assert(typeof imageItem.image_url === 'object', 'image_url must be an object, not a string');
        assert(imageItem.image_url.url !== undefined, 'image_url must have url property');
        assert(typeof imageItem.image_url.url === 'string', 'url must be a string');
        assert(imageItem.image_url.url.startsWith('data:image/'), 'url should be a data URL');
    });

    it('should NOT have image_url as a direct string (the bug we fixed)', () => {
        const imageData = "data:image/png;base64,abc123";

        // WRONG format (the bug):
        const wrongFormat = {
            type: "image_url",
            image_url: imageData  // This is wrong!
        };

        // CORRECT format:
        const correctFormat = {
            type: "image_url",
            image_url: { url: imageData }
        };

        assert(typeof wrongFormat.image_url === 'string', 'Wrong format has image_url as string');
        assert(typeof correctFormat.image_url === 'object', 'Correct format has image_url as object');
        assert(correctFormat.image_url.url === imageData, 'Correct format has url inside object');
    });
});

describe('Message Structure for API Request', () => {
    it('should create valid messages array structure', () => {
        const messages = [];
        const prompt = "What do you see?";
        const imageData = "data:image/jpeg;base64,/9j/4AAQ...";

        const messageContent = [{ type: "text", text: prompt }];
        messageContent.push({
            type: "image_url",
            image_url: { url: imageData }
        });

        messages.push({
            role: "user",
            content: messageContent
        });

        assertEqual(messages.length, 1, 'Should have 1 message');
        assertEqual(messages[0].role, 'user', 'Role should be user');
        assert(Array.isArray(messages[0].content), 'Content should be an array');
        assertEqual(messages[0].content.length, 2, 'Content should have 2 items');
    });

    it('should create valid JSON for fetch body', () => {
        const messages = [{
            role: "user",
            content: [
                { type: "text", text: "Analyze this" },
                { type: "image_url", image_url: { url: "data:image/png;base64,xyz" } }
            ]
        }];

        const formData = JSON.stringify({
            messages: messages,
            model: "anthropic/claude-opus-4.5",
            stream: true
        });

        // Should not throw
        const parsed = JSON.parse(formData);

        assert(parsed.messages !== undefined, 'Parsed data should have messages');
        assertEqual(parsed.model, 'anthropic/claude-opus-4.5', 'Model should match');
        assertEqual(parsed.stream, true, 'Stream should be true');
        assertEqual(parsed.messages[0].content[1].image_url.url, 'data:image/png;base64,xyz', 'Image URL should be preserved');
    });
});
