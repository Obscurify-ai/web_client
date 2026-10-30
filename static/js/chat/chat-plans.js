// Plans in the chat: the sidebar shows the account's plan, and "Upgrade" (or the plan
// itself) opens a picker that changes it with /change_tier, paid from the balance, as the
// Account page does. A model the plan doesn't include points here too.
'use strict';
(function () {
    const modal = document.getElementById('plans-modal');
    if (!modal || !isLoggedIn) return;
    const list = document.getElementById('plans-list');
    const message = document.getElementById('plans-message');
    const balanceEl = document.getElementById('plans-balance');
    const RANK = { pay_as_you_go: 0, casual: 1, pro: 2 };
    const NAME = { pay_as_you_go: 'Pay as you go', casual: 'Casual', pro: 'Pro' };
    const usd = (n) => '$' + Number(n || 0).toFixed(2);
    let current = (document.getElementById('plan-status') || {}).dataset?.plan || 'pay_as_you_go';
    let balance = 0;

    function what(t) {
        if (t.tier === 'pro') return `Frontier and uncensored models, API access, ${usd(t.included_credit)} of usage included each month`;
        if (t.tier === 'casual') return `Frontier models, ${usd(t.included_credit)} of usage included each month`;
        return 'No monthly fee: pay only for what you use';
    }

    function say(text, isError, link) {
        message.replaceChildren(document.createTextNode(text));
        if (link) {
            const a = document.createElement('a');
            a.href = link.href;
            a.textContent = link.text;
            message.append(' ', a);
        }
        message.classList.toggle('error', !!isError);
        message.hidden = false;
    }

    function render(tiers) {
        list.replaceChildren();
        tiers.forEach((t) => {
            const card = document.createElement('div');
            card.className = 'plan-card' + (t.tier === current ? ' current' : '');
            card.dataset.tier = t.tier;
            const head = document.createElement('div');
            head.className = 'plan-head';
            head.innerHTML = '<span class="plan-name"></span><span class="plan-price"></span>';
            head.querySelector('.plan-name').textContent = NAME[t.tier] || t.tier;
            head.querySelector('.plan-price').textContent = t.monthly_fee > 0 ? usd(t.monthly_fee) + '/mo' : 'Free';
            const desc = document.createElement('p');
            desc.className = 'plan-desc';
            desc.textContent = what(t);
            card.append(head, desc);
            if (t.tier === current) {
                const badge = document.createElement('span');
                badge.className = 'plan-current';
                badge.textContent = 'Your plan';
                card.append(badge);
            } else {
                const up = (RANK[t.tier] || 0) > (RANK[current] || 0);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sidebar-btn ' + (up ? 'sidebar-btn-primary' : 'sidebar-btn-secondary');
                btn.textContent = up ? 'Upgrade to ' + NAME[t.tier] : 'Switch to ' + NAME[t.tier];
                btn.addEventListener('click', () => confirm(t, up, card));
                card.append(btn);
            }
            list.append(card);
        });
    }

    function confirm(t, up, card) {
        list.querySelectorAll('.plan-confirm').forEach((el) => el.remove());
        message.hidden = true;
        const box = document.createElement('div');
        box.className = 'plan-confirm';
        const p = document.createElement('p');
        if (up && balance < t.monthly_fee) {
            p.append(`${NAME[t.tier]} costs ${usd(t.monthly_fee)} a month and your balance is ${usd(balance)}. `);
            const a = document.createElement('a');
            a.href = '/account#voucherSection';
            a.textContent = 'Add funds';
            p.append(a, ' first.');
            box.append(p);
            card.append(box);
            return;
        }
        p.textContent = up
            ? `Pay ${usd(t.monthly_fee)} from your balance (${usd(balance)}) for ${NAME[t.tier]}? It renews monthly while your balance covers it.`
            : `Switch to ${NAME[t.tier]}? Your current plan ends now.`;
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'sidebar-btn sidebar-btn-primary';
        go.textContent = up ? 'Pay ' + usd(t.monthly_fee) : 'Switch';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'sidebar-btn sidebar-btn-secondary';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => box.remove());
        go.addEventListener('click', () => change(t, go));
        const row = document.createElement('div');
        row.className = 'plan-confirm-actions';
        row.append(cancel, go);
        box.append(p, row);
        card.append(box);
    }

    async function change(t, btn) {
        btn.disabled = true;
        btn.textContent = 'Changing…';
        try {
            const r = await fetch('/change_tier', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tier: t.tier, payment_method: 'balance' }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.error) {
                const err = typeof data.error === 'string' ? data.error : (data.error && data.error.message) || data.message || 'The plan could not be changed.';
                say(err, true, /balance/i.test(err) ? { href: '/account#voucherSection', text: 'Add funds' } : null);
                btn.disabled = false;
                btn.textContent = 'Try again';
                return;
            }
            say(`You're on ${NAME[t.tier]} now.`);
            // The page knows which models the plan unlocks: load it again.
            setTimeout(() => location.reload(), 1200);
        } catch (_) {
            say('Could not reach Obscurify. Check your connection.', true);
            btn.disabled = false;
            btn.textContent = 'Try again';
        }
    }

    async function open() {
        message.hidden = true;
        modal.classList.add('open');
        if (typeof closeSidebar === 'function' && window.innerWidth < 900) closeSidebar();
        try {
            const [tiers, tier, bal] = await Promise.all([
                fetch('/available_tiers').then((r) => r.json()),
                fetch('/account_tier').then((r) => r.json()),
                fetch('/get_user_balance').then((r) => r.json()),
            ]);
            if (tier && tier.tier) current = tier.tier;
            balance = Number((bal && bal.balance) || 0);
            balanceEl.textContent = 'Balance: ' + usd(balance);
            render((tiers && tiers.tiers) || []);
        } catch (_) {
            list.replaceChildren();
            say('Could not load the plans. Check your connection.', true);
        }
    }

    function close() { modal.classList.remove('open'); }

    window.openPlans = open;
    document.getElementById('plans-modal-close').addEventListener('click', close);
    modal.querySelector('.modal-overlay').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('#upgrade-btn, #plan-status, .open-plans');
        if (!trigger) return;
        e.preventDefault();
        open();
    });
})();
