// /models: filter chips and search over the server-rendered cards. Without this file every
// card shows and the chips are plain links (/models?filter=<key>) the server ignores.
(function () {
    const search = document.getElementById('models-search');
    const chips = [...document.querySelectorAll('.models-chip')];
    const cards = [...document.querySelectorAll('.model-card')];
    const groups = [...document.querySelectorAll('.models-group')];
    const count = document.getElementById('models-count');
    const empty = document.getElementById('models-empty');
    if (!search || cards.length === 0) return;

    const params = new URLSearchParams(location.search);
    let filter = params.get('filter') || '';
    if (!chips.some((c) => c.dataset.filter === filter)) filter = '';
    search.value = params.get('q') || '';

    function apply() {
        const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const card of cards) {
            const inFilter = !filter || card.dataset.filters.split(' ').includes(filter);
            const text = card.dataset.search;
            const visible = inFilter && words.every((w) => text.includes(w));
            card.hidden = !visible;
            if (visible) shown++;
        }
        for (const group of groups) {
            group.hidden = !group.querySelector('.model-card:not([hidden])');
        }
        for (const chip of chips) {
            const on = chip.dataset.filter === filter;
            chip.classList.toggle('models-chip--on', on);
            chip.setAttribute('aria-pressed', String(on));
        }
        empty.hidden = shown > 0;
        count.textContent = filter || words.length ? `${shown} of ${cards.length} models` : '';

        const url = new URL(location.href);
        filter ? url.searchParams.set('filter', filter) : url.searchParams.delete('filter');
        search.value.trim() ? url.searchParams.set('q', search.value.trim()) : url.searchParams.delete('q');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    }

    for (const chip of chips) {
        chip.addEventListener('click', (event) => {
            event.preventDefault();
            filter = chip.dataset.filter;
            apply();
        });
    }
    search.addEventListener('input', apply);
    apply();
})();
