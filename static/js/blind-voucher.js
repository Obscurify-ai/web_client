/**
 * Blind-signed voucher client (RFC 9474, RSABSSA-SHA384-PSS-Deterministic).
 *
 * The browser picks a random voucher message and blinds it before sending it
 * with a payment. The server signs the blinded value once the payment clears,
 * and the browser unblinds the signature. The finished voucher is then
 * redeemed to an account later, and the server cannot tell which payment it
 * came from.
 *
 * Works in browsers and in Node (WebCrypto + BigInt).
 */
(function (root) {
    'use strict';

    var webcrypto = (root && root.crypto) || globalThis.crypto;
    var HASH_LEN = 48; // SHA-384
    var SALT_LEN = 48;
    var MESSAGE_LEN = 32;

    function b64urlToBytes(text) {
        var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function bytesToB64url(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function bytesToBigInt(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return hex ? BigInt('0x' + hex) : 0n;
    }

    function bigIntToBytes(value, length) {
        var hex = value.toString(16);
        if (hex.length > length * 2) throw new Error('integer too large');
        hex = hex.padStart(length * 2, '0');
        var out = new Uint8Array(length);
        for (var i = 0; i < length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    function bitLength(value) {
        return value.toString(2).length;
    }

    function modPow(base, exp, mod) {
        var result = 1n;
        base %= mod;
        while (exp > 0n) {
            if (exp & 1n) result = (result * base) % mod;
            base = (base * base) % mod;
            exp >>= 1n;
        }
        return result;
    }

    function gcd(a, b) {
        while (b) { var t = a % b; a = b; b = t; }
        return a;
    }

    function modInverse(a, m) {
        var oldR = a % m, r = m, oldS = 1n, s = 0n;
        while (r !== 0n) {
            var q = oldR / r;
            var t = r; r = oldR - q * r; oldR = t;
            t = s; s = oldS - q * s; oldS = t;
        }
        if (oldR !== 1n) throw new Error('not invertible');
        return ((oldS % m) + m) % m;
    }

    function randomBytes(length) {
        var out = new Uint8Array(length);
        webcrypto.getRandomValues(out);
        return out;
    }

    async function sha384(bytes) {
        return new Uint8Array(await webcrypto.subtle.digest('SHA-384', bytes));
    }

    function concat() {
        var total = 0, i;
        for (i = 0; i < arguments.length; i++) total += arguments[i].length;
        var out = new Uint8Array(total), offset = 0;
        for (i = 0; i < arguments.length; i++) { out.set(arguments[i], offset); offset += arguments[i].length; }
        return out;
    }

    async function mgf1(seed, length) {
        var out = new Uint8Array(0);
        for (var counter = 0; out.length < length; counter++) {
            var c = new Uint8Array([counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]);
            out = concat(out, await sha384(concat(seed, c)));
        }
        return out.slice(0, length);
    }

    // EMSA-PSS-ENCODE (RFC 8017 9.1.1) with SHA-384 and MGF1-SHA-384.
    async function emsaPssEncode(messageHash, emBits, salt) {
        var emLen = Math.ceil(emBits / 8);
        if (emLen < HASH_LEN + salt.length + 2) throw new Error('modulus too small');
        var h = await sha384(concat(new Uint8Array(8), messageHash, salt));
        var db = concat(new Uint8Array(emLen - salt.length - HASH_LEN - 2), new Uint8Array([1]), salt);
        var mask = await mgf1(h, emLen - HASH_LEN - 1);
        for (var i = 0; i < db.length; i++) db[i] ^= mask[i];
        db[0] &= 0xff >>> (8 * emLen - emBits);
        return concat(db, h, new Uint8Array([0xbc]));
    }

    function parseKey(key) {
        var n = bytesToBigInt(b64urlToBytes(key.n));
        return {
            n: n,
            e: bytesToBigInt(b64urlToBytes(key.e)),
            kLen: Math.ceil(bitLength(n) / 8),
            modBits: bitLength(n),
        };
    }

    /**
     * Blind a fresh random voucher message for `key` ({n, e} base64url).
     * Returns the blinded message to send with the payment, and the secret
     * state to keep (never sent) until the signature comes back.
     */
    async function blind(key) {
        var pk = parseKey(key);
        var message = randomBytes(MESSAGE_LEN);
        var encoded = await emsaPssEncode(await sha384(message), pk.modBits - 1, randomBytes(SALT_LEN));
        var m = bytesToBigInt(encoded);
        if (gcd(m, pk.n) !== 1n) throw new Error('invalid input');
        var r;
        do {
            r = bytesToBigInt(randomBytes(pk.kLen + 16)) % pk.n;
        } while (r < 2n || gcd(r, pk.n) !== 1n);
        var blinded = (m * modPow(r, pk.e, pk.n)) % pk.n;
        return {
            blindedMessage: bytesToB64url(bigIntToBytes(blinded, pk.kLen)),
            secret: {
                message: bytesToB64url(message),
                inverse: modInverse(r, pk.n).toString(16),
                encoded: bytesToB64url(encoded),
            },
        };
    }

    /**
     * Unblind the server's signature and check it. Returns the voucher
     * signature (base64url) for `secret.message`.
     */
    function finalize(key, secret, blindSignatureB64) {
        var pk = parseKey(key);
        var z = bytesToBigInt(b64urlToBytes(blindSignatureB64));
        var s = (z * BigInt('0x' + secret.inverse)) % pk.n;
        if (modPow(s, pk.e, pk.n) !== bytesToBigInt(b64urlToBytes(secret.encoded))) {
            throw new Error('The server returned an invalid signature');
        }
        return bytesToB64url(bigIntToBytes(s, pk.kLen));
    }

    function voucherCode(denominationCents, keyId, secret, signatureB64) {
        return ['obv1', denominationCents, keyId, secret.message, signatureB64].join('.');
    }

    function parseVoucherCode(code) {
        var parts = String(code || '').trim().split('.');
        if (parts.length !== 5 || parts[0] !== 'obv1') return null;
        var cents = parseInt(parts[1], 10);
        if (!(cents > 0)) return null;
        return { code: parts.join('.'), denominationCents: cents, keyId: parts[2] };
    }

    var api = {
        blind: blind,
        finalize: finalize,
        voucherCode: voucherCode,
        parseVoucherCode: parseVoucherCode,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.ObscurifyVoucher = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
