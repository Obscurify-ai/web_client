// chat-sync.js — Encrypted sync of saved chats, presets and favorites between this browser,
// other browsers and the Android app signed in with the same account number.
//
// Everything is encrypted here, with a key made from the account number's seed (the one private
// sessions use, private-sessions.js), before it leaves. The server (src/api/sync.rs) gets a
// bearer token made from the same seed and blobs it can't open, under ids it can't tell apart;
// requests carry no cookie, so it can't tell whose they are either. The Android app does the
// same in src/sync.rs; the two must agree on everything below marked FORMAT.
//
// FORMAT
//   derive(label) = HMAC-SHA256(seed, u32be(9) "chat-sync" u32be(len) label)   (Seed::derive)
//   token  = "sync1_" + hex(derive("token"))         id key = derive("id")
//   AES-256-GCM key = derive("key")
//   record id for local key K ("conv:<id>", "prefs", "att:<sha256 hex>") = hex(HMAC(id key, K))[0..32]
//   blob = 0x01 | nonce(12) | AES-GCM(plain, aad = record id)
//   plain = u32be(n) | gzip(JSON envelope) (n bytes) | zeros up to a multiple of 4096
//   envelope = {v:1, k:"conv", id, conv} | {v:1, k:"conv", id, deleted:true}
//            | {v:1, k:"prefs", prefs:{presets, newChatPreset, favorites}} | {v:1, k:"att", h, data}
//            | {v:1, k:"att", h, deleted:true}   (an image no chat used any more: a tombstone, not a
//              DELETE, so a device whose chat still uses it, kept by an edit that beat a delete,
//              learns it's gone and puts it back)
//   In a synced chat every "data:..." string over 2048 chars (images) is replaced by
//   "obscurify-att:<sha256 hex of it>" and sent once as its own "att" record.
//   A chat is the web's conversation object (chat-conversations.js); fields a device doesn't
//   know it keeps as they are.
//
// Merging: the server orders writes (revisions), never device clocks. A chat changed here and
// elsewhere keeps the longer one when one is the other plus more messages; title, folder, pin,
// model and settings come from whichever side changed them. Otherwise both are kept (this
// device's version becomes a copy).
//
// On by default once signed in with the account code (accounts with a 16-digit number convert
// to a code first: the account page); the switch (account page) is per device.
// Off deletes the synced copy, and the other devices then stop syncing too (they keep their
// chats). Chats saved while signed in to another account are never uploaded to this one.
//
// Joining: a device that has chats from before it had the number (signed out, or before sync
// existed) and finds other devices' chats already synced asks first ("Combine chats?"). Until
// it is answered the device reads nothing into its chats and writes nothing to the server.
// Combine puts all of them on every device; "Not on this device" turns sync off here only
// (the synced copy and the other devices carry on).

(function () {
    'use strict';
    const OFF = 'obscurify_sync_off';
    const JOINED = 'obscurify_sync_joined';       // the account (owner) this browser combined with
    const SEED = 'obscurify_sync_seed';           // set when the number changes (account page)
    const PRIVATE_SEED = 'obscurify_private_seed'; // private-sessions.js, from signing in
    const API = '/sync/v1';
    const ATT_MIN = 2048;
    const ATT_PREFIX = 'obscurify-att:';
    const PAD = 4096;
    const MAX_RECORD = 6 * 1024 * 1024;
    const META_FIELDS = ['title', 'titleSet', 'folder', 'pinned', 'model', 'settings'];
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    // Only accounts with an account code sync (private-sessions.js keeps which this browser signed
    // in with): 16 digits can be guessed by someone holding the server, a code can't.
    const hasCode = () => localStorage.getItem('obscurify_account_kind') === 'code';
    const seedHex = () => (hasCode() ? localStorage.getItem(SEED) || localStorage.getItem(PRIVATE_SEED) || null : null);
    // The account's plan leaves sync out (the server says so in the page). Sync pauses: chats stay
    // on this device, the synced copy stays as it is and syncing carries on with a plan that has
    // it. Only the apps enforce this: the server can't tell whose a store is.
    const planOff = () => document.body.hasAttribute('data-sync-off');
    // Switched on here, whether or not the plan has it now.
    const enabled = () => !!seedHex() && localStorage.getItem(OFF) !== '1' && !!(window.crypto && crypto.subtle);
    const on = () => enabled() && !planOff();
    const meta = (k, v) => chatStore.meta(k, v);
    const metaUpdate = (k, fn) => chatStore.metaUpdate(k, fn);
    // A chat's record, changed here: it goes up.
    const touched = (m) => (m ? Object.assign(m, { dirty: true, ver: (m.ver || 0) + 1 }) : undefined);
    // Chats saved here whose record doesn't say so yet (mark()).
    const unmarked = new Map(); // id -> saves waiting

    // --- keys and records (FORMAT) ---------------------------------------------------------

    const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
    // (Records are megabytes of this: a callback per byte took seconds on a phone.)
    function b64dec(s) {
        if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(s);
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function lengthPrefixed(parts) {
        const bytes = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
        const out = new Uint8Array(bytes.reduce((n, b) => n + 4 + b.length, 0));
        const view = new DataView(out.buffer);
        let o = 0;
        for (const b of bytes) { view.setUint32(o, b.length); out.set(b, o + 4); o += 4 + b.length; }
        return out;
    }

    async function hmac(key, msg) {
        const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
    }

    const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

    let keysFor = null;
    let keysCache = null;
    async function keysOf(seedHexValue) {
        const seed = unhex(seedHexValue);
        const derive = (label) => hmac(seed, lengthPrefixed(['chat-sync', label]));
        const token = 'sync1_' + hex(await derive('token'));
        const aes = await crypto.subtle.importKey('raw', await derive('key'), 'AES-GCM', false, ['encrypt', 'decrypt']);
        return { token, aes, idKey: await derive('id'), owner: (await sha256(token)).slice(0, 16) };
    }
    async function keys() {
        const s = seedHex();
        if (!s) return null;
        if (keysFor !== s) { keysCache = await keysOf(s); keysFor = s; }
        return keysCache;
    }

    const recordId = async (k, localKey) => hex(await hmac(k.idKey, enc.encode(localKey))).slice(0, 32);

    async function pipe(bytes, stream) {
        return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
    }

    async function seal(k, id, envelope) {
        const z = await pipe(enc.encode(JSON.stringify(envelope)), new CompressionStream('gzip'));
        const plain = new Uint8Array(Math.ceil((z.length + 4) / PAD) * PAD);
        new DataView(plain.buffer).setUint32(0, z.length);
        plain.set(z, 4);
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(id) }, k.aes, plain));
        const out = new Uint8Array(13 + ct.length);
        out[0] = 1;
        out.set(nonce, 1);
        out.set(ct, 13);
        return out;
    }

    async function unseal(k, id, blob) {
        if (blob[0] !== 1) throw new Error('unknown record format ' + blob[0]);
        const plain = new Uint8Array(await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: blob.slice(1, 13), additionalData: enc.encode(id) }, k.aes, blob.slice(13)));
        const n = new DataView(plain.buffer).getUint32(0);
        return JSON.parse(dec.decode(await pipe(plain.slice(4, 4 + n), new DecompressionStream('gzip'))));
    }

    // --- the server ------------------------------------------------------------------------

    let stopped = false;     // the server has sync off: nothing more this visit
    let state = {};          // { owner, after, epoch }: this round's (run())
    let backoffUntil = 0;
    let full = false;        // this account's sync storage is full

    function call(k, method, path, body, rev) {
        const headers = { Authorization: 'Bearer ' + k.token };
        if (rev !== undefined) headers['If-Match'] = String(rev);
        if (body) headers['Content-Type'] = 'application/octet-stream';
        // No cookie: the server must not learn whose store this is.
        // A request that hangs mustn't hold up syncing for good (a round waits for it).
        const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined;
        return fetch(API + path, { method, headers, body, credentials: 'omit', cache: 'no-store', signal });
    }

    function failed(r) {
        if (r.status === 404) stopped = true;
        else if (r.status === 413) full = true;
        else {
            const after = parseInt(r.headers.get('retry-after') || '', 10);
            backoffUntil = Date.now() + 1000 * Math.min(3600, after > 0 ? after : 60);
        }
        return false;
    }

    // --- images: records of their own ---------------------------------------------------------

    function mapStrings(v, fn) {
        if (typeof v === 'string') return fn(v);
        if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
        if (v && typeof v === 'object') {
            const out = {};
            for (const key of Object.keys(v)) out[key] = mapStrings(v[key], fn);
            return out;
        }
        return v;
    }

    async function splitImages(conv) {
        const found = [];
        mapStrings(conv, (s) => { if (s.length > ATT_MIN && s.startsWith('data:')) found.push(s); return s; });
        const atts = new Map();
        const byData = new Map();
        for (const data of found) {
            if (byData.has(data)) continue;
            const h = await sha256(data);
            byData.set(data, h);
            atts.set(h, data);
        }
        return { conv: mapStrings(conv, (s) => (byData.has(s) ? ATT_PREFIX + byData.get(s) : s)), atts };
    }

    async function joinImages(conv) {
        const wanted = new Set();
        mapStrings(conv, (s) => { if (s.startsWith(ATT_PREFIX)) wanted.add(s.slice(ATT_PREFIX.length)); return s; });
        const data = new Map();
        for (const h of wanted) {
            const m = await meta('att:' + h);
            if (m && m.data && !m.deleted) data.set(h, m.data);
        }
        return mapStrings(conv, (s) => (s.startsWith(ATT_PREFIX) && data.has(s.slice(ATT_PREFIX.length)) ? data.get(s.slice(ATT_PREFIX.length)) : s));
    }

    async function uploadImage(k, h, data) {
        const key = 'att:' + h;
        const m = await meta(key);
        if (m && m.owner === k.owner && m.rev && !m.deleted) return true;
        const id = await recordId(k, key);
        const blob = await seal(k, id, { v: 1, k: 'att', h, data });
        if (blob.length > MAX_RECORD) return true; // too big to sync: the other devices see it missing
        // Over a tombstone (deleted elsewhere while a chat here still used it): at its revision.
        let ifMatch = m && m.owner === k.owner && m.deleted ? m.rev : 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            const r = await call(k, 'PUT', '/records/' + id, blob, ifMatch);
            if (r.status === 409) {
                const body = await r.json();
                if (!(await sameStore(body.epoch))) return false;
                let there = null;
                try { there = body.data ? await unseal(k, id, b64dec(body.data)) : null; } catch (_e) { there = null; }
                if (there && there.deleted) { ifMatch = body.rev; continue; } // a tombstone: put it back
                // Already there (the same image in another chat, or from another device).
                await meta(key, { rev: body.rev, owner: k.owner, data });
                return true;
            }
            if (!r.ok) return failed(r);
            const body = await r.json();
            if (!(await madeHere(k, body.epoch))) return false;
            await meta(key, { rev: body.rev, owner: k.owner, data });
            return true;
        }
        return false;
    }

    // Images no synced chat here uses any more become tombstones on the server (see FORMAT).
    async function dropImages(k, hashes) {
        if (!hashes.length) return;
        const all = await chatStore.metaAll('conv:');
        const used = new Set();
        for (const [key, m] of Object.entries(all)) if (key.startsWith('conv:') && m && !m.deleted) (m.atts || []).forEach((h) => used.add(h));
        for (const h of hashes) {
            const m = await meta('att:' + h);
            if (used.has(h) || !m || m.deleted || !m.rev) continue;
            const id = await recordId(k, 'att:' + h);
            const r = await call(k, 'PUT', '/records/' + id, await seal(k, id, { v: 1, k: 'att', h, deleted: true }), m.rev);
            if (r.ok) await meta('att:' + h, { rev: (await r.json()).rev, owner: k.owner, deleted: true });
        }
    }

    // An image arrived: chats here that came without it (it was gone when they did) get it now.
    async function imageArrived(h, data) {
        const all = await chatStore.metaAll('conv:');
        const ref = ATT_PREFIX + h;
        for (const [key, m] of Object.entries(all)) {
            if (!key.startsWith('conv:') || !m || !(m.atts || []).includes(h)) continue;
            const conv = chatStore.get(key.slice(5));
            if (!conv || !JSON.stringify(conv).includes(ref)) continue;
            await chatStore.applyRemote(mapStrings(conv, (s) => (s === ref ? data : s)));
            openChatChanged(conv.id, chatStore.get(conv.id));
        }
    }

    // An image was deleted elsewhere: chats here that still use it put it back (next push).
    async function imageGone(k, h) {
        const all = await chatStore.metaAll('conv:');
        for (const [key, m] of Object.entries(all)) {
            if (!key.startsWith('conv:') || !m || m.deleted || m.owner !== k.owner || !(m.atts || []).includes(h)) continue;
            if (!chatStore.get(key.slice(5))) continue;
            await metaUpdate(key, touched);
        }
    }

    // --- merging --------------------------------------------------------------------------------

    // Key order and defaults differ between the web and the app, so compare with sorted keys.
    const stable = (v) => (Array.isArray(v) ? v.map(stable)
        : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { if (v[k] !== undefined) o[k] = stable(v[k]); return o; }, {}) : v);
    const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
    const fieldsOf = (c) => { const o = {}; for (const f of META_FIELDS) if (c[f] !== undefined) o[f] = c[f]; return o; };
    // FORMAT: two messages are the same message when role and text match (the app keeps
    // messages in its own shape, so whole objects differ).
    const textOf = (m) => (typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : '');
    const sameMessage = (a, b) => a.role === b.role && textOf(a).trim() === textOf(b).trim();
    const isPrefix = (a, b) => a.length <= b.length && a.every((m, i) => sameMessage(m, b[i]));

    // { conv } to keep, plus { copy } when the two can't be put together.
    function merge(local, remote, base) {
        const L = local.messages || [];
        const R = remote.messages || [];
        let out;
        if (isPrefix(R, L)) out = Object.assign({}, remote, { messages: L, compaction: local.compaction });
        else if (isPrefix(L, R)) out = Object.assign({}, remote);
        else return { conv: remote, copy: Object.assign({}, local, { id: 'conv-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) }) };
        for (const f of META_FIELDS) {
            if (!same(local[f], base ? base[f] : undefined)) {
                if (local[f] === undefined) delete out[f]; else out[f] = local[f];
            }
        }
        out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
        return { conv: out };
    }

    // --- pulling ----------------------------------------------------------------------------------

    function openChatChanged(id, conv) {
        if (typeof currentConversationId === 'undefined' || currentConversationId !== id) return;
        if (typeof isGeneratingResponse !== 'undefined' && isGeneratingResponse) return;
        if (!conv) { if (typeof startNewConversation === 'function') startNewConversation(); return; }
        if (typeof messages !== 'undefined' && messages.length === conv.messages.length && isPrefix(messages, conv.messages) && same(messages, conv.messages)) return;
        if (typeof loadConversation === 'function') loadConversation(id);
    }

    async function applyRecord(k, rec) {
        let env;
        try {
            env = await unseal(k, rec.id, b64dec(rec.data));
        } catch (e) {
            console.warn('chat sync: a record could not be read', e);
            return;
        }
        if (env.k === 'att' && env.h && env.deleted) {
            await meta('att:' + env.h, { rev: rec.rev, owner: k.owner, deleted: true });
            await imageGone(k, env.h);
        } else if (env.k === 'att' && env.h) {
            await meta('att:' + env.h, { rev: rec.rev, owner: k.owner, data: env.data });
            await imageArrived(env.h, env.data);
        } else if (env.k === 'prefs' && env.prefs) {
            const m = (await meta('prefs')) || {};
            const mine = readPrefs();
            if (m.hash && m.hash !== await sha256(JSON.stringify(mine))) {
                await meta('prefs', Object.assign(m, { rev: rec.rev })); // changed here too: ours goes up next
            } else {
                writePrefs(env.prefs, mine);
                await meta('prefs', { rev: rec.rev, owner: k.owner, hash: await sha256(JSON.stringify(readPrefs())), last: env.prefs });
            }
        } else if (env.k === 'conv' && typeof env.id === 'string' && env.id) {
            return applyConv(k, rec, env);
        }
    }

    // 'defer': the chat is open here with an answer being written; it's applied next round
    // (applying now would be overwritten when the answer is saved).
    async function applyConv(k, rec, env) {
        const key = 'conv:' + env.id;
        // This device's own upload coming back (or one it already has): nothing new. Merging it with
        // what the chat has become since made a copy of every chat that synced while it was being
        // answered, and brought back chats deleted right after they went up.
        const had = await meta(key);
        if (had && had.owner === k.owner && had.rev === rec.rev) return;
        if (typeof currentConversationId !== 'undefined' && currentConversationId === env.id
            && typeof isGeneratingResponse !== 'undefined' && isGeneratingResponse) return 'defer';
        const remote = env.deleted ? null : await joinImages(env.conv);
        const atts = [];
        if (remote) {
            remote.id = env.id;
            mapStrings(env.conv, (s) => { if (s.startsWith(ATT_PREFIX)) atts.push(s.slice(ATT_PREFIX.length)); return s; });
        }
        let keep;
        let saved;
        // In one step, so a save here meanwhile is either part of this or comes after it.
        await metaUpdate(key, (was) => {
            const m = was || {};
            const local = chatStore.get(env.id);
            const changedHere = (m.dirty && m.owner === k.owner) || unmarked.has(env.id);
            if (!remote) {
                if (changedHere && local) return Object.assign(m, { rev: rec.rev, owner: k.owner, deleted: false });
                keep = null;
                if (local) saved = chatStore.applyRemote(null, env.id);
                return { rev: rec.rev, owner: k.owner, deleted: true, atts: [] };
            }
            let dirty = false;
            let copy = null;
            keep = remote;
            if (changedHere && local && !m.deleted) {
                const merged = merge(local, remote, m.base);
                keep = merged.conv;
                copy = merged.copy;
                dirty = !same(keep, remote);
            }
            if (copy) chatStore.save(chatStore.all().concat([copy]));
            saved = chatStore.applyRemote(keep);
            return { rev: rec.rev, owner: k.owner, dirty, ver: (m.ver || 0) + 1, base: fieldsOf(remote), atts };
        });
        await saved;
        if (saved) openChatChanged(env.id, keep);
    }

    // false: the store isn't the one this device synced with (deleted, or deleted and made
    // again): sync was turned off on another device, so it stops here too.
    async function sameStore(epoch) {
        if ((epoch || null) === (state.epoch || null)) return true;
        if (state.epoch) { await turnedOffElsewhere(); return false; }
        state.epoch = epoch;
        await meta('state', state);
        return true;
    }

    // The sidebar shows chats as they arrive: the first sync of a phone takes seconds.
    let drawnAt = 0;
    function drawSoon(now) {
        if ((!now && Date.now() - drawnAt < 400) || typeof renderConversationsList !== 'function') return;
        drawnAt = Date.now();
        renderConversationsList();
    }

    async function pull(k) {
        pages: for (let page = 0; page < 100; page++) {
            const r = await call(k, 'GET', '/records?after=' + state.after);
            if (!r.ok) return failed(r);
            const body = await r.json();
            if (!(await sameStore(body.epoch))) return false;
            if (body.rev < state.after) {
                // Same store, older revisions (restored from a backup): send everything again.
                await markAllDirty(k);
                state.after = 0;
                await meta('state', state);
                continue;
            }
            for (const rec of body.records) {
                if ((await applyRecord(k, rec)) === 'defer') break pages;
                state.after = rec.rev;
                drawSoon();
            }
            await meta('state', state);
            if (!body.more) break;
            drawSoon(true); // the next page can be a while
        }
        drawSoon(true);
        return true;
    }

    // --- pushing ----------------------------------------------------------------------------------

    // Chats with nothing on record yet are this account's from now on: they go up.
    // (Chats tagged with another account stay here and never go up.)
    async function adopt(k) {
        const all = await chatStore.metaAll('conv:');
        for (const id of chatStore.ids()) {
            const m = all['conv:' + id];
            if (!m) await metaUpdate('conv:' + id, (now) => (now ? undefined : { owner: k.owner, dirty: true, ver: 1 }));
            else if (m.owner === k.owner && !m.rev && !m.dirty && !m.deleted && !m.tooBig) await metaUpdate('conv:' + id, touched);
        }
    }

    // (Their revisions are forgotten: the server numbers from further back now, so the same number
    // can be another device's write.)
    async function markAllDirty(k) {
        const all = await chatStore.metaAll('conv:');
        for (const [key, m] of Object.entries(all)) {
            if (key.startsWith('conv:') && m && m.owner === k.owner) await metaUpdate(key, (now) => (now ? Object.assign(now.deleted ? now : touched(now), { rev: 0 }) : undefined));
        }
    }

    // A write answered from a store this device didn't sync with: it made the store again after
    // another device deleted it (sync turned off there). Delete it again and stop here too.
    async function madeHere(k, epoch) {
        if (!state.epoch || epoch === state.epoch) {
            if (!state.epoch) { state.epoch = epoch; await meta('state', state); }
            return true;
        }
        await call(k, 'DELETE', '').catch(() => null);
        await turnedOffElsewhere();
        return false;
    }

    async function pushConv(k, id) {
        const key = 'conv:' + id;
        const m = await meta(key);
        if (!m || !m.dirty || m.owner !== k.owner) return 'done';
        const ver = m.ver;
        const local = chatStore.get(id);
        let env;
        let hashes = [];
        if (!local || m.deleted) {
            if (!m.rev) { await meta(key, null); return 'done'; } // never went up
            env = { v: 1, k: 'conv', id, deleted: true };
        } else {
            const split = await splitImages(local);
            for (const [h, data] of split.atts) if (!(await uploadImage(k, h, data))) return 'failed';
            hashes = [...split.atts.keys()];
            env = { v: 1, k: 'conv', id, conv: split.conv };
        }
        const rid = await recordId(k, key);
        const blob = await seal(k, rid, env);
        if (blob.length > MAX_RECORD) { await meta(key, Object.assign(m, { dirty: false, tooBig: true })); return 'done'; }
        const r = await call(k, 'PUT', '/records/' + rid, blob, m.rev || 0);
        if (r.status === 409) {
            const body = await r.json();
            if (!(await sameStore(body.epoch))) return 'failed';
            if (!body.data) { await metaUpdate(key, (now) => Object.assign(now || m, { rev: 0 })); return 'again'; } // the record is gone: make it again
            if ((await applyRecord(k, { id: rid, rev: body.rev, data: body.data })) === 'defer') return 'failed';
            return 'again';
        }
        if (!r.ok) return failed(r) ? 'done' : 'failed';
        const { rev, epoch } = await r.json();
        if (!(await madeHere(k, epoch))) return 'failed';
        if (!env.deleted) full = false; // room again
        if (env.deleted) {
            await meta(key, { rev, owner: k.owner, deleted: true, atts: [] });
            await dropImages(k, m.atts || []);
        } else {
            await metaUpdate(key, (was) => {
                const now = was || {};
                return Object.assign(now, { rev, owner: k.owner, dirty: now.ver !== ver, deleted: false, base: fieldsOf(local), atts: hashes });
            });
            await dropImages(k, (m.atts || []).filter((h) => !hashes.includes(h)));
        }
        return 'done';
    }

    function readPrefs() {
        let s = {};
        try { s = JSON.parse(localStorage.getItem('obscurify_chat_settings') || '{}') || {}; } catch (_e) { /* none */ }
        let favorites = [];
        try { favorites = JSON.parse(localStorage.getItem('obscurify_favorite_models') || '[]') || []; } catch (_e) { /* none */ }
        return { presets: Array.isArray(s.presets) ? s.presets : [], newChatPreset: s.newChatPreset || null, favorites };
    }

    function writePrefs(p) {
        let s = {};
        try { s = JSON.parse(localStorage.getItem('obscurify_chat_settings') || '{}') || {}; } catch (_e) { /* none */ }
        if (Array.isArray(p.presets)) s.presets = p.presets;
        if ('newChatPreset' in p) s.newChatPreset = p.newChatPreset || null;
        localStorage.setItem('obscurify_chat_settings', JSON.stringify(s));
        if (Array.isArray(p.favorites)) {
            if (typeof saveFavoriteModels === 'function') saveFavoriteModels(p.favorites);
            else localStorage.setItem('obscurify_favorite_models', JSON.stringify(p.favorites));
            if (typeof renderModelPicker === 'function') { try { renderModelPicker(); } catch (_e) { /* not drawn yet */ } }
        }
    }

    async function pushPrefs(k) {
        const prefs = readPrefs();
        const hash = await sha256(JSON.stringify(prefs));
        const m = (await meta('prefs')) || {};
        if (m.owner === k.owner && m.hash === hash) return;
        if (!m.rev && !prefs.presets.length && !prefs.favorites.length) return; // nothing to share yet
        const rid = await recordId(k, 'prefs');
        // Fields another device knows and this one doesn't (Android has no presets) stay as they were.
        const out = Object.assign({}, m.owner === k.owner ? m.last : {}, prefs);
        const r = await call(k, 'PUT', '/records/' + rid, await seal(k, rid, { v: 1, k: 'prefs', prefs: out }), m.owner === k.owner ? (m.rev || 0) : 0);
        if (r.status === 409) {
            const body = await r.json();
            if (!(await sameStore(body.epoch))) return;
            await meta('prefs', Object.assign(m, { owner: k.owner, rev: body.rev, hash: null })); // ours wins: try again next round
            return;
        }
        if (!r.ok) return failed(r);
        const body = await r.json();
        if (!(await madeHere(k, body.epoch))) return;
        await meta('prefs', { rev: body.rev, owner: k.owner, hash, last: out });
    }

    async function push(k) {
        let probed = false;
        const all = await chatStore.metaAll('conv:');
        for (const [key, m] of Object.entries(all)) {
            if (!key.startsWith('conv:') || !m || !m.dirty || m.owner !== k.owner) continue;
            // Full: deletes (which make room), and one new chat a round to see if there's room again
            // (other devices may have deleted chats).
            if (full && !m.deleted) { if (probed) continue; probed = true; }
            for (let attempt = 0; attempt < 3; attempt++) {
                const result = await pushConv(k, key.slice(5));
                if (result !== 'again') break;
            }
            if (stopped || Date.now() < backoffUntil || !on()) return;
        }
        await pushPrefs(k);
    }

    // --- running ------------------------------------------------------------------------------------

    // Forget everything about the synced copy, but not which account each chat was made under
    // (so turning sync back on, here or after signing in to another account, doesn't upload
    // another account's chats), nor what each chat's title, folder etc. were when last synced
    // (so on joining again, a rename made elsewhere meanwhile isn't undone by this device's
    // older title: merge() sees this device didn't change it).
    async function clearMeta() {
        const all = await chatStore.metaAll('conv:');
        for (const key of await chatStore.metaKeys()) {
            const m = all[key];
            // (Only for chats still here: a deleted chat leaves nothing of itself behind.)
            if (key.startsWith('conv:') && m && m.owner && !m.deleted && chatStore.get(key.slice(5))) await meta(key, m.base ? { owner: m.owner, base: m.base } : { owner: m.owner });
            else await meta(key, null);
        }
        state = {};
    }

    // The synced copy is gone (turned off on another device): stop here too, keep the chats.
    async function turnedOffElsewhere() {
        localStorage.setItem(OFF, '1');
        localStorage.removeItem(JOINED);
        await clearMeta();
    }

    // --- joining: asking before this device's chats and the synced ones are combined ----------

    // Whether this device has joined the account's synced copy (agreed to combine, or had
    // nothing to combine). Devices that synced before the question existed count as joined.
    async function isJoined(k) {
        if (localStorage.getItem(JOINED) === k.owner) return true;
        const st = (await meta('state')) || {};
        return st.owner === k.owner && !!st.epoch;
    }
    const agree = (k) => localStorage.setItem(JOINED, k.owner);

    // The chats the question is about: ones this device had before it had this account's key
    // (made signed out, or before sync existed), which carry no account yet. Chats made since,
    // signed in to this account, are its own (mark() tags them) and go up without asking.
    async function unsynced(k) {
        const all = await chatStore.metaAll('conv:');
        return chatStore.ids().filter((id) => !all['conv:' + id]);
    }

    // The chats in the synced copy, read without joining it: nothing is kept, and the store's
    // epoch isn't recorded (sameStore()), so the next round still knows this device hasn't joined.
    async function remoteChats(k) {
        const ids = new Set();
        let after = 0;
        for (let page = 0; page < 100; page++) {
            const r = await call(k, 'GET', '/records?after=' + after);
            if (!r.ok) { failed(r); return null; }
            const body = await r.json();
            if (!body.epoch) return ids; // no synced copy
            for (const rec of body.records) {
                after = rec.rev;
                let env;
                try { env = await unseal(k, rec.id, b64dec(rec.data)); } catch (_e) { continue; }
                if (env.k === 'conv' && typeof env.id === 'string') {
                    if (env.deleted) ids.delete(env.id); else ids.add(env.id);
                }
            }
            if (!body.more) break;
        }
        return ids;
    }

    // true: go ahead and sync. false: wait (the question is on screen, or the server can't
    // be reached).
    async function mayJoin(k) {
        if (await isJoined(k)) return true;
        if (asking === k.owner) return false;
        const here = await unsynced(k);
        if (here.length) {
            const there = await remoteChats(k);
            if (!there) return false;
            const newHere = here.filter((id) => !there.has(id)).length;
            const newThere = [...there].filter((id) => !chatStore.get(id)).length;
            if (newHere && newThere) {
                if (!on()) return false;
                ask(k, newHere, newThere);
                return false;
            }
        }
        if (!on()) return false;
        agree(k);
        return true;
    }

    let asking = null; // the account whose question is on screen
    let dialog = null;
    function closeAsk() {
        asking = null;
        if (dialog) { try { dialog.close(); } catch (_e) { /* closed */ } dialog.remove(); dialog = null; }
    }
    const changedHere = () => window.dispatchEvent(new Event('chatsync'));

    function ask(k, here, there) {
        closeAsk();
        asking = k.owner;
        if (!document.getElementById('sync-join-style')) {
            const style = document.createElement('style');
            style.id = 'sync-join-style';
            style.textContent = '#sync-join{width:min(380px,calc(100vw - 24px));padding:20px;background:#000;color:var(--text-color,#eee);border:1px solid var(--border-color,#333);border-radius:16px}'
                + '#sync-join::backdrop{background:rgba(0,0,0,.7)}'
                + '#sync-join h2{margin:0 0 8px;font:700 1.05rem var(--mono,monospace)}'
                + '#sync-join p{margin:0 0 18px;color:var(--muted-color,#999);font-size:.9rem;line-height:1.45}'
                + '#sync-join .row{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}'
                + '#sync-join button{padding:10px 18px;border-radius:20px;font:700 .85rem var(--mono,monospace);cursor:pointer}'
                + '#sync-join-no{background:#000;color:var(--text-color,#eee);border:1px solid var(--border-color,#333)}'
                + '#sync-join-combine{background:var(--accent-color,#00d97e);color:#000;border:0}';
            document.head.appendChild(style);
        }
        const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
        dialog = document.createElement('dialog');
        dialog.id = 'sync-join';
        dialog.setAttribute('aria-labelledby', 'sync-join-title');
        const title = document.createElement('h2');
        title.id = 'sync-join-title';
        title.textContent = 'Combine chats?';
        const text = document.createElement('p');
        text.id = 'sync-join-text';
        text.textContent = 'This browser has ' + plural(here, 'chat') + (here === 1 ? ' that isn\'t' : ' that aren\'t') + ' synced, and your account has '
            + plural(there, 'chat') + ' from your other devices. Combine puts all ' + (here + there)
            + ' on every device signed in with your account code. Nothing is deleted.';
        const row = document.createElement('div');
        row.className = 'row';
        const no = document.createElement('button');
        no.type = 'button';
        no.id = 'sync-join-no';
        no.textContent = 'Not on this device';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.id = 'sync-join-combine';
        yes.textContent = 'Combine';
        yes.autofocus = true;
        row.append(no, yes);
        dialog.append(title, text, row);
        document.body.appendChild(dialog);
        no.addEventListener('click', () => {
            localStorage.setItem(OFF, '1'); // here only: the synced copy stays
            closeAsk();
            changedHere();
        });
        yes.addEventListener('click', () => {
            agree(k);
            closeAsk();
            changedHere();
            tick();
        });
        dialog.addEventListener('cancel', (e) => e.preventDefault()); // Escape doesn't answer it
        dialog.showModal();
    }

    // Answered in another tab: close it here too.
    window.addEventListener('storage', (e) => {
        if (asking && (e.key === JOINED || e.key === OFF || e.key === null)) {
            closeAsk();
            changedHere();
            if (on()) soon(300);
        }
    });

    async function run() {
        if (!on() || stopped || Date.now() < backoffUntil) return;
        await chatStore.ready;
        await marking;
        if (!chatStore.usesIndexedDb()) return; // no room in localStorage for a second copy of images
        const k = await keys();
        if (!k) return;
        state = (await meta('state')) || {};
        if (state.owner !== k.owner) {
            state = { owner: k.owner, after: 0, epoch: null };
            await meta('state', state);
        }
        if (!(await mayJoin(k))) return;
        await adopt(k);
        if (!(await pull(k))) return;
        if (on() && !stopped) await push(k);
    }

    // One tab syncs at a time (the others see its changes through chat-store.js).
    function runOnce() {
        if (!navigator.locks) return run();
        return navigator.locks.request('obscurify-chat-sync', { ifAvailable: true }, (lock) => (lock ? run() : null));
    }

    let running = null;
    let again = false;
    let looked = false;      // this page has had a first round: what's here is what there is
    function tick() {
        if (running) { again = true; return running; }
        running = runOnce().catch((e) => {
            console.warn('chat sync:', e);
            backoffUntil = Date.now() + 30000;
        }).finally(() => {
            running = null;
            if (again) { again = false; soon(500); }
            if (!looked) {
                looked = true;
                if (typeof renderConversationsList === 'function') renderConversationsList();
            }
        });
        return running;
    }

    let soonTimer = null;
    function soon(ms) { clearTimeout(soonTimer); soonTimer = setTimeout(tick, ms); }

    async function mark(changed, deleted) {
        // Paused by the plan: changes are still marked, to be sent when it has sync again.
        if (!enabled()) {
            // Off: nothing to send, but a deleted chat's record (its title as last synced) goes.
            for (const id of deleted) await meta('conv:' + id, null);
            return;
        }
        const k = await keys();
        if (!k) return;
        for (const id of changed) {
            await metaUpdate('conv:' + id, (was) => {
                const m = was || {};
                if (m.owner && m.owner !== k.owner) return undefined; // another account's chat
                return Object.assign(m, { owner: k.owner, dirty: true, deleted: false, ver: (m.ver || 0) + 1 });
            });
        }
        for (const id of deleted) {
            await metaUpdate('conv:' + id, (m) => {
                if (!m) return undefined;
                if (m.owner !== k.owner || !m.rev) return null;
                return Object.assign(m, { dirty: true, deleted: true, ver: (m.ver || 0) + 1 });
            });
        }
    }
    // Saves are marked in order, and a round waits for the marks (run()).
    let marking = Promise.resolve();
    chatStore.onLocalChange((changed, deleted) => {
        for (const id of changed) unmarked.set(id, (unmarked.get(id) || 0) + 1);
        marking = marking.then(() => mark(changed, deleted)).catch((e) => console.warn('chat sync:', e)).then(() => {
            for (const id of changed) { const n = unmarked.get(id) - 1; if (n) unmarked.set(id, n); else unmarked.delete(id); }
        });
        soon(1500);
    });

    async function deleteRemote() {
        const k = await keys();
        if (!k) return true;
        try {
            const r = await call(k, 'DELETE', '');
            return r.ok || r.status === 404;
        } catch (_e) {
            return false;
        }
    }

    window.ChatSync = {
        on,
        available: () => !!seedHex(),
        isFull: () => full,
        // The account's chats may still be on their way (the sidebar then doesn't say there are none).
        arriving: () => on() && !looked,
        // Whether this device has joined the synced copy (turning it off then deletes it).
        async joined() {
            const k = await keys();
            return !!k && enabled() && isJoined(k);
        },
        planOff,
        // The switch. On here is agreeing to combine. Off deletes the synced copy (the other
        // devices then stop too) if this device joined it, or always with `everywhere`
        // (account deletion); a device that never joined only stops here.
        async setOn(v, opts) {
            const k = await keys();
            if (v) {
                localStorage.removeItem(OFF);
                if (k) agree(k);
                closeAsk();
                stopped = false;
                backoffUntil = 0;
                await tick();
                return true;
            }
            const wasJoined = !!k && enabled() && (await isJoined(k));
            localStorage.setItem(OFF, '1');
            closeAsk();
            if (running) await running;
            const ok = (wasJoined || (opts && opts.everywhere)) ? await deleteRemote() : true;
            localStorage.removeItem(JOINED);
            await clearMeta();
            return ok;
        },
        syncNow: () => tick(),
        // Wipe (chat-privacy.js): the synced copy goes too, or the chats would come straight back.
        async wipe() {
            const k = await keys();
            if (k && enabled() && (await isJoined(k))) await deleteRemote();
            closeAsk();
        },
        // A new account number (account page): the chats move to the new number's store.
        // The old number's copy is deleted even if this device never joined it: devices still on
        // the old number would otherwise keep syncing to it.
        async moveTo(newSeedHex) {
            const oldSeed = seedHex();
            const wasOn = enabled();
            if (running) await running;
            closeAsk();
            const fresh = await keysOf(newSeedHex);
            let wasJoined = false;
            if (wasOn && oldSeed) {
                const old = await keysOf(oldSeed);
                wasJoined = await isJoined(old);
                const all = await chatStore.metaAll('conv:');
                await call(old, 'DELETE', '').catch(() => null);
                await clearMeta();
                for (const [key, m] of Object.entries(all)) {
                    if (key.startsWith('conv:') && m && m.owner === old.owner && !m.deleted) {
                        await meta(key, Object.assign({ owner: fresh.owner, dirty: wasJoined, ver: 1 }, m.base ? { base: m.base } : {}));
                    }
                }
            }
            localStorage.setItem(SEED, newSeedHex);
            if (wasJoined) agree(fresh); else localStorage.removeItem(JOINED);
            if (wasOn) tick();
        },
        // Signing out: forget the key (chats stay in this browser, as before).
        forget() { localStorage.removeItem(SEED); localStorage.removeItem(JOINED); closeAsk(); },
    };

    // Start once the page's chats are loaded; then every 30 s while the tab is visible and right
    // after anything changes here.
    chatStore.ready.then(() => setTimeout(tick, 300));
    setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
})();
