/**
 * Account page: add credit through blind-signed vouchers.
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

    var state = {
        method: 'card',
        crypto: 'XMR',
        keys: null,
        stripe: null,
        stripeKey: null,
        elements: null,
        cardOrderId: null,
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
        el('buyVoucherBtn').textContent = 'Continue to Payment';
    }

    function selectMethod(method) {
        state.method = method;
        el('voucherMethodCard').classList.toggle('active', method === 'card');
        el('voucherMethodCrypto').classList.toggle('active', method === 'crypto');
        el('voucherCryptoPills').style.display = method === 'crypto' ? 'flex' : 'none';
        syncAmountField();
    }

    function selectCrypto(currency) {
        state.crypto = currency;
        document.querySelectorAll('#voucherCryptoPills .pill').forEach(function (pill) {
            pill.classList.toggle('active', pill.getAttribute('data-currency') === currency);
        });
        syncAmountField();
    }

    // ---------- Paying ----------

    function buy() {
        var method = state.method === 'card' ? 'card' : state.crypto;
        var cents = readAmountCents();
        if (cents !== null && (isNaN(cents) || cents < 50 || cents > 1000000)) {
            setStatus('Enter an amount between $0.50 and $10,000.', true);
            return;
        }
        if (cents === null && amountRequired()) {
            setStatus('Enter an amount.', true);
            return;
        }
        var btn = el('buyVoucherBtn');
        btn.disabled = true;
        el('voucherPayment').innerHTML = '';
        setStatus('Setting up the payment…');

        anonFetch('/vouchers/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cents === null
                ? { payment_method: method }
                : { payment_method: method, amount_cents: cents }),
        }).then(function (order) {
            var orders = load(ORDERS_KEY, []);
            orders.push({
                orderId: order.order_id,
                method: method,
                amountCents: order.amount_cents || null,
                addresses: order.addresses || null,
                coinAmounts: order.amounts || null,
                fundedCents: 0,
                createdAt: Date.now(),
            });
            save(ORDERS_KEY, orders);
            render();
            if (method === 'card') return showCardForm(order);
            showCryptoPayment(order.order_id);
            startPolling();
        }).catch(function (error) {
            setStatus('Error: ' + error.message, true);
        }).finally(function () {
            btn.disabled = false;
        });
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

    function showCardForm(order) {
        return loadStripe(order.publishable_key).then(function (stripe) {
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
            setStatus('Payment received. Collecting your vouchers…');
            pollOrders([state.cardOrderId]);
            startPolling();
        });
    }

    function showCryptoPayment(orderId) {
        var order = load(ORDERS_KEY, []).filter(function (o) { return o.orderId === orderId; })[0];
        var container = el('voucherPayment');
        container.innerHTML = '';
        if (!order || !order.addresses) return;
        Object.keys(order.addresses).forEach(function (coin) {
            var address = order.addresses[coin];
            var row = document.createElement('div');
            row.className = 'deposit-address';
            var info = document.createElement('div');
            info.className = 'address-info';
            var currency = document.createElement('div');
            currency.className = 'currency';
            var due = order.coinAmounts && order.coinAmounts[coin];
            currency.textContent = due
                ? 'Send ' + trimAmount(due) + ' ' + (coin === 'Lightning' ? 'BTC' : coin) + ' (about ' + dollars(order.amountCents) + ') within 1 hour'
                : order.amountCents
                    ? 'Pay ' + dollars(order.amountCents) + ' within 1 hour'
                    : 'Send any amount of ' + coin + ' within 1 hour';
            var addr = document.createElement('div');
            addr.className = 'address';
            addr.textContent = address;
            var hint = document.createElement('div');
            hint.className = 'copy-hint';
            hint.textContent = 'Click to copy';
            info.appendChild(currency);
            info.appendChild(addr);
            info.appendChild(hint);
            var qrBox = document.createElement('div');
            qrBox.className = 'qr-code';
            var qr = qrcode(0, 'L');
            qr.addData(address);
            qr.make();
            qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
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
        setStatus('Your credit appears once the payment confirms. You can leave and come back.');
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
            setStatus(dollars(total) + ' received. It will be added to your balance within the hour.');
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
        var credited = 0, already = 0, invalid = 0;
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
            if (credited > 0) setStatus('$' + credited.toFixed(2) + ' added to your balance.');
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

    function render() {
        var list = el('voucherList');
        if (!list) return;
        list.innerHTML = '';
        var orders = load(ORDERS_KEY, []);
        var vouchers = load(VOUCHERS_KEY, []);
        if (!orders.length && !vouchers.length) {
            list.innerHTML = '<div class="empty-state">No payments or vouchers waiting.</div>';
            return;
        }
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
            var title = order.amountCents ? dollars(order.amountCents) + ' ' + method + ' payment' : method + ' payment, any amount';
            var detail;
            if (order.fundedCents > 0) {
                detail = 'Received ' + dollars(order.fundedCents) + (order.method === 'card' ? '' : '. More sent here is added too.');
            } else if (!stale) {
                detail = 'Waiting for payment';
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
                dollars(total) + ' waiting',
                'Added automatically within the hour',
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
            pill.addEventListener('click', function () { selectCrypto(pill.getAttribute('data-currency')); });
        });
        el('voucherMethodCard').addEventListener('click', function () { selectMethod('card'); });
        el('voucherMethodCrypto').addEventListener('click', function () { selectMethod('crypto'); });
        el('buyVoucherBtn').addEventListener('click', buy);
        el('redeemCodeBtn').addEventListener('click', function () {
            var input = el('voucherCodeInput');
            var codes = input.value.split(/\s+/).filter(Boolean);
            if (!codes.length) return;
            redeem(codes).then(function () { input.value = ''; });
        });

        selectMethod(state.method);
        selectCrypto(state.crypto);
        render();
        if (load(ORDERS_KEY, []).some(function (o) { return !isStale(o); }) || Object.keys(load(BATCHES_KEY, {})).length) {
            pollOrders();
            startPolling();
        }
        redeemDue();
        setInterval(function () { redeemDue(); render(); }, 30 * 1000);
    });
})();
