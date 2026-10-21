/**
 * Model favorites (heart toggle) and picker search filtering.
 *
 * These exercise the real implementation from chat-models.js rather than a
 * re-implementation: the module exports its pure helpers for the Node harness.
 */

const { assert, assertEqual, describe, it } = require('./harness');
const {
    normalizeFavoriteModels,
    isValidFavoriteModelId,
    isFavoriteModel,
    toggleFavoriteModel,
    filterModelsForPicker,
    MAX_FAVORITE_MODELS,
    FAVORITE_MODELS_STORAGE_KEY
} = require('../chat/chat-models');

const models = [
    { id: 'anthropic/claude-opus-4.5', name: 'Anthropic: Claude Opus 4.5', pricing: { prompt: 1, completion: 1 } },
    { id: 'google/gemini-3.1', name: 'Google: Gemini 3.1', pricing: { prompt: 1, completion: 1 } },
    { id: 'openai/gpt-5-nano', name: 'OpenAI: GPT-5 Nano', pricing: { prompt: 0, completion: 0 } }
];

function resetFavorites() {
    delete global.localStorage.data[FAVORITE_MODELS_STORAGE_KEY];
    global.document.cookie = '';
}

describe('Model Favorites Storage', () => {
    it('accepts sane model ids and rejects ones that would corrupt the cookie', () => {
        assertEqual(isValidFavoriteModelId('anthropic/claude-opus-4.5'), true, 'valid model id accepted');
        assertEqual(isValidFavoriteModelId('vendor/model:thinking'), true, 'colons are allowed');
        assertEqual(isValidFavoriteModelId('bad id,with,commas'), false, 'spaces and commas rejected');
        assertEqual(isValidFavoriteModelId(''), false, 'empty rejected');
        assertEqual(isValidFavoriteModelId('a'.repeat(201)), false, 'over-long rejected');
    });

    it('normalizes, dedupes and caps the stored list', () => {
        assertEqual(normalizeFavoriteModels(['a/b', 'a/b', ' c/d ']), ['a/b', 'c/d'], 'dupes and padding removed');
        assertEqual(normalizeFavoriteModels('not-an-array'), [], 'non-array rejected');

        const many = Array.from({ length: MAX_FAVORITE_MODELS + 5 }, (_, i) => `m/${i}`);
        assertEqual(normalizeFavoriteModels(many).length, MAX_FAVORITE_MODELS, 'capped at the max');
    });

    it('toggles a favorite on and off, persisting it', () => {
        resetFavorites();

        assertEqual(isFavoriteModel('google/gemini-3.1'), false, 'not a favorite to start');
        assertEqual(toggleFavoriteModel('google/gemini-3.1'), 'added', 'first toggle adds');
        assertEqual(isFavoriteModel('google/gemini-3.1'), true, 'model is now a favorite');
        assertEqual(
            JSON.parse(global.localStorage.data[FAVORITE_MODELS_STORAGE_KEY]),
            ['google/gemini-3.1'],
            'written to localStorage'
        );

        assertEqual(toggleFavoriteModel('google/gemini-3.1'), 'removed', 'second toggle removes');
        assertEqual(isFavoriteModel('google/gemini-3.1'), false, 'model is no longer a favorite');
    });

    it('keeps several favorites and preserves their order', () => {
        resetFavorites();

        toggleFavoriteModel('openai/gpt-5-nano');
        toggleFavoriteModel('google/gemini-3.1');

        assertEqual(
            JSON.parse(global.localStorage.data[FAVORITE_MODELS_STORAGE_KEY]),
            ['openai/gpt-5-nano', 'google/gemini-3.1'],
            'favorites accumulate in click order'
        );
    });

    it('refuses to exceed the favorites limit', () => {
        resetFavorites();

        for (let i = 0; i < MAX_FAVORITE_MODELS; i++) {
            assertEqual(toggleFavoriteModel(`m/${i}`), 'added', `added m/${i}`);
        }
        assertEqual(toggleFavoriteModel('m/extra'), 'limit', 'extra favorite refused at the limit');
        assertEqual(isFavoriteModel('m/extra'), false, 'refused favorite is not stored');
    });

    it('ignores an invalid id', () => {
        resetFavorites();

        assertEqual(toggleFavoriteModel('bad id'), 'invalid', 'invalid id reported');
        assertEqual(isFavoriteModel('bad id'), false, 'nothing stored');
    });
});

describe('Picker Search and Provider Filter', () => {
    it('matches on model name and id, case-insensitively', () => {
        assertEqual(
            filterModelsForPicker(models, { query: 'gemini' }).map((m) => m.id),
            ['google/gemini-3.1'],
            'matches by name'
        );
        assertEqual(
            filterModelsForPicker(models, { query: 'GPT-5' }).map((m) => m.id),
            ['openai/gpt-5-nano'],
            'matches by id, ignoring case'
        );
        assertEqual(filterModelsForPicker(models, { query: 'zzz' }), [], 'no match returns nothing');
    });

    it('filters by the selected provider', () => {
        assertEqual(
            filterModelsForPicker(models, { provider: 'Google' }).map((m) => m.id),
            ['google/gemini-3.1'],
            'only that provider returns'
        );
        assertEqual(
            filterModelsForPicker(models, { provider: 'Nobody' }),
            [],
            'unknown provider returns nothing'
        );
    });

    it('shows only favorites for the Favorites category', () => {
        assertEqual(
            filterModelsForPicker(models, { provider: 'Favorites', favorites: ['openai/gpt-5-nano'] }).map((m) => m.id),
            ['openai/gpt-5-nano'],
            'favorites only'
        );
        assertEqual(
            filterModelsForPicker(models, { provider: 'Favorites' }),
            [],
            'no favorites means an empty category'
        );
    });

    it('sorts favorites to the top of the unfiltered list', () => {
        const result = filterModelsForPicker(models, { favorites: ['openai/gpt-5-nano'] });

        assertEqual(result[0].id, 'openai/gpt-5-nano', 'favorite sorts first');
        assertEqual(result.length, 3, 'every model is still listed');
    });

    it('applies the provider filter and the search query together', () => {
        assertEqual(
            filterModelsForPicker(models, { provider: 'Anthropic', query: 'opus' }).map((m) => m.id),
            ['anthropic/claude-opus-4.5'],
            'both filters applied'
        );
    });

    it('still finds favorites when searching', () => {
        const result = filterModelsForPicker(models, { query: 'nano', favorites: ['openai/gpt-5-nano'] });
        assertEqual(result.map((m) => m.id), ['openai/gpt-5-nano'], 'favorite matches the query');
    });
});