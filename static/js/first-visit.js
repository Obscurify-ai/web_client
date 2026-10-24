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
 */
(function () {
    var KEY = 'obscurify_first_source';
    var AFF_KEY = 'obscurify_aff';
    var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    var params;
    try {
        params = new URLSearchParams(location.search);
    } catch (e) {
        return;
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
