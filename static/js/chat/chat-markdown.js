// chat-markdown.js — Markdown pipeline. Handles safe-HTML tag allowlist,
// <think> reasoning blocks, web-search chip tokens, and the DOMParser-based
// sanitizer that turns raw markdown into a trusted DocumentFragment. Consumed
// by chat-message.js, chat-stream.js, chat-conversations.js, and chat-local.js.

const SAFE_MARKDOWN_TAGS = new Set([
    'a', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
]);

const THINK_BLOCK_TOKEN_PREFIX = 'OBSCURIFYTHINKBLOCK';
const THINK_BLOCK_REGEX = /<think(?:\s+[^>]*)?>([\s\S]*?)(<\/think\s*>|$)/gi;

const WEB_SEARCH_TOKEN_PREFIX = 'OBSCURIFYWEBSEARCH';
const WEB_SEARCH_TOKEN_REGEX = /@@OBSCURIFYWEBSEARCH(\d+)@@/g;
// Registry populated by buildAssistantResponseMarkdown before markdown is rendered.
let webSearchRegistry = [];

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtmlForPre(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Render markdown while keeping <think> blocks as valid <details> HTML.
// This avoids markdown wrapping <details> in <p> tags, which breaks structure
// and can hide/disconnect the reasoning text.
function renderMarkdownWithThinking(markdown) {
    const source = String(markdown || '');
    const thinkBlocks = [];
    const webSearchBlocks = [];
    let transformed = '';
    let lastIndex = 0;
    let match;

    THINK_BLOCK_REGEX.lastIndex = 0;
    while ((match = THINK_BLOCK_REGEX.exec(source)) !== null) {
        const blockStart = match.index;
        const blockEnd = THINK_BLOCK_REGEX.lastIndex;
        const blockContent = match[1] || '';
        const closingTag = match[2] || '';
        const blockToken = '@@' + THINK_BLOCK_TOKEN_PREFIX + thinkBlocks.length + '@@';

        transformed += source.slice(lastIndex, blockStart);
        transformed += '\n\n' + blockToken + '\n\n';
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

    // Web-search sentinel tokens: @@OBSCURIFYWEBSEARCH<n>@@
    WEB_SEARCH_TOKEN_REGEX.lastIndex = 0;
    transformed = transformed.replace(WEB_SEARCH_TOKEN_REGEX, (fullToken, idx) => {
        const i = parseInt(idx, 10);
        if (Number.isNaN(i) || !webSearchRegistry[i]) return '';
        webSearchBlocks.push({ token: fullToken, entry: webSearchRegistry[i] });
        return '\n\n' + fullToken + '\n\n';
    });

    let html;
    try {
        html = converter.makeHtml(transformed);
    } catch (err) {
        console.warn('converter.makeHtml failed; falling back to escaped source', err);
        return '<pre>' + escapeHtmlForPre(source) + '</pre>';
    }

    for (const block of thinkBlocks) {
        const summaryText = block.streaming ? 'Thinking...' : 'Thinking';
        let contentHtml;
        try {
            contentHtml = converter.makeHtml(block.content);
        } catch (err) {
            console.warn('converter.makeHtml failed for thinking block; escaping', err);
            contentHtml = '<pre>' + escapeHtmlForPre(block.content) + '</pre>';
        }
        const detailsHtml =
            '<details class="thinking-block" open><summary>' + summaryText + '</summary>' + contentHtml + '</details>';
        const escapedToken = escapeRegExp(block.token);
        html = html.replace(new RegExp('<p>\\s*' + escapedToken + '\\s*<\\/p>', 'g'), detailsHtml);
        html = html.replace(new RegExp(escapedToken, 'g'), detailsHtml);
    }

    for (const block of webSearchBlocks) {
        const entry = block.entry;
        const safeQuery = escapeHtmlForPre(entry.query || '');
        const searching = entry.status === 'searching';
        const errored = entry.status === 'error';
        const classes = ['web-search-chip'];
        if (searching) classes.push('searching');
        if (errored) classes.push('errored');
        let resultsHtml = '';
        if (errored) {
            resultsHtml = '<p>' + escapeHtmlForPre(entry.error || 'Search failed') + '</p>';
        } else if (entry.results) {
            try {
                resultsHtml = converter.makeHtml(entry.results);
            } catch (err) {
                console.warn('converter.makeHtml failed for web search results; escaping', err);
                resultsHtml = '<pre>' + escapeHtmlForPre(entry.results) + '</pre>';
            }
        }
        const spinner = searching ? '<span class="web-search-spinner" aria-hidden="true"></span>' : '';
        const summary = '<summary>' + spinner + '<span class="web-search-icon">&#128269;</span> ' + safeQuery + '</summary>';
        const body = resultsHtml
            ? '<div class="web-search-results">' + resultsHtml + '</div>'
            : '';
        const detailsHtml = '<details class="' + classes.join(' ') + '">' + summary + body + '</details>';
        const escapedToken = escapeRegExp(block.token);
        html = html.replace(new RegExp('<p>\\s*' + escapedToken + '\\s*<\\/p>', 'g'), detailsHtml);
        html = html.replace(new RegExp(escapedToken, 'g'), detailsHtml);
    }

    return html;
}

function mergeStreamingText(current, incoming) {
    const currentText = String(current || '');
    const incomingText = String(incoming || '');

    if (!incomingText) return currentText;
    if (!currentText) return incomingText;

    // Some providers stream cumulative snapshots instead of deltas.
    if (incomingText.startsWith(currentText)) return incomingText;
    // Guard against duplicated chunks.
    if (currentText.endsWith(incomingText)) return currentText;

    return currentText + incomingText;
}

function buildAssistantResponseMarkdown(contentText, reasoningText, thinkingComplete, webSearches) {
    const content = String(contentText || '');
    const reasoningRaw = String(reasoningText || '');
    const reasoning = reasoningRaw.trim();

    // Populate registry so renderMarkdownWithThinking can resolve tokens.
    webSearchRegistry = Array.isArray(webSearches) ? webSearches.slice() : [];
    let webSearchPrefix = '';
    for (let i = 0; i < webSearchRegistry.length; i += 1) {
        webSearchPrefix += '@@' + WEB_SEARCH_TOKEN_PREFIX + i + '@@\n\n';
    }

    let body;
    if (!reasoning) {
        body = content;
    } else {
        const reasoningBlock = thinkingComplete
            ? '<think>\n' + reasoning + '\n</think>'
            : '<think>\n' + reasoning;
        body = content ? reasoningBlock + '\n\n' + content : reasoningBlock;
    }

    return webSearchPrefix + body;
}

function isSafeMarkdownUrl(url) {
    if (!url) return false;
    const normalized = String(url).trim().toLowerCase();
    if (normalized.startsWith('javascript:') || normalized.startsWith('data:') || normalized.startsWith('vbscript:')) {
        return false;
    }
    return normalized.startsWith('http://')
        || normalized.startsWith('https://')
        || normalized.startsWith('mailto:')
        || normalized.startsWith('/')
        || normalized.startsWith('#');
}

function toSafeMarkdownFragment(markdown) {
    const fragment = document.createDocumentFragment();
    const markdownText = markdown || '';

    if (typeof DOMParser === 'undefined') {
        fragment.appendChild(document.createTextNode(markdownText));
        return fragment;
    }

    const parser = new DOMParser();
    const parsed = parser.parseFromString(renderMarkdownWithThinking(markdownText), 'text/html');

    const appendSafeChildren = (sourceNode, targetNode) => {
        Array.from(sourceNode.childNodes || []).forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) {
                targetNode.appendChild(document.createTextNode(child.textContent || ''));
                return;
            }

            if (child.nodeType !== Node.ELEMENT_NODE) {
                return;
            }

            const tag = child.tagName.toLowerCase();
            if (!SAFE_MARKDOWN_TAGS.has(tag)) {
                appendSafeChildren(child, targetNode);
                return;
            }

            const safeElement = document.createElement(tag);

            if (tag === 'a') {
                const href = child.getAttribute('href');
                if (href && isSafeMarkdownUrl(href)) {
                    safeElement.setAttribute('href', href);
                    safeElement.setAttribute('rel', 'noopener noreferrer nofollow');
                }

                const title = child.getAttribute('title');
                if (title) {
                    safeElement.setAttribute('title', title);
                }
            }

            if (tag === 'code' || tag === 'pre' || tag === 'details' || tag === 'div' || tag === 'span') {
                const className = child.getAttribute('class');
                if (className && /^[a-zA-Z0-9_\-\s]+$/.test(className)) {
                    safeElement.setAttribute('class', className);
                }
            }

            if (tag === 'details' && child.hasAttribute('open')) {
                safeElement.setAttribute('open', '');
            }

            appendSafeChildren(child, safeElement);
            targetNode.appendChild(safeElement);
        });
    };

    appendSafeChildren(parsed.body, fragment);
    return fragment;
}

function renderMarkdownIntoElement(element, markdown) {
    element.replaceChildren(toSafeMarkdownFragment(markdown));
}
