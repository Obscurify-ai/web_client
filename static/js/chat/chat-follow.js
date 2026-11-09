// chat-follow.js — Follow the answer while it streams, the way other chat apps do: the
// view stays at the bottom as text arrives until the reader scrolls up; then it stays
// put and a "New messages below" button (bottom right) jumps back and follows again.
//
// It watches #response-list for changes rather than hooking each renderer, so plain
// chat, Code Mode and local models all follow without knowing about it.

const chatFollow = (() => {
    const NEAR_BOTTOM_PX = 80;
    let following = true;
    let button = null;
    let scheduled = false;
    // Our own scrolls fire scroll events too; this tells them apart from the reader's.
    let selfScrollUntil = 0;

    // The element that scrolls the messages: the nearest scrolling ancestor of the list,
    // or the page.
    function scroller() {
        let el = document.getElementById('response-list');
        while (el && el !== document.body && el !== document.documentElement) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function distanceFromBottom(s) {
        return s.scrollHeight - s.scrollTop - s.clientHeight;
    }

    function generating() {
        return typeof isGeneratingResponse !== 'undefined' && isGeneratingResponse;
    }

    function toBottom() {
        const s = scroller();
        selfScrollUntil = Date.now() + 150;
        s.scrollTop = s.scrollHeight;
    }

    function ensureButton() {
        if (button) return button;
        button = document.createElement('button');
        button.type = 'button';
        button.id = 'follow-button';
        button.className = 'follow-button';
        button.hidden = true;
        button.innerHTML = 'New messages below <span aria-hidden="true">↓</span>';
        button.addEventListener('click', () => {
            following = true;
            button.hidden = true;
            toBottom();
        });
        document.body.appendChild(button);
        return button;
    }

    // Keep the button just above the input bar, whatever its height.
    function placeButton() {
        const bar = document.getElementById('bottom-container');
        const barHeight = bar && bar.offsetParent !== null ? bar.offsetHeight : 0;
        ensureButton().style.bottom = (barHeight + 12) + 'px';
    }

    function onChange() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            if (!generating()) return;
            if (following) {
                toBottom();
            } else if (distanceFromBottom(scroller()) > NEAR_BOTTOM_PX) {
                placeButton();
                ensureButton().hidden = false;
            }
        });
    }

    function onScroll() {
        if (Date.now() < selfScrollUntil) return;
        const near = distanceFromBottom(scroller()) <= NEAR_BOTTOM_PX;
        following = near;
        if (near && button) button.hidden = true;
    }

    // Scrolling up by wheel, touch or keys stops following at once, before the next chunk
    // would pull the view back down.
    function onReaderScrollIntent(event) {
        if (!generating()) return;
        const up = (event.type === 'wheel' && event.deltaY < 0)
            || event.type === 'touchmove'
            || (event.type === 'keydown' && ['ArrowUp', 'PageUp', 'Home'].includes(event.key));
        if (up) following = false;
    }

    function init() {
        const list = document.getElementById('response-list');
        if (!list) return;
        new MutationObserver(onChange).observe(list, { childList: true, subtree: true, characterData: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        list.parentElement && list.parentElement.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('wheel', onReaderScrollIntent, { passive: true });
        window.addEventListener('touchmove', onReaderScrollIntent, { passive: true });
        window.addEventListener('keydown', onReaderScrollIntent);
        window.addEventListener('resize', () => { if (button && !button.hidden) placeButton(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    return {
        // A new message was sent: follow its answer from the bottom.
        start() {
            following = true;
            if (button) button.hidden = true;
            toBottom();
        },
    };
})();
