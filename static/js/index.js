const converter = new showdown.Converter();
let promptToRetry = null;
let uniqueIdToRetry = null;

const submitButton = document.getElementById('submit-button');
const regenerateResponseButton = document.getElementById('regenerate-response-button');
const promptInput = document.getElementById('prompt-input');
const imageData = document.getElementById('image-input');
const modelSelect = document.getElementById('model-select');
const responseList = document.getElementById('response-list');
let isGeneratingResponse = false;

let loadInterval = null;

function showResponseList() {
    document.getElementById('response-list').style.display = 'block';
}

promptInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.shiftKey) {
            document.execCommand('insertHTML', false, '<br/><br/>');
        } else {
            document.getElementById('landing-content')?.classList.add('hidden');
            document.getElementById('how-it-works')?.classList.add('hidden');
            showResponseList();
            getGPTResult();
        }
    }
});

submitButton.addEventListener("click", () => {
    // document.getElementById('landing-content').classList.add('hidden');
    // document.getElementById('how-it-works').classList.add('hidden');
    showResponseList();
    getGPTResult();
});

function generateUniqueId() {
    const timestamp = Date.now();
    const randomNumber = Math.random();
    const hexadecimalString = randomNumber.toString(16);

    return `id-${timestamp}-${hexadecimalString}`;
}

function addResponse(selfFlag, prompt) {
    const uniqueId = generateUniqueId();
    const html = `
        <div class="message ${selfFlag ? 'user-message' : 'assistant-message'}" 
             style="border: 1px solid purple;">
            <strong>${selfFlag ? 'User' : 'Assistant'}:</strong>
            <div class="prompt-content" id="${uniqueId}">${prompt}</div>
        </div>
    `;
    responseList.insertAdjacentHTML('beforeend', html);
    responseList.scrollTop = responseList.scrollHeight;
    return uniqueId;
}

function loader(element) {
    element.textContent = '.'

    loadInterval = setInterval(() => {
        element.textContent += '.';
        if (element.textContent === '....') {
            element.textContent = '.';
        }
    }, 300);
}

function setErrorForResponse(element, message) {
    element.innerText = message;
    element.style.color = 'rgb(255, 84, 84)';
}

function setRetryResponse(prompt, uniqueId) {
    promptToRetry = prompt;
    uniqueIdToRetry = uniqueId;
    if (regenerateResponseButton) {
        regenerateResponseButton.style.display = 'flex';
    }
}

async function regenerateGPTResult() {
    try {
        await getGPTResult(promptToRetry, uniqueIdToRetry)
        regenerateResponseButton.classList.add("loading");
    } finally {
        regenerateResponseButton.classList.remove("loading");
    }
}

async function fetchAndPopulateModels() {
    const modelSelect = document.getElementById('model-select');
    try {
        const response = await fetch('/models');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        // Sort the models alphabetically by name
        data.data.sort((a, b) => a.name.localeCompare(b.name));

        data.data.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name; // Use the model name as the display text
            modelSelect.appendChild(option);
        });
    } catch (error) {
        console.error("Failed to fetch models:", error);
    }
}

document.addEventListener("DOMContentLoaded", function () {
    promptInput.focus();
    fetchAndPopulateModels(); // Populate model options
});

let base64Images = null;
// base64 encode image
document.getElementById('image-input').addEventListener('change', function () {
    const files = this.files;
    base64Images = []; // Initialize as an array to hold multiple images
    Array.from(files).forEach(file => {
        if (file) {
            const reader = new FileReader();
            reader.onload = function (event) {
                // Push each base64 encoded string to the array
                base64Images.push(event.target.result);
            };
            reader.readAsDataURL(file);
        }
    });
});

let messages = [];

async function getGPTResult(_promptToRetry, _uniqueIdToRetry) {
    const prompt = _promptToRetry ?? promptInput.textContent;
    // const imageData = base64Images;
    const token = document.getElementById('token-input').value;
    const model = modelSelect.value;

    if (isGeneratingResponse || !prompt) {
        return;
    }
    submitButton.classList.add("loading");
    promptInput.textContent = '';

    if (!_uniqueIdToRetry) {
        addResponse(true, prompt);
    }

    const uniqueId = _uniqueIdToRetry ?? addResponse(false);
    const responseElement = document.getElementById(uniqueId);
    loader(responseElement);
    isGeneratingResponse = true;

    const messageContent = [{ type: "text", text: prompt }];

    if (base64Images && base64Images.length > 0) {
        base64Images.forEach(imageData => {
            messageContent.push({
                type: "image_url",
                image_url: imageData
            });
        });
    }

    messages.push({
        role: "user",
        content: messageContent
    });

    const formData = JSON.stringify({
        messages: messages,
        model: model,
        stream: true
    });

    try {
        const response = await fetch('/chat/completions/', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: formData
        });

        if (!response.ok) {
            setRetryResponse(prompt, uniqueId);
            const errorText = await response.json();
            console.log('Full error object:', errorText);
            const errorMessage = errorText && typeof errorText === 'object' && 'detail' in errorText
                ? errorText.detail
                : JSON.stringify(errorText);
            setErrorForResponse(responseElement, `Error: ${errorMessage}`);


            if (base64Images && base64Images.length > 0) {
                responseElement.innerHTML += '<p>Error. Ensure you are using a vision capable model if you are inputting an image.</p>';
            }
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;

        responseElement.textContent = '';
        clearInterval(loadInterval);

        let assistantResponse = '';

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            if (value) {
                const chunk = decoder.decode(value);
                // console.log("Raw chunk:", chunk);
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (data === '[DONE]') {
                            done = true;
                            break;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices[0].delta.content;
                            if (content) {
                                assistantResponse += content;
                                const htmlContent = converter.makeHtml(assistantResponse);
                                responseElement.innerHTML = htmlContent;

                                // black highlight on all code blocks
                                // responseElement.querySelectorAll('pre code').forEach((block) => {
                                //     hljs.highlightElement(block);
                                // });
                            }
                        } catch (parseError) {
                            // TODO better handling
                            console.error("Failed to parse JSON:", parseError);
                            console.log("Raw data:", data);
                        }
                    }
                }
            }
            done = readerDone;
        }

        // Add the assistant's response to the messages list
        messages.push({ role: "assistant", content: assistantResponse });

        promptToRetry = null;
        uniqueIdToRetry = null;
        if (regenerateResponseButton) {
            regenerateResponseButton.style.display = 'none';
        }
        setTimeout(() => {
            responseList.scrollTop = responseList.scrollHeight;
            // hljs.highlightAll();
        }, 10);
    } catch (err) {
        setRetryResponse(prompt, uniqueId);
        setErrorForResponse(responseElement, `Error: ${err.message}`);
    } finally {
        isGeneratingResponse = false;
        clearInterval(loadInterval);
        submitButton.classList.remove("loading");
    }
}

if (regenerateResponseButton) {
    regenerateResponseButton.addEventListener("click", () => {
        regenerateGPTResult();
    });
}