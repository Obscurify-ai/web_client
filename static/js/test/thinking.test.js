/**
 * Thinking block rendering and reasoning merge helper tests.
 */

const { assert, assertEqual, describe, it } = require('./harness');

const THINK_BLOCK_TOKEN_PREFIX = 'OBSCURIFYTHINKBLOCK';
const THINK_BLOCK_REGEX = /<think(?:\s+[^>]*)?>([\s\S]*?)(<\/think\s*>|$)/gi;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeStreamingText(current, incoming) {
    const currentText = String(current || '');
    const incomingText = String(incoming || '');

    if (!incomingText) return currentText;
    if (!currentText) return incomingText;
    if (incomingText.startsWith(currentText)) return incomingText;
    if (currentText.endsWith(incomingText)) return currentText;

    return currentText + incomingText;
}

function buildAssistantResponseMarkdown(contentText, reasoningText, thinkingComplete) {
    const content = String(contentText || '');
    const reasoningRaw = String(reasoningText || '');
    const reasoning = reasoningRaw.trim();

    if (!reasoning) {
        return content;
    }

    const reasoningBlock = thinkingComplete
        ? '<think>\n' + reasoning + '\n</think>'
        : '<think>\n' + reasoning;

    if (!content) {
        return reasoningBlock;
    }

    return reasoningBlock + '\n\n' + content;
}

// Simplified markdown converter for tests: split paragraphs on blank lines.
const testMarkdownConverter = {
    makeHtml(text) {
        return String(text || '')
            .split(/\n{2,}/)
            .map((part) => `<p>${part}</p>`)
            .join('\n');
    }
};

function renderMarkdownWithThinking(markdown, converter) {
    const source = String(markdown || '');
    const thinkBlocks = [];
    let transformed = '';
    let lastIndex = 0;
    let match;

    THINK_BLOCK_REGEX.lastIndex = 0;
    while ((match = THINK_BLOCK_REGEX.exec(source)) !== null) {
        const blockStart = match.index;
        const blockEnd = THINK_BLOCK_REGEX.lastIndex;
        const blockContent = match[1] || '';
        const closingTag = match[2] || '';
        const blockToken = `@@${THINK_BLOCK_TOKEN_PREFIX}${thinkBlocks.length}@@`;

        transformed += source.slice(lastIndex, blockStart);
        transformed += `\n\n${blockToken}\n\n`;
        thinkBlocks.push({
            token: blockToken,
            content: blockContent.trim(),
            streaming: !closingTag
        });

        lastIndex = blockEnd;
        if (!closingTag) {
            break;
        }
    }
    transformed += source.slice(lastIndex);

    let html = converter.makeHtml(transformed);
    for (const block of thinkBlocks) {
        const summaryText = block.streaming ? 'Thinking...' : 'Thinking';
        const contentHtml = converter.makeHtml(block.content);
        const detailsHtml = `<details class="thinking-block" open><summary>${summaryText}</summary>${contentHtml}</details>`;
        const escapedToken = escapeRegExp(block.token);
        html = html.replace(new RegExp(`<p>\\s*${escapedToken}\\s*<\\/p>`, 'g'), detailsHtml);
        html = html.replace(new RegExp(escapedToken, 'g'), detailsHtml);
    }

    return html;
}

describe('reasoning merge helpers', () => {
    it('should merge incremental chunks by appending', () => {
        const result = mergeStreamingText('Hello', ' world');
        assertEqual(result, 'Hello world', 'Should append incremental chunk');
    });

    it('should merge cumulative chunks by replacement', () => {
        const result = mergeStreamingText('Hel', 'Hello');
        assertEqual(result, 'Hello', 'Should accept cumulative snapshot');
    });

    it('should dedupe repeated chunk', () => {
        const result = mergeStreamingText('Hello', 'Hello');
        assertEqual(result, 'Hello', 'Should avoid duplicate append');
    });

    it('should build response with closed think block when content exists', () => {
        const result = buildAssistantResponseMarkdown('Final answer', 'Reasoning text', true);
        assert(result.includes('<think>'), 'Should include opening think tag');
        assert(result.includes('</think>'), 'Should include closing think tag');
        assert(result.includes('Final answer'), 'Should include final answer');
    });

    it('should build open think block while reasoning is still streaming', () => {
        const result = buildAssistantResponseMarkdown('', 'Reasoning text', false);
        assert(result.includes('<think>'), 'Should include opening think tag');
        assert(!result.includes('</think>'), 'Should not close think tag while streaming');
    });
});

describe('renderMarkdownWithThinking', () => {
    it('should render completed <think> block as visible details without malformed wrapping', () => {
        const input = '<think>\nLet me think step by step.\n</think>\n\nHere is the answer.';
        const result = renderMarkdownWithThinking(input, testMarkdownConverter);
        assert(result.includes('<details class="thinking-block" open>'), 'Should create details element');
        assert(result.includes('<summary>Thinking</summary>'), 'Should use Thinking summary');
        assert(result.includes('Let me think step by step.'), 'Should preserve thinking content');
        assert(result.includes('Here is the answer.'), 'Should preserve answer content');
        assert(!result.includes('<p><details'), 'Should avoid malformed paragraph wrapper before details');
        assert(!result.includes('</details></p>'), 'Should avoid malformed paragraph wrapper after details');
    });

    it('should render unclosed streaming <think> block with Thinking... summary', () => {
        const input = '<think>\nStreaming thought';
        const result = renderMarkdownWithThinking(input, testMarkdownConverter);
        assert(result.includes('<summary>Thinking...</summary>'), 'Should use streaming summary');
        assert(result.includes('Streaming thought'), 'Should preserve partial streaming content');
    });

    it('should handle think tags with attributes and preserve final answer', () => {
        const input = '<think class="hidden">\nReasoning path\n</think>\n\nFinal answer.';
        const result = renderMarkdownWithThinking(input, testMarkdownConverter);
        assert(result.includes('<summary>Thinking</summary>'), 'Should parse think tag with attributes');
        assert(result.includes('Reasoning path'), 'Should preserve reasoning content');
        assert(result.includes('Final answer.'), 'Should preserve final answer content');
    });

    it('should support multiple think blocks', () => {
        const input = '<think>First</think>\n\nMiddle\n\n<think>Second</think>\n\nEnd';
        const result = renderMarkdownWithThinking(input, testMarkdownConverter);
        const detailsCount = (result.match(/<details class="thinking-block" open>/g) || []).length;
        assertEqual(detailsCount, 2, 'Should render two details blocks');
        assert(result.includes('First'), 'Should include first thinking block');
        assert(result.includes('Second'), 'Should include second thinking block');
    });

    it('should not leak think placeholder tokens with real Showdown rendering', () => {
        const showdownLib = require('../showdown.min.js');
        const realConverter = new showdownLib.Converter({
            tables: true,
            strikethrough: true,
            tasklists: true
        });

        const input = '<think>\nLeaked placeholder check\n</think>\n\nVisible answer.';
        const result = renderMarkdownWithThinking(input, realConverter);
        assert(!result.includes(THINK_BLOCK_TOKEN_PREFIX), 'Should never leak internal placeholder token');
        assert(result.includes('<details class="thinking-block" open>'), 'Should render think block as details');
        assert(result.includes('Visible answer.'), 'Should preserve visible answer');
    });
});
