/**
 * Obscurify Chat Configuration
 *
 * This file configures API endpoints for the chat interface.
 * Self-hosters can modify these settings to point to their own backend.
 *
 * For Obscurify.ai, these defaults work out of the box.
 * For custom deployments, adjust the endpoints to match your API.
 */
window.CHAT_CONFIG = {
    api: {
        // Base URL for API requests. Empty string = same origin (default).
        // Set to your API server URL if hosting frontend separately.
        // Example: "https://api.example.com"
        baseUrl: "",

        // Endpoint to fetch available models (GET request)
        // Should return OpenAI-compatible format: { data: [{ id, name, ... }] }
        modelsEndpoint: "/models",

        // Endpoint for authenticated users (POST request)
        // Should accept OpenAI-compatible chat completion format
        chatEndpoint: "/web/chat/completions",

        // Endpoint for anonymous/guest users (POST request)
        // Set to same as chatEndpoint if no distinction needed
        anonChatEndpoint: "/anon/chat/completions",

        // Endpoint to fetch frontier model info (optional)
        // Set to null to disable frontier model distinction
        frontierModelsEndpoint: "/frontier_models",
    },

    features: {
        // Enable WebLLM local model support
        // Requires WebGPU-capable browser
        enableLocalMode: true,

        // Show Tor onion link in sidebar
        // Set to false if not running a Tor hidden service
        enableTorLink: true,
    }
};
