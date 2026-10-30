// The landing page's cipher sheet: fresh groups on each visit, and the headline resolving out of
// digits once. Purely decorative: without this file the headline simply stands alone.
(function () {
    function digit() {
        const b = new Uint8Array(1);
        do { crypto.getRandomValues(b); } while (b[0] >= 250);
        return String(b[0] % 10);
    }
    function group() {
        return Array.from({ length: 5 }, digit).join('');
    }

    document.querySelectorAll('[data-groups]').forEach((el) => {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < Number(el.dataset.groups); i++) {
            const g = group();
            if (digit() === '0' && digit() < '5') {
                const mark = document.createElement('i');
                mark.textContent = g;
                frag.append(mark);
            } else {
                frag.append(g);
            }
            frag.append(' ');
        }
        el.append(frag);
    });

    const scramble = (text) => text.replace(/\S/g, digit);

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // While a reply is arriving, it ends in ciphertext that resolves as the text catches up.
    setInterval(() => {
        const tail = document.querySelector('.cipher-tail');
        if (typeof isGeneratingResponse === 'undefined' || !isGeneratingResponse) {
            if (tail) tail.remove();
            return;
        }
        const replies = document.querySelectorAll('.message.assistant-message');
        const reply = replies[replies.length - 1];
        if (!reply) return;
        const el = tail || document.createElement('span');
        el.className = 'cipher-tail';
        el.setAttribute('aria-hidden', 'true');
        el.textContent = group() + ' ' + group().slice(0, 3) + ' ' + group() + ' ';
        if (el.parentElement !== reply) reply.append(el);
    }, 110);

    document.querySelectorAll('.pad-word b').forEach((word, line) => {
        const text = word.textContent;
        let resolved = -line * 3;
        word.classList.add('pad-scrambling');
        const timer = setInterval(() => {
            resolved++;
            const done = Math.max(0, resolved);
            word.textContent = text.slice(0, done) + scramble(text.slice(done));
            if (done >= text.length) {
                clearInterval(timer);
                word.textContent = text;
                word.classList.remove('pad-scrambling');
            }
        }, 30);
    });
})();
