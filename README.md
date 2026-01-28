# Obscurify Chat

A privacy-focused chat interface for AI models. Originally built for [Obscurify.ai](https://obscurify.ai), this frontend is open-source and can be used with any OpenAI-compatible API.

## Features

- Clean, responsive chat interface
- Streaming responses with markdown rendering
- Image attachments for vision-capable models
- Local model support via WebLLM (runs entirely in browser)
- Conversation history stored locally in browser
- No-JavaScript fallback version for Tor users
- Dark theme optimized for privacy-conscious users

## Quick Start

### Option 1: Static HTML (Simplest)

1. Run the render script to generate static HTML:

```bash
python scripts/render-static.py
```

2. Serve the `dist/` directory:

```bash
npx serve dist
# or
python -m http.server 8000 --directory dist
```

3. Configure your API endpoint in `dist/static/js/config.js`

### Option 2: Use with Tera/Jinja2 Backend

The templates use [Tera](https://tera.netlify.app/) syntax (compatible with Jinja2). Copy the `templates/` and `static/` directories to your project and render with your backend.

**Required template variables for `chat.html`:**

| Variable | Type | Description |
|----------|------|-------------|
| `logged_in` | bool | Whether user is authenticated |
| `can_access_frontier` | bool | Whether user can access premium models |
| `default_free_model` | string | Model ID for free tier users |
| `default_paid_model` | string | Model ID for paid tier users |
| `username` | string | Current user's username (empty if guest) |

**Required template variables for `chat_nojs.html`:**

| Variable | Type | Description |
|----------|------|-------------|
| `chat_messages` | array | Array of `{role, content_html}` objects |
| `available_models` | array | Array of `{id, name}` objects |
| `selected_model` | string | Currently selected model ID |
| `message_history` | string | Serialized message history for form |
| `previous_prompt` | string | Previous prompt (for form persistence) |

## Configuration

Edit `static/js/config.js` to customize API endpoints:

```javascript
window.CHAT_CONFIG = {
    api: {
        // Your API server URL (empty = same origin)
        baseUrl: "https://api.example.com",

        // Endpoint to list available models
        modelsEndpoint: "/v1/models",

        // Chat completion endpoint (authenticated users)
        chatEndpoint: "/v1/chat/completions",

        // Chat completion endpoint (anonymous users)
        // Set same as chatEndpoint if no distinction needed
        anonChatEndpoint: "/v1/chat/completions",

        // Set to null to disable frontier model distinction
        frontierModelsEndpoint: null,
    },
    features: {
        enableLocalMode: true,  // WebLLM local models
        enableTorLink: false,   // Show Tor link in sidebar
    }
};
```

## API Requirements

Your backend should implement these OpenAI-compatible endpoints:

### GET `/models`

Returns available models:

```json
{
    "data": [
        {"id": "gpt-4", "name": "GPT-4"},
        {"id": "claude-3", "name": "Claude 3"}
    ]
}
```

### POST `/chat/completions`

Accepts streaming chat completions:

```json
{
    "model": "gpt-4",
    "messages": [
        {"role": "user", "content": "Hello"}
    ],
    "stream": true
}
```

Returns SSE stream with `data: {"choices": [{"delta": {"content": "..."}}]}` format.

## Local Mode (WebLLM)

The chat interface supports running models locally in the browser using [WebLLM](https://github.com/mlc-ai/web-llm). This requires:

- Chrome 113+, Edge 113+, or Opera 99+ (WebGPU support)
- A GPU with sufficient VRAM for the chosen model

Models are downloaded and cached in the browser. No data is sent to any server when using local mode.

## File Structure

```
obscurify-chat/
├── templates/
│   ├── chat.html           # Main chat interface (Tera template)
│   └── chat_nojs.html      # No-JavaScript version (Tera template)
├── static/
│   ├── js/
│   │   ├── chat.js         # Chat logic
│   │   └── config.js       # API configuration
│   └── styles/
│       ├── common.css      # Shared styles
│       ├── chat.css        # Chat-specific styles
│       └── chat_nojs.css   # No-JS specific styles
├── scripts/
│   └── render-static.py    # Template renderer
├── README.md
└── LICENSE
```

## License

MIT License - see [LICENSE](LICENSE)

## Attribution

Originally developed for [Obscurify.ai](https://obscurify.ai) - Your AI Anonymizer.

Tor hidden service: `http://obscure2sm2fs5uqtpuqv4qsalqi6hxtje3xgxmtaeoy4bjlqau6c4id.onion/`
