/*
 * Affiliate dashboard. Data comes from /affiliate/api/summary (monthly totals
 * only). Credit payouts are blind vouchers: this browser blinds random voucher
 * messages, the server signs them without seeing them, and this browser
 * unblinds them into codes the affiliate can redeem in any account.
 */
(function () {
    'use strict';
    var V = window.ObscurifyVoucher;
    var PENDING_KEY = 'obscurify_affiliate_credit_pending';
    var CODES_KEY = 'obscurify_affiliate_credit_codes';
    var DENOMS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
    var data = null;
    var selectedRail = null;

    function el(id) { return document.getElementById(id); }
    function text(id, value) { var e = el(id); if (e) e.textContent = value; }
    function money(v) { return '$' + Number(v).toFixed(2); }
    function api(method, url, body) {
        return fetch(url, {
            method: method, credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined
        }).then(function (r) {
            if (r.status === 401) { location.href = '/affiliates#signin'; throw new Error('signed out'); }
            return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || ('Request failed (' + r.status + ')'));
                return d;
            });
        });
    }
    function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
    function save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

    function selectRail(rail) {
        selectedRail = rail;
        document.querySelectorAll('#railTabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-rail') === rail); });
        document.querySelectorAll('.rail').forEach(function (p) { p.style.display = p.getAttribute('data-panel') === rail ? '' : 'none'; });
        text('railMsg', '');
    }

    function render() {
        var d = data;
        text('code', d.code);
        document.querySelectorAll('.codeText').forEach(function (e) { e.textContent = d.code; });
        text('status', d.status === 'active' ? 'Active' : 'Paused');
        text('link', d.link);
        text('shortLink', d.short_link);
        var pct = function (r) { return (Number(r) * 100).toFixed(0) + '%'; };
        text('rates', pct(d.rates.plan) + ' of plans, ' + pct(d.rates.usage) + ' of usage, +' + pct(d.rates.credit_bonus) + ' as credit; held ' + d.hold_days + ' days after month end');
        text('bonusPct', (Number(d.rates.credit_bonus) * 100).toFixed(0));
        document.querySelectorAll('.bonus').forEach(function (e) { e.textContent = (Number(d.rates.credit_bonus) * 100).toFixed(0); });
        text('held', money(d.balances.held));
        text('nextRelease', d.balances.next_release ? 'next release ' + d.balances.next_release : '');
        text('available', money(d.balances.available));
        text('paidOut', money(d.balances.paid_out));
        text('creditAvail', money(d.balances.credit_available_cents / 100));
        text('minCredit', d.minimums.credit); text('minLightning', d.minimums.lightning);
        text('minStripe', d.minimums.stripe); text('minMonero', d.minimums.monero);
        el('pausedNotice').style.display = d.payouts_enabled ? 'none' : '';
        var railNames = { credit: 'Obscurify credit', lightning: 'Lightning', stripe: 'Bank (Stripe)', monero: 'Monero (manual)' };
        text('currentRail', 'Current payout method: ' + railNames[d.payout.rail] + '.');
        if (d.payout.lightning_address) el('lnAddress').value = d.payout.lightning_address;
        if (d.payout.monero_address) el('xmrAddress').value = d.payout.monero_address;
        if (d.email) el('email').value = d.email;
        var sel = el('stripeCountry');
        if (!sel.options.length) {
            d.payout.stripe_countries.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
        }
        if (d.country) sel.value = d.country;
        sel.disabled = d.payout.stripe_connected;
        el('stripeConnect').textContent = d.payout.stripe_payouts_enabled ? 'Update bank details' : (d.payout.stripe_connected ? 'Finish Stripe setup' : 'Connect with Stripe');
        el('stripeDashboard').style.display = d.payout.stripe_payouts_enabled ? '' : 'none';
        text('stripeState', !d.payout.stripe_available ? 'Bank payouts are not available yet.' :
            d.payout.stripe_payouts_enabled ? 'Your bank is connected.' + (d.payout.rail === 'stripe' ? '' : ' Choose "Use bank payouts" below to switch.') :
            d.payout.stripe_connected ? 'Stripe still needs some details from you.' : '');
        if (d.payout.stripe_payouts_enabled && d.payout.rail !== 'stripe' && !el('useStripe')) {
            var b = document.createElement('button'); b.id = 'useStripe'; b.textContent = 'Use bank payouts';
            b.addEventListener('click', function () { setRail({ rail: 'stripe' }); });
            el('stripeConnect').parentNode.appendChild(b);
        }
        el('creditAmount').max = (d.balances.credit_available_cents / 100).toFixed(2);
        el('creditAmount').placeholder = 'up to ' + money(d.balances.credit_available_cents / 100);

        var months = el('months');
        if (d.months.length) {
            months.innerHTML = '';
            d.months.forEach(function (m) {
                var tr = document.createElement('tr');
                [m.month, m.clicks, m.signups, m.paying_accounts, money(m.paid_spend), money(m.commission)].forEach(function (v) {
                    var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
                });
                months.appendChild(tr);
            });
        }
        var payouts = el('payouts');
        if (d.payouts.length) {
            payouts.innerHTML = '';
            d.payouts.forEach(function (p) {
                var tr = document.createElement('tr');
                var amount = money(p.amount_usd) + (Number(p.bonus_usd) > 0 ? ' + ' + money(p.bonus_usd) + ' bonus' : '');
                var status = p.rail === 'monero' && p.status === 'pending' ? 'owed (sending by hand)' : p.status;
                [p.date, railNames[p.rail] || p.rail, amount, status, p.reference || ''].forEach(function (v) {
                    var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
                });
                payouts.appendChild(tr);
            });
        }
        if (selectedRail === null) selectRail(d.payout.rail);
    }

    function refresh() { return api('GET', '/affiliate/api/summary').then(function (d) { data = d; render(); }); }

    function setRail(body) {
        text('railMsg', 'Saving…');
        return api('POST', '/affiliate/payout-method', body).then(function () {
            return refresh().then(function () { el('railMsg').className = 'ok'; text('railMsg', 'Saved.'); });
        }).catch(function (e) { el('railMsg').className = 'err'; text('railMsg', e.message); });
    }

    // ---- credit vouchers -------------------------------------------------
    function showCodes() {
        var codes = load(CODES_KEY, []);
        el('voucherBox').style.display = codes.length ? '' : 'none';
        el('voucherCodes').value = codes.join('\n');
    }

    function split(cents) {
        var out = [];
        DENOMS.forEach(function (d) { while (cents >= d) { out.push(d); cents -= d; } });
        return out;
    }

    // Sign a saved pending batch (also used to finish one interrupted by a reload).
    function signPending() {
        var pending = load(PENDING_KEY, null);
        if (!pending) return Promise.resolve();
        text('creditMsg', 'Signing vouchers…');
        return api('POST', '/affiliate/vouchers/sign', {
            vouchers: pending.map(function (p) { return { denomination_cents: p.cents, key_id: p.keyId, blinded_message: p.blinded }; })
        }).then(function (res) {
            var codes = load(CODES_KEY, []);
            pending.forEach(function (p, i) {
                var sig = V.finalize(p.key, p.secret, res.blind_signatures[i]);
                codes.push(V.voucherCode(p.cents, p.keyId, p.secret, sig));
            });
            save(CODES_KEY, codes);
            localStorage.removeItem(PENDING_KEY);
            text('creditMsg', '');
            showCodes();
            return refresh();
        }).catch(function (e) {
            // Rejected batches can't succeed later; anything else can be retried.
            if (!/network|failed to fetch/i.test(e.message)) localStorage.removeItem(PENDING_KEY);
            el('creditMsg').className = 'err'; text('creditMsg', e.message);
        });
    }

    function takeCredit() {
        var cents = Math.round(parseFloat(el('creditAmount').value) * 100);
        if (!(cents > 0)) { text('creditMsg', 'Enter an amount.'); return; }
        if (cents > data.balances.credit_available_cents) { text('creditMsg', 'You can take up to ' + money(data.balances.credit_available_cents / 100) + '.'); return; }
        el('takeCredit').disabled = true;
        el('creditMsg').className = 'muted'; text('creditMsg', 'Preparing vouchers…');
        api('GET', '/affiliate/api/voucher-keys').then(function (k) {
            var keys = {};
            k.keys.forEach(function (key) { keys[key.denomination_cents] = key; });
            var parts = split(cents);
            if (parts.length > 64) throw new Error('That amount needs too many vouchers; take less at a time.');
            return Promise.all(parts.map(function (c) {
                var key = { n: keys[c].n, e: keys[c].e };
                return V.blind(key).then(function (b) { return { cents: c, keyId: keys[c].key_id, key: key, blinded: b.blindedMessage, secret: b.secret }; });
            }));
        }).then(function (batch) {
            save(PENDING_KEY, batch);
            return signPending();
        }).catch(function (e) { el('creditMsg').className = 'err'; text('creditMsg', e.message); })
        .then(function () { el('takeCredit').disabled = false; });
    }

    document.addEventListener('DOMContentLoaded', function () {
        var params = new URLSearchParams(location.search);
        if (params.get('stripe')) {
            el('stripeNotice').style.display = '';
            el('stripeNotice').textContent = params.get('stripe') === 'connected'
                ? 'Your bank is connected through Stripe. Bank payouts are now your payout method.'
                : 'Stripe still needs a few details before it can pay you. Use "Finish Stripe setup" to continue.';
            history.replaceState(null, '', '/affiliate');
        }
        document.querySelectorAll('[data-copy]').forEach(function (b) {
            b.addEventListener('click', function () {
                navigator.clipboard.writeText(el(b.getAttribute('data-copy')).textContent).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); });
            });
        });
        document.querySelectorAll('#railTabs button').forEach(function (b) {
            b.addEventListener('click', function () {
                var rail = b.getAttribute('data-rail');
                selectRail(rail);
                if (rail === 'credit' && data.payout.rail !== 'credit') setRail({ rail: 'credit' });
            });
        });
        el('saveLightning').addEventListener('click', function () { setRail({ rail: 'lightning', lightning_address: el('lnAddress').value }); });
        el('saveMonero').addEventListener('click', function () { setRail({ rail: 'monero', monero_address: el('xmrAddress').value }); });
        el('stripeConnect').addEventListener('click', function () {
            text('stripeState', 'Opening Stripe…');
            api('POST', '/affiliate/stripe/onboard', { country: el('stripeCountry').value }).then(function (r) { location.href = r.url; })
                .catch(function (e) { el('stripeState').className = 'err'; text('stripeState', e.message); });
        });
        el('stripeDashboard').addEventListener('click', function () {
            api('POST', '/affiliate/stripe/dashboard').then(function (r) { location.href = r.url; })
                .catch(function (e) { text('stripeState', e.message); });
        });
        el('takeCredit').addEventListener('click', takeCredit);
        el('copyVouchers').addEventListener('click', function () { navigator.clipboard.writeText(el('voucherCodes').value); this.textContent = 'Copied'; });
        el('clearVouchers').addEventListener('click', function () {
            if (confirm('Remove the vouchers from this browser? Make sure you saved them.')) { localStorage.removeItem(CODES_KEY); showCodes(); }
        });
        el('saveEmail').addEventListener('click', function () {
            api('POST', '/affiliate/email', { email: el('email').value || null }).then(function () { el('saveEmail').textContent = 'Saved'; })
                .catch(function (e) { alert(e.message); });
        });
        el('rotateNumber').addEventListener('click', function () {
            if (!confirm('Get a new affiliate number? The old one stops working and other browsers are signed out.')) return;
            api('POST', '/affiliate/rotate-number').then(function (r) {
                el('newNumber').innerHTML = '<p>Your new affiliate number (save it now):</p>';
                var n = document.createElement('div'); n.className = 'number'; n.textContent = r.affiliate_number; el('newNumber').appendChild(n);
            }).catch(function (e) { alert(e.message); });
        });
        el('logoutBtn').addEventListener('click', function () {
            api('POST', '/affiliates/logout').then(function () { location.href = '/affiliates'; });
        });
        showCodes();
        refresh().then(signPending).catch(function () {});
    });
})();
