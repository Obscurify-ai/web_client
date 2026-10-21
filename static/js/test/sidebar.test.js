/**
 * Sidebar model visibility and favorite ordering tests.
 */

const { assert, assertEqual, describe, it } = require('./harness');
const {
    shouldIncludeModelForSidebar,
    buildProviderList,
    buildModelListForProvider,
    chooseDefaultModel
} = require('./helpers');

describe('Sidebar Model Visibility', () => {
    const freeModel = { id: 'free/model', pricing: { prompt: 0, completion: 0 } };
    const paidModel = { id: 'paid/model', pricing: { prompt: 0.1, completion: 0.2 } };
    const frontierModel = { id: 'frontier/model', pricing: { prompt: 1, completion: 1 } };
    const uncensoredModel = { id: 'uncensored/model', pricing: { prompt: 1, completion: 1 } };
    const restrictions = {
        frontierModels: ['frontier/model'],
        uncensoredModels: ['uncensored/model']
    };

    it('guest users only see free models', () => {
        const access = {
            loggedIn: false,
            canAccessFrontierModels: false,
            canAccessUncensoredModels: false
        };
        assertEqual(shouldIncludeModelForSidebar(freeModel, access, restrictions), true, 'Guest sees free model');
        assertEqual(shouldIncludeModelForSidebar(paidModel, access, restrictions), false, 'Guest does not see paid model');
    });

    it('PAYG users see paid non-frontier models (including uncensored)', () => {
        const access = {
            loggedIn: true,
            canAccessFrontierModels: false,
            canAccessUncensoredModels: false
        };
        assertEqual(shouldIncludeModelForSidebar(freeModel, access, restrictions), true, 'PAYG sees free model');
        assertEqual(shouldIncludeModelForSidebar(paidModel, access, restrictions), true, 'PAYG sees paid standard model');
        assertEqual(shouldIncludeModelForSidebar(frontierModel, access, restrictions), false, 'PAYG does not see frontier model');
        assertEqual(shouldIncludeModelForSidebar(uncensoredModel, access, restrictions), true, 'PAYG sees uncensored model');
    });

    it('Casual users can see frontier and uncensored', () => {
        const access = {
            loggedIn: true,
            canAccessFrontierModels: true,
            canAccessUncensoredModels: false
        };
        assertEqual(shouldIncludeModelForSidebar(frontierModel, access, restrictions), true, 'Casual sees frontier model');
        assertEqual(shouldIncludeModelForSidebar(uncensoredModel, access, restrictions), true, 'Casual sees uncensored model');
    });

    it('Pro users can see all models', () => {
        const access = {
            loggedIn: true,
            canAccessFrontierModels: true,
            canAccessUncensoredModels: true
        };
        assertEqual(shouldIncludeModelForSidebar(freeModel, access, restrictions), true, 'Pro sees free model');
        assertEqual(shouldIncludeModelForSidebar(paidModel, access, restrictions), true, 'Pro sees paid model');
        assertEqual(shouldIncludeModelForSidebar(frontierModel, access, restrictions), true, 'Pro sees frontier model');
        assertEqual(shouldIncludeModelForSidebar(uncensoredModel, access, restrictions), true, 'Pro sees uncensored model');
    });

    it('PAYG users do not see wildcard-matched frontier models', () => {
        const access = {
            loggedIn: true,
            canAccessFrontierModels: false,
            canAccessUncensoredModels: true
        };
        const wildcardRestrictions = {
            frontierModels: ['**opus-4.6**', 'openai/gpt-5.2-pro', 'google/gemini-3-pro-preview'],
            uncensoredModels: []
        };
        const frontierByWildcard = { id: 'anthropic/claude-opus-4.6:thinking', pricing: { prompt: 1, completion: 1 } };

        assertEqual(
            shouldIncludeModelForSidebar(frontierByWildcard, access, wildcardRestrictions),
            false,
            'PAYG does not see frontier model matched by wildcard pattern'
        );
    });
});

describe('Favorite Model Ordering', () => {
    const models = [
        { id: 'anthropic/claude-opus-4.5', name: 'Anthropic: Claude Opus 4.5' },
        { id: 'google/gemini-2.0-flash-001', name: 'Google: Gemini 2.0 Flash' },
        { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o Mini' }
    ];
    const favorites = ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini'];

    it('shows Favorites provider near the top when favorites exist', () => {
        const providers = buildProviderList(models, favorites);
        assertEqual(providers[0], 'Favorites', 'Favorites provider should be first');
    });

    it('puts first favorite first in all-providers model list', () => {
        const orderedIds = buildModelListForProvider(models, '', favorites);
        assertEqual(orderedIds[0], 'google/gemini-2.0-flash-001', 'First favorite should be first');
        assertEqual(orderedIds[1], 'openai/gpt-4o-mini', 'Second favorite should be second');
    });

    it('shows all favorites inside Favorites provider in order', () => {
        const favoriteProviderIds = buildModelListForProvider(models, 'Favorites', favorites);
        assertEqual(favoriteProviderIds[0], 'google/gemini-2.0-flash-001', 'First favorite should lead Favorites provider');
        assertEqual(favoriteProviderIds[1], 'openai/gpt-4o-mini', 'Second favorite should follow in Favorites provider');
    });

    it('uses first favorite as default model on fresh load', () => {
        const selected = chooseDefaultModel(
            models,
            true,
            'anthropic/claude-opus-4.5',
            'openai/gpt-4o-mini',
            favorites
        );
        assertEqual(selected, 'google/gemini-2.0-flash-001', 'First favorite should be selected');
    });
});
