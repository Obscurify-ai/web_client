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

// A reopened reply's searches, for the tokens in its saved markdown.
function setWebSearchRegistry(searches) {
    webSearchRegistry = Array.isArray(searches) ? searches.slice() : [];
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtmlForPre(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Bare URLs are lifted out before markdown runs and put back as links afterwards. Models paste
// CDN links with underscores in the path (`.../inference_output/video/...`), which markdown ate
// as emphasis: the user saw the words italicised and no link at all.
const BARE_URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;
const URL_TOKEN_PREFIX = 'OBSCURIFYBAREURL';

function protectBareUrls(markdown, store) {
    return String(markdown).replace(BARE_URL_REGEX, (match, offset, whole) => {
        // Leave markdown links, autolinks and HTML attributes alone.
        const before = whole.slice(Math.max(0, offset - 3), offset);
        if (before.endsWith('](') || before.endsWith('<') || /[\s]?=\s*["']$/.test(before)) return match;
        let url = match.replace(/[.,;:]+$/, '');
        let tail = match.slice(url.length);
        // A closing bracket belongs to the sentence unless the URL opened one.
        while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
            url = url.slice(0, -1);
            tail = ')' + tail;
        }
        const token = '@@' + URL_TOKEN_PREFIX + store.length + '@@';
        store.push(url);
        return token + tail;
    });
}

function restoreBareUrls(html, store) {
    return store.reduce((out, url, i) => {
        const escaped = escapeHtmlForPre(url);
        const link = '<a href="' + escaped + '" rel="noopener noreferrer nofollow" target="_blank">' + escaped + '</a>';
        return out.split('@@' + URL_TOKEN_PREFIX + i + '@@').join(link);
    }, html);
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
    const bareUrls = [];
    try {
        html = restoreBareUrls(converter.makeHtml(protectBareUrls(transformed, bareUrls)), bareUrls);
    } catch (err) {
        console.warn('converter.makeHtml failed; falling back to escaped source', err);
        return '<pre>' + escapeHtmlForPre(source) + '</pre>';
    }

    for (const block of thinkBlocks) {
        // Web searches sit in the fold too, in the order they happened (before the reasoning).
        let searches = 0;
        block.content = block.content.replace(WEB_SEARCH_TOKEN_REGEX, (fullToken, idx) => {
            const i = parseInt(idx, 10);
            if (Number.isNaN(i) || !webSearchRegistry[i]) return '';
            searches += 1;
            webSearchBlocks.push({ token: fullToken, entry: webSearchRegistry[i] });
            return '\n\n' + fullToken + '\n\n';
        });
        const summaryText = block.streaming
            ? 'Thinking...'
            : 'Thinking' + (searches ? ' · ' + searches + (searches === 1 ? ' tool call' : ' tool calls') : '');
        let contentHtml;
        try {
            contentHtml = converter.makeHtml(block.content);
        } catch (err) {
            console.warn('converter.makeHtml failed for thinking block; escaping', err);
            contentHtml = '<pre>' + escapeHtmlForPre(block.content) + '</pre>';
        }
        const detailsHtml =
            '<details class="thinking-block"><summary>' + summaryText + '</summary>' + contentHtml + '</details>';
        const escapedToken = escapeRegExp(block.token);
        html = html.replace(new RegExp('<p>\\s*' + escapedToken + '\\s*<\\/p>', 'g'), detailsHtml);
        html = html.replace(new RegExp(escapedToken, 'g'), detailsHtml);
    }

    for (const block of webSearchBlocks) {
        const entry = block.entry;
        const searching = entry.status === 'searching';
        const errored = entry.status === 'error';
        const classes = ['tool-call', 'web-search-chip'];
        if (searching) classes.push('running');
        if (errored) classes.push('failed');
        let resultsHtml = '';
        if (entry.results) {
            try {
                resultsHtml = converter.makeHtml(entry.results);
            } catch (err) {
                console.warn('converter.makeHtml failed for web search results; escaping', err);
                resultsHtml = '<pre>' + escapeHtmlForPre(entry.results) + '</pre>';
            }
        }
        const field = (label, valueHtml, cls) => '<div class="tool-call-field"><div class="tool-call-label">' + label + '</div>'
            + '<div class="tool-call-value ' + (cls || '') + '">' + valueHtml + '</div></div>';
        const summary = '<summary><span class="tool-call-name">web_search</span>'
            + '<span class="tool-call-detail">&quot;' + escapeHtmlForPre(entry.query || '') + '&quot;</span>'
            + '<span class="tool-call-state">' + (searching ? 'running' : (errored ? 'failed' : '')) + '</span>'
            + '<span class="tool-call-price">' + (searching || errored ? '' : 'free') + '</span></summary>';
        const body = '<div class="tool-call-body">'
            + field('Input', '<pre>' + escapeHtmlForPre(JSON.stringify({ query: entry.query || '' }, null, 2)) + '</pre>')
            + (errored ? field('Error', escapeHtmlForPre(entry.error || 'Search failed'), 'tool-call-error') : '')
            + (resultsHtml ? field('Result', resultsHtml, 'web-search-results') : '')
            + field('Cost', searching ? 'running…' : (errored ? 'nothing charged' : 'free'))
            + '</div>';
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
    // The searches go first in the Thinking fold: the server runs them before the model answers.
    let webSearchPrefix = '';
    for (let i = 0; i < webSearchRegistry.length; i += 1) {
        webSearchPrefix += '@@' + WEB_SEARCH_TOKEN_PREFIX + i + '@@\n\n';
    }
    const work = (webSearchPrefix + reasoning).trim();

    let body;
    if (!work) {
        body = content;
    } else {
        const reasoningBlock = thinkingComplete || content
            ? '<think>\n' + work + '\n</think>'
            : '<think>\n' + work;
        body = content ? reasoningBlock + '\n\n' + content : reasoningBlock;
    }

    return body;
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

// Thinking blocks start collapsed. A stream re-renders the whole message on
// every chunk, so keep open whichever ones the reader clicked open.
function renderMarkdownIntoElement(element, markdown) {
    const blocks = (el) => Array.from(el.querySelectorAll('details.thinking-block'));
    const opened = blocks(element).map((block) => block.open);
    element.replaceChildren(toSafeMarkdownFragment(markdown));
    blocks(element).forEach((block, i) => {
        if (opened[i]) block.open = true;
    });
}
