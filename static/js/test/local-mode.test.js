/**
 * Local mode tests: model helpers, predefined models, state, WebGPU detection,
 * and local chat message formatting.
 */

const { assert, assertEqual, describe, it } = require('./harness');

// Define local mode constants for testing (subset of actual models)
const PREDEFINED_LOCAL_MODELS = [
    { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', name: 'SmolLM2 360M', vram: '~0.5GB' },
    { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen 2.5 1.5B', vram: '~1.5GB' },
    { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', name: 'Llama 3.2 3B', vram: '~2GB' },
    { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', name: 'Phi 3.5 Mini', vram: '~2.5GB' },
    { id: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC', name: 'DeepSeek R1 7B', vram: '~5GB' }
];

function getLocalModelDisplayName(modelId) {
    const predefined = PREDEFINED_LOCAL_MODELS.find(m => m.id === modelId);
    return predefined ? predefined.name : modelId.split('-')[0];
}

// Mock navigator.gpu
global.navigator = { gpu: undefined };

async function checkLocalModeRequirements() {
    if (!navigator.gpu) {
        return {
            supported: false,
            reason: "WebGPU not supported. Use Chrome 113+, Edge 113+, or Opera 99+."
        };
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return {
                supported: false,
                reason: "No WebGPU adapter found. Your GPU may not be supported or is disabled."
            };
        }

        const adapterInfo = await adapter.requestAdapterInfo();
        return {
            supported: true,
            gpu: adapterInfo.description || adapterInfo.vendor || 'Unknown GPU',
            info: `GPU: ${adapterInfo.description || adapterInfo.vendor || 'Detected'}`
        };
    } catch (err) {
        return { supported: false, reason: `WebGPU error: ${err.message}` };
    }
}

let enabledLocalModels = [];
let activeLocalModel = null;

describe('Local Model Helpers', function() {
    it('getLocalModelDisplayName returns predefined name for known models', () => {
        assertEqual(
            getLocalModelDisplayName('SmolLM2-360M-Instruct-q4f16_1-MLC'),
            'SmolLM2 360M',
            'Should return "SmolLM2 360M" for SmolLM2 model'
        );
        assertEqual(
            getLocalModelDisplayName('Qwen2.5-1.5B-Instruct-q4f16_1-MLC'),
            'Qwen 2.5 1.5B',
            'Should return "Qwen 2.5 1.5B" for Qwen model'
        );
        assertEqual(
            getLocalModelDisplayName('DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC'),
            'DeepSeek R1 7B',
            'Should return "DeepSeek R1 7B" for DeepSeek model'
        );
    });

    it('getLocalModelDisplayName handles unknown models', () => {
        assertEqual(
            getLocalModelDisplayName('Custom-Model-xyz'),
            'Custom',
            'Should return first segment for unknown model'
        );
        assertEqual(
            getLocalModelDisplayName('SomeNewModel-7B-q4f16_1-MLC'),
            'SomeNewModel',
            'Should return first segment for unknown model'
        );
    });
});

describe('Predefined Local Models', function() {
    it('PREDEFINED_LOCAL_MODELS has correct structure', () => {
        assert(Array.isArray(PREDEFINED_LOCAL_MODELS), 'Should be an array');
        assert(PREDEFINED_LOCAL_MODELS.length >= 3, 'Should have at least 3 predefined models');

        PREDEFINED_LOCAL_MODELS.forEach((model, i) => {
            assert(typeof model.id === 'string', `Model ${i} should have string id`);
            assert(typeof model.name === 'string', `Model ${i} should have string name`);
            assert(typeof model.vram === 'string', `Model ${i} should have string vram`);
            assert(model.id.length > 0, `Model ${i} id should not be empty`);
            assert(model.name.length > 0, `Model ${i} name should not be empty`);
        });
    });

    it('All predefined model IDs contain MLC suffix', () => {
        PREDEFINED_LOCAL_MODELS.forEach(model => {
            assert(
                model.id.endsWith('-MLC'),
                `Model ${model.name} ID should end with -MLC`
            );
        });
    });
});

describe('Local Model State', function() {
    it('enabledLocalModels starts empty', () => {
        assertEqual(enabledLocalModels.length, 0, 'Should start with empty array');
    });

    it('activeLocalModel starts null', () => {
        assertEqual(activeLocalModel, null, 'Should start as null');
    });

    it('enabledLocalModels can be modified', () => {
        enabledLocalModels.push('test-model');
        assertEqual(enabledLocalModels.length, 1, 'Should have 1 model after push');
        enabledLocalModels = enabledLocalModels.filter(id => id !== 'test-model');
        assertEqual(enabledLocalModels.length, 0, 'Should be empty after filter');
    });
});

describe('WebGPU Detection', function() {
    it('checkLocalModeRequirements returns object with supported field', async () => {
        const result = await checkLocalModeRequirements();
        assert(typeof result === 'object', 'Should return an object');
        assert('supported' in result, 'Should have supported field');
        assertEqual(result.supported, false, 'Should be false when navigator.gpu is undefined');
        assert('reason' in result, 'Should have reason field when not supported');
    });

    it('checkLocalModeRequirements provides helpful error message', async () => {
        const result = await checkLocalModeRequirements();
        assert(
            result.reason.includes('WebGPU not supported'),
            'Should mention WebGPU not supported'
        );
        assert(
            result.reason.includes('Chrome'),
            'Should mention Chrome as compatible browser'
        );
    });

    it('checkLocalModeRequirements handles mock WebGPU adapter', async () => {
        // Mock WebGPU with adapter
        const mockAdapter = {
            requestAdapterInfo: async () => ({
                vendor: 'NVIDIA',
                description: 'GeForce RTX 3080'
            })
        };

        navigator.gpu = {
            requestAdapter: async () => mockAdapter
        };

        const result = await checkLocalModeRequirements();
        assertEqual(result.supported, true, 'Should be supported with mock adapter');
        assertEqual(result.gpu, 'GeForce RTX 3080', 'Should extract GPU description');
        assert(result.info.includes('GeForce'), 'Info should contain GPU name');

        // Reset mock
        navigator.gpu = undefined;
    });

    it('checkLocalModeRequirements handles null adapter', async () => {
        navigator.gpu = {
            requestAdapter: async () => null
        };

        const result = await checkLocalModeRequirements();
        assertEqual(result.supported, false, 'Should not be supported with null adapter');
        assert(
            result.reason.includes('No WebGPU adapter found'),
            'Should explain adapter not found'
        );

        // Reset mock
        navigator.gpu = undefined;
    });
});

describe('Local Chat Message Formatting', function() {
    it('should convert multimodal content to text-only for local models', () => {
        const messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'What is in this image?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
            ]
        }];

        // Simulate the conversion done in runLocalChatCompletion
        const formattedMessages = messages.map(msg => {
            if (typeof msg.content === 'string') {
                return { role: msg.role, content: msg.content };
            } else if (Array.isArray(msg.content)) {
                const textPart = msg.content.find(p => p.type === 'text');
                return { role: msg.role, content: textPart?.text || '' };
            }
            return msg;
        });

        assertEqual(formattedMessages.length, 1, 'Should have 1 message');
        assertEqual(formattedMessages[0].role, 'user', 'Role should be user');
        assertEqual(
            formattedMessages[0].content,
            'What is in this image?',
            'Content should be text only'
        );
        assert(
            typeof formattedMessages[0].content === 'string',
            'Content should be a string, not array'
        );
    });

    it('should handle string content unchanged', () => {
        const messages = [{ role: 'user', content: 'Hello world' }];

        const formattedMessages = messages.map(msg => {
            if (typeof msg.content === 'string') {
                return { role: msg.role, content: msg.content };
            } else if (Array.isArray(msg.content)) {
                const textPart = msg.content.find(p => p.type === 'text');
                return { role: msg.role, content: textPart?.text || '' };
            }
            return msg;
        });

        assertEqual(formattedMessages[0].content, 'Hello world', 'String content should pass through');
    });
});
