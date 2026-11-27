// chat-meter.js: the usage meter in the chat sidebar, for plans with weekly or 5-hour limits
// ("This week: 14% · Resets Mon", a bar, no dollars) and for a Pay As You Go with terms of its
// own (the balance). Read from /account_tier on load,
// when the sidebar opens and when the page comes back into view. Not after a reply: a request tied to
// the account at the moment a private chat ends would say when the account chatted.
(function () {
    const box = document.getElementById('usage-meter');
    if (!box) return;
    const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
    const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    function bar(label, w, reset) {
        const pct = w.limit > 0 ? Math.min(100, Math.round(100 * w.used / w.limit)) : 0;
        const row = document.createElement('span');
        row.className = 'usage-meter-row';
        const text = document.createElement('span');
        text.className = 'usage-meter-text';
        text.textContent = `${label}: ${pct}%` + (reset ? ` · ${reset}` : '');
        const track = document.createElement('span');
        track.className = 'usage-meter-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', label);
        track.setAttribute('aria-valuenow', pct);
        track.setAttribute('aria-valuemin', 0);
        track.setAttribute('aria-valuemax', 100);
        const fill = document.createElement('span');
        fill.className = 'usage-meter-fill' + (pct >= 100 ? ' full' : '');
        fill.style.width = pct + '%';
        track.append(fill);
        row.append(text, track);
        return row;
    }

    async function refresh() {
        try {
            const [t, b] = await Promise.all([
                fetch('/account_tier').then((r) => (r.ok ? r.json() : null)),
                fetch('/get_user_balance').then((r) => (r.ok ? r.json() : null)).catch(() => null),
            ]);
            if (typeof updateLowBalanceBanner === 'function' && b) {
                updateLowBalanceBanner(b.low_balance ? b.spendable_balance : null);
            }
            if (!t) return;
            const rows = [];
            if (t.usage_week) rows.push(bar('This week', t.usage_week, t.usage_week.frees_at ? 'Resets ' + day(t.usage_week.frees_at) : ''));
            // The 5 hours matter day to day on the top plan (for agents); on others, only once they're used up.
            const w = t.usage_5h;
            if (w && (t.tier === 'pro' || w.used >= w.limit)) rows.push(bar('5 hours', w, w.frees_at ? 'Resets ' + time(w.frees_at) : ''));
            if (!rows.length && t.tier === 'pay_as_you_go') {
                if (!b) return;
                const text = document.createElement('span');
                text.className = 'usage-meter-text';
                text.textContent = 'Balance: $' + Number(b.balance || 0).toFixed(2);
                rows.push(text);
            }
            box.replaceChildren(...rows);
            box.hidden = !rows.length;
        } catch (_) { /* the meter just stays as it was */ }
    }

    refresh();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    const side = box.closest('aside');
    if (side) new MutationObserver(() => { if (side.classList.contains('open')) refresh(); }).observe(side, { attributes: true, attributeFilter: ['class'] });
    window.refreshUsageMeter = refresh;
})();
