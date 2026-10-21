// chat-config.js — Runtime config resolution (merges window.CHAT_CONFIG with
// sensible defaults) and CSRF token lifecycle: fetch/cache with a 1-minute
// expiry buffer, and a guarded logout-and-redirect path for expired sessions.

// Helper to get config values with defaults
function getConfig() {
    const defaults = {
        api: {
            baseUrl: "",
            modelsEndpoint: "/models",
            chatEndpoint: "/web/chat/completions",
            anonChatEndpoint: "/anon/chat/completions",
            frontierModelsEndpoint: "/frontier_models",
            uncensoredModelsEndpoint: "/uncensored_models",
            csrfEndpoint: "/api/csrf-token",
        },
        features: {
            enableLocalMode: true,
            enableTorLink: true,
        }
    };
    if (typeof window.CHAT_CONFIG === 'undefined') {
        return defaults;
    }
    return {
        api: { ...defaults.api, ...window.CHAT_CONFIG.api },
        features: { ...defaults.features, ...window.CHAT_CONFIG.features }
    };
}

// CSRF token management
let csrfToken = null;
let csrfExpiry = 0;
let sessionRedirectInProgress = false;

function handleSessionExpiryRedirect() {
    if (sessionRedirectInProgress) {
        return;
    }
    sessionRedirectInProgress = true;

    const nextPath = (window.location.pathname || '/') + (window.location.search || '');
    fetch('/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(() => null)
        .finally(() => {
            window.location.href = '/account?next=' + encodeURIComponent(nextPath);
        });
}

async function getCSRFToken() {
    // Return cached token if still valid (with 1 min buffer before expiry)
    if (csrfToken && Date.now() < csrfExpiry - 60000) {
        return csrfToken;
    }

    // Only fetch CSRF token if logged in (anon requests don't need it)
    const loggedIn = typeof isLoggedIn !== 'undefined' ? isLoggedIn : false;
    if (!loggedIn) {
        return null;
    }

    try {
        const config = getConfig();
        const response = await fetch(config.api.baseUrl + config.api.csrfEndpoint, {
            method: 'GET',
            credentials: 'same-origin'
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                handleSessionExpiryRedirect();
            }
            console.warn('Failed to fetch CSRF token:', response.status);
            return null;
        }

        const data = await response.json();
        csrfToken = data.token;
        csrfExpiry = Date.now() + (data.expires_in * 1000);
        return csrfToken;
    } catch (err) {
        console.warn('Error fetching CSRF token:', err);
        return null;
    }
}
