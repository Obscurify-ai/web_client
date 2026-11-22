/**
 * Account page: add credit.
 *
 * By default a payment is a top-up: POST /top_ups ties it to this account and
 * the server puts every confirmed payment on the balance by itself, so the
 * page can be closed and any device shows it (GET /top_ups).
 *
 * Buying a plan is the same top-up with `plan` and `billing`: the server
 * prices it and switches the plan on once the payment is in full.
 *
 * "Blind voucher" is the opt-in where we can't tell which account paid. Its
 * credit only exists in this browser until it is added, so the page has to
 * stay open, and the user is told so plainly:
 *
 * 1. Pay: start an order by card or Lightning (any amount you type) or get a
 *    BTC/XMR address that takes any amount, any number of times. The order
 *    request never sends the session cookie (credentials: 'omit'), so it is
 *    not tied to the signed-in account.
 * 2. Collect: when the order shows money received, this browser blinds
 *    vouchers adding up to it (1¢ to $5,000 in 1-2-5 steps), has the server
 *    sign them, and unblinds them. The batch is saved before it is sent, so a
 *    lost response is retried with the same vouchers and never lost.
 * 3. Spend: each voucher waits a random 5 to 60 minutes, separately, before it
 *    goes on the balance, so neither the time nor the total lines up with the
 *    payment. Users can skip the wait.
 *
 * Depends on blind-voucher.js (ObscurifyVoucher), qrcode.min.js, and the
 * account page's authFetch / fetchAccountBalance.
 */
(function () {
    'use strict';

    var ORDERS_KEY = 'obscurify_voucher_orders';
    var VOUCHERS_KEY = 'obscurify_vouchers';
    var BATCHES_KEY = 'obscurify_voucher_batches';
    var MIN_DELAY_MS = 5 * 60 * 1000;
    var MAX_DELAY_MS = 60 * 60 * 1000;
    var POLL_MS = 10 * 1000;
    // After the first few minutes, check each order at most once a minute.
    var FAST_POLL_FOR_MS = 10 * 60 * 1000;
    var SLOW_POLL_MS = 60 * 1000;
    // Stop checking on our own after this; the user can still press "Check Again".
    // A card payment finishes on this page, so a card order still unpaid after
    // half an hour was abandoned. A crypto address keeps taking payments, and
    // BTCPay keeps watching it for a day.
    var CARD_ORDER_TTL_MS = 30 * 60 * 1000;
    var CRYPTO_ORDER_TTL_MS = 24 * 60 * 60 * 1000;
    var MAX_PER_SIGN = 64;
    var MAX_PER_REDEEM = 20;

    var TOP_UP_POLL_MS = 15 * 1000;
    var BLIND_CONFIRM = 'Blind voucher: keep this page open until the credit is on your balance, ' +
        'about 20 minutes for the payment to confirm and then up to an hour. ' +
        'If you close the tab or the browser before then, the money is lost and we cannot get it back.\n\nContinue?';

    var state = {
        blind: false,
        topUps: [],
        topUpsLoaded: false,
        creditedSeen: null,
        topUpTimer: null,
        cardIsTopUp: false,
        method: 'card',
        crypto: 'XMR',
        network: null,
        keys: null,
        stripe: null,
        stripeKey: null,
        elements: null,
        cardOrderId: null,
        plan: null,
        billing: 'monthly',
        // Came from "Upgrade": the payment for the plan starts at once, and changing
        // method, coin or term starts it again with the new choice.
        autoPay: false,
        // Counts payments asked for: only the latest one's reply is shown.
        paySeq: 0,
        // Plan payments opened on this page, so going back to a choice reuses its payment.
        planOrders: {},
        appliedSeen: null,
        pollTimer: null,
        collecting: {},
    };

    function el(id) { return document.getElementById(id); }

    function load(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
    }

    function save(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function dollars(cents) {
        return '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
    }

    // "0.016347006343" -> "0.016347006343"; "0.00006075000" -> "0.00006075"
    function trimAmount(text) {
        return String(text).indexOf('.') === -1 ? String(text) : String(text).replace(/0+$/, '').replace(/\.$/, '');
    }

    function setStatus(message, isError) {
        var box = el('voucherStatus');
        if (!box) return;
        box.textContent = message || '';
        box.style.color = isError ? '#f87171' : 'var(--text-muted, #aaa)';
    }

    // Order calls go out without cookies so they carry no account.
    function anonFetch(url, options) {
        options = options || {};
        options.credentials = 'omit';
        return fetch(url, options).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (!response.ok) {
                    var err = new Error(data.error || ('Request failed (' + response.status + ')'));
                    err.status = response.status;
                    throw err;
                }
                return data;
            });
        });
    }

    function getKeys() {
        if (state.keys) return Promise.resolve(state.keys);
        return anonFetch('/vouchers/keys').then(function (data) {
            state.keys = data.keys.slice().sort(function (a, b) { return b.denomination_cents - a.denomination_cents; });
            return state.keys;
        });
    }

    // Largest values first; the 1-2-5 series makes this exact.
    function split(cents, keys) {
        var parts = [];
        keys.forEach(function (key) {
            while (cents >= key.denomination_cents) {
                parts.push(key);
                cents -= key.denomination_cents;
            }
        });
        return parts;
    }

    function chunks(list, size) {
        var out = [];
        for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
        return out;
    }

    // ---------- Choosing what to buy: credit or a plan ----------

    var PLAN_TERMS = { monthly: 'a month', annual: '12 months' };

    function planPill(plan) {
        return document.querySelector('#voucherPurpose .pill[data-plan="' + (plan || '') + '"]');
    }

    // Choose credit (plan null) or a plan and how long to prepay it.
    function selectPlan(plan, billing) {
        state.plan = plan || null;
        if (billing) state.billing = billing;
        document.querySelectorAll('#voucherPurpose .pill').forEach(function (pill) {
            var on = (pill.getAttribute('data-plan') || null) === state.plan;
            pill.classList.toggle('active', on);
            pill.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        document.querySelectorAll('#voucherPlanTerm .pill').forEach(function (pill) {
            var on = pill.getAttribute('data-billing') === state.billing;
            pill.classList.toggle('active', on);
            pill.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        var buying = !!state.plan;
        el('voucherPlanTerm').hidden = !buying;
        el('voucherAmountBlock').hidden = buying;
        // A plan belongs to this account, so it can't be paid blind.
        if (buying) selectBlind(false);
        // .blind-toggle is display: flex, which outranks [hidden]
        el('voucherBlindLabel').style.display = buying ? 'none' : '';
        var summary = el('voucherPlanSummary');
        summary.hidden = !buying;
        if (buying) {
            var pill = planPill(state.plan);
            var cents = parseInt(pill.getAttribute(
                state.billing === 'annual' ? 'data-year' : 'data-month'), 10);
            var onPaidPlan = typeof currentTier !== 'undefined' && currentTier && currentTier !== 'pay_as_you_go';
            summary.textContent = pill.getAttribute('data-name') + ' for ' + PLAN_TERMS[state.billing] + ': ' +
                (onPaidPlan ? 'up to ' : '') + dollars(cents) +
                (onPaidPlan ? ', less what your plan has already paid this month. ' : '. ') +
                'It switches on as soon as the payment confirms. Anything already on your balance stays there.';
        }
        // Paying for a plan from "Upgrade" starts with each tap: no Continue button.
        el('buyVoucherBtn').style.display = state.autoPay && buying ? 'none' : '';
        syncAmountField();
    }

    // "Upgrade" with too little on the balance: go straight to paying for the plan,
    // by crypto (XMR unless another coin is named) or card, at the plan's price.
    function payForPlan(plan, billing, pay) {
        state.autoPay = true;
        selectPlan(plan, billing);
        var coin = document.querySelector('#voucherCryptoPills .pill[data-currency="' + pay + '"]') ? pay : 'XMR';
        if (pay === 'card') selectMethod('card');
        else {
            selectMethod('crypto');
            selectCrypto(coin);
        }
        buy();
    }

    // A plan payment already on screen follows the new choice at once.
    function payAgain() {
        if (state.autoPay && state.plan) buy();
    }

    // ---------- Choosing amount and method ----------

    function amountRequired() {
        return state.method === 'card' || state.crypto === 'Lightning';
    }

    function readAmountCents() {
        var raw = (el('voucherAmountInput').value || '').trim();
        if (!raw) return null;
        var value = Math.round(parseFloat(raw) * 100);
        return isFinite(value) ? value : NaN;
    }

    function syncAmountField() {
        var input = el('voucherAmountInput');
        input.placeholder = amountRequired() ? 'Amount' : 'Any amount';
        el('voucherAmountHint').textContent = amountRequired()
            ? ''
            : 'Optional: leave it empty to send any amount.';
        el('buyVoucherBtn').textContent = state.plan
            ? 'Continue to Payment'
            : state.blind ? 'Continue to Blind Payment' : 'Continue to Payment';
    }

    function selectMethod(method) {
        state.method = method;
        el('voucherMethodCard').classList.toggle('active', method === 'card');
        el('voucherMethodCrypto').classList.toggle('active', method === 'crypto');
        el('voucherCryptoPills').style.display = method === 'crypto' ? 'flex' : 'none';
        if (el('voucherNetworkPills')) el('voucherNetworkPills').hidden = !(method === 'crypto' && isEvm(state.crypto));
        syncAmountField();
    }

    function selectBlind(on) {
        state.blind = !!on;
        el('voucherBlindToggle').checked = state.blind;
        el('voucherBlindWarning').hidden = !state.blind;
        el('buyVoucherBtn').textContent = state.blind ? 'Continue to Blind Payment' : 'Continue to Payment';
    }

    // ETH, USDC and USDT share one address on every network listed.
    var EVM_COINS = ['ETH', 'USDC', 'USDT'];

    function isEvm(coin) { return EVM_COINS.indexOf(coin) !== -1; }

    function networkPills() {
        return Array.prototype.slice.call(document.querySelectorAll('#voucherNetworkPills .pill'));
    }

    function takes(pill, coin) {
        return (pill.getAttribute('data-tokens') || '').split(' ').indexOf(coin) !== -1;
    }

    function selectCrypto(currency) {
        state.crypto = currency;
        document.querySelectorAll('#voucherCryptoPills .pill').forEach(function (pill) {
            pill.classList.toggle('active', pill.getAttribute('data-currency') === currency);
        });
        var row = el('voucherNetworkPills');
        if (row) {
            row.hidden = !(state.method === 'crypto' && isEvm(currency));
            // Only networks that take this coin (no USDT on Base).
            var shown = networkPills().filter(function (pill) {
                pill.hidden = !takes(pill, currency);
                return !pill.hidden;
            });
            var keys = shown.map(function (pill) { return pill.getAttribute('data-network'); });
            selectNetwork(keys.indexOf(state.network) !== -1 ? state.network : (keys[0] || null));
        }
        syncAmountField();
    }

    function selectNetwork(key) {
        state.network = key;
        networkPills().forEach(function (pill) {
            var on = pill.getAttribute('data-network') === key;
            pill.classList.toggle('active', on);
            pill.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    function orderBody(method, cents) {
        var body = { payment_method: method };
        if (state.plan) {
            body.plan = state.plan;
            body.billing = state.billing;
        } else if (cents !== null) body.amount_cents = cents;
        if (isEvm(method) && state.network) body.network = state.network;
        return body;
    }

    function networkLabel(accepts, key) {
        var found = (accepts || []).filter(function (n) { return n.key === key; })[0];
        return found ? found.label : '';
    }

    // "Base, Arbitrum and Optimism"
    function joinNames(names) {
        if (names.length < 2) return names.join('');
        return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    }

    // ---------- Paying ----------

    function buy() {
        var method = state.method === 'card' ? 'card' : state.crypto;
        if (state.plan) return topUp(method, null);
        var cents = readAmountCents();
        // Card fees eat a tenth of small card payments; crypto costs nothing to take.
        var min = method === 'card' ? 500 : 100;
        if (cents !== null && (isNaN(cents) || cents < min || cents > 1000000)) {
            setStatus(method === 'card'
                ? 'Card payments start at $5. Crypto takes $1 and up.'
                : 'Enter an amount between $1 and $10,000.', true);
            return;
        }
        if (cents === null && amountRequired()) {
            setStatus('Enter an amount.', true);
            return;
        }
        if (!state.blind) return topUp(method, cents);
        if (!confirm(BLIND_CONFIRM)) return;
        var btn = el('buyVoucherBtn');
        btn.disabled = true;
        el('voucherPayment').innerHTML = '';
        setStatus('Setting up the payment…');

        anonFetch('/vouchers/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderBody(method, cents)),
        }).then(function (order) {
            var orders = load(ORDERS_KEY, []);
            orders.push({
                orderId: order.order_id,
                method: method,
                amountCents: order.amount_cents || null,
                addresses: order.addresses || null,
                coinAmounts: order.amounts || null,
                network: order.network || null,
                accepts: order.accepts || null,
                fundedCents: 0,
                createdAt: Date.now(),
            });
            save(ORDERS_KEY, orders);
            render();
            state.cardIsTopUp = false;
            if (method === 'card') return showCardForm(order);
            showCryptoPayment(order.order_id);
            startPolling();
        }).catch(function (error) {
            setStatus('Error: ' + error.message, true);
        }).finally(function () {
            btn.disabled = false;
        });
    }

    // ---------- Top-ups (default): the server credits the account ----------

    function readJson(response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
            if (!response.ok) {
                var err = new Error(data.error || ('Request failed (' + response.status + ')'));
                err.status = response.status;
                throw err;
            }
            return data;
        });
    }

    // Session cookie when signed in, else the API key typed on the page.
    function authHeaders() {
        return typeof getAuthHeaders === 'function' ? getAuthHeaders() : { 'Content-Type': 'application/json' };
    }

    // Crypto quotes hold for an hour.
    var PLAN_ORDER_MS = 45 * 60 * 1000;

    function openTopUp(body) {
        var key = JSON.stringify(body);
        var known = body.plan && state.planOrders[key];
        if (known && Date.now() - known.at < PLAN_ORDER_MS) return Promise.resolve(known.order);
        return authFetch('/top_ups', { method: 'POST', headers: authHeaders(), body: key })
            .then(readJson).then(function (order) {
                if (body.plan) state.planOrders[key] = { at: Date.now(), order: order };
                return order;
            });
    }

    function topUp(method, cents) {
        var btn = el('buyVoucherBtn');
        // A slow reply for an earlier choice must not replace what's shown for this one.
        var seq = ++state.paySeq;
        var current = function () { return seq === state.paySeq; };
        btn.disabled = true;
        el('voucherPayment').innerHTML = '';
        setStatus('Setting up the payment…');
        openTopUp(orderBody(method, cents)).then(function (order) {
            if (!current()) return;
            if (method === 'card') {
                state.cardIsTopUp = true;
                return showCardForm(order, current);
            }
            renderAddresses(order.addresses, order.amounts, order.amount_cents, order.network, order.accepts);
            setStatus(order.plan
                ? planName(order.plan) + ' switches on as soon as the payment confirms. You can close this page.'
                : 'It goes on your balance as soon as the payment confirms. You can close this page.');
            return refreshTopUps().then(startTopUpPolling);
        }).catch(function (error) {
            if (!current() || (error && error.isSessionExpired)) return;
            setStatus('Error: ' + error.message, true);
        }).finally(function () {
            if (current()) btn.disabled = false;
        });
    }

    // Forget the payment on screen, and any reply still on its way.
    function dropPayment() {
        state.paySeq++;
        el('voucherPayment').innerHTML = '';
        el('buyVoucherBtn').disabled = false;
        setStatus('');
    }

    function planName(plan) {
        var pill = planPill(plan);
        return pill ? pill.getAttribute('data-name') : plan;
    }

    function creditedTotal(list) {
        return list.reduce(function (sum, t) { return sum + (t.credited_cents || 0); }, 0);
    }

    // Load this account's recent top-ups; say so when new money lands.
    function refreshTopUps() {
        return authFetch('/top_ups', { headers: authHeaders() }).then(readJson).then(function (data) {
            state.topUps = data.top_ups || [];
            state.topUpsLoaded = true;
            var total = creditedTotal(state.topUps);
            if (state.creditedSeen !== null && total > state.creditedSeen) {
                setStatus(dollars(total - state.creditedSeen) + ' added to your balance.');
                if (state.cardIsTopUp) el('voucherPayment').innerHTML = '';
                if (typeof fetchAccountBalance === 'function') fetchAccountBalance();
                if (typeof window.refreshTransactions === 'function') window.refreshTransactions();
            }
            if (window.ObscurifyFunnel && window.ObscurifyFunnel.topUps) window.ObscurifyFunnel.topUps(state.topUps);
            state.creditedSeen = total;
            // A plan paid for here just switched on.
            var applied = state.topUps.filter(function (t) { return t.plan_state === 'applied'; })
                .map(function (t) { return t.order_id; });
            if (state.appliedSeen !== null) {
                var fresh = state.topUps.filter(function (t) {
                    return t.plan_state === 'applied' && state.appliedSeen.indexOf(t.order_id) === -1;
                })[0];
                if (fresh) {
                    state.paySeq++;
                    state.planOrders = {};
                    el('buyVoucherBtn').disabled = false;
                    setStatus(planName(fresh.plan) + ' is on. Thanks!');
                    el('voucherPayment').innerHTML = '';
                    selectPlan(null);
                    if (typeof window.fetchAccountTier === 'function') window.fetchAccountTier();
                    if (typeof fetchAccountBalance === 'function') fetchAccountBalance();
                }
            }
            state.appliedSeen = applied;
            if (!state.topUps.some(function (t) { return t.open; })) stopTopUpPolling();
            render();
        }).catch(function () { /* try again on the next poll */ });
    }

    function startTopUpPolling() {
        if (!state.topUpTimer) state.topUpTimer = setInterval(function () {
            if (!document.hidden) refreshTopUps();
        }, TOP_UP_POLL_MS);
    }

    function stopTopUpPolling() {
        if (state.topUpTimer) clearInterval(state.topUpTimer);
        state.topUpTimer = null;
    }

    function loadStripe(publishableKey) {
        if (state.stripe && state.stripeKey === publishableKey) return Promise.resolve(state.stripe);
        return new Promise(function (resolve, reject) {
            var ready = function () {
                state.stripe = Stripe(publishableKey);
                state.stripeKey = publishableKey;
                resolve(state.stripe);
            };
            if (window.Stripe) return ready();
            var script = document.createElement('script');
            script.src = 'https://js.stripe.com/v3/';
            script.onload = ready;
            script.onerror = function () { reject(new Error('Could not load the card payment form')); };
            document.head.appendChild(script);
        });
    }

    // `current`, when given, says whether this is still the payment being asked for.
    function showCardForm(order, current) {
        return loadStripe(order.publishable_key).then(function (stripe) {
            if (current && !current()) return;
            state.cardOrderId = order.order_id;
            state.elements = stripe.elements({
                clientSecret: order.client_secret,
                appearance: {
                    theme: 'night',
                    variables: {
                        colorPrimary: '#00ff9d',
                        colorBackground: '#1a1a2e',
                        colorText: '#ffffff',
                        colorDanger: '#f87171',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        borderRadius: '8px',
                    },
                },
            });
            var container = el('voucherPayment');
            container.innerHTML =
                '<div id="voucher-payment-element" style="background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px;"></div>' +
                '<div class="action-buttons" style="margin-top: 16px;"><button type="button" class="btn btn-primary" id="payVoucherBtn">Pay ' + dollars(order.amount_cents) + '</button></div>';
            state.elements.create('payment').mount('#voucher-payment-element');
            el('payVoucherBtn').addEventListener('click', payCard);
            setStatus('');
        });
    }

    function payCard() {
        var btn = el('payVoucherBtn');
        btn.disabled = true;
        btn.textContent = 'Processing…';
        state.stripe.confirmPayment({
            elements: state.elements,
            confirmParams: { return_url: window.location.origin + '/account' },
            redirect: 'if_required',
        }).then(function (result) {
            if (result.error) {
                setStatus(result.error.message, true);
                btn.disabled = false;
                btn.textContent = 'Try Again';
                return;
            }
            el('voucherPayment').innerHTML = '';
            state.planOrders = {};
            if (state.cardIsTopUp) {
                setStatus('Payment received. Adding it to your balance…');
                refreshTopUps().then(startTopUpPolling);
                return;
            }
            setStatus('Payment received. Collecting your vouchers…');
            pollOrders([state.cardOrderId]);
            startPolling();
        });
    }

    function showCryptoPayment(orderId) {
        var order = load(ORDERS_KEY, []).filter(function (o) { return o.orderId === orderId; })[0];
        el('voucherPayment').innerHTML = '';
        if (!order || !order.addresses) return;
        renderAddresses(order.addresses, order.coinAmounts, order.amountCents, order.network, order.accepts);
        setStatus('Blind voucher: keep this page open until the credit is on your balance. Closing it loses the money.', true);
    }

    function renderAddresses(addresses, coinAmounts, amountCents, network, accepts) {
        var container = el('voucherPayment');
        container.innerHTML = '';
        if (!addresses) return;
        Object.keys(addresses).forEach(function (coin) {
            var address = addresses[coin];
            var row = document.createElement('div');
            row.className = 'deposit-address';
            var info = document.createElement('div');
            info.className = 'address-info';
            var currency = document.createElement('div');
            currency.className = 'currency';
            var due = coinAmounts && coinAmounts[coin];
            var on = isEvm(coin) && network ? ' on ' + networkLabel(accepts, network) : '';
            currency.textContent = due
                ? 'Send ' + trimAmount(due) + ' ' + (coin === 'Lightning' ? 'BTC' : coin) + on + ' (about ' + dollars(amountCents) + ') within 1 hour'
                : amountCents
                    ? 'Pay ' + dollars(amountCents) + ' within 1 hour'
                    : 'Send any amount of ' + coin + on + ' within 1 hour';
            var addr = document.createElement('div');
            addr.className = 'address';
            addr.textContent = address;
            var hint = document.createElement('div');
            hint.className = 'copy-hint';
            hint.textContent = 'Click to copy';
            info.appendChild(currency);
            info.appendChild(addr);
            if (isEvm(coin) && accepts) {
                var others = accepts.filter(function (n) {
                    return n.key !== network && n.tokens.indexOf(coin) !== -1;
                }).map(function (n) { return n.label; });
                if (others.length) {
                    var note = document.createElement('div');
                    note.className = 'network-note';
                    note.textContent = 'Same address works on ' + joinNames(others) + '.';
                    info.appendChild(note);
                }
            }
            info.appendChild(hint);
            var qrBox = document.createElement('div');
            qrBox.className = 'qr-code';
            var qr = qrcode(0, 'L');
            qr.addData(address);
            qr.make();
            // A picture with its own white border: dark modes, extensions like Dark Reader
            // and high contrast recolor an SVG or the page behind it, not a picture.
            var qrImage = document.createElement('img');
            qrImage.src = qr.createDataURL(8, 8 * 4);
            qrImage.alt = 'QR code of the address';
            qrBox.appendChild(qrImage);
            row.appendChild(info);
            row.appendChild(qrBox);
            row.addEventListener('click', function () {
                navigator.clipboard.writeText(address).then(function () {
                    hint.textContent = 'Copied!';
                    setTimeout(function () { hint.textContent = 'Click to copy'; }, 1500);
                });
            });
            container.appendChild(row);
        });
    }

    // ---------- Collecting vouchers ----------

    function isStale(order) {
        var ttl = order.method === 'card' ? CARD_ORDER_TTL_MS : CRYPTO_ORDER_TTL_MS;
        return order.expired || Date.now() - order.createdAt > ttl;
    }

    function updateOrder(orderId, changes) {
        save(ORDERS_KEY, load(ORDERS_KEY, []).map(function (o) {
            return o.orderId === orderId ? Object.assign({}, o, changes) : o;
        }));
    }

    function removeOrderRecord(orderId) {
        save(ORDERS_KEY, load(ORDERS_KEY, []).filter(function (o) { return o.orderId !== orderId; }));
    }

    // Blind vouchers for `cents`, or resend the batch saved for this order.
    function collect(order, cents) {
        if (state.collecting[order.orderId]) return state.collecting[order.orderId];
        var batches = load(BATCHES_KEY, {});
        var batchReady = batches[order.orderId]
            ? Promise.resolve(batches[order.orderId])
            : getKeys().then(function (keys) {
                return Promise.all(split(cents, keys).map(function (key) {
                    return ObscurifyVoucher.blind(key).then(function (b) {
                        return {
                            cents: key.denomination_cents,
                            keyId: key.key_id,
                            key: { n: key.n, e: key.e },
                            secret: b.secret,
                            blindedMessage: b.blindedMessage,
                        };
                    });
                }));
            }).then(function (items) {
                var all = load(BATCHES_KEY, {});
                all[order.orderId] = items;
                save(BATCHES_KEY, all); // saved before sending, so a lost reply is retried
                return items;
            });

        var run = batchReady.then(function (items) {
            return chunks(items, MAX_PER_SIGN).reduce(function (prev, part) {
                return prev.then(function (done) {
                    return anonFetch('/vouchers/orders/' + encodeURIComponent(order.orderId) + '/sign', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ vouchers: part.map(function (it) {
                            return { denomination_cents: it.cents, key_id: it.keyId, blinded_message: it.blindedMessage };
                        }) }),
                    }).then(function (res) {
                        return done.concat(part.map(function (it, i) {
                            var sig = ObscurifyVoucher.finalize(it.key, it.secret, res.blind_signatures[i]);
                            return { code: ObscurifyVoucher.voucherCode(it.cents, it.keyId, it.secret, sig), cents: it.cents };
                        }));
                    });
                });
            }, Promise.resolve([]));
        }).then(function (vouchers) {
            var wallet = load(VOUCHERS_KEY, []);
            var total = 0;
            vouchers.forEach(function (v) {
                total += v.cents;
                wallet.push({
                    code: v.code,
                    cents: v.cents,
                    group: order.orderId,
                    redeemAfter: Date.now() + MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS),
                });
            });
            save(VOUCHERS_KEY, wallet);
            var all = load(BATCHES_KEY, {});
            delete all[order.orderId];
            save(BATCHES_KEY, all);
            if (order.method === 'card') {
                removeOrderRecord(order.orderId);
                if (state.cardOrderId === order.orderId) el('voucherPayment').innerHTML = '';
            }
            if (window.ObscurifyFunnel) window.ObscurifyFunnel.step('deposit', total);
            setStatus(dollars(total) + ' received as a blind voucher. Keep this page open: it is added within the hour.', true);
        }).catch(function (error) {
            // A rejected batch (keys changed, nothing left to collect) is
            // dropped and rebuilt from the order's current state.
            if (error.status === 400 || error.status === 409) {
                var all = load(BATCHES_KEY, {});
                delete all[order.orderId];
                save(BATCHES_KEY, all);
                state.keys = null;
            }
        }).finally(function () {
            delete state.collecting[order.orderId];
            render();
        });
        state.collecting[order.orderId] = run;
        return run;
    }

    // Check orders that are still live. `force` checks the given orders even
    // if they are stale or were checked a moment ago ("Check Again").
    function pollOrders(force) {
        var now = Date.now();
        var batches = load(BATCHES_KEY, {});
        var orders = load(ORDERS_KEY, []).filter(function (order) {
            if (force) return force.indexOf(order.orderId) !== -1;
            if (batches[order.orderId]) return true; // finish a collection that was cut off
            if (isStale(order)) return false;
            var slow = now - order.createdAt > FAST_POLL_FOR_MS;
            return !slow || !order.lastCheckedAt || now - order.lastCheckedAt >= SLOW_POLL_MS;
        });
        if (!force && !load(ORDERS_KEY, []).some(function (o) { return !isStale(o); }) && !Object.keys(batches).length) {
            stopPolling();
        }
        return Promise.all(orders.map(function (order) {
            updateOrder(order.orderId, { lastCheckedAt: now });
            return anonFetch('/vouchers/orders/' + encodeURIComponent(order.orderId))
                .then(function (status) {
                    updateOrder(order.orderId, { fundedCents: status.funded_cents, expired: status.status === 'expired' });
                    if (batches[order.orderId] || status.available_cents > 0) {
                        return collect(order, status.available_cents);
                    }
                })
                .catch(function () { /* try again on the next poll */ });
        })).then(render);
    }

    function startPolling() {
        if (!state.pollTimer) state.pollTimer = setInterval(function () { pollOrders(); }, POLL_MS);
    }

    function stopPolling() {
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
    }

    // ---------- Redeeming ----------

    function redeem(codes) {
        if (!codes.length) return Promise.resolve();
        var credited = 0, already = 0, invalid = 0, proUntil = null;
        return chunks(codes, MAX_PER_REDEEM).reduce(function (prev, part) {
            return prev.then(function () {
                return authFetch('/vouchers/redeem', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ vouchers: part }),
                })
                    .then(function (response) { return response.json(); })
                    .then(function (data) {
                        if (data.error) throw new Error(data.error);
                        if (data.pro_access_until) proUntil = data.pro_access_until;
                        var done = {};
                        (data.results || []).forEach(function (result, i) {
                            done[part[i]] = true;
                            if (result.status === 'credited') credited += result.amount_usd;
                            else if (result.status === 'already_redeemed') already++;
                            else invalid++;
                        });
                        save(VOUCHERS_KEY, load(VOUCHERS_KEY, []).filter(function (v) { return !done[v.code]; }));
                    });
            });
        }, Promise.resolve()).then(function () {
            var trial = codes.some(function (c) { return /^obt1/i.test(c); });
            if (credited > 0 && trial && proUntil) {
                setStatus('$' + credited.toFixed(2) + ' added to your balance, and Pro models are unlocked until ' + new Date(proUntil).toLocaleDateString() + '.');
                if (typeof window.fetchAccountTier === 'function') window.fetchAccountTier();
            } else if (credited > 0) setStatus('$' + credited.toFixed(2) + ' added to your balance.');
            else if (already) setStatus('That voucher was already used.', true);
            else if (invalid) setStatus('That is not a valid voucher.', true);
            if (typeof fetchAccountBalance === 'function') fetchAccountBalance();
            if (typeof window.refreshTransactions === 'function') window.refreshTransactions();
            render();
        }).catch(function (error) {
            if (error && error.isSessionExpired) return;
            setStatus('Error: ' + error.message, true);
        });
    }

    function redeemDue() {
        var due = load(VOUCHERS_KEY, []).filter(function (v) { return v.redeemAfter <= Date.now(); });
        return redeem(due.map(function (v) { return v.code; }));
    }

    function forgetOrder(orderId) {
        if (!confirm('Forget this payment? Anything sent to it later will not be collected.')) return;
        removeOrderRecord(orderId);
        el('voucherPayment').innerHTML = '';
        render();
    }

    // ---------- Rendering ----------

    function button(label, onClick, primary) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (primary ? 'btn-primary' : 'btn-secondary') + ' voucher-btn';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    }

    function row(title, detail, actions) {
        var r = document.createElement('div');
        r.className = 'voucher-item';
        var info = document.createElement('div');
        var t = document.createElement('div');
        t.className = 'voucher-title';
        t.textContent = title;
        var d = document.createElement('div');
        d.className = 'voucher-detail';
        d.textContent = detail;
        info.appendChild(t);
        info.appendChild(d);
        var a = document.createElement('div');
        a.className = 'voucher-actions';
        actions.forEach(function (x) { a.appendChild(x); });
        r.appendChild(info);
        r.appendChild(a);
        return r;
    }

    // Only payments still waiting on something are listed here; finished ones
    // are deposits in the transaction history (tap one for how it was paid).
    function waitingTopUp(t) {
        if (t.plan_state === 'pending' && t.credited_cents > 0) return true;
        return t.open && (!t.credited_cents || (t.amount_cents && t.credited_cents < t.amount_cents));
    }
    function waitingOrder(o) {
        return !isStale(o) && !(o.fundedCents > 0);
    }

    function render() {
        var list = el('voucherList');
        if (!list) return;
        list.innerHTML = '';
        var orders = load(ORDERS_KEY, []).filter(waitingOrder);
        var vouchers = load(VOUCHERS_KEY, []);
        var topUps = state.topUps.filter(waitingTopUp);
        var heading = el('voucherListHeading');
        var empty = !orders.length && !vouchers.length && !topUps.length;
        if (heading) heading.style.display = empty ? 'none' : '';
        if (empty) return;
        topUps.forEach(function (t) {
            var actions = [];
            if (t.open && t.addresses) {
                actions.push(button('Payment details', function () {
                    renderAddresses(t.addresses, t.amounts, t.amount_cents, t.network, t.accepts);
                }));
            }
            var on = t.network ? ' on ' + networkLabel(t.accepts, t.network) : '';
            var title = t.amount_cents
                ? dollars(t.amount_cents) + ' ' + t.payment_method + on + ' payment'
                : t.payment_method + on + ' payment, any amount';
            if (t.plan) title = planName(t.plan) + ' for ' + PLAN_TERMS[t.billing] + ': ' + title;
            var detail;
            if (t.plan_state === 'pending' && t.credited_cents > 0 && t.credited_cents < (t.amount_cents || 0)) {
                detail = dollars(t.credited_cents) + ' arrived and is on your balance. ' +
                    planName(t.plan) + ' switches on when the other ' + dollars(t.amount_cents - t.credited_cents) + ' arrives.';
            } else if (t.plan_state === 'pending' && t.credited_cents > 0) {
                detail = 'Paid. Switching ' + planName(t.plan) + ' on…';
            } else if (t.plan && t.open && !t.credited_cents) {
                detail = 'Waiting for payment. ' + planName(t.plan) + ' switches on when it confirms, even if you close this page.';
            } else if (t.credited_cents > 0) {
                detail = 'Added ' + dollars(t.credited_cents) + ' to your balance' +
                    (t.open && t.payment_method !== 'card' ? '. More sent here is added too.' : '.');
            } else if (t.open) {
                detail = 'Waiting for payment. It is added when it confirms, even if you close this page.';
            } else {
                detail = 'No payment received';
            }
            list.appendChild(row(title, detail, actions));
        });
        orders.forEach(function (order) {
            var stale = isStale(order);
            var method = order.method === 'card' ? 'card' : order.method;
            var actions = [];
            if (order.addresses && !stale) actions.push(button('Payment details', function () { showCryptoPayment(order.orderId); }));
            if (stale) {
                actions.push(button('Check Again', function () {
                    updateOrder(order.orderId, { expired: false, createdAt: Date.now() });
                    pollOrders([order.orderId]).then(function () { startPolling(); render(); });
                }));
            }
            actions.push(button('Forget', function () { forgetOrder(order.orderId); }));
            var title = 'Blind ' + (order.amountCents ? dollars(order.amountCents) + ' ' + method + ' payment' : method + ' payment, any amount');
            var detail;
            if (order.fundedCents > 0) {
                detail = 'Received ' + dollars(order.fundedCents) + (order.method === 'card' ? '' : '. More sent here is added too.');
            } else if (!stale) {
                detail = 'Waiting for payment. Keep this page open until it is on your balance.';
            } else if (order.expired) {
                detail = 'Payment did not complete. Paid anyway? Contact support with order ' + order.orderId.slice(0, 8) + '.';
            } else {
                detail = 'No payment received';
            }
            list.appendChild(row(title, detail, actions));
        });

        // One row per payment: its vouchers go on the balance separately.
        var groups = {};
        var groupOrder = [];
        vouchers.forEach(function (v) {
            var g = v.group || v.code;
            if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
            groups[g].push(v);
        });
        groupOrder.forEach(function (g) {
            var items = groups[g];
            var total = items.reduce(function (s, v) { return s + v.cents; }, 0);
            var codes = items.map(function (v) { return v.code; });
            list.appendChild(row(
                dollars(total) + ' blind voucher waiting',
                'Keep this page open: added within the hour. Closing it loses the money unless you copy the codes.',
                [
                    button('Add Now', function () {
                        if (confirm('Add it now? Adding right away makes it easier to match to your payment.')) {
                            redeem(codes);
                        }
                    }, true),
                    button('Copy Codes', function () {
                        navigator.clipboard.writeText(codes.join('\n')).then(function () {
                            setStatus('Voucher codes copied. Anyone with the codes can spend them.');
                        });
                    }),
                ]
            ));
        });
    }

    // The plan list sends people here when their balance doesn't cover a plan.
    window.ObscurifyCheckout = {
        choosePlan: function (plan, billing, pay) {
            if (!el('voucherPurpose')) return;
            payForPlan(plan, billing || 'monthly', pay || 'XMR');
            el('voucherSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
    };

    document.addEventListener('DOMContentLoaded', function () {
        if (!el('voucherSection')) return;

        // Orders from the fixed-amount design had no address list kept the
        // same way; drop anything this version can't read.
        save(ORDERS_KEY, load(ORDERS_KEY, []).filter(function (o) { return o && o.orderId && o.method; }));

        document.querySelectorAll('#voucherAmounts .pill').forEach(function (pill) {
            pill.addEventListener('click', function () {
                el('voucherAmountInput').value = (parseInt(pill.getAttribute('data-cents'), 10) / 100).toString();
            });
        });
        document.querySelectorAll('#voucherCryptoPills .pill').forEach(function (pill) {
            pill.addEventListener('click', function () { selectCrypto(pill.getAttribute('data-currency')); payAgain(); });
        });
        networkPills().forEach(function (pill) {
            pill.addEventListener('click', function () { selectNetwork(pill.getAttribute('data-network')); payAgain(); });
        });
        document.querySelectorAll('#voucherPurpose .pill').forEach(function (pill) {
            pill.addEventListener('click', function () {
                var plan = pill.getAttribute('data-plan');
                if (!plan && state.autoPay) {
                    state.autoPay = false;
                    dropPayment();
                }
                selectPlan(plan);
                payAgain();
            });
        });
        document.querySelectorAll('#voucherPlanTerm .pill').forEach(function (pill) {
            pill.addEventListener('click', function () { selectPlan(state.plan, pill.getAttribute('data-billing')); payAgain(); });
        });
        el('voucherMethodCard').addEventListener('click', function () { selectMethod('card'); payAgain(); });
        el('voucherMethodCrypto').addEventListener('click', function () { selectMethod('crypto'); payAgain(); });
        el('buyVoucherBtn').addEventListener('click', buy);
        el('voucherBlindToggle').addEventListener('change', function () { selectBlind(this.checked); });
        el('redeemCodeBtn').addEventListener('click', function () {
            var input = el('voucherCodeInput');
            var codes = input.value.split(/\s+/).filter(Boolean);
            if (!codes.length) return;
            redeem(codes).then(function () { input.value = ''; });
        });

        selectMethod(state.method);
        selectCrypto(state.crypto);
        selectBlind(false);
        selectPlan(null);
        // The chat's plan picker links here with the plan already chosen.
        var params = new URLSearchParams(window.location.search);
        var wanted = params.get('plan');
        if ((wanted === 'casual' || wanted === 'pro') && planPill(wanted)) {
            payForPlan(wanted, params.get('billing') === 'annual' ? 'annual' : 'monthly', params.get('pay') || 'XMR');
            params.delete('plan');
            params.delete('billing');
            params.delete('pay');
            var rest = params.toString();
            history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
            setTimeout(function () { el('voucherSection').scrollIntoView({ block: 'start' }); }, 0);
        }
        render();
        refreshTopUps().then(function () {
            if (state.topUps.some(function (t) { return t.open; })) startTopUpPolling();
        });
        if (load(ORDERS_KEY, []).some(function (o) { return !isStale(o); }) || Object.keys(load(BATCHES_KEY, {})).length) {
            pollOrders();
            startPolling();
        }
        redeemDue();
        setInterval(function () { redeemDue(); render(); }, 30 * 1000);

        // A blind payment or voucher still in this browser is lost if the page
        // closes, so ask first.
        window.addEventListener('beforeunload', function (event) {
            var waiting = load(VOUCHERS_KEY, []).length ||
                Object.keys(load(BATCHES_KEY, {})).length ||
                load(ORDERS_KEY, []).some(function (o) { return !isStale(o) && !(o.method === 'card' && !o.fundedCents); });
            if (!waiting) return;
            event.preventDefault();
            event.returnValue = '';
        });
    });
})();
