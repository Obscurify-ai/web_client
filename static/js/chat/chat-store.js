// chat-store.js — where saved chats live in this browser: IndexedDB, one record per chat.
//
// localStorage held them all as one JSON string and filled up at 5-10 MB (a few chats with
// images). IndexedDB has room, so chats move there on first load (the localStorage copy is
// dropped only once every chat reads back). Without IndexedDB (some locked-down browsers)
// chats stay in localStorage as before.
//
// The rest of the chat calls getConversations()/saveConversations() synchronously, so the chats
// are kept in memory too (`cache`), loaded before the page restores the last chat
// (`chatStore.ready`). A save writes only the chats that changed, so two tabs don't overwrite
// each other's chats; each tells the others what it changed (BroadcastChannel).
//
// chat-sync.js listens with chatStore.onLocalChange and writes what other devices sent with
// chatStore.applyRemote, which doesn't count as a local change.

const chatStore = (function () {
    const LEGACY_KEY = 'obscurify_conversations';
    const DB_NAME = 'obscurify';
    const DB_VERSION = 1;
    const STORES = ['conversations', 'sync'];

    let cache = [];          // the chats, as saved
    let saved = new Map();   // id -> JSON of the saved chat, to see what a save changed
    let db = null;           // null: localStorage fallback
    const listeners = [];    // onLocalChange(changedIds, deletedIds)
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('obscurify-chats') : null;

    function req(r) {
        return new Promise((resolve, reject) => {
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }

    function tx(stores, mode, fn) {
        return new Promise((resolve, reject) => {
            const t = db.transaction(stores, mode);
            let out;
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('aborted'));
            out = fn(t);
        });
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
            const r = indexedDB.open(DB_NAME, DB_VERSION);
            r.onupgradeneeded = () => {
                for (const name of STORES) {
                    if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
                }
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.onblocked = () => reject(new Error('IndexedDB blocked'));
        });
    }

    function legacy() {
        try {
            const data = localStorage.getItem(LEGACY_KEY);
            const list = data ? JSON.parse(data) : [];
            return Array.isArray(list) ? list : [];
        } catch (_e) {
            return [];
        }
    }

    function setCache(list) {
        cache = list;
        saved = new Map(list.map((c) => [c.id, JSON.stringify(c)]));
    }

    async function readAll() {
        return tx(['conversations'], 'readonly', (t) => req(t.objectStore('conversations').getAll()));
    }

    // Chats still in localStorage (from before, or put there by an older tab) move in. A chat
    // already in IndexedDB keeps whichever copy is newer.
    async function migrate() {
        const old = legacy();
        if (!old.length) return;
        const have = new Map((await readAll()).map((c) => [c.id, c]));
        await tx(['conversations'], 'readwrite', (t) => {
            const s = t.objectStore('conversations');
            for (const c of old) {
                if (!c || !c.id) continue;
                const mine = have.get(c.id);
                if (!mine || (c.updatedAt || 0) > (mine.updatedAt || 0)) s.put(c, c.id);
            }
        });
        const after = new Set((await readAll()).map((c) => c.id));
        if (old.every((c) => !c || !c.id || after.has(c.id))) localStorage.removeItem(LEGACY_KEY);
    }

    const ready = (async () => {
        try {
            db = await openDb();
            db.onversionchange = () => db.close();
            await migrate();
            setCache(await readAll());
        } catch (e) {
            console.warn('Chats stay in localStorage:', e);
            db = null;
            setCache(legacy());
        }
        cache.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    })();

    async function persist(puts, dels) {
        if (!db) {
            try {
                localStorage.setItem(LEGACY_KEY, JSON.stringify(cache));
            } catch (e) {
                console.error('Failed to save conversations:', e);
            }
            return;
        }
        await tx(['conversations'], 'readwrite', (t) => {
            const s = t.objectStore('conversations');
            for (const c of puts) s.put(c, c.id);
            for (const id of dels) s.delete(id);
        });
    }

    // What `list` changes against what's saved: [changed chats], [deleted ids].
    function diff(list) {
        const ids = new Set();
        const puts = [];
        for (const c of list) {
            if (!c || !c.id) continue;
            ids.add(c.id);
            const json = JSON.stringify(c);
            if (saved.get(c.id) !== json) puts.push(c);
        }
        const dels = [...saved.keys()].filter((id) => !ids.has(id));
        return { puts, dels };
    }

    function write(list, local) {
        const { puts, dels } = diff(list);
        if (!puts.length && !dels.length) return Promise.resolve();
        setCache(list.filter((c) => c && c.id));
        const changed = puts.map((c) => c.id);
        const done = persist(puts, dels)
            .then(() => { if (channel) channel.postMessage({ changed, deleted: dels }); })
            .catch((e) => console.error('Failed to save conversations:', e));
        if (local) for (const fn of listeners) { try { fn(changed, dels); } catch (e) { console.error(e); } }
        return done;
    }

    // The chat open in this tab changed in another tab (or came from another device there):
    // show it, unless an answer is being written here (its save keeps both, chat-conversations.js).
    function openChatChangedElsewhere(changed, deleted) {
        if (typeof currentConversationId === 'undefined' || !currentConversationId) return;
        if (typeof isGeneratingResponse !== 'undefined' && isGeneratingResponse) return;
        if (deleted.includes(currentConversationId)) { if (typeof startNewConversation === 'function') startNewConversation(); return; }
        if (!changed.includes(currentConversationId)) return;
        const c = cache.find((x) => x.id === currentConversationId);
        if (c && typeof messages !== 'undefined' && JSON.stringify(c.messages) !== JSON.stringify(messages) && typeof loadConversation === 'function') loadConversation(c.id);
    }

    // Another tab saved: read those chats back.
    if (channel) {
        channel.onmessage = async (event) => {
            if (!db) { setCache(legacy()); }
            else if (event.data && event.data.wiped) { setCache([]); }
            else {
                const { changed = [], deleted = [] } = event.data || {};
                const fresh = await tx(['conversations'], 'readonly', (t) =>
                    Promise.all(changed.map((id) => req(t.objectStore('conversations').get(id)))));
                const byId = new Map(cache.map((c) => [c.id, c]));
                for (const id of deleted) byId.delete(id);
                for (const c of await fresh) if (c && c.id) byId.set(c.id, c);
                setCache([...byId.values()]);
                openChatChangedElsewhere(changed, deleted);
            }
            if (typeof renderConversationsList === 'function') renderConversationsList();
        };
    }

    return {
        ready,
        usesIndexedDb: () => !!db,
        // A copy: callers change what they get and hand it back to save().
        ids: () => cache.map((c) => c.id),
        all: () => (typeof structuredClone === 'function' ? structuredClone(cache) : JSON.parse(JSON.stringify(cache))),
        get: (id) => {
            const c = cache.find((x) => x.id === id);
            return c ? JSON.parse(JSON.stringify(c)) : null;
        },
        save: (list) => write(list, true),
        // From another device (chat-sync.js): saved, but not a change to send back.
        applyRemote(conv, deletedId) {
            const list = cache.filter((c) => c.id !== (conv ? conv.id : deletedId));
            if (conv) list.push(conv);
            list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return write(list, false);
        },
        onLocalChange: (fn) => listeners.push(fn),
        // chat-sync.js's own records (keys, revisions), in the same database.
        async meta(key, value) {
            if (!db) {
                const k = 'obscurify_sync_meta:' + key;
                if (value === undefined) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_e) { return null; } }
                if (value === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(value));
                return;
            }
            if (value === undefined) return tx(['sync'], 'readonly', (t) => req(t.objectStore('sync').get(key)));
            return tx(['sync'], 'readwrite', (t) => {
                if (value === null) t.objectStore('sync').delete(key); else t.objectStore('sync').put(value, key);
            });
        },
        async metaAll() {
            if (!db) {
                const out = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('obscurify_sync_meta:')) { try { out[k.slice(20)] = JSON.parse(localStorage.getItem(k)); } catch (_e) { /* skip */ } }
                }
                return out;
            }
            return tx(['sync'], 'readonly', (t) => {
                const s = t.objectStore('sync');
                return Promise.all([req(s.getAllKeys()), req(s.getAll())]).then(([keys, values]) => {
                    const out = {};
                    keys.forEach((k, i) => { out[k] = values[i]; });
                    return out;
                });
            });
        },
        // Wipe: every chat and sync record in this browser.
        async wipe() {
            setCache([]);
            localStorage.removeItem(LEGACY_KEY);
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith('obscurify_sync_meta:')) localStorage.removeItem(k);
            }
            if (db) {
                await tx(STORES, 'readwrite', (t) => { for (const s of STORES) t.objectStore(s).clear(); });
                if (channel) channel.postMessage({ wiped: true });
            }
        },
    };
})();
