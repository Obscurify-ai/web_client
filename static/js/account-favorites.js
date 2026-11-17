// Favorite models on the Account page: search the catalogue to add one, drag
// (or arrow keys on the handle) to reorder, x to remove. Every change saves at
// once. Storage is the chat's: localStorage `obscurify_favorite_models` (JSON
// array) plus the cookie of the same name (comma list) that the no-JS chat reads.
// New chats start on the first favorite the account can use; that row is marked.
(function () {
    'use strict';

    var KEY = 'obscurify_favorite_models';
    var MAX = 20;
    var MAX_ID = 200;
    var RESULTS = 8;

    var list = document.getElementById('favoriteModelsList');
    var search = document.getElementById('favoriteModelSearch');
    var results = document.getElementById('favoriteModelResults');
    var status = document.getElementById('favoriteModelsStatus');
    if (!list || !search || !results) return;

    var access = window.favoriteModelAccess || { frontier: false, uncensored: false };
    var catalog = null; // id -> model, once loaded
    var frontier = [];
    var uncensored = [];
    var favorites = load();
    var active = -1; // highlighted search result

    function validId(id) {
        return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID && /^[A-Za-z0-9/_:.\-+]+$/.test(id);
    }

    function normalize(ids) {
        var out = [];
        (ids || []).forEach(function (raw) {
            var id = String(raw || '').trim();
            if (validId(id) && out.indexOf(id) === -1 && out.length < MAX) out.push(id);
        });
        return out;
    }

    function readCookie() {
        var prefix = KEY + '=';
        var parts = String(document.cookie || '').split(';');
        for (var i = 0; i < parts.length; i++) {
            var c = parts[i].trim();
            if (c.indexOf(prefix) === 0) {
                try { return normalize(decodeURIComponent(c.slice(prefix.length)).split(',')); } catch (_e) { return []; }
            }
        }
        return [];
    }

    function load() {
        try {
            var parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (Array.isArray(parsed)) {
                var ids = normalize(parsed);
                if (ids.length) return ids;
            }
        } catch (_e) { /* fall back to the cookie */ }
        return readCookie();
    }

    function save(message) {
        try {
            localStorage.setItem(KEY, JSON.stringify(favorites));
        } catch (_e) {
            say('This browser won’t save favorites.', '#f87171');
            return;
        }
        var cookie = KEY + '=' + encodeURIComponent(favorites.join(',')) + '; Path=/; Max-Age=31536000; SameSite=Lax';
        if (location.protocol === 'https:') cookie += '; Secure';
        document.cookie = cookie;
        say(message || 'Saved', '#4ade80');
    }

    var sayTimer = null;
    function say(text, color) {
        if (!status) return;
        status.textContent = text;
        status.style.color = color || '#888';
        clearTimeout(sayTimer);
        sayTimer = setTimeout(function () { status.textContent = ''; }, 2500);
    }

    function matches(id, patterns) {
        return patterns.some(function (p) {
            if (typeof p !== 'string' || !p.trim()) return false;
            p = p.trim();
            if (p.indexOf('*') === -1) return id === p;
            var re = '^' + p.split('*').map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$';
            return new RegExp(re).test(id);
        });
    }

    // Why new chats can't start on this model, or '' when they can.
    function problem(id) {
        if (!catalog) return '';
        if (!catalog[id]) return 'Not available right now';
        if (!access.uncensored && matches(id, uncensored)) return 'Needs Pro';
        if (!access.frontier && matches(id, frontier)) return 'Needs Casual or Pro';
        return '';
    }

    function displayName(id) {
        var m = catalog && catalog[id];
        return m && m.name ? m.name : id;
    }

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function render() {
        var focusedId = document.activeElement && document.activeElement.closest
            && document.activeElement.closest('.fav-row') && document.activeElement.closest('.fav-row').dataset.id;
        list.replaceChildren();
        var defaultId = catalog ? favorites.find(function (id) { return !problem(id); }) : favorites[0];
        favorites.forEach(function (id, index) {
            var row = el('li', 'fav-row');
            row.dataset.id = id;
            var why = problem(id);
            if (why) row.classList.add('is-unusable');

            var handle = el('button', 'fav-handle');
            handle.type = 'button';
            handle.setAttribute('aria-label', 'Move ' + displayName(id) + ' (drag, or use the arrow keys)');
            handle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.8"/><circle cx="15" cy="5" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="9" cy="19" r="1.8"/><circle cx="15" cy="19" r="1.8"/></svg>';
            handle.addEventListener('pointerdown', startDrag);
            handle.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(id, e.key === 'ArrowUp' ? index - 1 : index + 1);
                }
            });

            var text = el('div', 'fav-text');
            var name = el('div', 'fav-name', displayName(id));
            if (id === defaultId) name.appendChild(el('span', 'fav-badge', 'New chats'));
            text.appendChild(name);
            var meta = el('div', 'fav-id', displayName(id) === id ? '' : id);
            if (why) meta.appendChild(el('span', 'fav-problem', (meta.textContent ? ' \u00b7 ' : '') + why));
            text.appendChild(meta);

            var remove = el('button', 'fav-remove', '×');
            remove.type = 'button';
            remove.setAttribute('aria-label', 'Remove ' + displayName(id));
            remove.addEventListener('click', function () {
                favorites = favorites.filter(function (f) { return f !== id; });
                save('Removed');
                render();
                renderResults();
            });

            row.append(handle, text, remove);
            list.appendChild(row);
            if (id === focusedId) handle.focus();
        });
        list.hidden = favorites.length === 0;
        var empty = document.getElementById('favoriteModelsEmpty');
        if (empty) empty.hidden = favorites.length > 0;
        search.disabled = favorites.length >= MAX;
        search.placeholder = favorites.length >= MAX ? 'Up to ' + MAX + ' favorites' : 'Search models to add';
    }

    function move(id, to) {
        var from = favorites.indexOf(id);
        if (from === -1 || to < 0 || to >= favorites.length || to === from) return;
        favorites.splice(from, 1);
        favorites.splice(to, 0, id);
        save();
        render();
    }

    // Pointer drag (mouse, touch and pen alike): the row follows the pointer
    // through the list and the order is saved on release.
    function startDrag(e) {
        if (e.button !== undefined && e.button !== 0) return;
        var row = e.currentTarget.closest('.fav-row');
        e.preventDefault();
        // Listen on window: moving the row in the DOM drops pointer capture.
        var pointerId = e.pointerId;
        row.classList.add('is-dragging');
        list.classList.add('is-sorting');
        var startOrder = favorites.join('\n');

        function onMove(ev) {
            if (ev.pointerId !== pointerId) return;
            ev.preventDefault();
            var y = ev.clientY;
            var rows = Array.prototype.slice.call(list.children);
            var before = null;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] === row) continue;
                var box = rows[i].getBoundingClientRect();
                if (y < box.top + box.height / 2) { before = rows[i]; break; }
            }
            if (before !== row.nextSibling && before !== row) list.insertBefore(row, before);
        }
        function onUp(ev) {
            if (ev.pointerId !== pointerId) return;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            row.classList.remove('is-dragging');
            list.classList.remove('is-sorting');
            favorites = Array.prototype.map.call(list.children, function (r) { return r.dataset.id; });
            if (favorites.join('\n') !== startOrder) save();
            render();
        }
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }

    // --- search ---------------------------------------------------------------

    function searchMatches() {
        var q = search.value.trim().toLowerCase();
        if (!q || !catalog) return [];
        var words = q.split(/\s+/);
        var out = [];
        Object.keys(catalog).forEach(function (id) {
            if (favorites.indexOf(id) !== -1) return;
            var hay = (id + ' ' + (catalog[id].name || '')).toLowerCase();
            if (words.every(function (w) { return hay.indexOf(w) !== -1; })) out.push(catalog[id]);
        });
        // Usable first, then names that start with the query, then catalogue order (newest first).
        out.sort(function (a, b) {
            var pa = problem(a.id) ? 1 : 0, pb = problem(b.id) ? 1 : 0;
            if (pa !== pb) return pa - pb;
            var sa = (a.name || '').toLowerCase().replace(/^[^:]*:\s*/, '').indexOf(words[0]) === 0 ? 0 : 1;
            var sb = (b.name || '').toLowerCase().replace(/^[^:]*:\s*/, '').indexOf(words[0]) === 0 ? 0 : 1;
            return sa - sb;
        });
        return out.slice(0, RESULTS);
    }

    function renderResults() {
        var found = searchMatches();
        results.replaceChildren();
        if (!search.value.trim()) {
            results.hidden = true;
            search.setAttribute('aria-expanded', 'false');
            return;
        }
        if (!catalog) {
            results.appendChild(el('li', 'fav-result-empty', 'Loading models…'));
        } else if (!found.length) {
            results.appendChild(el('li', 'fav-result-empty', 'No models match'));
        }
        if (active >= found.length) active = found.length - 1;
        found.forEach(function (m, i) {
            var li = el('li', 'fav-result' + (i === active ? ' is-active' : ''));
            li.id = 'fav-result-' + i;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', i === active ? 'true' : 'false');
            li.dataset.id = m.id;
            li.appendChild(el('div', 'fav-name', m.name || m.id));
            var meta = el('div', 'fav-id', m.id);
            var why = problem(m.id);
            if (why) meta.appendChild(el('span', 'fav-problem', ' · ' + why));
            li.appendChild(meta);
            // mousedown, not click: keeps focus in the search box.
            li.addEventListener('mousedown', function (e) { e.preventDefault(); add(m.id); });
            results.appendChild(li);
        });
        results.hidden = false;
        search.setAttribute('aria-expanded', 'true');
        if (active >= 0) search.setAttribute('aria-activedescendant', 'fav-result-' + active);
        else search.removeAttribute('aria-activedescendant');
    }

    function add(id) {
        if (favorites.length >= MAX || favorites.indexOf(id) !== -1) return;
        favorites.push(id);
        save('Added ' + displayName(id));
        search.value = '';
        active = -1;
        render();
        renderResults();
        search.focus();
    }

    search.addEventListener('input', function () { active = search.value.trim() ? 0 : -1; renderResults(); });
    search.addEventListener('focus', renderResults);
    search.addEventListener('blur', function () { results.hidden = true; search.setAttribute('aria-expanded', 'false'); });
    search.addEventListener('keydown', function (e) {
        var count = results.querySelectorAll('.fav-result').length;
        if (e.key === 'ArrowDown' && count) {
            e.preventDefault(); active = (active + 1) % count; renderResults();
        } else if (e.key === 'ArrowUp' && count) {
            e.preventDefault(); active = (active - 1 + count) % count; renderResults();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            var pick = results.querySelectorAll('.fav-result')[Math.max(active, 0)];
            if (pick) add(pick.dataset.id);
        } else if (e.key === 'Escape') {
            search.value = ''; active = -1; renderResults();
        }
    });

    function fetchJson(url) {
        return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
    }

    render();
    Promise.all([
        fetchJson('/v1/models'),
        fetchJson('/frontier_models').catch(function () { return {}; }),
        fetchJson('/uncensored_models').catch(function () { return {}; })
    ]).then(function (got) {
        catalog = {};
        (got[0].data || []).forEach(function (m) {
            // Decision models answer typed questions, not chats (as in the chat's picker).
            if (!m.decisions) catalog[m.id] = m;
        });
        frontier = got[1].frontier_models || [];
        uncensored = got[2].uncensored_models || [];
        render();
        renderResults();
    }).catch(function () {
        say('Couldn’t load the model list. Reload to try again.', '#f87171');
    });
})();
