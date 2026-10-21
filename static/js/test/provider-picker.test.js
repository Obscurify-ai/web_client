/**
 * Category picker: Free as the default, the extra categories, counts and search.
 *
 * These exercise the real implementation from chat-models.js.
 */

const { assert, assertEqual, describe, it } = require('./harness');
const {
    buildProviderEntries,
    providerSelectionLabel,
    filterModelsForPicker,
    modelVisibleForFilter,
    modelMatchesCategory,
    isCategoryFilter,
    isFreeModel,
    isCheapModel,
    modelSearchResults,
    PROVIDER_SEARCH_MODEL_LIMIT,
    FREE_CATEGORY
} = require('../chat/chat-models');

const models = [
    { id: 'anthropic/claude-opus-4.8:thinking', name: 'Anthropic: Claude Opus 4.8 (Thinking)', pricing: { prompt: 0.000015, completion: 0.000075 } },
    { id: 'google/gemini-3.1', name: 'Google: Gemini 3.1', pricing: { prompt: 0.000001, completion: 0.000002 } },
    { id: 'openai/gpt-5-nano', name: 'OpenAI: GPT-5 Nano', pricing: { prompt: 0, completion: 0 } },
    { id: 'cohere/north-mini-code:free', name: 'Cohere: North Mini Code (free)', pricing: { prompt: 0, completion: 0 } },
    { id: 'thedrummer/rocinante-12b-v1.1', name: 'TheDrummer: Rocinante 12B', pricing: { prompt: 0.0000002, completion: 0.0000004 } },
    { id: 'z-ai/glm-5.3-uncensored', name: 'Z.ai: GLM 5.3 Uncensored', pricing: { prompt: 0.0000003, completion: 0.0000006 } }
];

const FRONTIER = ['*opus-4.8*'];
const UNCENSORED = ['*uncensored*'];

function context(favorites = [], frontierPatterns = FRONTIER, uncensoredPatterns = UNCENSORED) {
    return {
        favoriteSet: new Set(favorites),
        frontierPatterns,
        uncensoredPatterns
    };
}

const ids = (list) => list.map((model) => model.id);

describe('Category List', () => {
    it('leads with Favorites, then All, Free, Cheap…each with a count', () => {
        const entries = buildProviderEntries(models, ['openai/gpt-5-nano'], context(['openai/gpt-5-nano']));
        const categories = entries.filter((entry) => entry.kind === 'category');

        assertEqual(
            categories.map((entry) => entry.value),
            ['Favorites', '', 'Free', 'Cheap', 'Reasoning', 'Uncensored', 'Roleplay', 'Frontier'],
            'Favorites is the top category'
        );
        assertEqual(categories[0].count, 1, 'Favorites counts favourites');
        assertEqual(categories[1].count, 6, 'All models counts everything');
        assertEqual(categories[2].count, 2, 'Free counts zero-priced models');
        assertEqual(categories[3].count, 3, 'Cheap includes the free ones and the cheap paid model');
        assertEqual(categories[4].count, 1, 'Reasoning counts thinking models');
        assertEqual(categories[5].count, 1, 'Uncensored follows the API patterns');
        assertEqual(categories[6].count, 1, 'Roleplay counts roleplay fine-tunes');
        assertEqual(categories[7].count, 1, 'Frontier follows the API patterns');
    });

    it('always offers Favorites, first, even with none set', () => {
        const categories = buildProviderEntries(models, [], context([], [], []))
            .filter((entry) => entry.kind === 'category');

        assertEqual(categories[0].value, 'Favorites', 'Favorites still leads the list');
        assertEqual(categories[0].count, 0, 'and reports zero favourites');
    });

    it('hides the categories that match nothing', () => {
        const values = buildProviderEntries(models, [], context([], [], []))
            .map((entry) => entry.value);

        assertEqual(values.includes('Frontier'), false, 'empty Frontier hidden');
        assertEqual(values.includes('Uncensored'), false, 'empty Uncensored hidden');
        assertEqual(values.slice(0, 3), ['Favorites', '', 'Free'], 'the always-relevant ones stay');
    });

    it('keeps providers after the categories, alphabetically with counts', () => {
        const providers = buildProviderEntries(models, [], context()).filter((entry) => entry.kind === 'provider');

        assertEqual(
            providers.map((entry) => entry.label),
            ['Anthropic', 'Cohere', 'Google', 'OpenAI', 'TheDrummer', 'Z.ai'],
            'providers are sorted'
        );
        assertEqual(providers[0].count, 1, 'each provider counts its own models');
    });

    it('labels the current selection for the picker button', () => {
        const entries = buildProviderEntries(models, [], context());

        assertEqual(providerSelectionLabel(FREE_CATEGORY, entries), FREE_CATEGORY, 'Free label');
        assertEqual(providerSelectionLabel('', entries), 'All models', 'All label');
        assertEqual(providerSelectionLabel('Roleplay', entries), 'Roleplay', 'category label');
        assertEqual(providerSelectionLabel('Google', entries), 'Google', 'provider label');
    });

    it('recognises category filters but not provider names', () => {
        assertEqual(isCategoryFilter(FREE_CATEGORY), true, 'Free is a category');
        assertEqual(isCategoryFilter('Cheap'), true, 'Cheap is a category');
        assertEqual(isCategoryFilter(''), true, 'the unfiltered value is a category');
        assertEqual(isCategoryFilter('Google'), false, 'a provider is not a category');
    });
});

describe('Category Rules', () => {
    it('treats zero-priced models as free and cheap', () => {
        assertEqual(isFreeModel(models[2]), true, 'free model is free');
        assertEqual(isCheapModel(models[2]), true, 'free model is also cheap');
        assertEqual(isCheapModel(models[4]), true, 'sub-dollar model is cheap');
        assertEqual(isCheapModel(models[1]), false, 'expensive model is not cheap');
    });

    it('matches roleplay fine-tunes but not general models', () => {
        assertEqual(modelMatchesCategory(models[4], 'Roleplay', context()), true, 'rocinante is roleplay');
        assertEqual(modelMatchesCategory(models[1], 'Roleplay', context()), false, 'gemini is not roleplay');
    });

    it('matches reasoning models', () => {
        assertEqual(modelMatchesCategory(models[0], 'Reasoning', context()), true, 'thinking variant is reasoning');
        assertEqual(modelMatchesCategory(models[1], 'Reasoning', context()), false, 'plain model is not');
    });

    it('matches uncensored and frontier from the API pattern lists', () => {
        assertEqual(modelMatchesCategory(models[5], 'Uncensored', context()), true, 'uncensored pattern matches');
        assertEqual(modelMatchesCategory(models[0], 'Frontier', context()), true, 'frontier pattern matches');
        assertEqual(modelMatchesCategory(models[1], 'Frontier', context()), false, 'non-frontier model excluded');
    });
});

describe('Filtering by Category', () => {
    it('returns only free models for Free', () => {
        assertEqual(
            ids(filterModelsForPicker(models, { provider: FREE_CATEGORY, context: context() })).sort(),
            ['cohere/north-mini-code:free', 'openai/gpt-5-nano'],
            'only zero-priced models'
        );
    });

    it('returns the cheap set for Cheap', () => {
        assertEqual(
            ids(filterModelsForPicker(models, { provider: 'Cheap', context: context() })).sort(),
            ['cohere/north-mini-code:free', 'openai/gpt-5-nano', 'thedrummer/rocinante-12b-v1.1'],
            'free plus sub-dollar models'
        );
    });

    it('returns roleplay models for Roleplay', () => {
        assertEqual(
            ids(filterModelsForPicker(models, { provider: 'Roleplay', context: context() })),
            ['thedrummer/rocinante-12b-v1.1'],
            'roleplay fine-tunes only'
        );
    });

    it('combines a category with a search query', () => {
        assertEqual(
            ids(filterModelsForPicker(models, { provider: 'Cheap', query: 'nano', context: context() })),
            ['openai/gpt-5-nano'],
            'the query narrows the category'
        );
    });

    it('does not leak paid models into Free', () => {
        const freeIds = ids(filterModelsForPicker(models, { provider: FREE_CATEGORY, context: context() }));

        assertEqual(freeIds.some((id) => id.startsWith('anthropic/')), false, 'paid Anthropic model excluded');
        assertEqual(freeIds.some((id) => id.startsWith('google/')), false, 'paid Google model excluded');
    });
});

describe('Model Visibility Under a Filter', () => {
    it('includes free models and excludes paid ones in the Free category', () => {
        assertEqual(modelVisibleForFilter(models[2], FREE_CATEGORY, context()), true, 'free model is listed');
        assertEqual(modelVisibleForFilter(models[0], FREE_CATEGORY, context()), false, 'paid model is not');
    });

    it('keeps favourites listed under a filter', () => {
        // Regression: favourites were skipped under any filter, which left the
        // Free default with an empty model select.
        assertEqual(
            modelVisibleForFilter(models[2], FREE_CATEGORY, context(['openai/gpt-5-nano'])),
            true,
            'a favourite free model still appears under Free'
        );
    });

    it('lists favourites separately when nothing is filtered', () => {
        assertEqual(
            modelVisibleForFilter(models[2], '', context(['openai/gpt-5-nano'])),
            false,
            'favourite is handled by the favourites block, not the main list'
        );
        assertEqual(modelVisibleForFilter(models[0], '', context()), true, 'non-favourites still listed');
    });

    it('filters by provider name', () => {
        assertEqual(modelVisibleForFilter(models[0], 'Anthropic', context()), true, 'matching provider listed');
        assertEqual(modelVisibleForFilter(models[1], 'Anthropic', context()), false, 'other provider excluded');
    });
});

describe('Category Picker Model Search', () => {
    it('finds models by display name and by id', () => {
        const byName = modelSearchResults(models, 'gemini', []);
        assertEqual(ids(byName.results), ['google/gemini-3.1'], 'matches the display name');
        assertEqual(byName.total, 1, 'total counts every match');
        assertEqual(byName.truncated, false, 'a short list needs no truncation note');

        const byId = modelSearchResults(models, 'rocinante-12b', []);
        assertEqual(ids(byId.results), ['thedrummer/rocinante-12b-v1.1'], 'matches the id');
    });

    it('searches the whole catalogue, not just one category', () => {
        // The point of the search: reach a model without first picking its category.
        const result = modelSearchResults(models, 'claude', []);
        assertEqual(ids(result.results), ['anthropic/claude-opus-4.8:thinking'], 'paid model found with no category filter');
    });

    it('lists nothing for an empty query', () => {
        assertEqual(modelSearchResults(models, '', []).results.length, 0, 'empty query lists no models');
        assertEqual(modelSearchResults(models, '   ', []).results.length, 0, 'whitespace is not a query');
    });

    it('keeps favourites at the top of the matches', () => {
        const result = modelSearchResults(models, 'e', ['google/gemini-3.1'], 100);
        assertEqual(result.results[0].id, 'google/gemini-3.1', 'favourite matches sort first');
    });

    it('caps a broad query and reports how many matched', () => {
        const many = Array.from({ length: 60 }, (unused, index) => ({
            id: `vendor-${index}/model-${index}`,
            name: `Vendor ${index}: Model ${index}`,
            pricing: { prompt: 0.000001, completion: 0.000002 }
        }));

        const result = modelSearchResults(many, 'model', []);
        assertEqual(result.results.length, PROVIDER_SEARCH_MODEL_LIMIT, 'lists one page of matches');
        assertEqual(result.total, 60, 'counts every match');
        assertEqual(result.truncated, true, 'flags that the list was cut short');

        const explicit = modelSearchResults(models, 'o', [], 2);
        assertEqual(explicit.results.length, 2, 'respects an explicit limit');
        assertEqual(explicit.truncated, true, 'still flags truncation');
    });
});