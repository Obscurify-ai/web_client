// The landing page's cipher sheet: fresh hex groups on each visit, a few of them lit in a colour
// palette picked fresh each visit, and the headline resolving out of the cipher once.
// Purely decorative: without this file the headline simply stands alone.
(function () {
    const HEX = '0123456789abcdef';
    function byte() {
        const b = new Uint8Array(1);
        crypto.getRandomValues(b);
        return b[0];
    }
    const hex = () => HEX[byte() & 15];
    const group = () => Array.from({ length: 4 }, hex).join('');

    // A palette per visit: three hues spread round the wheel from a random start, never the
    // orange-brown band (it reads as rust on black). Each lit group takes one, a little off.
    const wrap = (h) => ((h % 360) + 360) % 360;
    const cool = (h) => (wrap(h) >= 15 && wrap(h) < 75 ? wrap(h) + 150 : wrap(h));
    const start = (byte() * 360) / 256;
    const palette = [0, 110 + (byte() % 40), 230 + (byte() % 40)].map((d) => cool(start + d));
    const pad = document.querySelector('.pad');
    if (pad) pad.style.setProperty('--pad-accent', `hsl(${palette[0].toFixed(0)} 85% 64%)`);
    const tint = () => {
        const h = cool(palette[byte() % 3] + (byte() % 30) - 15);
        return `hsl(${h.toFixed(0)} ${72 + (byte() % 20)}% ${58 + (byte() % 12)}%)`;
    };

    document.querySelectorAll('[data-groups]').forEach((el) => {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < Number(el.dataset.groups); i++) {
            const g = group();
            if (byte() < 26) {
                const mark = document.createElement('i');
                mark.textContent = g;
                mark.style.color = tint();
                frag.append(mark);
            } else {
                frag.append(g);
            }
            frag.append(' ');
        }
        el.append(frag);
    });

    const scramble = (text) => text.replace(/\S/g, hex);

    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // While a reply is arriving, it ends in ciphertext that resolves as the text catches up.
    // It is the only waiting sign, so with reduced motion it still shows, just without changing.
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
        if (!still || !tail) el.textContent = group() + ' ' + group() + ' ' + group() + ' ';
        if (el.parentElement !== reply) reply.append(el);
    }, 110);

    if (still) return;

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
