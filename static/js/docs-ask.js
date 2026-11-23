// The box on /tutorials: typing searches the tutorials in this page, Ask answers from them.
// Markdown goes through the chat's sanitizer (chat-markdown.js), which uses `converter`.
const converter = new showdown.Converter({ tables: true, strikethrough: true, tasklists: true });

(() => {
    const box = document.getElementById('docs-ask');
    const content = document.querySelector('.tutorial-content');
    if (content) addCopyButtons(content);
    if (!box || typeof fetch !== 'function') return;
    box.hidden = false;

    const form = document.getElementById('docs-ask-form');
    const input = document.getElementById('docs-ask-input');
    const send = document.getElementById('docs-ask-send');
    const clear = document.getElementById('docs-ask-clear');
    const thread = document.getElementById('docs-ask-thread');
    const results = document.getElementById('docs-ask-results');
    const here = location.pathname.match(/^\/tutorials\/([\w-]+)$/);
    const STOP = new Set(['a', 'an', 'and', 'are', 'can', 'do', 'for', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'set', 'setup', 'the', 'to', 'up', 'use', 'what', 'with', 'you']);
    const KEPT = 8; // messages of the conversation sent with the next question
    let messages = [];
    let pages = null;
    let busy = false;
    let turn = null; // the question being answered; Clear aborts it

    function index() {
        pages = pages || fetch('/tutorials/search.json', { credentials: 'omit' })
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => { pages = null; return []; });
        return pages;
    }

    function score(page, words) {
        const title = page.title.toLowerCase();
        const about = (page.description || '').toLowerCase();
        const text = page.text.toLowerCase();
        let total = 0;
        for (const word of words) {
            const hits = text.split(word).length - 1;
            const points = (title.includes(word) ? 10 : 0) + (about.includes(word) ? 4 : 0) + Math.min(hits, 5);
            if (!points) return 0;
            total += points;
        }
        return total;
    }

    // An address as its own link text, [https://x](https://x), breaks in the chat's renderer, which links
    // bare addresses itself: leave it just the address.
    function tidyLinks(text) {
        return text.replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, '$1');
    }

    async function search() {
        const query = input.value;
        const all = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        const words = all.filter((w) => !STOP.has(w));
        if (!words.length) { results.replaceChildren(); return; }
        const list = await index();
        if (input.value !== query) return;
        const found = list.map((page) => ({ page, points: score(page, words) })).filter((f) => f.points)
            .sort((a, b) => b.points - a.points).slice(0, 8);
        results.replaceChildren(...found.map(({ page }) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = '/tutorials/' + encodeURIComponent(page.slug);
            a.textContent = page.title;
            li.append(a);
            if (page.description) {
                const p = document.createElement('p');
                p.textContent = page.description;
                li.append(p);
            }
            return li;
        }));
        if (!found.length) {
            const li = document.createElement('li');
            li.className = 'docs-ask-none';
            li.textContent = 'No tutorial has all those words. Ask answers it from the docs.';
            results.append(li);
        }
    }

    function fit() {
        input.style.height = 'auto';
        input.style.height = input.scrollHeight + 'px';
    }

    function addCopyButtons(root) {
        root.querySelectorAll('pre').forEach((pre) => {
            if (pre.parentElement.classList.contains('code-wrap')) return;
            const wrap = document.createElement('div');
            wrap.className = 'code-wrap';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'code-copy';
            button.textContent = 'Copy';
            button.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(pre.textContent);
                    button.textContent = 'Copied';
                } catch (err) {
                    getSelection().selectAllChildren(pre);
                    button.textContent = 'Selected';
                }
                setTimeout(() => { button.textContent = 'Copy'; }, 1500);
            });
            pre.replaceWith(wrap);
            wrap.append(pre, button);
        });
    }

    function showError(answer, text) {
        const p = document.createElement('p');
        p.className = 'docs-ask-error';
        p.textContent = text;
        answer.append(p);
    }

    async function ask(question) {
        busy = true;
        send.disabled = true;
        clear.hidden = false;
        const mine = turn = new AbortController();
        results.replaceChildren();
        const asked = document.createElement('div');
        asked.className = 'docs-ask-question';
        asked.textContent = question;
        const answer = document.createElement('div');
        answer.className = 'docs-ask-answer';
        answer.textContent = 'Reading the docs...';
        thread.append(asked, answer);
        messages.push({ role: 'user', content: question });
        let text = '';
        let error = '';
        try {
            let recent = messages.slice(-KEPT);
            if (recent[0].role !== 'user') recent = recent.slice(1);
            const res = await fetch('/tutorials/ask', {
                method: 'POST',
                signal: mine.signal,
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: recent, page: here ? here[1] : null })
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                const said = body.error && (body.error.message || body.error);
                error = res.status === 429 ? 'Too many questions from your network this hour. Try again later, or search the tutorials.'
                    : (typeof said === 'string' ? said : 'No answer came back. Try again.');
            } else {
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let pending = '';
                for (let part = await reader.read(); !part.done; part = await reader.read()) {
                    pending += decoder.decode(part.value, { stream: true });
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    for (const line of lines) {
                        if (!line.startsWith('data: {')) continue;
                        const event = JSON.parse(line.slice(6));
                        if (event.text) text += event.text;
                        if (event.error) error = event.error;
                    }
                    if (text) renderMarkdownIntoElement(answer, tidyLinks(text));
                }
            }
        } catch (err) {
            error = 'The connection dropped. Try again.';
        }
        if (mine.signal.aborted) return; // cleared: the thread and messages are no longer this question's
        if (text) {
            renderMarkdownIntoElement(answer, tidyLinks(text));
            // The chat turns addresses into links, in code too: a config should read as plain text.
            answer.querySelectorAll('pre a, code a').forEach((a) => a.replaceWith(a.textContent));
            addCopyButtons(answer);
            messages.push({ role: 'assistant', content: text });
        } else {
            answer.textContent = '';
            messages.pop();
        }
        if (error) showError(answer, error);
        busy = false;
        send.disabled = false;
    }

    let timer;
    input.addEventListener('focus', index, { once: true });
    input.addEventListener('input', () => {
        fit();
        clearTimeout(timer);
        timer = setTimeout(search, 120);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            form.requestSubmit();
        }
    });
    clear.addEventListener('click', () => {
        if (turn) turn.abort();
        clearTimeout(timer);
        messages = [];
        thread.replaceChildren();
        results.replaceChildren();
        input.value = '';
        fit();
        busy = false;
        send.disabled = false;
        clear.hidden = true;
        input.focus();
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const question = input.value.trim();
        if (!question || busy) return;
        clearTimeout(timer);
        input.value = '';
        fit();
        ask(question);
    });
})();
