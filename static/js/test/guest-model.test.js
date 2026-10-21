/**
 * Guests chat with the configured guest model (defaultFreeModel) even when it
 * is a paid model, because Obscurify pays for it.
 * Run with: node --test static/js/test/guest-model.test.js
 */

// Browser globals the chat modules expect at load time.
require('./setup');

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getModelRestriction, isFreeModel } = require('../chat/chat-models');

const GUEST_MODEL = {
    id: 'meta-llama/llama-3.3-70b-instruct',
    pricing: { prompt: '0.00000006', completion: '0.00000025' }
};
const OTHER_PAID_MODEL = {
    id: 'anthropic/claude-opus-4.8',
    pricing: { prompt: '0.000015', completion: '0.000075' }
};
const NO_RESTRICTED_PATTERNS = { frontierModels: [], uncensoredModels: [] };

function access(loggedIn) {
    return { loggedIn, canAccessFrontierModels: false, canAccessUncensoredModels: false };
}

beforeEach(() => {
    global.defaultFreeModel = GUEST_MODEL.id;
});

test('guests can pick the guest model, and it is listed as free', () => {
    global.isLoggedIn = false;

    assert.equal(getModelRestriction(GUEST_MODEL, access(false), NO_RESTRICTED_PATTERNS), null);
    assert.equal(isFreeModel(GUEST_MODEL), true);
});

test('guests are still asked to sign up for other paid models', () => {
    global.isLoggedIn = false;

    assert.equal(getModelRestriction(OTHER_PAID_MODEL, access(false), NO_RESTRICTED_PATTERNS), 'login');
    assert.equal(isFreeModel(OTHER_PAID_MODEL), false);
});

test('signed-in users are not told the guest model is free', () => {
    global.isLoggedIn = true;

    assert.equal(isFreeModel(GUEST_MODEL), false);
    assert.equal(getModelRestriction(GUEST_MODEL, access(true), NO_RESTRICTED_PATTERNS), null);
});
