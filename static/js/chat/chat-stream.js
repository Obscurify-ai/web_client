// chat-stream.js — Core cloud chat pipeline: the `messages` history array,
// the web-search toggle + indicator, and getGPTResult which either delegates
// to the local WASM path or runs the cloud SSE stream. Handles abort,
// incremental SSE parsing, `delta.content` / `delta.reasoning` /
// `delta.reasoning_details` / `delta.web_search` merging, and buffered-tail
// chunk recovery.

// Assistant entries keep the clean answer in `content`, the rendered markdown
// (with <think> and web-search chips) in `display`, and the provider's
// structured `reasoning_details` so it can be replayed on the next turn.
let messages = [];

// Accumulate streamed `reasoning_details` fragments. Fragments sharing an
// `index` (or, without one, consecutive fragments of the same type) are parts
// of one block: text is concatenated and late fields like `signature` filled in.
function mergeReasoningDetails(accumulated, incoming) {
    if (!Array.isArray(incoming)) return accumulated;
    for (const item of incoming) {
        if (!item || typeof item !== 'object') continue;
        const last = accumulated[accumulated.length - 1];
        const target = Number.isInteger(item.index)
            ? accumulated.find(d => d.index === item.index)
            : (last && last.index === undefined && last.type === item.type ? last : null);
        if (!target) {
            accumulated.push(Object.assign({}, item));
            continue;
        }
        for (const [key, value] of Object.entries(item)) {
            if (value === null || value === undefined) continue;
            if (['text', 'summary', 'data'].includes(key) && typeof value === 'string') {
                target[key] = (target[key] || '') + value;
            } else {
                target[key] = value;
            }
        }
    }
    return accumulated;
}

// Build the wire-format history for `model`. Only role/content go out, plus
// reasoning_details on assistant turns produced by the same model (signed or
// encrypted reasoning is not portable across providers). Inline <think> blocks
// and web-search chip tokens are display-only and stripped from content.
// A Code Mode reply carries its tool turns in `trace`: replayed as-is when the request
// offers tools, otherwise flattened into its stored markdown (code, output, answer).
function toApiMessages(history, model, opts) {
    const withTools = Boolean(opts && opts.tools);
    return history.flatMap(msg => {
        if (msg.role === 'assistant' && Array.isArray(msg.trace) && msg.trace.length > 0) {
            if (!withTools) return [{ role: 'assistant', content: msg.display || msg.content || '' }];
            const replay = msg.trace.map(t => {
                const m = { role: t.role, content: t.content };
                if (t.tool_calls) m.tool_calls = t.tool_calls;
                if (t.tool_call_id) m.tool_call_id = t.tool_call_id;
                if (t.reasoning_details && msg.model === model) m.reasoning_details = t.reasoning_details;
                return m;
            });
            return replay.concat([{ role: 'assistant', content: msg.content || '' }]);
        }
        let content = msg.content;
        if (msg.role === 'assistant' && typeof content === 'string') {
            content = content
                .replace(THINK_BLOCK_REGEX, '')
                .replace(WEB_SEARCH_TOKEN_REGEX, '')
                .trim();
        }
        const apiMessage = { role: msg.role, content: content };
        if (msg.role === 'assistant' && msg.model === model && Array.isArray(msg.reasoning_details) && msg.reasoning_details.length > 0) {
            apiMessage.reasoning_details = msg.reasoning_details;
        }
        return [apiMessage];
    });
}

// Web search toggle state
let webSearchEnabled = localStorage.getItem('webSearchEnabled') !== 'false';
const webSearchToggle = document.getElementById('web-search-toggle');
const webSearchIndicator = document.getElementById('web-search-indicator');

function updateWebSearchIndicator() {
    if (webSearchIndicator) {
        webSearchIndicator.classList.toggle('active', webSearchEnabled);
    }
    if (webSearchToggle) {
        webSearchToggle.classList.toggle('active', webSearchEnabled);
    }
}
updateWebSearchIndicator();

if (webSearchToggle) {
    webSearchToggle.addEventListener('click', function (e) {
        e.preventDefault();
        webSearchEnabled = !webSearchEnabled;
        localStorage.setItem('webSearchEnabled', String(webSearchEnabled));
        updateWebSearchIndicator();
    });
}

async function getGPTResult(_promptToRetry, _uniqueIdToRetry) {
    const prompt = _promptToRetry || promptInput.textContent;
    const model = modelSelect.value;

    if (isGeneratingResponse || !prompt) {
        return;
    }
    submitButton.classList.add("loading");
    promptInput.textContent = '';

    let userMessageId = null;
    let userBubble = null;
    if (!_uniqueIdToRetry) {
        userMessageId = addResponse(true, prompt, base64Images);
        userBubble = document.getElementById(userMessageId)?.closest('.message') || null;
    }

    const uniqueId = _uniqueIdToRetry || addResponse(false);

    if (userBubble) {
        userBubble.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    const responseElement = document.getElementById(uniqueId);
    loader(responseElement);
    isGeneratingResponse = true;

    const messageContent = [{ type: "text", text: prompt }];

    if (base64Images && base64Images.length > 0) {
        base64Images.forEach(imgData => {
            messageContent.push({
                type: "image_url",
                image_url: {
                    url: imgData
                }
            });
        });
    }

    messages.push({
        role: "user",
        content: messageContent
    });
    if (userBubble) {
        userBubble.dataset.msgIdx = String(messages.length - 1);
    }

    // Create abort controller for this request
    currentAbortController = new AbortController();
    updateActionButton(true);

    // Check if using local model
    if (typeof isLocalMode !== 'undefined' && isLocalMode && typeof activeLocalModel !== 'undefined' && activeLocalModel && isModelLoaded(activeLocalModel)) {
        try {
            // Warn about images not being supported in local mode
            if (base64Images && base64Images.length > 0) {
                clearInterval(loadInterval);
                const note = document.createElement('p');
                note.style.color = '#fc885a';
                note.style.marginBottom = '12px';
                note.textContent = 'Note: Local models do not support image input. Processing text only.';
                responseElement.replaceChildren(note);
            }

            clearInterval(loadInterval);
            responseElement.textContent = '';
            responseElement.style.color = '';

            const assistantResponse = await runLocalChatCompletion(toApiMessages(messages, activeLocalModel), uniqueId, responseElement);

            // Add the assistant's response to the messages list (with model label for history)
            const localModelLabel = getLocalModelDisplayName(activeLocalModel) + ' (Local)';
            messages.push({ role: "assistant", content: assistantResponse, modelLabel: localModelLabel });

            // Clear image previews after successful send
            base64Images = null;
            imageByteSizes = null;
            updateImagePreviews();
        } catch (err) {
            if (err.name === 'AbortError') {
                clearInterval(loadInterval);
                if (!responseElement.textContent || responseElement.textContent === '.' || responseElement.textContent === '..' || responseElement.textContent === '...') {
                    responseElement.textContent = 'Stopped';
                    responseElement.style.color = '#888';
                }
            } else {
                // Keep the runs shown so far; the error goes under them.
                const errorBox = document.createElement('div');
                errorBox.className = 'code-turn-error';
                responseElement.appendChild(errorBox);
                setErrorForResponse(errorBox, err.message, prompt, uniqueId);
            }
        } finally {
            isGeneratingResponse = false;
            clearInterval(loadInterval);
            submitButton.classList.remove("loading");
            currentAbortController = null;
            updateActionButton(false);
        }
        return;
    }

    // Code Mode: an agent loop that runs the model's code in the browser sandbox
    if (typeof codeModeActive === 'function' && codeModeActive()) {
        try {
            await runCodeTurn({ model, uniqueId, responseElement, prompt });
            base64Images = null;
            imageByteSizes = null;
            updateImagePreviews();
        } catch (err) {
            clearInterval(loadInterval);
            if (err.name === 'AbortError') {
                const stopped = document.createElement('p');
                stopped.className = 'code-turn-stopped';
                stopped.textContent = 'Stopped';
                responseElement.appendChild(stopped);
            } else {
                setErrorForResponse(responseElement, err.message, prompt, uniqueId);
            }
        } finally {
            isGeneratingResponse = false;
            clearInterval(loadInterval);
            submitButton.classList.remove("loading");
            currentAbortController = null;
            updateActionButton(false);
        }
        return;
    }

    // Cloud API path
    const formData = JSON.stringify({
        messages: toApiMessages(messages, model),
        model: model,
        stream: true,
        ...(webSearchEnabled && { web_search: true })
    });

    // Determine which endpoint to use based on auth state
    const config = getConfig();
    const loggedIn = typeof isLoggedIn !== 'undefined' ? isLoggedIn : false;
    const endpoint = config.api.baseUrl + (loggedIn ? config.api.chatEndpoint : config.api.anonChatEndpoint);

    // Build headers - include CSRF token for authenticated /web/ requests
    const headers = { 'Content-Type': 'application/json' };
    if (loggedIn) {
        const token = await getCSRFToken();
        if (token) {
            headers['X-CSRF-Token'] = token;
        }
    }

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            credentials: 'same-origin',
            body: formData,
            signal: currentAbortController.signal
        });

        if (!response.ok) {
            if (loggedIn && (response.status === 401 || response.status === 403)) {
                handleSessionExpiryRedirect();
                return;
            }

            let errorMessage = 'Request failed';
            try {
                const errorText = await response.json();
                errorMessage = errorText && typeof errorText === 'object'
                    ? (errorText.error || errorText.detail || JSON.stringify(errorText))
                    : JSON.stringify(errorText);
            } catch (_err) {
                errorMessage = 'Request failed (' + response.status + ')';
            }
            setErrorForResponse(responseElement, errorMessage, prompt, uniqueId);

            if (base64Images && base64Images.length > 0) {
                const note = document.createElement('p');
                note.textContent = 'Error. Ensure you are using a vision capable model if you are inputting an image.';
                responseElement.appendChild(note);
            }
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;
        let firstOutputReceived = false;

        let assistantContent = '';
        let assistantReasoning = '';
        let reasoningDetails = [];
        let assistantResponse = '';
        const webSearches = [];
        let buffer = '';  // Buffer for incomplete lines across chunks

        const mergeWebSearchDelta = (ws) => {
            if (!ws || typeof ws !== 'object') return;
            const query = typeof ws.query === 'string' ? ws.query : '';
            if (!query) return;
            const entry = {
                query,
                status: typeof ws.status === 'string' ? ws.status : 'done',
                results: typeof ws.results === 'string' ? ws.results : undefined,
                error: typeof ws.error === 'string' ? ws.error : undefined
            };
            const existing = webSearches.findIndex(e => e.query === query);
            if (existing >= 0) {
                webSearches[existing] = Object.assign({}, webSearches[existing], entry);
            } else {
                webSearches.push(entry);
            }
        };

        const updateAssistantRender = (thinkingComplete) => {
            try {
                assistantResponse = buildAssistantResponseMarkdown(
                    assistantContent,
                    assistantReasoning,
                    thinkingComplete,
                    webSearches
                );
                rawContentStore[uniqueId] = assistantResponse;
                renderMarkdownIntoElement(responseElement, assistantResponse);
            } catch (err) {
                console.warn('updateAssistantRender failed; falling back to plain text', err);
                const raw = String(assistantContent || '');
                rawContentStore[uniqueId] = raw;
                responseElement.textContent = raw;
            }
        };

        while (!done) {
            const result = await reader.read();
            const value = result.value;
            const readerDone = result.done;
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                // Keep the last element in buffer (may be incomplete)
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (data === '[DONE]') {
                            done = true;
                            break;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            // Check for error response
                            if (parsed.error) {
                                clearInterval(loadInterval);
                                setErrorForResponse(responseElement, parsed.error.message || 'Unknown error', prompt, uniqueId);
                                done = true;
                                break;
                            }
                            const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                            const content = delta && typeof delta.content === 'string' ? delta.content : '';
                            const reasoning = delta && typeof delta.reasoning === 'string' ? delta.reasoning : '';
                            if (delta) reasoningDetails = mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
                            const webSearch = delta && delta.web_search && typeof delta.web_search === 'object' ? delta.web_search : null;
                            if (webSearch) {
                                mergeWebSearchDelta(webSearch);
                            }
                            if (content || reasoning || webSearch) {
                                if (!firstOutputReceived) {
                                    firstOutputReceived = true;
                                    clearInterval(loadInterval);
                                    responseElement.textContent = '';
                                    responseElement.style.color = '';  // Reset color from loader
                                }
                                assistantContent = mergeStreamingText(assistantContent, content);
                                assistantReasoning = mergeStreamingText(assistantReasoning, reasoning);
                                updateAssistantRender(assistantContent.length > 0);
                            }
                        } catch (parseError) {
                            // Ignore parse errors for incomplete chunks
                        }
                    }
                }
            }
            if (!done) done = readerDone;
        }
        // Process any remaining buffered data
        if (buffer.startsWith('data:')) {
            const data = buffer.substring(5).trim();
            if (data && data !== '[DONE]') {
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                    const content = delta && typeof delta.content === 'string' ? delta.content : '';
                    const reasoning = delta && typeof delta.reasoning === 'string' ? delta.reasoning : '';
                    if (delta) reasoningDetails = mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
                    const webSearch = delta && delta.web_search && typeof delta.web_search === 'object' ? delta.web_search : null;
                    if (webSearch) {
                        mergeWebSearchDelta(webSearch);
                    }
                    if (content || reasoning || webSearch) {
                        if (!firstOutputReceived) {
                            firstOutputReceived = true;
                            clearInterval(loadInterval);
                            responseElement.textContent = '';
                            responseElement.style.color = '';
                        }
                        assistantContent = mergeStreamingText(assistantContent, content);
                        assistantReasoning = mergeStreamingText(assistantReasoning, reasoning);
                        updateAssistantRender(assistantContent.length > 0);
                    }
                } catch (e) { /* ignore */ }
            }
        }

        // Close a still-open thinking block if stream ended before content appeared.
        if (assistantReasoning && assistantContent.length === 0) {
            updateAssistantRender(true);
        }

        // Add the assistant's response to the messages list (with model label for history)
        const cloudModelLabel = model.includes('/') ? model.split('/').pop() : model;
        // A reasoning-only (truncated) reply still needs non-empty content on replay.
        const assistantMessage = {
            role: "assistant",
            content: assistantContent || assistantReasoning.trim(),
            display: assistantResponse,
            model: model,
            modelLabel: cloudModelLabel
        };
        if (reasoningDetails.length > 0) {
            assistantMessage.reasoning_details = reasoningDetails;
        }
        messages.push(assistantMessage);
        if (typeof attachHtmlPreviews === 'function') attachHtmlPreviews(responseElement);

        // Clear image previews after successful send
        base64Images = null;
        imageByteSizes = null;
        updateImagePreviews();
    } catch (err) {
        // Handle abort separately - don't show as error
        if (err.name === 'AbortError') {
            clearInterval(loadInterval);
            // If we got some content, keep it; otherwise show "Stopped"
            if (!responseElement.textContent || responseElement.textContent === '.' || responseElement.textContent === '..' || responseElement.textContent === '...') {
                responseElement.textContent = 'Stopped';
                responseElement.style.color = '#888';
            }
        } else {
            setErrorForResponse(responseElement, err.message, prompt, uniqueId);
        }
    } finally {
        isGeneratingResponse = false;
        clearInterval(loadInterval);
        submitButton.classList.remove("loading");
        currentAbortController = null;
        updateActionButton(false);
    }
}
