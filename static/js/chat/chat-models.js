// chat-models.js — Cloud model catalog: fetches /models, /frontier_models,
// /uncensored_models; computes per-model access restrictions (login/upgrade);
// manages favorite-model preferences (localStorage + cookie fallback);
// builds the provider-filter + model-select dropdowns; keeps the prompt
// placeholder in sync with the chosen model.

async function fetchUncensoredModels(config) {
    try {
        const endpoint = config.api.uncensoredModelsEndpoint || "/uncensored_models";
        const response = await fetch(config.api.baseUrl + endpoint);
        const data = await response.json();
        return data.uncensored_models || [];
    } catch (error) {
        console.error('Error fetching uncensored models:', error);
        return [];
    }
}

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

function getModelRestriction(model, access, restrictions) {
    if (!access.loggedIn && isPaidModel(model) && !isGuestModel(model)) {
        return 'login';
    }

    if (!access.canAccessFrontierModels && modelMatchesAnyPattern(model.id, restrictions.frontierModels)) {
        return 'upgrade';
    }

    if (!access.canAccessUncensoredModels && modelMatchesAnyPattern(model.id, restrictions.uncensoredModels)) {
        return 'upgrade';
    }

    return null;
}

// Cached model data for provider filtering
let _allModels = [];
let _modelRestrictions = {};
const FAVORITE_MODELS_STORAGE_KEY = 'obscurify_favorite_models';
const FAVORITE_MODELS_COOKIE_NAME = 'obscurify_favorite_models';
const MAX_FAVORITE_MODELS = 20;
const MAX_FAVORITE_MODEL_LENGTH = 200;
/// Pseudo-provider for the zero-priced models. Anonymous and free-tier callers
/// land here by default, because most providers only hold models they cannot run.
const FREE_CATEGORY = 'Free';

/// "Cheap" is a paid model you can run a lot of: at most $0.50 per million output
/// tokens and $0.25 per million input tokens. Free models count as cheap too.
const CHEAP_COMPLETION_PER_TOKEN = 0.0000005;
const CHEAP_PROMPT_PER_TOKEN = 0.00000025;

/// Curated roleplay / creative-writing fine-tunes. Deliberately conservative:
/// well-known character-roleplay families, not general chat models.
const ROLEPLAY_PATTERNS = [
    '*mythomax*',
    '*remm-slerp*',
    '*rocinante*',
    '*magnum*',
    '*hanami*',
    '*euryale*',
    '*lunaris*',
    '*weaver*',
    '*lumimaid*',
    '*cydonia*',
    '*magidonia*',
    '*storybreaker*',
    '*tenyxchat*',
    '*aion-rp*',
    '*airoboros*'
];

/// Models that expose a reasoning/thinking mode.
const REASONING_PATTERNS = ['*thinking*', '*reasoning*', '*deepseek-r1*', '*-r1-*', '*magistral*'];

/// The model guests chat with (DEFAULT_FREE_MODEL). It is often a paid model
/// that Obscurify pays for, so it is free only for visitors who aren't signed in.
function isGuestModel(model) {
    const loggedIn = typeof isLoggedIn !== 'undefined' ? isLoggedIn : false;
    const guestModelId = typeof defaultFreeModel !== 'undefined' ? defaultFreeModel : '';
    return !loggedIn && Boolean(guestModelId) && model?.id === guestModelId;
}

/// Free means zero-priced, or the guest model for guests: the same rule the
/// anonymous endpoint enforces.
function isFreeModel(model) {
    return !isPaidModel(model) || isGuestModel(model);
}

function isCheapModel(model) {
    if (isFreeModel(model)) {
        return true;
    }
    const pricing = (model && model.pricing) || {};
    const prompt = Number(pricing.prompt) || 0;
    const completion = Number(pricing.completion) || 0;
    return completion <= CHEAP_COMPLETION_PER_TOKEN && prompt <= CHEAP_PROMPT_PER_TOKEN;
}

/// Frontier/uncensored membership comes from the API pattern lists, filled in by
/// fetchAndPopulateModels. Reasoning/roleplay/cheap are computed locally.
let _frontierPatterns = [];
let _uncensoredPatterns = [];

/// Every category offered by the filter, in display order. Favorites leads,
/// because it is the user's own shortlist. `match` receives the model and a
/// context of {favoriteSet, frontierPatterns, uncensoredPatterns}.
const CATEGORY_DEFINITIONS = [
    {
        value: 'Favorites',
        label: 'Favorites',
        match: (model, context) => Boolean(context.favoriteSet && context.favoriteSet.has(model.id))
    },
    { value: '', label: 'All models', match: () => true },
    { value: FREE_CATEGORY, label: FREE_CATEGORY, match: (model) => isFreeModel(model) },
    { value: 'Cheap', label: 'Cheap', match: (model) => isCheapModel(model) },
    {
        value: 'Reasoning',
        label: 'Reasoning',
        match: (model) => modelMatchesAnyPattern(model.id, REASONING_PATTERNS)
    },
    {
        value: 'Uncensored',
        label: 'Uncensored',
        match: (model, context) => modelMatchesAnyPattern(model.id, context.uncensoredPatterns || [])
    },
    {
        value: 'Roleplay',
        label: 'Roleplay',
        match: (model) => modelMatchesAnyPattern(model.id, ROLEPLAY_PATTERNS)
    },
    {
        value: 'Frontier',
        label: 'Frontier',
        match: (model, context) => modelMatchesAnyPattern(model.id, context.frontierPatterns || [])
    }
];

function isCategoryFilter(value) {
    return CATEGORY_DEFINITIONS.some((definition) => definition.value === value);
}

function categoryContext(favoriteIds) {
    const favorites = Array.isArray(favoriteIds)
        ? favoriteIds
        : getAvailableFavoriteModelIds();
    return {
        favoriteSet: new Set(favorites),
        frontierPatterns: _frontierPatterns,
        uncensoredPatterns: _uncensoredPatterns
    };
}

/// Does this model belong to this category filter?
function modelMatchesCategory(model, category, context) {
    const ctx = context || categoryContext();
    const definition = CATEGORY_DEFINITIONS.find((entry) => entry.value === category);
    return definition ? definition.match(model, ctx) : false;
}

function extractProvider(modelName) {
    if (modelName.includes(': ')) {
        return modelName.split(': ')[0];
    }
    return '';
}

function stripProvider(modelName) {
    if (modelName.includes(': ')) {
        return modelName.split(': ').slice(1).join(': ');
    }
    return modelName;
}

function isValidFavoriteModelId(modelId) {
    if (!modelId || modelId.length > MAX_FAVORITE_MODEL_LENGTH) {
        return false;
    }
    return /^[A-Za-z0-9/_:.\-+]+$/.test(modelId);
}

function normalizeFavoriteModels(rawModels) {
    if (!Array.isArray(rawModels)) {
        return [];
    }

    const normalized = [];
    rawModels.forEach((modelId) => {
        const value = String(modelId || '').trim();
        if (!isValidFavoriteModelId(value)) {
            return;
        }
        if (normalized.includes(value)) {
            return;
        }
        normalized.push(value);
    });
    return normalized.slice(0, MAX_FAVORITE_MODELS);
}

function getCookieValue(name) {
    const prefix = name + '=';
    const cookieParts = String(document.cookie || '').split(';');
    for (const part of cookieParts) {
        const cookie = part.trim();
        if (cookie.startsWith(prefix)) {
            return cookie.slice(prefix.length);
        }
    }
    return '';
}

function getFavoriteModelsFromCookie() {
    const rawValue = getCookieValue(FAVORITE_MODELS_COOKIE_NAME);
    if (!rawValue) {
        return [];
    }

    try {
        const decoded = decodeURIComponent(rawValue);
        return normalizeFavoriteModels(decoded.split(','));
    } catch (_error) {
        return [];
    }
}

function getFavoriteModelsPreference() {
    try {
        const rawValue = localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY);
        if (rawValue) {
            const parsed = JSON.parse(rawValue);
            const normalized = normalizeFavoriteModels(parsed);
            if (normalized.length > 0) {
                return normalized;
            }
        }
    } catch (_error) {
        // Fall back to cookie if localStorage is unavailable or invalid.
    }

    return getFavoriteModelsFromCookie();
}

function getAvailableFavoriteModelIds() {
    const favorites = getFavoriteModelsPreference();
    const availableIds = new Set(_allModels.map((model) => model.id));
    return favorites.filter((modelId) => availableIds.has(modelId));
}

// --- favorites (write path) -------------------------------------------------
// The read path above predates this: nothing in the UI ever wrote a favorite, so
// the "Favorites" provider category could never fill up.

function saveFavoriteModels(modelIds) {
    const normalized = normalizeFavoriteModels(modelIds);
    try {
        localStorage.setItem(FAVORITE_MODELS_STORAGE_KEY, JSON.stringify(normalized));
    } catch (_error) {
        // localStorage can be unavailable (private mode); the cookie is the fallback.
    }
    try {
        const value = encodeURIComponent(normalized.join(','));
        const secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? '; Secure' : '';
        document.cookie = `${FAVORITE_MODELS_COOKIE_NAME}=${value}; path=/; max-age=31536000; SameSite=Lax${secure}`;
    } catch (_error) {
        // Cookies can be blocked; localStorage remains the primary store.
    }
}

function isFavoriteModel(modelId) {
    return getFavoriteModelsPreference().includes(modelId);
}

/**
 * Toggle a model in the favorites list.
 * Returns 'added', 'removed', 'limit' or 'invalid' so the caller can explain it.
 */
function toggleFavoriteModel(modelId) {
    if (!isValidFavoriteModelId(modelId)) {
        return 'invalid';
    }

    const current = getFavoriteModelsPreference();
    if (current.includes(modelId)) {
        saveFavoriteModels(current.filter((id) => id !== modelId));
        return 'removed';
    }

    if (current.length >= MAX_FAVORITE_MODELS) {
        return 'limit';
    }

    saveFavoriteModels([...current, modelId]);
    return 'added';
}

// --- picker filtering -------------------------------------------------------

function modelMatchesQuery(model, query) {
    if (!query) {
        return true;
    }
    return `${model.name} ${model.id}`.toLowerCase().includes(query);
}

/**
 * Models to show for the current provider filter and search query, favorites
 * first. Pure, so the test harness can exercise the real implementation.
 */
function sortModelsForPicker(a, b, context) {
    const aFavorite = context.favoriteSet.has(a.id) ? 0 : 1;
    const bFavorite = context.favoriteSet.has(b.id) ? 0 : 1;
    if (aFavorite !== bFavorite) {
        return aFavorite - bFavorite;
    }
    return a.name.localeCompare(b.name);
}

function filterModelsForPicker(models, options) {
    const provider = (options && options.provider) || '';
    const query = String((options && options.query) || '').trim().toLowerCase();
    const favorites = (options && options.favorites) || [];
    const context = (options && options.context) || categoryContext(favorites);

    if (isCategoryFilter(provider)) {
        // Favourites stay pinned to the top of every category, as they were.
        return models
            .filter((model) => modelMatchesCategory(model, provider, context))
            .filter((model) => modelMatchesQuery(model, query))
            .sort((a, b) => sortModelsForPicker(a, b, context));
    }

    return models
        .filter((model) => {
            if (provider && extractProvider(model.name) !== provider) {
                return false;
            }
            return modelMatchesQuery(model, query);
        })
        .sort((a, b) => sortModelsForPicker(a, b, context));
}

// --- picker rendering -------------------------------------------------------

function modelDisplayName(model) {
    return stripProvider(model.name);
}

function syncModelPickerLabel() {
    const label = document.getElementById('model-picker-label');
    if (!label) {
        return;
    }

    const selected = _allModels.find((model) => model.id === modelSelect.value);
    if (selected) {
        label.textContent = modelDisplayName(selected);
        return;
    }

    if (modelSelect.selectedIndex >= 0 && modelSelect.options[modelSelect.selectedIndex]) {
        const text = modelSelect.options[modelSelect.selectedIndex].textContent || '';
        label.textContent = stripProvider(text).replace(/ \((Upgrade|Sign up)\)$/, '') || 'Select a model';
        return;
    }

    label.textContent = 'Select a model';
}

/**
 * Categories and providers for the provider picker, each with a model count.
 * Pure, so the test harness can exercise the real implementation.
 */
function buildProviderEntries(models, favoriteIds, context) {
    const favorites = Array.isArray(favoriteIds) ? favoriteIds : [];
    const ctx = context || categoryContext(favorites);

    const entries = [];
    CATEGORY_DEFINITIONS.forEach((definition) => {
        const count = models.filter((model) => definition.match(model, ctx)).length;
        // Hide categories nothing matches, but always offer All models and
        // Favorites: Favorites is the top category, and showing it at zero with an
        // explanatory empty state is how the feature gets discovered.
        const alwaysShown = definition.value === '' || definition.value === 'Favorites';
        if (count === 0 && !alwaysShown) {
            return;
        }
        entries.push({
            value: definition.value,
            label: definition.label,
            count,
            kind: 'category'
        });
    });

    const countsByProvider = new Map();
    models.forEach((model) => {
        const provider = extractProvider(model.name);
        if (!provider) {
            return;
        }
        countsByProvider.set(provider, (countsByProvider.get(provider) || 0) + 1);
    });

    [...countsByProvider.keys()]
        .sort((a, b) => a.localeCompare(b))
        .forEach((provider) => {
            entries.push({
                value: provider,
                label: provider,
                count: countsByProvider.get(provider),
                kind: 'provider'
            });
        });

    return entries;
}

/**
 * Should a model appear in the model dropdown under the current filter?
 *
 * The filter is a category ("", `Free`, or `Favorites`) or a provider name. Note
 * that favourites are listed separately when nothing is filtered, but are part of
 * the list under any filter — otherwise a favourite would be missing from the
 * underlying select and could not be chosen from the picker.
 *
 * Pure, so the test harness can exercise the real rule.
 */
function modelVisibleForFilter(model, selectedProvider, context) {
    const ctx = context || categoryContext();
    const isFavorite = Boolean(ctx.favoriteSet && ctx.favoriteSet.has(model.id));

    if (!selectedProvider && isFavorite) {
        return false;
    }
    if (isCategoryFilter(selectedProvider)) {
        return modelMatchesCategory(model, selectedProvider, ctx);
    }
    if (selectedProvider) {
        return extractProvider(model.name) === selectedProvider;
    }
    return true;
}

/// How many model matches the category picker offers before it asks for a
/// narrower query. A two-letter query can match hundreds of models.
const PROVIDER_SEARCH_MODEL_LIMIT = 30;

/**
 * Models matching a query in the category picker's search box.
 *
 * That box searches categories and providers; it searches models too, so a model
 * can be chosen straight from the results without first picking a category.
 * Results are capped, because an unselective query matches most of the catalogue.
 *
 * Pure, so the test harness can exercise the real rule.
 */
function modelSearchResults(models, query, favoriteIds, limit) {
    const trimmed = String(query || '').trim();
    const capped = Number.isFinite(limit) ? limit : PROVIDER_SEARCH_MODEL_LIMIT;

    if (!trimmed) {
        return { results: [], total: 0, truncated: false };
    }

    const matches = filterModelsForPicker(models, { provider: '', query: trimmed, favorites: favoriteIds });
    return {
        results: matches.slice(0, capped),
        total: matches.length,
        truncated: matches.length > capped
    };
}

/// Description shown on the provider picker button for a given filter value.
function providerSelectionLabel(value, entries) {
    const source = entries || buildProviderEntries(_allModels, getAvailableFavoriteModelIds());
    const match = source.find((entry) => entry.value === value);
    if (match) {
        return match.label;
    }
    return value || 'All models';
}

function buildProviderRow(entry, selectedValue) {
    const isActive = entry.value === selectedValue;
    const row = document.createElement('div');
    row.className = 'model-picker-row';
    row.setAttribute('role', 'option');
    row.dataset.providerValue = entry.value;
    row.tabIndex = 0;
    row.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) {
        row.classList.add('model-picker-row--selected');
    }

    const text = document.createElement('span');
    text.className = 'model-picker-row-text';
    const name = document.createElement('span');
    name.className = 'model-picker-row-name';
    name.textContent = entry.label;
    text.append(name);

    const count = document.createElement('span');
    count.className = 'model-picker-row-count';
    count.textContent = isActive ? `\u2713 ${entry.count}` : String(entry.count);

    row.append(text, count);
    return row;
}

function syncProviderPickerLabel() {
    const label = document.getElementById('provider-picker-label');
    if (!label) {
        return;
    }
    const providerSelect = document.getElementById('provider-select');
    const value = providerSelect ? providerSelect.value : '';
    label.textContent = providerSelectionLabel(value);
}

function renderProviderPicker() {
    const list = document.getElementById('provider-picker-list');
    if (!list) {
        return;
    }

    syncProviderPickerLabel();
    list.replaceChildren();

    if (_allModels.length === 0) {
        const loading = document.createElement('p');
        loading.className = 'model-picker-empty';
        loading.textContent = 'Loading models...';
        list.appendChild(loading);
        return;
    }

    const search = document.getElementById('provider-search');
    const query = (search ? search.value : '').trim().toLowerCase();
    const providerSelect = document.getElementById('provider-select');
    const selected = providerSelect ? providerSelect.value : '';
    const entries = buildProviderEntries(_allModels, getAvailableFavoriteModelIds());
    const matches = query
        ? entries.filter((entry) => entry.label.toLowerCase().includes(query))
        : entries;
    const favorites = getAvailableFavoriteModelIds();
    const modelMatches = modelSearchResults(_allModels, query, favorites);

    if (matches.length === 0 && modelMatches.results.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'model-picker-empty';
        empty.textContent = `Nothing matches "${query}"`;
        list.appendChild(empty);
        return;
    }

    const groups = [
        ['Categories', matches.filter((entry) => entry.kind === 'category')],
        ['Providers', matches.filter((entry) => entry.kind === 'provider')]
    ];

    groups.forEach(([title, groupEntries]) => {
        if (groupEntries.length === 0) {
            return;
        }
        const heading = document.createElement('p');
        heading.className = 'model-picker-group-title';
        heading.textContent = title;
        list.appendChild(heading);
        groupEntries.forEach((entry) => {
            list.appendChild(buildProviderRow(entry, selected));
        });
    });

    // Models last: typing a model name then picking it is a one-step way to
    // switch model, whatever category or provider happens to be filtered.
    if (modelMatches.results.length > 0) {
        const heading = document.createElement('p');
        heading.className = 'model-picker-group-title';
        heading.textContent = 'Models';
        list.appendChild(heading);

        const favoriteSet = new Set(favorites);
        modelMatches.results.forEach((model) => {
            list.appendChild(buildPickerRow(model, favoriteSet));
        });

        if (modelMatches.truncated) {
            const note = document.createElement('p');
            note.className = 'model-picker-note';
            note.textContent = `Showing the first ${modelMatches.results.length} of `
                + `${modelMatches.total} matching models \u2014 keep typing to narrow it down.`;
            list.appendChild(note);
        }
    }
}

function selectProvider(value) {
    const providerSelect = document.getElementById('provider-select');
    if (!providerSelect) {
        return;
    }
    providerSelect.value = value;
    // The existing change listener rebuilds the model list and both pickers.
    providerSelect.dispatchEvent(new Event('change'));
    closeProviderPicker();
}

/// Select a model straight from the category picker's search results.
///
/// That search spans the whole catalogue, so the chosen model may sit outside the
/// current category — and only models passing the current filter exist in the
/// underlying <select>. Fall back to "All models" when the option is missing.
function selectModelFromSearch(modelId) {
    if (!modelId) {
        return;
    }

    const providerSelect = document.getElementById('provider-select');
    const optionExists = typeof modelSelect.querySelector === 'function'
        && modelSelect.querySelector(`option[value="${modelId}"]:not(:disabled)`);

    if (!optionExists && providerSelect && providerSelect.value !== '') {
        providerSelect.value = '';
        providerSelect.dispatchEvent(new Event('change'));
    }

    selectModelFromPicker(modelId);
    closeProviderPicker();
}

function openProviderPicker() {
    const panel = document.getElementById('provider-picker-panel');
    const toggle = document.getElementById('provider-picker-toggle');
    const search = document.getElementById('provider-search');
    if (!panel || !toggle) {
        return;
    }
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    if (search) {
        search.value = '';
        search.focus();
    }
    renderProviderPicker();
}

function closeProviderPicker() {
    const panel = document.getElementById('provider-picker-panel');
    const toggle = document.getElementById('provider-picker-toggle');
    if (panel) {
        panel.hidden = true;
    }
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
    }
}

function handleProviderRowSelection(event) {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) {
        return;
    }

    // Model rows are the category picker's search results for models.
    const modelRow = target.closest('[data-model-id]');
    if (modelRow) {
        if (modelRow.getAttribute('aria-disabled') !== 'true') {
            selectModelFromSearch(modelRow.dataset.modelId);
        }
        return;
    }

    const row = target.closest('[data-provider-value]');
    if (!row) {
        return;
    }
    selectProvider(row.dataset.providerValue || '');
}

function initProviderPicker() {
    const picker = document.getElementById('provider-picker');
    const toggle = document.getElementById('provider-picker-toggle');
    const list = document.getElementById('provider-picker-list');
    const search = document.getElementById('provider-search');
    if (!picker || !toggle || !list) {
        return;
    }

    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const panel = document.getElementById('provider-picker-panel');
        if (panel && panel.hidden) {
            openProviderPicker();
        } else {
            closeProviderPicker();
        }
    });

    if (search) {
        search.addEventListener('input', renderProviderPicker);
    }

    list.addEventListener('click', handleProviderRowSelection);
    list.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleProviderRowSelection(event);
    });

    document.addEventListener('click', (event) => {
        if (!picker.contains(event.target)) {
            closeProviderPicker();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeProviderPicker();
        }
    });
}

function populateProviderDropdown(favoriteModelIds) {
    const providerSelect = document.getElementById('provider-select');
    if (!providerSelect) {
        return;
    }

    const favorites = favoriteModelIds || getAvailableFavoriteModelIds();
    const previous = providerSelect.value;
    const entries = buildProviderEntries(_allModels, favorites);

    providerSelect.replaceChildren();

    entries.forEach((entry) => {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = `${entry.label} (${entry.count})`;
        providerSelect.appendChild(option);
    });

    // Keep the current filter selected when it still exists.
    if (previous && entries.some((entry) => entry.value === previous)) {
        providerSelect.value = previous;
    }

    renderProviderPicker();
}

function buildPickerRow(model, favoriteSet) {
    const restriction = _modelRestrictions[model.id] || null;
    const isFavorite = favoriteSet.has(model.id);

    const row = document.createElement('div');
    row.className = 'model-picker-row';
    row.setAttribute('role', 'option');
    row.dataset.modelId = model.id;
    row.setAttribute('aria-selected', model.id === modelSelect.value ? 'true' : 'false');
    row.title = model.id;

    if (model.id === modelSelect.value) {
        row.classList.add('model-picker-row--selected');
    }

    if (restriction) {
        row.classList.add('model-picker-row--restricted');
        row.setAttribute('aria-disabled', 'true');
    } else {
        row.tabIndex = 0;
    }

    const text = document.createElement('span');
    text.className = 'model-picker-row-text';

    const name = document.createElement('span');
    name.className = 'model-picker-row-name';
    name.textContent = restriction
        ? `${modelDisplayName(model)} (${restriction === 'login' ? 'Sign up' : 'Upgrade'})`
        : modelDisplayName(model);

    const provider = document.createElement('span');
    provider.className = 'model-picker-row-provider';
    provider.textContent = extractProvider(model.name) || model.id;

    text.append(name, provider);

    const heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'model-picker-heart' + (isFavorite ? ' is-favorite' : '');
    heart.dataset.heartFor = model.id;
    heart.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
    heart.setAttribute('aria-label', isFavorite
        ? `Remove ${modelDisplayName(model)} from favorites`
        : `Add ${modelDisplayName(model)} to favorites`);
    heart.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
    heart.textContent = isFavorite ? '\u2665' : '\u2661';

    // Hearting a model must not change which model is selected.
    heart.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const result = toggleFavoriteModel(model.id);
        const note = document.getElementById('model-picker-limit');
        if (note) {
            note.hidden = result !== 'limit';
        }
        if (result === 'limit') {
            return;
        }

        populateProviderDropdown(getAvailableFavoriteModelIds());
        renderModelPicker();
    });

    row.append(text, heart);
    return row;
}

function renderModelPicker() {
    const list = document.getElementById('model-picker-list');
    if (!list) {
        return;
    }

    syncModelPickerLabel();

    const search = document.getElementById('model-search');
    const query = search ? search.value : '';
    const providerSelect = document.getElementById('provider-select');
    const provider = providerSelect ? providerSelect.value : '';
    const favorites = getAvailableFavoriteModelIds();
    const favoriteSet = new Set(favorites);

    list.replaceChildren();

    if (_allModels.length === 0) {
        const loading = document.createElement('p');
        loading.className = 'model-picker-empty';
        loading.textContent = 'Loading models...';
        list.appendChild(loading);
        return;
    }

    const matches = filterModelsForPicker(_allModels, { provider, query, favorites });

    if (matches.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'model-picker-empty';
        if (provider === 'Favorites' && favorites.length === 0 && !query) {
            empty.textContent = 'No favorites yet \u2014 tap the \u2661 on any model to add one.';
        } else {
            empty.textContent = query ? `No models match "${query}"` : 'No models available';
        }
        list.appendChild(empty);
        return;
    }

    const groups = [];
    if (provider === 'Favorites') {
        groups.push(['Favorites', matches]);
    } else {
        const favoriteMatches = matches.filter((model) => favoriteSet.has(model.id));
        const otherMatches = matches.filter((model) => !favoriteSet.has(model.id));
        if (favoriteMatches.length > 0) {
            groups.push(['Favorites', favoriteMatches]);
        }
        if (otherMatches.length > 0) {
            groups.push([query ? 'Results' : (provider ? `${provider} models` : 'All models'), otherMatches]);
        }
    }

    groups.forEach(([title, groupModels]) => {
        const heading = document.createElement('p');
        heading.className = 'model-picker-group-title';
        heading.textContent = title;
        list.appendChild(heading);

        groupModels.forEach((model) => {
            list.appendChild(buildPickerRow(model, favoriteSet));
        });
    });

    if (!query && typeof list.querySelector === 'function') {
        const selectedRow = list.querySelector('.model-picker-row--selected');
        if (selectedRow && typeof selectedRow.scrollIntoView === 'function') {
            selectedRow.scrollIntoView({ block: 'nearest' });
        }
    }
}

// --- picker behaviour -------------------------------------------------------

function openModelPicker() {
    const panel = document.getElementById('model-picker-panel');
    const toggle = document.getElementById('model-picker-toggle');
    const search = document.getElementById('model-search');
    if (!panel || !toggle) {
        return;
    }

    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    if (search) {
        search.value = '';
        search.focus();
    }
    renderModelPicker();
}

function closeModelPicker() {
    const panel = document.getElementById('model-picker-panel');
    const toggle = document.getElementById('model-picker-toggle');
    if (panel) {
        panel.hidden = true;
    }
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
    }
}

function selectModelFromPicker(modelId) {
    if (!modelId || !modelSelect.querySelector(`option[value="${modelId}"]:not(:disabled)`)) {
        return;
    }
    modelSelect.value = modelId;
    modelSelect.dispatchEvent(new Event('change'));
    closeModelPicker();
}

function handlePickerRowSelection(event) {
    if (event.target.closest && event.target.closest('.model-picker-heart')) {
        return;
    }
    const row = event.target.closest ? event.target.closest('.model-picker-row') : null;
    if (!row || row.getAttribute('aria-disabled') === 'true') {
        return;
    }
    selectModelFromPicker(row.dataset.modelId);
}

function initModelPicker() {
    const picker = document.getElementById('model-picker');
    const toggle = document.getElementById('model-picker-toggle');
    const list = document.getElementById('model-picker-list');
    const search = document.getElementById('model-search');
    if (!picker || !toggle || !list) {
        return;
    }

    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const panel = document.getElementById('model-picker-panel');
        if (panel && panel.hidden) {
            openModelPicker();
        } else {
            closeModelPicker();
        }
    });

    if (search) {
        search.addEventListener('input', renderModelPicker);
    }

    list.addEventListener('click', handlePickerRowSelection);
    list.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handlePickerRowSelection(event);
    });

    document.addEventListener('click', (event) => {
        if (!picker.contains(event.target)) {
            closeModelPicker();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeModelPicker();
        }
    });
}

function populateModelDropdown(selectedProvider) {
    const configDefaultFreeModel = typeof defaultFreeModel !== 'undefined' ? defaultFreeModel : '';
    const configDefaultPaidModel = typeof defaultPaidModel !== 'undefined' ? defaultPaidModel : 'anthropic/claude-opus-4.5';
    const canAccessFrontierModels = typeof canAccessFrontier !== 'undefined' ? canAccessFrontier : false;
    const favoriteModelIds = getAvailableFavoriteModelIds();
    const primaryFavoriteModelId = favoriteModelIds[0] || '';
    const favoriteSet = new Set(favoriteModelIds);
    const filterContext = {
        favoriteSet,
        frontierPatterns: _frontierPatterns,
        uncensoredPatterns: _uncensoredPatterns
    };

    // Remember current selection to try to preserve it
    const previousValue = modelSelect.value;

    modelSelect.replaceChildren();
    const optionsFragment = document.createDocumentFragment();
    let firstAvailableModelId = '';
    let hasDefaultFreeOption = false;
    let hasDefaultPaidOption = false;
    let hasPrimaryFavoriteOption = false;
    let hasPreviousValue = false;

    const appendModelOption = (model, displayName) => {
        const restriction = _modelRestrictions[model.id] || null;
        const option = document.createElement('option');
        option.value = model.id;

        if (restriction) {
            const label = restriction === 'login' ? 'Sign up' : 'Upgrade';
            option.textContent = `${displayName} (${label})`;
            option.disabled = true;
        } else {
            option.textContent = displayName;
            if (!firstAvailableModelId) {
                firstAvailableModelId = model.id;
            }
            if (model.id === configDefaultFreeModel) {
                hasDefaultFreeOption = true;
            }
            if (model.id === configDefaultPaidModel) {
                hasDefaultPaidOption = true;
            }
            if (model.id === primaryFavoriteModelId) {
                hasPrimaryFavoriteOption = true;
            }
            if (model.id === previousValue) {
                hasPreviousValue = true;
            }
        }

        optionsFragment.appendChild(option);
    };

    if (selectedProvider === 'Favorites') {
        favoriteModelIds.forEach((favoriteId) => {
            const model = _allModels.find((item) => item.id === favoriteId);
            if (!model) {
                return;
            }
            appendModelOption(model, stripProvider(model.name));
        });
    } else {
        if (!selectedProvider) {
            favoriteModelIds.forEach((favoriteId) => {
                const model = _allModels.find((item) => item.id === favoriteId);
                if (!model) {
                    return;
                }
                appendModelOption(model, `Favorites: ${stripProvider(model.name)}`);
            });
        }

        _allModels.forEach((model) => {
            if (!modelVisibleForFilter(model, selectedProvider, filterContext)) {
                return;
            }

            const displayName = selectedProvider ? stripProvider(model.name) : model.name;
            appendModelOption(model, displayName);
        });
    }
    modelSelect.appendChild(optionsFragment);

    // Try to preserve previous selection
    if (hasPreviousValue) {
        modelSelect.value = previousValue;
    } else if (primaryFavoriteModelId && hasPrimaryFavoriteOption) {
        modelSelect.value = primaryFavoriteModelId;
    } else if (canAccessFrontierModels && hasDefaultPaidOption) {
        modelSelect.value = configDefaultPaidModel;
    } else if (configDefaultFreeModel && hasDefaultFreeOption) {
        modelSelect.value = configDefaultFreeModel;
    } else if (firstAvailableModelId) {
        modelSelect.value = firstAvailableModelId;
    }

    updateModelDisplayName();
    renderModelPicker();
    syncProviderPickerLabel();
}

async function fetchAndPopulateModels() {
    try {
        const config = getConfig();
        const modelsPromise = fetch(config.api.baseUrl + config.api.modelsEndpoint).then(async (response) => {
            if (!response.ok) {
                throw new Error('HTTP error! status: ' + response.status);
            }
            return response.json();
        });

        // Fetch restriction lists in parallel with models.
        const frontierPromise = config.api.frontierModelsEndpoint
            ? fetch(config.api.baseUrl + config.api.frontierModelsEndpoint)
                .then(async (response) => response.json())
                .then((data) => data.frontier_models || [])
                .catch((e) => {
                    console.error('Failed to fetch frontier models:', e);
                    return [];
                })
            : Promise.resolve([]);

        const uncensoredPromise = fetchUncensoredModels(config);
        const [data, frontierModels, uncensoredModels] = await Promise.all([
            modelsPromise,
            frontierPromise,
            uncensoredPromise
        ]);

        // Sort the models alphabetically by name
        data.data.sort((a, b) => a.name.localeCompare(b.name));
        _allModels = data.data;

        // Frontier and Uncensored membership comes from these pattern lists.
        _frontierPatterns = frontierModels;
        _uncensoredPatterns = uncensoredModels;

        // Check if user is logged in (using global variable from template)
        const loggedIn = typeof isLoggedIn !== 'undefined' ? isLoggedIn : false;
        const canAccessFrontierModels = typeof canAccessFrontier !== 'undefined' ? canAccessFrontier : false;
        const canAccessUncensoredModels = typeof canAccessUncensored !== 'undefined' ? canAccessUncensored : false;

        // Pre-compute restrictions for all models
        _modelRestrictions = {};
        _allModels.forEach(model => {
            const restriction = getModelRestriction(
                model,
                { loggedIn, canAccessFrontierModels, canAccessUncensoredModels },
                { frontierModels, uncensoredModels }
            );
            if (restriction) {
                _modelRestrictions[model.id] = restriction;
            }
        });

        // Populate provider dropdown (Favorites shows up here as a category)
        const favoriteModelIds = getAvailableFavoriteModelIds();
        populateProviderDropdown(favoriteModelIds);

        // Free-tier and anonymous callers land on the Free category: under "All
        // models" they mostly see providers whose models they cannot run.
        const defaultProvider = canAccessFrontierModels ? '' : FREE_CATEGORY;
        if (providerSelectElement) {
            providerSelectElement.value = defaultProvider;
        }

        // Populate model dropdown for the default category
        populateModelDropdown(defaultProvider);

        // Set default model based on tier access
        const configDefaultFreeModel = typeof defaultFreeModel !== 'undefined' ? defaultFreeModel : '';
        const configDefaultPaidModel = typeof defaultPaidModel !== 'undefined' ? defaultPaidModel : 'anthropic/claude-opus-4.5';
        const preferredDefaultModel = favoriteModelIds[0]
            || (canAccessFrontierModels ? configDefaultPaidModel : configDefaultFreeModel);

        if (preferredDefaultModel
            && modelSelect.querySelector(`option[value="${preferredDefaultModel}"]:not(:disabled)`)) {
            modelSelect.value = preferredDefaultModel;
        }

        updateModelDisplayName();
    } catch (error) {
        console.error("Failed to fetch models:", error);
    }
}

function updateModelDisplayName() {
    syncModelPickerLabel();

    if (modelSelect.selectedIndex >= 0) {
        const selectedOption = modelSelect.options[modelSelect.selectedIndex];
        let modelName = selectedOption.textContent;
        if (modelName.includes('Loading')) {
            landingPromptInput.setAttribute('data-placeholder', 'Chatting anonymously');
            chatPromptInput.setAttribute('data-placeholder', 'Chatting anonymously');
            return;
        }
        if (modelName.includes(': ')) {
            modelName = modelName.split(': ').slice(1).join(': ');
        }
        modelName = modelName.replace(/ \((Upgrade|Sign up)\)$/, '');
        const placeholder = `Chatting anonymously with ${modelName}`;
        landingPromptInput.setAttribute('data-placeholder', placeholder);
        chatPromptInput.setAttribute('data-placeholder', placeholder);
    }
}

// Update model display name when user changes model
modelSelect.addEventListener('change', updateModelDisplayName);

// Filter models when provider changes
const providerSelectElement = document.getElementById('provider-select');
if (providerSelectElement) {
    providerSelectElement.addEventListener('change', function () {
        populateModelDropdown(this.value);
    });
}

initModelPicker();
initProviderPicker();

document.addEventListener("DOMContentLoaded", function () {
    landingPromptInput.focus();
    void fetchAndPopulateModels();
});

// If this script is ever evaluated after DOMContentLoaded has already fired (a
// deferred/late load, Rocket Loader, or a re-injection), the listener above
// never runs and the picker would stay empty. Populate now in that case.
if (typeof document !== 'undefined'
    && document.readyState !== 'loading'
    && !_allModels.length
    && typeof getConfig === 'function') {
    void fetchAndPopulateModels();
}

// Exported for the Node test harness; browsers ignore this block.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeFavoriteModels,
        isValidFavoriteModelId,
        isFavoriteModel,
        toggleFavoriteModel,
        filterModelsForPicker,
        modelMatchesQuery,
        buildProviderEntries,
        modelSearchResults,
        PROVIDER_SEARCH_MODEL_LIMIT,
        providerSelectionLabel,
        modelVisibleForFilter,
        modelMatchesCategory,
        isCategoryFilter,
        categoryContext,
        isCheapModel,
        CATEGORY_DEFINITIONS,
        ROLEPLAY_PATTERNS,
        REASONING_PATTERNS,
        isFreeModel,
        isGuestModel,
        getModelRestriction,
        isPaidModel,
        extractProvider,
        stripProvider,
        FREE_CATEGORY,
        MAX_FAVORITE_MODELS,
        FAVORITE_MODELS_STORAGE_KEY,
        FAVORITE_MODELS_COOKIE_NAME
    };
}
