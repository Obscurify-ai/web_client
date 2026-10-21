/**
 * Helper functions mirrored from static/js/chat/ modules (formerly chat.js) for unit testing.
 */

function isPaidModel(model) {
    const promptPrice = Number(model?.pricing?.prompt || 0);
    const completionPrice = Number(model?.pricing?.completion || 0);
    return promptPrice > 0 || completionPrice > 0;
}

function escapeRegexLiteral(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesModelPattern(modelId, pattern) {
    if (typeof pattern !== 'string') {
        return false;
    }

    const trimmed = pattern.trim();
    if (!trimmed) {
        return false;
    }

    if (!trimmed.includes('*')) {
        return modelId === trimmed;
    }

    const regexSource = '^' + trimmed.split('*').map(escapeRegexLiteral).join('.*') + '$';
    return new RegExp(regexSource).test(modelId);
}

function modelMatchesAnyPattern(modelId, patterns) {
    if (!Array.isArray(patterns)) {
        return false;
    }
    return patterns.some((pattern) => matchesModelPattern(modelId, pattern));
}

function shouldIncludeModelForSidebar(model, access, restrictions) {
    if (!access.loggedIn) {
        return !isPaidModel(model);
    }

    if (!access.canAccessFrontierModels && modelMatchesAnyPattern(model.id, restrictions.frontierModels)) {
        return false;
    }

    // Always show uncensored models in sidebar (visible but restricted at usage time)
    return true;
}

function extractProvider(modelName) {
    if (modelName.includes(': ')) {
        return modelName.split(': ')[0];
    }
    return '';
}

function getAvailableFavorites(models, favorites) {
    const modelIds = new Set(models.map((m) => m.id));
    return (favorites || []).filter((id, index, arr) => arr.indexOf(id) === index && modelIds.has(id));
}

function buildProviderList(models, favorites) {
    const providers = [...new Set(models.map(m => extractProvider(m.name)).filter(Boolean))].sort();
    const availableFavorites = getAvailableFavorites(models, favorites);
    if (availableFavorites.length > 0) {
        return ['Favorites', ...providers];
    }
    return providers;
}

function buildModelListForProvider(models, selectedProvider, favorites) {
    const availableFavorites = getAvailableFavorites(models, favorites);
    const favoriteSet = new Set(availableFavorites);

    if (selectedProvider === 'Favorites') {
        return availableFavorites;
    }

    const rest = models
        .filter((model) => !favoriteSet.has(model.id))
        .filter((model) => !selectedProvider || extractProvider(model.name) === selectedProvider)
        .map((model) => model.id);

    if (!selectedProvider) {
        return [...availableFavorites, ...rest];
    }

    return rest;
}

function chooseDefaultModel(models, canAccessFrontierModels, defaultPaidModel, defaultFreeModel, favorites) {
    const availableFavorites = getAvailableFavorites(models, favorites);
    if (availableFavorites.length > 0) {
        return availableFavorites[0];
    }

    const modelIds = new Set(models.map((m) => m.id));
    if (canAccessFrontierModels && modelIds.has(defaultPaidModel)) {
        return defaultPaidModel;
    }
    if (modelIds.has(defaultFreeModel)) {
        return defaultFreeModel;
    }
    return models[0]?.id || '';
}

module.exports = {
    isPaidModel,
    escapeRegexLiteral,
    matchesModelPattern,
    modelMatchesAnyPattern,
    shouldIncludeModelForSidebar,
    extractProvider,
    getAvailableFavorites,
    buildProviderList,
    buildModelListForProvider,
    chooseDefaultModel
};
