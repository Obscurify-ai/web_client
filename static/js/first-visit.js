/*
 * Remember where this browser first arrived from, so that if it signs up the
 * sign-up can be counted under that source (a daily total, never stored with
 * the account). Kept only in this browser, for 30 days, and only ever sent by
 * the sign-up page.
 *
 * Source: a link tag (?utm_source= or ?ref=) if present, else the referring
 * site's host, else "direct".
 *
 * Affiliate links (?aff=CODE on any page) are remembered the same way, in
 * this browser's storage only (no cookie), for 30 days; the most recent
 * affiliate link wins. The sign-up page sends the code with the new account
 * and shows it to the visitor, who can remove it.
 *
 * Ad angles: an ad link carries ?utm_source=<channel>&utm_campaign=<angle>.
 * The tag is kept in this browser's storage (no cookie) for 30 days, and
 * ObscurifyFunnel.step() posts it once per step (landed, chat, signup,
 * deposit) so the server can add one to that day's count for the angle
 * (src/web/funnel.rs). The most recent ad wins.
 *
 * Organic visits (no ad tag, referred by a search engine or an AI assistant) are
 * counted the same way under organic/<engine>, e.g. organic/google. Only the
 * engine's name is kept, never the referring URL or the search words, and an
 * organic visit never replaces an ad tag this browser already has.
 */
(function () {
    var KEY = 'obscurify_first_source';
    var AFF_KEY = 'obscurify_aff';
    var ANGLE_KEY = 'obscurify_angle';
    var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    var params;
    try {
        params = new URLSearchParams(location.search);
    } catch (e) {
        return;
    }

    function readAngle() {
        try {
            var a = JSON.parse(localStorage.getItem(ANGLE_KEY) || 'null');
            return a && a.a && Date.now() - a.t < MAX_AGE_MS ? a : null;
        } catch (e) {
            return null;
        }
    }

    function send(a, name, cents) {
        var body = JSON.stringify({ angle: a.a, step: name, cents: cents || 0 });
        try {
            fetch('/funnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'omit' });
        } catch (e) {}
    }

    window.ObscurifyFunnel = {
        // Count `name` for this browser's ad angle. Every step is sent once, except
        // deposits (each one, with its amount). The first deposit or plan also sends
        // `customer` once: that count is the paying customers an angle brought.
        step: function (name, cents) {
            var a = readAngle();
            if (!a || (a.done && a.done[name])) return;
            a.done = a.done || {};
            if (name !== 'deposit') a.done[name] = 1;
            if (name === 'signup') { a.since = Date.now(); a.counted = 0; }
            var firstPayment = (name === 'deposit' || name === 'subscribe') && !a.done.customer;
            if (firstPayment) a.done.customer = 1;
            try { localStorage.setItem(ANGLE_KEY, JSON.stringify(a)); } catch (e) { return; }
            send(a, name, cents);
            if (firstPayment) send(a, 'customer', cents);
        },
        // The account page passes its top-ups (GET /top_ups) on every load. Credit that
        // arrived since this browser's ad sign-up and wasn't counted yet is a deposit, so
        // a card payment that comes back as a fresh page still counts.
        topUps: function (list) {
            var a = readAngle();
            // Sign-ups from before `since` was kept: count from the ad landing instead.
            var since = a && (a.since || (a.done && a.done.signup ? a.t : 0));
            if (!since || !list) return;
            var total = 0;
            list.forEach(function (t) {
                if (Date.parse(t.created_at) >= since - 60000) total += t.credited_cents || 0;
            });
            var fresh = total - (a.counted || 0);
            if (fresh <= 0) return;
            a.counted = total;
            try { localStorage.setItem(ANGLE_KEY, JSON.stringify(a)); } catch (e) { return; }
            this.step('deposit', fresh);
        },
        // A plan change answered by POST /change_tier.
        plan: function (tier, charged) {
            if (tier !== 'casual' && tier !== 'pro') return;
            this.step('subscribe', Math.round(Number(charged || 0) * 100));
        }
    };

    try {
        var channel = (params.get('utm_source') || '').trim().toLowerCase();
        var campaign = (params.get('utm_campaign') || '').trim().toLowerCase();
        var tagged = channel + '/' + campaign;
        if (channel && campaign && /^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(tagged) && tagged.length <= 80) {
            var current = readAngle();
            if (!current || current.a !== tagged) {
                localStorage.setItem(ANGLE_KEY, JSON.stringify({ a: tagged, t: Date.now(), done: {} }));
            }
            window.ObscurifyFunnel.step('landed');
        }
    } catch (e) {
        // Storage blocked: this visit just isn't counted.
    }

    // Organic: a visit with no ad tag that came from a search engine or an AI assistant
    // is counted the same way, as organic/<engine>. Only the engine's name is kept (never
    // the referring URL or the search words), and it never replaces an ad visit.
    try {
        var ref = document.referrer && !params.get('utm_source') && !params.get('gclid')
            ? new URL(document.referrer).hostname.toLowerCase() : '';
        var engine = ref && ref !== location.hostname ? organicEngine(ref) : '';
        if (engine && !readAngle()) {
            localStorage.setItem(ANGLE_KEY, JSON.stringify({ a: 'organic/' + engine, t: Date.now(), done: {} }));
            window.ObscurifyFunnel.step('landed');
        }
    } catch (e) {
        // Storage blocked or a bad referrer: this visit just isn't counted.
    }

    function organicEngine(host) {
        var is = function (d) { return host === d || host.slice(-d.length - 1) === '.' + d; };
        if (is('chatgpt.com') || is('chat.openai.com')) return 'chatgpt';
        if (is('perplexity.ai')) return 'perplexity';
        if (is('gemini.google.com')) return 'gemini';
        if (is('copilot.microsoft.com')) return 'copilot';
        if (is('claude.ai')) return 'claude';
        if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google';
        if (is('bing.com')) return 'bing';
        if (is('duckduckgo.com')) return 'duckduckgo';
        if (is('search.brave.com')) return 'brave';
        if (is('yahoo.com')) return 'yahoo';
        if (/(^|\.)yandex\.[a-z.]+$/.test(host)) return 'yandex';
        if (is('ecosia.org')) return 'ecosia';
        if (is('startpage.com')) return 'startpage';
        if (is('kagi.com')) return 'kagi';
        if (is('qwant.com')) return 'qwant';
        return '';
    }

    try {
        var aff = (params.get('aff') || '').trim().toLowerCase();
        if (aff && aff.length <= 100 && /^[a-z0-9-]+$/.test(aff)) {
            localStorage.setItem(AFF_KEY, JSON.stringify({ c: aff, t: Date.now() }));
        }
    } catch (e) {
        // Storage blocked: the code still works on a direct /signup?aff= link.
    }

    try {
        var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (saved && Date.now() - saved.t < MAX_AGE_MS) return;

        var tag = params.get('utm_source') || params.get('ref');
        var source = 'direct';
        if (tag) {
            source = 'tag:' + tag.slice(0, 60);
        } else if (document.referrer) {
            var host = new URL(document.referrer).hostname;
            if (host && host !== location.hostname) source = 'site:' + host;
        }
        localStorage.setItem(KEY, JSON.stringify({ s: source, t: Date.now() }));
    } catch (e) {
        // Storage blocked or a bad referrer: just don't count this one.
    }
})();
